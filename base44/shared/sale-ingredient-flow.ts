// SDK-backed helpers for deducting/restoring shop-prepared ingredient stock
// during a Kassa sale and its refund. Pure planning logic lives in
// shop-ingredient-deduction.ts; this module performs the entity reads/writes.

import {
  shopPreparedLines,
  aggregateIngredientRequirements,
  planIngredientDeductions,
  saleIngredientReason,
  ingredientsDeductedForSale,
  dedNum,
} from "./shop-ingredient-deduction.ts";

const httpError = (message: string, status: number) => {
  const error: any = new Error(message);
  error.status = status;
  return error;
};

const movementNumber = (now: string) =>
  `ST-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// Load the active tech-card (Recipe + RecipeItems) for every shop_prepared product.
// Returns Map<product_id, { recipe_id, output_quantity, items }> or null when missing.
export async function loadShopRecipes(
  service: any,
  shopPreparedItems: any[],
): Promise<{ byProduct: Map<string, any | null>; missing: string[] }> {
  const productIds = Array.from(new Set(
    shopPreparedItems.map((row) => String(row.product_id)).filter(Boolean),
  ));
  const byProduct = new Map<string, any | null>();
  for (const productId of productIds) byProduct.set(productId, null);

  if (!productIds.length) return { byProduct, missing: [] };

  const recipes = await service.entities.Recipe.filter(
    { active: true }, "-version", 1000,
  );
  const byProductId = new Map<string, any[]>();
  for (const r of recipes || []) {
    const key = String(r.product_id);
    if (!byProductId.has(key)) byProductId.set(key, []);
    byProductId.get(key)!.push(r);
  }

  const recipeIds: string[] = [];
  const chosenRecipe = new Map<string, any>();
  for (const productId of productIds) {
    const rows = (byProductId.get(productId) || []).sort(
      (a: any, b: any) => Number(b.version || 0) - Number(a.version || 0),
    );
    if (rows.length > 1) {
      throw httpError("Bu mahsulot uchun bir nechta faol tex-karta topildi. Egasi tekshirishi kerak.", 409);
    }
    const recipe = rows[0] || null;
    if (recipe) {
      chosenRecipe.set(productId, recipe);
      recipeIds.push(recipe.id);
    }
  }

  let recipeItems: any[] = [];
  if (recipeIds.length) {
    recipeItems = await service.entities.RecipeItem.filter(
      { recipe_id: { $in: recipeIds } }, "position", 5000,
    );
  }
  const itemsByRecipe = new Map<string, any[]>();
  for (const ri of recipeItems || []) {
    const key = String(ri.recipe_id);
    if (!itemsByRecipe.has(key)) itemsByRecipe.set(key, []);
    itemsByRecipe.get(key)!.push(ri);
  }

  for (const productId of productIds) {
    const recipe = chosenRecipe.get(productId);
    if (!recipe) { byProduct.set(productId, null); continue; }
    byProduct.set(productId, {
      recipe_id: recipe.id,
      output_quantity: Number(recipe.output_quantity),
      items: (itemsByRecipe.get(recipe.id) || []).map((ri: any) => ({
        ingredient_id: ri.ingredient_id,
        ingredient_name_snapshot: ri.ingredient_name_snapshot,
        quantity: Number(ri.quantity),
        unit: String(ri.unit || ""),
      })),
    });
  }

  return { byProduct, missing: [] };
}

// Validate tech-cards and plan ingredient deductions for a sale.
// Returns { lines, requirements, plans, shortages }.
// Strict by default; Branch's gradual setup may explicitly allow missing cards.
// A present but invalid active card always blocks before any mutation.
export async function prepareSaleIngredientDeduction(
  service: any,
  shopId: string,
  items: any[],
  options: { allowMissing?: boolean } = {},
) {
  const shopPrepared = items.filter((row: any) => row.source_type === "shop_prepared");
  if (!shopPrepared.length) {
    return { lines: [], requirements: [], plans: [], shortages: [] };
  }

  const { byProduct } = await loadShopRecipes(service, shopPrepared);
  for (const recipe of byProduct.values()) {
    if (recipe && !recipe.items.length) {
      throw httpError("Faol tex-kartada masalliqlar kiritilmagan. Egasi tekshirishi kerak.", 409);
    }
  }
  const { lines, missing } = shopPreparedLines(
    shopPrepared.map((row: any) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      quantity: row.quantity,
      source_type: row.source_type,
    })),
    byProduct,
  );
  if (missing.length && !options.allowMissing) {
    throw httpError(
      "Bu mahsulot uchun faol tex-karta topilmadi. Avval tex-kartani kiriting.",
      409,
    );
  }

  for (const line of lines) {
    if (!Number.isFinite(line.recipe.output_quantity) || line.recipe.output_quantity <= 0
      || line.recipe.items.some((row: any) => !row.ingredient_id
        || !Number.isFinite(row.quantity) || row.quantity <= 0
        || !["g", "ml", "piece"].includes(row.unit))) {
      throw httpError("Tex-karta masalliqlari yoki natija miqdori noto‘g‘ri. Egasi tekshirishi kerak.", 409);
    }
  }
  const requirements = aggregateIngredientRequirements(lines);
  const ingredientIds = Array.from(new Set(requirements.map((r: any) => r.ingredient_id)));
  const stockRows = ingredientIds.length
    ? await service.entities.IngredientStock.filter(
        { location_id: shopId, ingredient_id: { $in: ingredientIds } },
        "ingredient_name",
        1000,
      )
    : [];
  const stockByIngredient = new Map<string, any>();
  for (const row of stockRows || []) {
    const key = String(row.ingredient_id);
    if (stockByIngredient.has(key)) {
      throw httpError(`${row.ingredient_name || "Masalliq"} uchun takroriy ombor qoldig‘i topildi.`, 409);
    }
    stockByIngredient.set(key, { id: row.id, quantity: dedNum(row.quantity || 0) });
  }

  const { plans, shortages } = planIngredientDeductions(requirements, stockByIngredient);
  return { lines, requirements, plans, shortages };
}

// Apply planned deductions after the sale record exists, before financial confirmation.
// Mutates IngredientStock and writes one StockMovement per ingredient (aggregated).
// `applied` is pushed with rollback descriptors.
export async function applySaleIngredientDeduction(
  service: any,
  params: {
    shopId: string;
    shopName: string;
    saleId: string;
    saleNumber: string;
    userId: string;
    userName: string;
    now: string;
    plans: any[];
    lines: any[];
    applied?: any[];
    movements?: any[];
  },
): Promise<{ movements: any[]; applied: any[] }> {
  const { shopId, shopName, saleId, saleNumber, userId, userName, now, plans, lines } = params;
  // Caller's journals retain partial writes if a later operation throws.
  const movements: any[] = params.movements || [];
  const applied: any[] = params.applied || [];

  // Build a per-ingredient product-name list for the reason text.
  const ingredientSources = new Map<string, string[]>();
  for (const line of lines || []) {
    for (const ri of line.recipe.items) {
      const key = String(ri.ingredient_id);
      if (!ingredientSources.has(key)) ingredientSources.set(key, []);
      ingredientSources.get(key)!.push(line.product_name);
    }
  }

  for (const plan of plans) {
    const req = plan.requirement;
    const stock = plan.stock;
    let stockRecord: any = stock?.id ? { id: stock.id } : null;

    if (stock?.id) {
      const update = await service.entities.IngredientStock.updateMany(
        { id: stock.id, quantity: plan.before },
        { $set: {
          quantity: plan.after,
          ingredient_name: req.ingredient_name,
          unit: plan.unit,
          location_name: shopName,
          updated_at: now,
          updated_by: userId,
          updated_by_name: userName,
        } },
      );
      if (!update?.success || Number(update.updated || 0) !== 1) {
        throw httpError(`${req.ingredient_name} qoldig‘i boshqa qurilmada o‘zgardi. Yangilang va qayta urinib ko‘ring.`, 409);
      }
    } else {
      stockRecord = await service.entities.IngredientStock.create({
        location_id: shopId,
        location_name: shopName,
        ingredient_id: req.ingredient_id,
        ingredient_name: req.ingredient_name,
        unit: plan.unit,
        quantity: plan.after,
        low_stock_level: 0,
        updated_at: now,
        updated_by: userId,
        updated_by_name: userName,
      });
    }
    applied.push({ stockId: stockRecord.id, quantity: req.total_required, before: plan.before, after: plan.after });

    const reason = saleIngredientReason(ingredientSources.get(req.ingredient_id) || []);
    const movement = await service.entities.StockMovement.create({
      movement_number: movementNumber(now),
      location_id: shopId,
      location_name: shopName,
      item_kind: "ingredient",
      item_id: req.ingredient_id,
      item_name: req.ingredient_name,
      unit: plan.unit,
      movement_type: "sale",
      quantity_change: -req.total_required,
      balance_before: plan.before,
      balance_after: plan.after,
      reason,
      reference_id: saleId,
      reference_type: "sale",
      order_id: undefined,
      order_number_snapshot: saleNumber,
      user_id: userId,
      user_name: userName,
      created_at: now,
    });
    movements.push(movement);
  }

  return { movements, applied };
}

// Restore ingredients for a refunded shop-prepared sale.
// Reads the ingredient `sale` StockMovement records for this sale and reverses them
// exactly once. Idempotent: the sale status flip (completed -> refunded) is the guard.
export async function restoreSaleIngredientsOnRefund(
  service: any,
  params: {
    shopId: string;
    shopName: string;
    saleId: string;
    saleNumber: string;
    refundId: string;
    userId: string;
    userName: string;
    now: string;
    movements?: any[];
    restocks?: any[];
  },
): Promise<{ movements: any[]; restocks: any[] }> {
  const { shopId, shopName, saleId, saleNumber, refundId, userId, userName, now } = params;

  const allMovements = await service.entities.StockMovement.filter(
    { reference_id: saleId, location_id: shopId, item_kind: "ingredient", movement_type: "sale" },
    "created_at",
    2000,
  );
  const toRestore = ingredientsDeductedForSale(allMovements || [], saleId);
  if (!toRestore.length) return { movements: [], restocks: [] };

  const ingredientIds = toRestore.map((r: any) => r.ingredient_id);
  const stockRows = await service.entities.IngredientStock.filter(
    { location_id: shopId, ingredient_id: { $in: ingredientIds } },
    "ingredient_name",
    1000,
  );
  const stockByIngredient = new Map<string, any>();
  for (const row of stockRows || []) {
    const key = String(row.ingredient_id);
    if (stockByIngredient.has(key)) {
      throw httpError(`${row.ingredient_name || "Masalliq"} uchun takroriy ombor qoldig‘i topildi.`, 409);
    }
    stockByIngredient.set(key, row);
  }

  const movements: any[] = params.movements || [];
  const restocks: any[] = params.restocks || [];

  for (const restore of toRestore) {
    const existing = stockByIngredient.get(restore.ingredient_id) || null;
    const before = dedNum(existing?.quantity || 0);
    const after = dedNum(before + restore.quantity);
    let stockRecord: any = existing;

    if (existing) {
      const update = await service.entities.IngredientStock.updateMany(
        { id: existing.id, quantity: before },
        { $set: {
          quantity: after,
          ingredient_name: restore.ingredient_name,
          unit: restore.unit,
          location_name: shopName,
          updated_at: now,
          updated_by: userId,
          updated_by_name: userName,
        } },
      );
      if (!update?.success || Number(update.updated || 0) !== 1) {
        throw httpError(`${restore.ingredient_name} qoldig‘i boshqa qurilmada o‘zgardi.`, 409);
      }
    } else {
      stockRecord = await service.entities.IngredientStock.create({
        location_id: shopId,
        location_name: shopName,
        ingredient_id: restore.ingredient_id,
        ingredient_name: restore.ingredient_name,
        unit: restore.unit,
        quantity: after,
        low_stock_level: 0,
        updated_at: now,
        updated_by: userId,
        updated_by_name: userName,
      });
    }
    restocks.push({ stockRecord, ingredient_id: restore.ingredient_id, quantity: restore.quantity, after });

    const movement = await service.entities.StockMovement.create({
      movement_number: movementNumber(now),
      location_id: shopId,
      location_name: shopName,
      item_kind: "ingredient",
      item_id: restore.ingredient_id,
      item_name: restore.ingredient_name,
      unit: restore.unit,
      movement_type: "refund",
      quantity_change: restore.quantity,
      balance_before: before,
      balance_after: after,
      reason: `Savdo qaytarildi: ${saleNumber}`,
      reference_id: refundId,
      reference_type: "refund",
      user_id: userId,
      user_name: userName,
      created_at: now,
    });
    movements.push(movement);
  }

  return { movements, restocks };
}