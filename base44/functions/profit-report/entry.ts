import { createClientFromRequest } from "npm:@base44/sdk";
import {
  loadIngredientCosts, computeProductCost, aggregateReport, num,
} from "../../shared/cost-engine.ts";

// Recorded shop expenses only — goods_payment is already in cost of goods,
// owner_withdrawal is a capital distribution, not an operating expense.
const EXPENSE_CATEGORIES = new Set(["shop_expense", "other_expense"]);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Tizimga kirish kerak." }, { status: 401 });
    const role = String(user.role || user?.data?.role || "");
    if (role !== "admin" && role !== "accountant") {
      return Response.json(
        { error: "Tannarx va foyda hisoboti faqat egasi va hisobchi uchun." },
        { status: 403 },
      );
    }
    const service = base44.asServiceRole;
    const body = await req.json();
    const action = String(body?.action || "report");
    const dateFrom = String(body?.date_from || "");
    const dateTo = String(body?.date_to || "");
    const shopId = String(body?.shop_id || "");
    const productId = String(body?.product_id || "");
    const categoryId = String(body?.category_id || "");

    const ingredientCosts = await loadIngredientCosts(service).catch(() => new Map());

    if (action === "product_breakdown") {
      const pid = String(body?.product_id || "");
      if (!pid) return Response.json({ error: "Mahsulot tanlanmagan." }, { status: 400 });
      const product = await service.entities.Product.get(pid).catch(() => null);
      const recipes = await service.entities.Recipe.filter({ product_id: pid, active: true });
      const recipe = (recipes || [])[0];
      const items = recipe ? await service.entities.RecipeItem.filter({ recipe_id: recipe.id }) : [];
      const rows = (items || []).map((ri: any) => {
        const ic = ingredientCosts.get(String(ri.ingredient_id)) || { cost: 0, hasPrice: false };
        const qty = num(ri.quantity);
        const lineCost = ic.hasPrice ? qty * ic.cost : 0;
        return {
          ingredient_id: ri.ingredient_id,
          ingredient_name: ri.ingredient_name_snapshot,
          quantity: qty,
          unit: ri.unit,
          cost_per_unit: ic.hasPrice ? Math.round(ic.cost * 100) / 100 : 0,
          line_cost: Math.round(lineCost),
          has_price: ic.hasPrice,
        };
      });
      const batchCost = rows.reduce((s: number, r: any) => s + r.line_cost, 0);
      const outputQty = num(recipe?.output_quantity) || 1;
      const outputUnit = String(recipe?.output_unit || product?.production_unit || "piece");
      const perOutput = outputQty > 0 ? batchCost / outputQty : 0;
      const perPiece = outputUnit === "sheet"
        ? perOutput / (num(product?.pieces_per_sheet) || 20)
        : perOutput;
      return Response.json({
        product_id: pid,
        product_name: product?.name,
        image_url: product?.image_url,
        recipe: recipe ? { output_quantity: outputQty, output_unit: outputUnit, version: recipe.version } : null,
        ingredients: rows,
        batch_cost: Math.round(batchCost),
        unit_cost_per_output: Math.round(perOutput),
        unit_cost_per_piece: Math.round(perPiece),
        has_recipe: !!recipe,
        missing: rows.filter((r: any) => !r.has_price).map((r: any) => r.ingredient_name),
      });
    }

    // ---- report ----
    const sales = await service.entities.Sale.list("-created_date", 1000);
    let filtered = (sales || []).filter((s: any) => s.status === "completed");
    if (dateFrom) filtered = filtered.filter((s: any) => String(s.created_date || "").slice(0, 10) >= dateFrom);
    if (dateTo) filtered = filtered.filter((s: any) => String(s.created_date || "").slice(0, 10) <= dateTo);
    if (shopId) filtered = filtered.filter((s: any) => s.shop_id === shopId);
    const saleIds = new Set(filtered.map((s: any) => s.id));

    const allItems = await service.entities.SaleItem.list("-created_date", 2000);
    let items = (allItems || []).filter((it: any) => saleIds.has(it.sale_id));

    const products = await service.entities.Product.list("name", 500);
    const productMap = new Map((products || []).map((p: any) => [p.id, p]));
    if (productId) items = items.filter((it: any) => it.product_id === productId);
    if (categoryId) {
      items = items.filter((it: any) => String(productMap.get(it.product_id)?.category_id || "") === categoryId);
    }

    // Resolve cost per sale item: immutable snapshot when present, else a current estimate.
    const costCache = new Map<string, any>();
    const costById = new Map<string, any>();
    for (const it of items) {
      const snap = Number(it.unit_cost_at_sale);
      if (snap > 0 && it.cost_is_estimate === false) {
        costById.set(String(it.id), { unitCost: snap, isEstimate: false, unknown: false });
        continue;
      }
      if (!costCache.has(String(it.product_id))) {
        costCache.set(
          String(it.product_id),
          await computeProductCost(service, String(it.product_id), ingredientCosts)
            .catch(() => ({ costPerPiece: 0, hasPrice: false, missing: [] })),
        );
      }
      const c = costCache.get(String(it.product_id));
      if (c.hasPrice) {
        costById.set(String(it.id), { unitCost: c.costPerPiece, isEstimate: true, unknown: false });
      } else {
        costById.set(String(it.id), { unitCost: 0, isEstimate: true, unknown: true });
      }
    }

    const report = aggregateReport(filtered, items, costById);

    // Recorded shop expenses (shop_expense + other_expense only).
    const movements = await service.entities.CashMovement.list("-created_date", 1000);
    let expenses = (movements || []).filter(
      (m: any) => m.type === "withdrawal" && EXPENSE_CATEGORIES.has(m.expense_category),
    );
    if (dateFrom) expenses = expenses.filter((m: any) => String(m.created_at || "").slice(0, 10) >= dateFrom);
    if (dateTo) expenses = expenses.filter((m: any) => String(m.created_at || "").slice(0, 10) <= dateTo);
    if (shopId) expenses = expenses.filter((m: any) => m.shop_id === shopId);
    const expensesTotal = Math.round(expenses.reduce((s: number, m: any) => s + num(m.amount), 0));

    const summary = {
      ...report.summary,
      expenses: expensesTotal,
      net_profit: report.summary.gross_profit - expensesTotal,
    };

    return Response.json({
      summary,
      products: report.products,
      expense_count: expenses.length,
      filters: { date_from: dateFrom, date_to: dateTo, shop_id: shopId, product_id: productId, category_id: categoryId },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Hisobotni tayyorlab bo‘lmadi." },
      { status: 500 },
    );
  }
}