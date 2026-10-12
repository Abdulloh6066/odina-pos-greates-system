import { resolveAppUser } from "../../shared/user-helpers.ts";
import { assertManagerRequestScope } from "../../shared/manager-request-scope.ts";
import { createClientFromRequest } from "npm:@base44/sdk";
import { loadIngredientCosts, recipeCostFromMap } from "../../shared/cost-engine.ts";
import { buildProductionIngredientForecast } from "../../shared/production-forecast-logic.ts";

const RECIPE_ROLES = new Set(["admin", "accountant"]);
const PRODUCTION_ROLES = new Set(["admin", "manager", "production"]);

// Recipe and production units always follow the product: central stock uses sheets, while shop stock uses pieces.

const cleanNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : NaN;
};

const userLabel = (user: any) => user.full_name || user.email || "Noma’lum xodim";

const fail = (message: string, status = 400) => {
  const error: any = new Error(message);
  error.status = status;
  return error;
};

const movementNumber = (now: string) =>
  `ST-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

async function activeRecipe(service: any, productId: string) {
  const rows = await service.entities.Recipe.filter({ product_id: productId, active: true });
  if ((rows || []).length > 1) {
    throw fail("Bu mahsulot uchun bir nechta faol retsept topildi. Egasi tekshirishi kerak.", 409);
  }
  return rows?.[0] || null;
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const auth = await base44.auth.me();
    if (!auth) return Response.json({ error: "Tizimga kirish kerak." }, { status: 401 });
    const user = await resolveAppUser(service, auth);

    const body = await req.json();
    if (user.role === "manager") await assertManagerRequestScope(service, user, body);
    const action = String(body?.action || "");

    if (action === "save_recipe") {
      if (!RECIPE_ROLES.has(user.role)) {
        return Response.json({ error: "Retseptni faqat egasi yoki buxgalter saqlashi mumkin." }, { status: 403 });
      }

      const productId = String(body?.product_id || "");
      const outputQuantity = cleanNumber(body?.output_quantity);
      const notes = String(body?.notes || "").trim();
      const requestedItems = Array.isArray(body?.items) ? body.items : [];

      if (!productId || !Number.isInteger(outputQuantity) || outputQuantity <= 0) {
        return Response.json({ error: "Mahsulot va retseptdan chiqadigan list/dona sonini kiriting." }, { status: 400 });
      }
      if (!requestedItems.length) {
        return Response.json({ error: "Retseptga kamida bitta masalliq qo‘shing." }, { status: 400 });
      }

      const product = await service.entities.Product.get(productId);
      if (!product || product.archived === true) {
        return Response.json({ error: "Mahsulot topilmadi yoki arxivlangan." }, { status: 404 });
      }
      if (product.source_type === "resale") {
        return Response.json({ error: "Tayyor holda xarid qilinadigan mahsulotga ishlab chiqarish retsepti kerak emas." }, { status: 400 });
      }

      const seen = new Set<string>();
      const normalizedItems = [];
      for (let index = 0; index < requestedItems.length; index += 1) {
        const requested = requestedItems[index];
        const ingredientId = String(requested?.ingredient_id || "");
        const quantity = cleanNumber(requested?.quantity);
        if (!ingredientId || !Number.isFinite(quantity) || quantity <= 0) {
          return Response.json({ error: "Har bir masalliq va uning musbat miqdorini kiriting." }, { status: 400 });
        }
        if (seen.has(ingredientId)) {
          return Response.json({ error: "Bir masalliq retseptga ikki marta qo‘shilgan." }, { status: 400 });
        }
        seen.add(ingredientId);
        const ingredient = await service.entities.Ingredient.get(ingredientId);
        if (!ingredient || ingredient.active === false) {
          return Response.json({ error: "Retseptdagi masalliq topilmadi yoki faol emas." }, { status: 404 });
        }
        if (ingredient.is_cake_layer === true && (product.source_type !== "central_produced"
          || ingredient.base_unit !== "piece" || ingredient.purchase_unit !== "piece"
          || Number(ingredient.conversion_to_base) !== 1
          || !Number.isSafeInteger(Number(requested.quantity) / outputQuantity))) {
          return Response.json({ error: "Qavatlar faqat markaziy mahsulot uchun, har bir natijaga butun list sonida kiritiladi." }, { status: 400 });
        }
        normalizedItems.push({
          ingredient_id: ingredient.id,
          ingredient_name_snapshot: ingredient.name,
          quantity,
          unit: ingredient.base_unit,
          position: index,
        });
      }

      const previousRecipes = await service.entities.Recipe.filter({ product_id: product.id });
      const nextVersion = Math.max(0, ...(previousRecipes || []).map((row: any) => Number(row.version || 0))) + 1;
      const activePrevious = (previousRecipes || []).filter((row: any) => row.active === true);
      const now = new Date().toISOString();
      let recipe: any = null;
      let createdItems: any[] = [];
      const deactivated: any[] = [];

      try {
        recipe = await service.entities.Recipe.create({
          product_id: product.id,
          product_name_snapshot: product.name,
          version: nextVersion,
          output_quantity: outputQuantity,
          output_unit: product.production_unit || "piece",
          active: false,
          notes,
          created_at: now,
          created_by: user.id,
          created_by_name: userLabel(user),
        });

        createdItems = await service.entities.RecipeItem.bulkCreate(
          normalizedItems.map((item) => ({
            recipe_id: recipe.id,
            product_id: product.id,
            ...item,
            created_at: now,
          })),
        );

        for (const previous of activePrevious) {
          await service.entities.Recipe.update(previous.id, { active: false });
          deactivated.push(previous);
        }

        recipe = await service.entities.Recipe.update(recipe.id, { active: true });
      } catch (error) {
        for (const previous of deactivated) {
          try { await service.entities.Recipe.update(previous.id, { active: true }); } catch {}
        }
        for (const item of createdItems || []) {
          try { await service.entities.RecipeItem.delete(item.id); } catch {}
        }
        if (recipe?.id) {
          try { await service.entities.Recipe.delete(recipe.id); } catch {}
        }
        throw error;
      }

      try {
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userLabel(user),
          action: "recipe_saved",
          details: `${product.name}. Retsept v${nextVersion}. Natija: ${outputQuantity} ${product.production_unit === "sheet" ? "list" : "dona"}. ${normalizedItems.length} ta masalliq.`,
        });
      } catch {}

      return Response.json({ recipe, items: createdItems });
    }

    if (action === "tomorrow_ingredient_forecast") {
      if (!PRODUCTION_ROLES.has(user.role)) {
        return Response.json({ error: "Bu prognozni faqat egasi yoki ishlab chiqarish xodimi ko‘ra oladi." }, { status: 403 });
      }

      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tashkent",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
      );
      const baseDate = new Date(Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
      ));
      const dateAtOffset = (days: number) => {
        const value = new Date(baseDate.getTime());
        value.setUTCDate(value.getUTCDate() + days);
        return [
          value.getUTCFullYear(),
          String(value.getUTCMonth() + 1).padStart(2, "0"),
          String(value.getUTCDate()).padStart(2, "0"),
        ].join("-");
      };
      const todayDate = dateAtOffset(0);
      const tomorrowDate = dateAtOffset(1);

      const locations = (await service.entities.Shop.filter(
        { location_type: "production" },
        "name",
        100,
      ) || []).filter((row: any) => row.active !== false);

      const requestedLocationId = String(body?.location_id || "");
      let location: any = null;
      if (["production", "manager"].includes(user.role)) {
        location = locations.find((row: any) => row.id === user.shop_id) || null;
        if (!location) {
          return Response.json({
            error: "Siz faol markaziy ishlab chiqarish omboriga biriktirilmagansiz.",
          }, { status: 403 });
        }
      } else if (requestedLocationId) {
        location = locations.find((row: any) => row.id === requestedLocationId) || null;
        if (!location) {
          return Response.json({ error: "Faol ishlab chiqarish ombori topilmadi." }, { status: 400 });
        }
      } else {
        location = locations.find((row: any) => row.is_main === true) || locations[0] || null;
      }

      if (!location) {
        return Response.json({
          error: "Markaziy ishlab chiqarish ombori yaratilmagan yoki faol emas.",
        }, { status: 409 });
      }

      const [todayOrders, tomorrowOrders, products, recipes, recipeItems, ingredientStocks] =
        await Promise.all([
          service.entities.CustomerOrder.filter({ required_date: todayDate }, "-created_date", 5000),
          service.entities.CustomerOrder.filter({ required_date: tomorrowDate }, "-created_date", 5000),
          service.entities.Product.list("name", 5000),
          service.entities.Recipe.filter({ active: true }, "-version", 5000),
          service.entities.RecipeItem.list("position", 5000),
          service.entities.IngredientStock.filter({ location_id: location.id }, "ingredient_name", 5000),
        ]);

      const orders = [...(todayOrders || []), ...(tomorrowOrders || [])];
      const orderIds = new Set(orders.map((order: any) => String(order.id)));
      const allOrderItems = orderIds.size
        ? await service.entities.CustomerOrderItem.list("-created_date", 5000)
        : [];
      const orderItems = (allOrderItems || []).filter((item: any) =>
        orderIds.has(String(item.order_id)),
      );

      const forecast = buildProductionIngredientForecast({
        orders,
        orderItems,
        products,
        recipes,
        recipeItems,
        ingredientStocks,
        todayDate,
        tomorrowDate,
      });

      return Response.json({
        ...forecast,
        location: { id: location.id, name: location.name },
        generated_at: new Date().toISOString(),
      });
    }

    if (action === "complete_production") {
      if (!PRODUCTION_ROLES.has(user.role)) {
        return Response.json({ error: "Ishlab chiqarishni faqat egasi yoki ishlab chiqarish xodimi kirita oladi." }, { status: 403 });
      }

      const locationId = String(body?.location_id || "");
      const productId = String(body?.product_id || "");
      const producedQuantity = cleanNumber(body?.produced_quantity);
      const notes = String(body?.notes || "").trim();

      if (!locationId || !productId || !Number.isInteger(producedQuantity) || producedQuantity <= 0) {
        return Response.json({ error: "Ishlab chiqarish joyi, mahsulot va musbat butun miqdor kiriting." }, { status: 400 });
      }
      if (["production", "manager"].includes(user.role) && (!user.shop_id || user.shop_id !== locationId)) {
        return Response.json({ error: "Siz faqat biriktirilgan ishlab chiqarish omborida ishlashingiz mumkin." }, { status: 403 });
      }

      const [location, product] = await Promise.all([
        service.entities.Shop.get(locationId),
        service.entities.Product.get(productId),
      ]);
      if (!location || location.active === false || location.location_type !== "production") {
        return Response.json({ error: "Faol markaziy ishlab chiqarish omborini tanlang." }, { status: 400 });
      }
      if (!product || product.active === false || product.archived === true || product.track_stock === false) {
        return Response.json({ error: "Faol va omborda kuzatiladigan mahsulot topilmadi." }, { status: 404 });
      }
      if (product.source_type !== "central_produced") {
        return Response.json({ error: "Bu bo‘limda faqat markazda ishlab chiqariladigan mahsulot tayyorlanadi." }, { status: 400 });
      }

      const recipe = await activeRecipe(service, product.id);
      if (!recipe) {
        return Response.json({ error: "Bu mahsulot uchun faol retsept yaratilmagan." }, { status: 409 });
      }
      if ((recipe.output_unit || "piece") !== (product.production_unit || "piece")) {
        return Response.json({ error: "Retsept va mahsulot birligi mos emas. Retseptni yangilang." }, { status: 409 });
      }
      const recipeOutput = cleanNumber(recipe.output_quantity);
      if (!Number.isFinite(recipeOutput) || recipeOutput <= 0) {
        return Response.json({ error: "Retsept natija miqdori noto‘g‘ri." }, { status: 409 });
      }

      const recipeItems = await service.entities.RecipeItem.filter({ recipe_id: recipe.id });
      if (!recipeItems?.length) {
        return Response.json({ error: "Faol retseptda masalliqlar yo‘q." }, { status: 409 });
      }

      const usagePlans = [];
      const shortages = [];
      for (const item of recipeItems) {
        const ingredient = await service.entities.Ingredient.get(item.ingredient_id);
        if (!ingredient || ingredient.active === false || ingredient.base_unit !== item.unit) {
          return Response.json({ error: "Retsept masallig‘i yoki birligi noto‘g‘ri. Retseptni tekshiring." }, { status: 409 });
        }
        if (ingredient.is_cake_layer === true && (ingredient.base_unit !== "piece"
          || ingredient.purchase_unit !== "piece" || Number(ingredient.conversion_to_base) !== 1
          || !Number.isSafeInteger(Number(item.quantity) / recipeOutput)
          || !Number.isSafeInteger(Number(body?.produced_quantity)))) {
          return Response.json({ error: "Qavat retseptida har bir mahsulot uchun butun list soni bo‘lishi kerak." }, { status: 409 });
        }
        const required = cleanNumber(Number(item.quantity) * producedQuantity / recipeOutput);
        if (!Number.isFinite(required) || required <= 0) {
          return Response.json({ error: "Retseptdagi masalliq miqdori noto‘g‘ri." }, { status: 409 });
        }
        const rows = await service.entities.IngredientStock.filter({
          location_id: location.id,
          ingredient_id: item.ingredient_id,
        });
        if ((rows || []).length > 1) {
          return Response.json({ error: `${item.ingredient_name_snapshot} uchun takroriy qoldiq topildi.` }, { status: 409 });
        }
        const stock = rows?.[0] || null;
        const before = cleanNumber(stock?.quantity || 0);
        if (stock && (stock.unit !== item.unit || (ingredient.is_cake_layer === true && !Number.isSafeInteger(before)))) {
          return Response.json({ error: "Masalliq/qavat qoldig‘i birligi retseptga mos emas." }, { status: 409 });
        }
        const after = cleanNumber(before - required);
        if (!stock || after < 0) {
          shortages.push({
            ingredient_id: item.ingredient_id,
            ingredient_name: item.ingredient_name_snapshot,
            required,
            available: before,
            missing: cleanNumber(required - before),
            unit: item.unit,
          });
        }
        usagePlans.push({ item, stock, required, before, after });
      }

      if (shortages.length) {
        return Response.json({
          error: "Ishlab chiqarish uchun masalliqlar yetarli emas.",
          shortages,
        }, { status: 409 });
      }

      // Save the calculated unit cost on the produced finished goods (best-effort).
      let batchUnitCost = 0;
      let batchTotalCost = 0;
      let costComputed = false;
      try {
        const ingredientCosts = await loadIngredientCosts(service);
        const { batchCost, hasAllPrices } = recipeCostFromMap(recipeItems, ingredientCosts);
        if (hasAllPrices && recipeOutput > 0) {
          batchUnitCost = batchCost / recipeOutput; // per output unit (piece/sheet)
          batchTotalCost = batchUnitCost * producedQuantity;
          costComputed = true;
        }
      } catch (costError) {
        console.warn("Production cost skipped:", costError);
      }

      const now = new Date().toISOString();
      const batchNumber = `PR-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 7).toUpperCase()}`;
      const claimedIngredients: any[] = [];
      const movementRecords: any[] = [];
      let productStock: any = null;
      let productStockWasCreated = false;
      let batch: any = null;
      let batchItems: any[] = [];

      try {
        for (const plan of usagePlans) {
          const update = await service.entities.IngredientStock.updateMany(
            { id: plan.stock.id, quantity: plan.before },
            { $set: {
              quantity: plan.after,
              updated_at: now,
              updated_by: user.id,
              updated_by_name: userLabel(user),
            } },
          );
          if (!update?.success || Number(update.updated || 0) !== 1) {
            throw fail(`${plan.item.ingredient_name_snapshot} qoldig‘i boshqa qurilmada o‘zgardi. Yangilang va qayta urinib ko‘ring.`, 409);
          }
          claimedIngredients.push(plan);
        }

        const productRows = await service.entities.ProductStock.filter({
          location_id: location.id,
          product_id: product.id,
        });
        if ((productRows || []).length > 1) {
          throw fail("Bu mahsulot uchun takroriy tayyor mahsulot qoldig‘i topildi.", 409);
        }
        const existingProductStock = productRows?.[0] || null;
        if (existingProductStock && (existingProductStock.unit || "piece") !== (product.production_unit || "piece")) {
          throw fail("Mahsulot qoldig‘i birligi retseptga mos emas.", 409);
        }
        const productBefore = cleanNumber(existingProductStock?.quantity || 0);
        const productAfter = cleanNumber(productBefore + producedQuantity);

        if (existingProductStock) {
          const update = await service.entities.ProductStock.updateMany(
            { id: existingProductStock.id, quantity: productBefore },
            { $set: {
              quantity: productAfter,
              location_name: location.name,
              product_name: product.name,
              unit: product.production_unit || "piece",
              updated_at: now,
              updated_by: user.id,
              updated_by_name: userLabel(user),
            } },
          );
          if (!update?.success || Number(update.updated || 0) !== 1) {
            throw fail("Tayyor mahsulot qoldig‘i boshqa qurilmada o‘zgardi. Yangilang va qayta urinib ko‘ring.", 409);
          }
          productStock = { ...existingProductStock, quantity: productAfter };
        } else {
          productStock = await service.entities.ProductStock.create({
            location_id: location.id,
            location_name: location.name,
            product_id: product.id,
            product_name: product.name,
            unit: product.production_unit || "piece",
            quantity: productAfter,
            low_stock_level: 0,
            updated_at: now,
            updated_by: user.id,
            updated_by_name: userLabel(user),
          });
          productStockWasCreated = true;
        }

        batch = await service.entities.ProductionBatch.create({
          batch_number: batchNumber,
          location_id: location.id,
          location_name: location.name,
          product_id: product.id,
          product_name_snapshot: product.name,
          recipe_id: recipe.id,
          recipe_version: Number(recipe.version || 1),
          recipe_output_quantity: recipeOutput,
          produced_quantity: producedQuantity,
          unit: product.production_unit || "piece",
          unit_cost: costComputed ? batchUnitCost : 0,
          total_cost: costComputed ? batchTotalCost : 0,
          status: "processing",
          notes,
          created_at: now,
          user_id: user.id,
          user_name: userLabel(user),
        });

        batchItems = await service.entities.ProductionBatchItem.bulkCreate(
          usagePlans.map((plan) => ({
            production_batch_id: batch.id,
            batch_number: batchNumber,
            location_id: location.id,
            product_id: product.id,
            ingredient_id: plan.item.ingredient_id,
            ingredient_name_snapshot: plan.item.ingredient_name_snapshot,
            quantity_used: plan.required,
            unit: plan.item.unit,
            balance_before: plan.before,
            balance_after: plan.after,
            created_at: now,
          })),
        );

        for (const plan of usagePlans) {
          const movement = await service.entities.StockMovement.create({
            movement_number: movementNumber(now),
            location_id: location.id,
            location_name: location.name,
            item_kind: "ingredient",
            item_id: plan.item.ingredient_id,
            item_name: plan.item.ingredient_name_snapshot,
            unit: plan.item.unit,
            movement_type: "production_use",
            quantity_change: -plan.required,
            balance_before: plan.before,
            balance_after: plan.after,
            reason: `${product.name} ishlab chiqarildi: ${producedQuantity} ${product.production_unit === "sheet" ? "list" : "dona"}`,
            reference_id: batch.id,
            reference_type: "production_batch",
            user_id: user.id,
            user_name: userLabel(user),
            created_at: now,
          });
          movementRecords.push(movement);
        }

        const outputMovement = await service.entities.StockMovement.create({
          movement_number: movementNumber(now),
          location_id: location.id,
          location_name: location.name,
          item_kind: "product",
          item_id: product.id,
          item_name: product.name,
          unit: product.production_unit || "piece",
          movement_type: "production_output",
          quantity_change: producedQuantity,
          balance_before: productBefore,
          balance_after: productAfter,
          reason: `Retsept v${Number(recipe.version || 1)} bo‘yicha ishlab chiqarildi`,
          reference_id: batch.id,
          reference_type: "production_batch",
          user_id: user.id,
          user_name: userLabel(user),
          created_at: now,
        });
        movementRecords.push(outputMovement);

        batch = await service.entities.ProductionBatch.update(batch.id, {
          status: "completed",
          completed_at: now,
        });

        if (costComputed) {
          try {
            await service.entities.Product.update(product.id, { last_production_cost: batchUnitCost });
          } catch {}
        }

        try {
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: userLabel(user),
            action: "production_completed",
            details: `${location.name}. ${product.name}: ${producedQuantity} ${product.production_unit === "sheet" ? "list" : "dona"}. Retsept v${Number(recipe.version || 1)}.`,
          });
        } catch {}

        return Response.json({
          batch,
          batch_items: batchItems,
          product_stock: productStock,
        });
      } catch (error) {
        for (const movement of movementRecords) {
          try { await service.entities.StockMovement.delete(movement.id); } catch {}
        }
        for (const item of batchItems || []) {
          try { await service.entities.ProductionBatchItem.delete(item.id); } catch {}
        }
        if (batch?.id) {
          try { await service.entities.ProductionBatch.delete(batch.id); } catch {}
        }
        if (productStock?.id) {
          try {
            await service.entities.ProductStock.updateMany(
              { id: productStock.id },
              { $inc: { quantity: -producedQuantity } },
            );
          } catch {}
        }
        for (const plan of claimedIngredients) {
          try {
            await service.entities.IngredientStock.updateMany(
              { id: plan.stock.id },
              { $inc: { quantity: plan.required } },
            );
          } catch {}
        }
        throw error;
      }
    }

    return Response.json({ error: "Noma’lum ishlab chiqarish amali." }, { status: 400 });
  } catch (error) {
    const status = Number((error as any)?.status || 500);
    return Response.json({
      error: error instanceof Error ? error.message : "Ishlab chiqarish amalini bajarib bo‘lmadi.",
    }, { status });
  }
}