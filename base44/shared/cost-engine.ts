// Pure cost & profit engine for the "Tannarx va foyda" module.
// No external imports — all SDK access is passed in via `service`.
// Pure math is unit-tested in src/tests/cost-engine.test.mjs.

export const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Purchase unit -> base unit (g / ml / piece) conversion factor.
// 1 kg = 1000 g, 1 l = 1000 ml, pieces remain pieces.
const PURCHASE_TO_BASE_FACTOR: Record<string, number> = {
  kg: 1000,
  l: 1000,
  g: 1,
  ml: 1,
  piece: 1,
};

// Base-unit quantity for a supplier receipt line.
export function receiptBaseQuantity(line: any): number {
  if (line?.base_quantity != null && Number(line.base_quantity) > 0) {
    return num(line.base_quantity);
  }
  const qty = num(line?.purchase_quantity);
  const factor = PURCHASE_TO_BASE_FACTOR[String(line?.purchase_unit || "")] || 1;
  return qty * factor;
}

// Weighted-average cost per base unit from non-cancelled receipt lines:
// cost_per_base_unit = sum(line_total) / sum(base_quantity).
export function weightedAvgIngredientCost(lines: any[]): { cost: number; hasPrice: boolean } {
  let totalCost = 0;
  let totalBase = 0;
  for (const line of lines || []) {
    const base = receiptBaseQuantity(line);
    if (base <= 0) continue;
    const lineTotal = num(line?.line_total);
    if (lineTotal > 0) {
      totalCost += lineTotal;
      totalBase += base;
    }
  }
  if (totalBase <= 0 || totalCost <= 0) return { cost: 0, hasPrice: false };
  return { cost: totalCost / totalBase, hasPrice: true };
}

// Sum recipe ingredient costs into a batch cost.
// Recipe quantities are already in the ingredient base unit (g / ml / piece).
// ingredientCosts: Map<ingredient_id, { cost, hasPrice }>.
export function recipeCostFromMap(
  recipeItems: any[],
  ingredientCosts: Map<string, any>,
): { batchCost: number; missing: string[]; hasAllPrices: boolean } {
  let batchCost = 0;
  const missing: string[] = [];
  const items = recipeItems || [];
  let hasAllPrices = items.length > 0;
  for (const ri of items) {
    const ic = ingredientCosts.get(String(ri.ingredient_id));
    if (!ic || !ic.hasPrice) {
      missing.push(String(ri.ingredient_name_snapshot || ri.ingredient_id));
      hasAllPrices = false;
      continue;
    }
    batchCost += num(ri.quantity) * ic.cost;
  }
  return { batchCost, missing, hasAllPrices };
}

// Convert batch cost to a per-piece cost.
// outputUnit is "piece" or "sheet"; sheet products split by pieces_per_sheet.
export function costPerPiece(
  batchCost: number,
  outputQuantity: number,
  outputUnit: string,
  piecesPerSheet: number,
): number {
  const out = num(outputQuantity);
  if (out <= 0) return 0;
  const perOutput = batchCost / out; // per piece or per sheet
  if (outputUnit === "sheet") {
    const pps = num(piecesPerSheet) || 1;
    return pps > 0 ? perOutput / pps : 0;
  }
  return perOutput;
}

// Only completed sales count toward profit; refunded sales are fully excluded
// (their revenue AND cost are reversed together).
export function isProfitRelevantSale(sale: any): boolean {
  return !!sale && sale.status === "completed";
}

export function grossProfitLine(netRevenue: number, totalCost: number): number {
  return num(netRevenue) - num(totalCost);
}

export function marginPercent(netRevenue: number, grossProfit: number): number {
  const r = num(netRevenue);
  if (r <= 0) return 0;
  return (grossProfit / r) * 100;
}

