import { loadIngredientCosts, recipeCostFromMap } from "./cost-engine.ts";

const cleanNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : NaN;
};

const userLabel = (user: any) => user.full_name || user.email || "Noma’lum xodim";

const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) => {
  const error: any = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
};

const movementNumber = (now: string) =>
  `ST-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

async function resolveProductionLocation(service: any, user: any) {
  const locations = (await service.entities.Shop.filter(
    { location_type: "production" },
    "name",
    100,
  ) || []).filter((row: any) => row.active !== false);

  if (user.role === "production") {
    const assigned = locations.find((row: any) => row.id === user.shop_id) || null;
    if (!assigned) {
      throw fail("Siz faol markaziy ishlab chiqarish omboriga biriktirilmagansiz.", 403);
    }
    return assigned;
  }

  const main = locations.find((row: any) => row.is_main === true) || locations[0] || null;
  if (!main) {
    throw fail("Markaziy ishlab chiqarish ombori yaratilmagan yoki faol emas.", 409);
  }
  return main;
}

async function activeRecipe(service: any, productId: string) {
  const rows = await service.entities.Recipe.filter({ product_id: productId, active: true });
  if ((rows || []).length > 1) {
    throw fail("Mahsulot uchun bir nechta faol tex-karta topildi. Egasi tekshirishi kerak.", 409);
  }
  return rows?.[0] || null;
}

async function buildOrderProductionPlan(service: any, order: any) {
  const orderItems = await service.entities.CustomerOrderItem.filter({ order_id: order.id });
  if (!orderItems?.length) {
    throw fail("Buyurtma mahsulotlari topilmadi. Tayyor holatiga o‘tkazilmadi.", 409);
  }

  const productCache = new Map<string, any>();
  const productPlansById = new Map<string, any>();

  for (const item of orderItems) {
    const productId = String(item.product_id || "");
    if (!productId) {
      throw fail("Buyurtmadagi mahsulot identifikatori topilmadi.", 409);
    }

    let product = productCache.get(productId);
    if (!productCache.has(productId)) {
      product = await service.entities.Product.get(productId);
      productCache.set(productId, product || null);
    }
    if (!product) {
      throw fail(`${item.product_name_snapshot || "Mahsulot"} katalogdan topilmadi.`, 409);
    }

    const sourceType = String(product.source_type || "central_produced");
    if (sourceType !== "central_produced" || product.track_stock === false) {
      continue;
    }

    const quantity = cleanNumber(item.quantity);
    const itemUnit = String(item.unit_snapshot || "piece");
    const productUnit = String(product.production_unit || "piece");
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw fail(`${item.product_name_snapshot || product.name} miqdori noto‘g‘ri.`, 409);
    }
    if (itemUnit !== productUnit) {
      throw fail(`${item.product_name_snapshot || product.name} buyurtma birligi tex-kartaga mos emas.`, 409);
    }

    const piecesPerSheet = itemUnit === "sheet"
      ? Math.max(1, Number(item.event_pieces_per_sheet_snapshot) || Number(product.pieces_per_sheet) || 1)
      : 1;
    const reservedPieces = cleanNumber(quantity * piecesPerSheet);
    const existing = productPlansById.get(productId);
    if (existing) {
      existing.producedQuantity = cleanNumber(existing.producedQuantity + quantity);
      existing.reservedPieces = cleanNumber(existing.reservedPieces + reservedPieces);
    } else {
      productPlansById.set(productId, {
        product,
        unit: productUnit,
        producedQuantity: quantity,
        reservedPieces,
        recipe: null,
        recipeItems: [],
        usages: [],
        unitCost: 0,
        totalCost: 0,
        costComputed: false,
      });
    }
  }

  const productPlans = Array.from(productPlansById.values());
  const ingredientPlansById = new Map<string, any>();

  for (const productPlan of productPlans) {
    const recipe = await activeRecipe(service, productPlan.product.id);
    if (!recipe) {
      throw fail(`${productPlan.product.name} uchun faol tex-karta yaratilmagan.`, 409);
    }

    const recipeUnit = String(recipe.output_unit || "piece");
    if (recipeUnit !== productPlan.unit) {
      throw fail(`${productPlan.product.name} tex-karta birligi mahsulot birligiga mos emas.`, 409);
    }
    const recipeOutput = cleanNumber(recipe.output_quantity);
    if (!Number.isFinite(recipeOutput) || recipeOutput <= 0) {
      throw fail(`${productPlan.product.name} tex-karta natija miqdori noto‘g‘ri.`, 409);
    }

    const recipeItems = await service.entities.RecipeItem.filter({ recipe_id: recipe.id });
    if (!recipeItems?.length) {
      throw fail(`${productPlan.product.name} faol tex-kartasida masalliqlar yo‘q.`, 409);
    }

    productPlan.recipe = recipe;
    productPlan.recipeItems = recipeItems;
    productPlan.recipeOutput = recipeOutput;

    for (const item of recipeItems) {
      const ingredientId = String(item.ingredient_id || "");
      const required = cleanNumber(
        Number(item.quantity) * productPlan.producedQuantity / recipeOutput,
      );
      const unit = String(item.unit || "");
      if (!ingredientId || !Number.isFinite(required) || required <= 0) {
        throw fail(`${productPlan.product.name} tex-kartasidagi masalliq miqdori noto‘g‘ri.`, 409);
      }

      let ingredientPlan = ingredientPlansById.get(ingredientId);
      if (!ingredientPlan) {
        ingredientPlan = {
          ingredientId,
          ingredientName: String(item.ingredient_name_snapshot || "Masalliq"),
          unit,
          totalRequired: 0,
          allocations: [],
          stock: null,
          before: 0,
          after: 0,
        };
        ingredientPlansById.set(ingredientId, ingredientPlan);
      } else if (ingredientPlan.unit !== unit) {
        throw fail(`${ingredientPlan.ingredientName} birligi tex-kartalarda bir xil emas.`, 409);
      }

      const allocation = {
        productPlan,
        recipeItem: item,
        required,
        balanceBefore: 0,
        balanceAfter: 0,
      };
      productPlan.usages.push(allocation);
      ingredientPlan.allocations.push(allocation);
      ingredientPlan.totalRequired = cleanNumber(ingredientPlan.totalRequired + required);
    }
  }

  const ingredientPlans = Array.from(ingredientPlansById.values());
  return { productPlans, ingredientPlans };
}

async function attachLocationStocks(service: any, location: any, ingredientPlans: any[]) {
  const shortages = [];

  for (const ingredientPlan of ingredientPlans) {
    const rows = await service.entities.IngredientStock.filter({
      location_id: location.id,
      ingredient_id: ingredientPlan.ingredientId,
    });
    if ((rows || []).length > 1) {
      throw fail(`${ingredientPlan.ingredientName} uchun takroriy qoldiq topildi.`, 409);
    }

    const stock = rows?.[0] || null;
    const before = cleanNumber(stock?.quantity || 0);
    const after = cleanNumber(before - ingredientPlan.totalRequired);
    if (stock?.unit && String(stock.unit) !== ingredientPlan.unit) {
      throw fail(`${ingredientPlan.ingredientName} ombor birligi tex-kartaga mos emas.`, 409);
    }
    if (!stock || after < 0) {
      shortages.push({
        ingredient_id: ingredientPlan.ingredientId,
        ingredient_name: ingredientPlan.ingredientName,
        required: ingredientPlan.totalRequired,
        available: before,
        missing: cleanNumber(ingredientPlan.totalRequired - before),
        unit: ingredientPlan.unit,
      });
    }

    ingredientPlan.stock = stock;
    ingredientPlan.before = before;
    ingredientPlan.after = after;

    let runningBalance = before;
    for (const allocation of ingredientPlan.allocations) {
      allocation.balanceBefore = runningBalance;
      runningBalance = cleanNumber(runningBalance - allocation.required);
      allocation.balanceAfter = runningBalance;
    }
  }

  if (shortages.length) {
    const summary = shortages
      .slice(0, 4)
      .map((item: any) => `${item.ingredient_name}: ${item.missing} ${item.unit}`)
      .join(", ");
    throw fail(`Masalliqlar yetarli emas. Yetishmaydi: ${summary}.`, 409, { shortages });
  }
}

async function computePlanCosts(service: any, productPlans: any[]) {
  try {
    const ingredientCosts = await loadIngredientCosts(service);
    for (const productPlan of productPlans) {
      const { batchCost, hasAllPrices } = recipeCostFromMap(
        productPlan.recipeItems,
        ingredientCosts,
      );
      if (hasAllPrices && productPlan.recipeOutput > 0) {
        productPlan.unitCost = batchCost / productPlan.recipeOutput;
        productPlan.totalCost = productPlan.unitCost * productPlan.producedQuantity;
        productPlan.costComputed = true;
      }
    }
  } catch (error) {
    console.warn("Buyurtma ishlab chiqarish tannarxi hisoblanmadi:", error);
  }
}

export async function reservedOrderProductionPieces(
  service: any,
  orderId: string,
): Promise<Map<string, number>> {
  const batches = await service.entities.ProductionBatch.filter({
    order_id: orderId,
    output_disposition: "customer_order",
    status: "completed",
  });
  const result = new Map<string, number>();
  for (const batch of batches || []) {
    const productId = String(batch.product_id || "");
    const pieces = cleanNumber(batch.reserved_pieces);
    if (!productId || !Number.isFinite(pieces) || pieces <= 0) continue;
    result.set(productId, cleanNumber((result.get(productId) || 0) + pieces));
  }
  return result;
}

export async function completeOrderReadyProduction({
  service,
  user,
  order,
  readyStamp,
  applyIngredients = true,
}: {
  service: any;
  user: any;
  order: any;
  readyStamp: string;
  applyIngredients?: boolean;
}) {
  const previousStatus = String(order.order_status || "qabul_qilindi");
  if (["tayyor", "yuborildi_olib_ketildi", "yakunlandi"].includes(previousStatus)) {
    return {
      order,
      previous_status: previousStatus,
      already_ready: true,
      production_applied: order.ready_inventory_state === "completed",
      production_batches: [],
      ingredient_updates: [],
    };
  }
  if (previousStatus !== "qabul_qilindi" && previousStatus !== "tayyorlanmoqda") {
    throw fail("Tayyor bo‘lish uchun buyurtma faol holatda bo‘lishi kerak.", 409);
  }
  if (order.ready_inventory_state === "processing") {
    throw fail("Bu buyurtma ombor hisobi boshqa oynada bajarilmoqda. Birozdan keyin yangilang.", 409);
  }
  if (order.ready_inventory_state === "completed") {
    throw fail("Buyurtmaning ombor hisobi tayyor, ammo holati mos emas. Egasi tekshirishi kerak.", 409);
  }

  const existingBatches = await service.entities.ProductionBatch.filter({
    order_id: order.id,
    output_disposition: "customer_order",
  });
  if ((existingBatches || []).some((batch: any) => batch.status !== "cancelled")) {
    throw fail("Bu buyurtma uchun oldingi ishlab chiqarish yozuvi topildi. Egasi tekshirishi kerak.", 409);
  }

  // Customer order recipe accounting is temporarily paused by server policy.
  // Keep inventory pending: marking an order ready is not proof of production.
  if (!applyIngredients) {
    const claim = await service.entities.CustomerOrder.updateMany(
      {
        id: order.id,
        order_status: previousStatus,
        ready_inventory_state: order.ready_inventory_state || { $exists: false },
      },
      { $set: { order_status: "tayyor", ready_at: readyStamp, updated_at: new Date().toISOString() } },
    );
    if (!claim?.success || Number(claim.updated || 0) !== 1) {
      throw fail("Buyurtma holati o‘zgardi. Yangilang va qayta urinib ko‘ring.", 409);
    }
    await service.entities.ActionHistory.create({
      user_id: user.id,
      user_name: userLabel(user),
      action: "production_status_change",
      details: `${order.order_number} · ${previousStatus} → tayyor · tex-karta hisobi vaqtincha o‘chirilgan · ${readyStamp}`,
    }).catch(() => {});
    return {
      order: { ...order, order_status: "tayyor", ready_at: readyStamp },
      previous_status: previousStatus,
      production_applied: false,
      production_batches: [],
      ingredient_updates: [],
    };
  }

  const location = await resolveProductionLocation(service, user);
  const { productPlans, ingredientPlans } = await buildOrderProductionPlan(service, order);
  await attachLocationStocks(service, location, ingredientPlans);
  await computePlanCosts(service, productPlans);

  const now = new Date().toISOString();
  const claimToken = crypto.randomUUID();
  const claimFilter = order.ready_inventory_state
    ? {
        id: order.id,
        order_status: previousStatus,
        ready_inventory_state: "pending",
      }
    : {
        id: order.id,
        order_status: previousStatus,
        ready_inventory_state: { $exists: false },
      };
  const claim = await service.entities.CustomerOrder.updateMany(
    claimFilter,
    {
      $set: {
        ready_inventory_state: "processing",
        ready_inventory_token: claimToken,
        ready_inventory_location_id: location.id,
        updated_at: now,
      },
    },
  );
  if (!claim?.success || Number(claim.updated || 0) !== 1) {
    throw fail("Buyurtma boshqa qurilmada o‘zgardi. Yangilang va qayta urinib ko‘ring.", 409);
  }

  const claimedIngredients: any[] = [];
  const createdBatches: any[] = [];
  const createdBatchItems: any[] = [];
  const createdMovements: any[] = [];

  try {
    for (const ingredientPlan of ingredientPlans) {
      const update = await service.entities.IngredientStock.updateMany(
        { id: ingredientPlan.stock.id, quantity: ingredientPlan.before },
        {
          $set: {
            quantity: ingredientPlan.after,
            updated_at: now,
            updated_by: user.id,
            updated_by_name: userLabel(user),
          },
        },
      );
      if (!update?.success || Number(update.updated || 0) !== 1) {
        throw fail(
          `${ingredientPlan.ingredientName} qoldig‘i boshqa qurilmada o‘zgardi. Yangilang va qayta urinib ko‘ring.`,
          409,
        );
      }
      claimedIngredients.push(ingredientPlan);
    }

    for (const productPlan of productPlans) {
      const batchNumber = `PR-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 7).toUpperCase()}`;
      let batch = await service.entities.ProductionBatch.create({
        batch_number: batchNumber,
        location_id: location.id,
        location_name: location.name,
        product_id: productPlan.product.id,
        product_name_snapshot: productPlan.product.name,
        order_id: order.id,
        order_number_snapshot: order.order_number,
        idempotency_key: `order-ready:${order.id}:${productPlan.product.id}`,
        output_disposition: "customer_order",
        reserved_pieces: productPlan.reservedPieces,
        recipe_id: productPlan.recipe.id,
        recipe_version: Number(productPlan.recipe.version || 1),
        recipe_output_quantity: productPlan.recipeOutput,
        produced_quantity: productPlan.producedQuantity,
        unit: productPlan.unit,
        unit_cost: productPlan.costComputed ? productPlan.unitCost : 0,
        total_cost: productPlan.costComputed ? productPlan.totalCost : 0,
        status: "processing",
        notes: `Buyurtma ${order.order_number} uchun avtomatik ishlab chiqarish`,
        created_at: now,
        user_id: user.id,
        user_name: userLabel(user),
      });
      createdBatches.push(batch);

      for (const usage of productPlan.usages) {
        const batchItem = await service.entities.ProductionBatchItem.create({
          production_batch_id: batch.id,
          batch_number: batchNumber,
          location_id: location.id,
          product_id: productPlan.product.id,
          order_id: order.id,
          order_number_snapshot: order.order_number,
          ingredient_id: usage.recipeItem.ingredient_id,
          ingredient_name_snapshot: usage.recipeItem.ingredient_name_snapshot,
          quantity_used: usage.required,
          unit: usage.recipeItem.unit,
          balance_before: usage.balanceBefore,
          balance_after: usage.balanceAfter,
          created_at: now,
        });
        createdBatchItems.push(batchItem);

        const movement = await service.entities.StockMovement.create({
          movement_number: movementNumber(now),
          location_id: location.id,
          location_name: location.name,
          item_kind: "ingredient",
          item_id: usage.recipeItem.ingredient_id,
          item_name: usage.recipeItem.ingredient_name_snapshot,
          unit: usage.recipeItem.unit,
          movement_type: "production_use",
          quantity_change: -usage.required,
          balance_before: usage.balanceBefore,
          balance_after: usage.balanceAfter,
          reason: `Buyurtma ${order.order_number} uchun ${productPlan.product.name} ishlab chiqarildi`,
          reference_id: batch.id,
          reference_type: "production_batch",
          order_id: order.id,
          order_number_snapshot: order.order_number,
          user_id: user.id,
          user_name: userLabel(user),
          created_at: now,
        });
        createdMovements.push(movement);
      }

      batch = await service.entities.ProductionBatch.update(batch.id, {
        status: "completed",
        completed_at: now,
      });
      createdBatches[createdBatches.length - 1] = batch;
    }

    const statusClaim = await service.entities.CustomerOrder.updateMany(
      {
        id: order.id,
        order_status: previousStatus,
        ready_inventory_state: "processing",
        ready_inventory_token: claimToken,
      },
      {
        $set: {
          order_status: "tayyor",
          ready_at: readyStamp,
          ready_inventory_state: "completed",
          ready_inventory_completed_at: now,
          ready_inventory_location_id: location.id,
          updated_at: now,
        },
        $unset: {
          ready_inventory_token: "",
        },
      },
    );
    if (!statusClaim?.success || Number(statusClaim.updated || 0) !== 1) {
      throw fail("Buyurtma holati o‘zgardi. Ombor hisobi qaytarildi; yangilang va qayta urinib ko‘ring.", 409);
    }

    for (const productPlan of productPlans) {
      if (!productPlan.costComputed) continue;
      await service.entities.Product.update(productPlan.product.id, {
        last_production_cost: productPlan.unitCost,
      }).catch(() => {});
    }

    await service.entities.ActionHistory.create({
      user_id: user.id,
      user_name: userLabel(user),
      action: "order_ready_production",
      details: `${order.order_number} · ${location.name} · ${productPlans.length} xil mahsulot · retsept masalliqlari avtomatik kamaydi · ${readyStamp}`,
    }).catch(() => {});

    return {
      order: {
        ...order,
        order_status: "tayyor",
        ready_at: readyStamp,
        ready_inventory_state: "completed",
        ready_inventory_completed_at: now,
        ready_inventory_location_id: location.id,
      },
      previous_status: previousStatus,
      production_applied: productPlans.length > 0,
      production_location: { id: location.id, name: location.name },
      production_batches: createdBatches,
      ingredient_updates: ingredientPlans.map((plan) => ({
        ingredient_id: plan.ingredientId,
        ingredient_name: plan.ingredientName,
        quantity_used: plan.totalRequired,
        quantity: plan.after,
        unit: plan.unit,
      })),
    };
  } catch (error) {
    let rollbackSafe = true;

    for (const movement of [...createdMovements].reverse()) {
      try {
        await service.entities.StockMovement.delete(movement.id);
      } catch {
        rollbackSafe = false;
      }
    }
    for (const item of [...createdBatchItems].reverse()) {
      try {
        await service.entities.ProductionBatchItem.delete(item.id);
      } catch {
        rollbackSafe = false;
      }
    }
    for (const batch of [...createdBatches].reverse()) {
      try {
        await service.entities.ProductionBatch.delete(batch.id);
      } catch {
        rollbackSafe = false;
      }
    }
    for (const ingredientPlan of [...claimedIngredients].reverse()) {
      try {
        const restored = await service.entities.IngredientStock.updateMany(
          { id: ingredientPlan.stock.id, quantity: ingredientPlan.after },
          {
            $set: {
              quantity: ingredientPlan.before,
              updated_at: new Date().toISOString(),
              updated_by: user.id,
              updated_by_name: userLabel(user),
            },
          },
        );
        if (!restored?.success || Number(restored.updated || 0) !== 1) {
          rollbackSafe = false;
        }
      } catch {
        rollbackSafe = false;
      }
    }

    if (rollbackSafe) {
      await service.entities.CustomerOrder.updateMany(
        {
          id: order.id,
          order_status: previousStatus,
          ready_inventory_state: "processing",
          ready_inventory_token: claimToken,
        },
        {
          $set: {
            ready_inventory_state: "pending",
            updated_at: new Date().toISOString(),
          },
          $unset: {
            ready_inventory_token: "",
            ready_inventory_location_id: "",
          },
        },
      ).catch(() => {});
    }

    if (!rollbackSafe) {
      throw fail(
        "Ombor hisobini to‘liq qaytarib bo‘lmadi. Qayta bosmang; egasi ombor tarixini tekshirishi kerak.",
        500,
      );
    }
    throw error;
  }
}
