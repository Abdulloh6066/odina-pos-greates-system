// Pure logic for deducting tech-card ingredients when a shop-prepared product
// (coffee, mojito, tea, smoothie…) is sold at a Kassa.
// No SDK access — all data is passed in. Tested offline in tests/shop-ingredient-deduction.test.mjs.

export const dedNum = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
};

export type RecipeInfo = {
  recipe_id: string;
  output_quantity: number;
  items: Array<{
    ingredient_id: string;
    ingredient_name_snapshot: string;
    quantity: number;
    unit: string;
  }>;
};

export type SaleLine = {
  product_id: string;
  product_name: string;
  quantity: number;
  source_type: string;
  fries_option?: string;
};

// Collect the active tech-card for every shop-prepared product in the sale.
// recipeItemsByProduct: Map<product_id, RecipeInfo | null>
// Returns the list of shop-prepared lines that must deduct ingredients.
export function shopPreparedLines(
  items: SaleLine[],
  recipeItemsByProduct: Map<string, RecipeInfo | null>,
): { lines: Array<SaleLine & { recipe: RecipeInfo }>; missing: string[] } {
  const lines: Array<SaleLine & { recipe: RecipeInfo }> = [];
  const missing: string[] = [];
  for (const item of items || []) {
    if (item.source_type !== "shop_prepared") continue;
    const recipe = recipeItemsByProduct.get(String(item.product_id)) || null;
    if (!recipe || !recipe.items?.length) {
      missing.push(String(item.product_name || item.product_id));
      continue;
    }
    lines.push({ ...item, recipe });
  }
  return { lines, missing };
}

// Aggregate identical ingredients across all shop-prepared drinks in one sale.
// Recipe quantities are per recipe output; each sold unit uses (qty / output_quantity).
export function aggregateIngredientRequirements(
  lines: Array<SaleLine & { recipe: RecipeInfo }>,
): Array<{
  ingredient_id: string;
  ingredient_name: string;
  unit: string;
  total_required: number;
  sources: Array<{ product_id: string; product_name: string; quantity: number; used: number }>;
}> {
  const agg = new Map<string, {
    ingredient_id: string;
    ingredient_name: string;
    unit: string;
    total_required: number;
    sources: Array<{ product_id: string; product_name: string; quantity: number; used: number }>;
  }>();

  for (const line of lines) {
    const output = dedNum(line.recipe.output_quantity) || 1;
    for (const ri of line.recipe.items) {
      const perUnit = dedNum(ri.quantity) / output; // ingredient per 1 sold unit
      const used = dedNum(perUnit * dedNum(line.quantity));
      if (used <= 0) continue;
      const key = String(ri.ingredient_id);
      if (!agg.has(key)) {
        agg.set(key, {
          ingredient_id: ri.ingredient_id,
          ingredient_name: String(ri.ingredient_name_snapshot || ri.ingredient_id),
          unit: String(ri.unit || ""),
          total_required: 0,
          sources: [],
        });
      }
      const entry = agg.get(key)!;
      entry.total_required = dedNum(entry.total_required + used);
      entry.sources.push({
        product_id: line.product_id,
        product_name: line.product_name,
        quantity: dedNum(line.quantity),
        used,
      });
    }
  }

  return Array.from(agg.values());
}

// stockByIngredient: Map<ingredient_id, { id: string | null, quantity: number }>
export function planIngredientDeductions(
  requirements: ReturnType<typeof aggregateIngredientRequirements>,
  stockByIngredient: Map<string, { id: string | null; quantity: number }>,
): {
  plans: Array<{
    requirement: ReturnType<typeof aggregateIngredientRequirements>[number];
    stock: { id: string | null; quantity: number } | null;
    before: number;
    after: number;
    unit: string;
  }>;
  shortages: Array<{
    ingredient_id: string;
    ingredient_name: string;
    required: number;
    available: number;
    missing: number;
    unit: string;
  }>;
} {
  const plans: any[] = [];
  const shortages: any[] = [];
  for (const req of requirements) {
    const stock = stockByIngredient.get(req.ingredient_id) || null;
    const before = dedNum(stock?.quantity || 0);
    const after = dedNum(before - req.total_required);
    if (after < 0) {
      shortages.push({
        ingredient_id: req.ingredient_id,
        ingredient_name: req.ingredient_name,
        required: req.total_required,
        available: before,
        missing: dedNum(-after),
        unit: req.unit,
      });
    }
    plans.push({ requirement: req, stock, before, after, unit: req.unit });
  }
  return { plans, shortages };
}

// Build the StockMovement reason text for a sale-driven ingredient deduction.
export function saleIngredientReason(productNames: string[]): string {
  const names = (productNames || []).filter(Boolean);
  const head = names.slice(0, 3).join(", ");
  const suffix = names.length > 3 ? " va boshqalar" : "";
  return `Kassa savdosi — ${head || "noma’lum mahsulot"}${suffix}`;
}

// Sum the ingredients that were deducted for a sale, from StockMovement records.
// movements: Array<{ item_kind, movement_type, item_id, item_name, quantity_change, unit, reference_id }>
export function ingredientsDeductedForSale(
  movements: any[],
  saleId: string,
): Array<{ ingredient_id: string; ingredient_name: string; quantity: number; unit: string }> {
  const agg = new Map<string, { ingredient_id: string; ingredient_name: string; quantity: number; unit: string }>();
  for (const m of movements || []) {
    if (String(m?.reference_id || "") !== String(saleId)) continue;
    if (m?.item_kind !== "ingredient") continue;
    if (m?.movement_type !== "sale") continue;
    const change = dedNum(m?.quantity_change);
    if (change >= 0) continue; // only deductions (negative)
    const key = String(m?.item_id || "");
    if (!key) continue;
    const restored = dedNum(-change);
    if (!agg.has(key)) {
      agg.set(key, {
        ingredient_id: key,
        ingredient_name: String(m?.item_name || key),
        quantity: 0,
        unit: String(m?.unit || ""),
      });
    }
    agg.get(key)!.quantity = dedNum(agg.get(key)!.quantity + restored);
  }
  return Array.from(agg.values());
}