// Aggregate completed-sale items into per-product rows + a summary.
// costById: Map<saleItem_id, { unitCost, isEstimate, unknown }>.
export function aggregateReport(
  sales: any[],
  saleItems: any[],
  costById: Map<string, any>,
) {
  const relevantIds = new Set(
    (sales || []).filter(isProfitRelevantSale).map((s: any) => s.id),
  );
  const byProduct = new Map<string, any>();
  let totalRevenue = 0;
  let totalCost = 0;
  let estimateCount = 0;
  let unknownCount = 0;

  for (const it of saleItems || []) {
    if (!relevantIds.has(it.sale_id)) continue;
    const netRevenue = num(it.line_total);
    const c = costById.get(String(it.id)) || { unitCost: 0, isEstimate: true, unknown: true };
    const qty = num(it.quantity);
    const lineCost = c.unknown ? 0 : num(c.unitCost) * qty;

    totalRevenue += netRevenue;
    if (!c.unknown) totalCost += lineCost;
    if (c.unknown) unknownCount += 1;
    else if (c.isEstimate) estimateCount += 1;

    const key = String(it.product_id);
    let p = byProduct.get(key);
    if (!p) {
      p = {
        product_id: key,
        name: it.product_name_snapshot,
        image_url: it.image_url_snapshot,
        quantity: 0,
        net_revenue: 0,
        total_cost: 0,
        gross_profit: 0,
        estimate: false,
        unknown: false,
      };
      byProduct.set(key, p);
    }
    p.quantity += qty;
    p.net_revenue += netRevenue;
    if (!c.unknown) p.total_cost += lineCost;
    p.gross_profit = p.net_revenue - p.total_cost;
    if (c.isEstimate) p.estimate = true;
    if (c.unknown) p.unknown = true;
  }

  const products = [...byProduct.values()]
    .map((p: any) => ({
      ...p,
      margin: p.net_revenue > 0 ? (p.gross_profit / p.net_revenue) * 100 : 0,
    }))
    .sort((a: any, b: any) => b.net_revenue - a.net_revenue);

  const grossProfit = totalRevenue - totalCost;
  return {
    summary: {
      net_revenue: Math.round(totalRevenue),
      cost_of_goods: Math.round(totalCost),
      gross_profit: Math.round(grossProfit),
      margin: totalRevenue > 0 ? Math.round((grossProfit / totalRevenue) * 10000) / 100 : 0,
      estimate_count: estimateCount,
      unknown_count: unknownCount,
    },
    products,
  };
}

// ---- SDK-backed loaders (take `service` = base44.asServiceRole) ----

// Weighted-average cost per base unit for every ingredient, from non-cancelled receipts.
export async function loadIngredientCosts(
  service: any,
): Promise<Map<string, { cost: number; hasPrice: boolean }>> {
  const receipts = await service.entities.SupplierReceipt.list("-received_at", 500);
  const validIds = new Set(
    (receipts || [])
      .filter((r: any) => r.status !== "cancelled" && r.status !== "cancelling")
      .map((r: any) => r.id),
  );
  const items = await service.entities.SupplierReceiptItem.list("-created_date", 1000);
  const byIngredient = new Map<string, any[]>();
  for (const it of items || []) {
    if (!validIds.has(it.receipt_id)) continue;
    const key = String(it.ingredient_id);
    if (!byIngredient.has(key)) byIngredient.set(key, []);
    byIngredient.get(key)!.push(it);
  }
  const result = new Map<string, { cost: number; hasPrice: boolean }>();
  for (const [id, lines] of byIngredient.entries()) {
    result.set(id, weightedAvgIngredientCost(lines));
  }
  return result;
}

// Per-piece production cost for a product from its active Tech Card + ingredient costs.
export async function computeProductCost(
  service: any,
  productId: string,
  ingredientCosts: Map<string, any>,
): Promise<{
  costPerPiece: number;
  hasPrice: boolean;
  missing: string[];
  outputUnit: string;
}> {
  const recipes = await service.entities.Recipe.filter({ product_id: productId, active: true });
  const recipe = (recipes || [])[0];
  if (!recipe) return { costPerPiece: 0, hasPrice: false, missing: [], outputUnit: "piece" };
  const items = await service.entities.RecipeItem.filter({ recipe_id: recipe.id });
  const { batchCost, missing, hasAllPrices } = recipeCostFromMap(items || [], ingredientCosts);
  const product = await service.entities.Product.get(productId).catch(() => null);
  const outputUnit = String(recipe.output_unit || product?.production_unit || "piece");
  const perPiece = costPerPiece(
    batchCost,
    num(recipe.output_quantity),
    outputUnit,
    num(product?.pieces_per_sheet) || 20,
  );
  return {
    costPerPiece: perPiece,
    hasPrice: hasAllPrices && (items || []).length > 0,
    missing,
    outputUnit,
  };
}