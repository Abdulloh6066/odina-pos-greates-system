import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";
import {
  loadIngredientCosts, computeProductCost, aggregateReport, num,
} from "../../shared/cost-engine.ts";
import { loadReportActivity, readReportRows, reportDate } from "../../shared/report-activity.ts";
import { computeShopReport } from "../../shared/daily-report-logic.ts";

// Recorded shop expenses only — goods_payment is already in cost of goods,
// owner_withdrawal is a capital distribution, not an operating expense.
const EXPENSE_CATEGORIES = new Set(["shop_expense", "other_expense", "other"]);

function tashkentBusinessDate(value: unknown) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function saleBusinessDate(sale: any) {
  return String(sale?.business_date || "")
    || tashkentBusinessDate(sale?.sold_at || sale?.created_date);
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) return Response.json({ error: "Tizimga kirish kerak." }, { status: 401 });
    const service = base44.asServiceRole;
    const user = await resolveAppUser(service, authenticatedUser);
    const role = user.role;
    const managerShopId = role === "manager" ? String(user.shop_id || user.data?.shop_id || "") : "";
    if (role !== "admin" && role !== "accountant" && !managerShopId) {
      return Response.json(
        { error: "Tannarx va foyda hisoboti faqat egasi, hisobchi va do‘kon boshqaruvchisi uchun." },
        { status: 403 },
      );
    }
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "So‘rov noto‘g‘ri." }, { status: 400 });
    }
    // A manager's report is always limited to his own shop.
    if (managerShopId && body && typeof body === "object") body.shop_id = managerShopId;
    const action = String(body?.action || "report");
    const today = reportDate(new Date().toISOString());
    const dateFrom = String(body?.date_from || `${today.slice(0, 7)}-01`);
    const dateTo = String(body?.date_to || today);
    const shopId = managerShopId || String(body?.shop_id || "");
    const productId = String(body?.product_id || "");
    const categoryId = String(body?.category_id || "");

    let ingredientCosts: Map<string, any> | null = null;

    if (action === "product_breakdown") {
      ingredientCosts = await loadIngredientCosts(service).catch(() => new Map());
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

    // Read complete activity for this date range. Refunds are read on their own
    // date, including their original sale-time costs when the sale was earlier.
    const activity = await loadReportActivity(service, dateFrom, dateTo, shopId ? [shopId] : []);
    const filtered = activity.sales.filter((s: any) => ["completed", "refunded"].includes(s.status))
      .map((s: any) => ({ ...s, status: "completed" }));
    let items: any[] = filtered.flatMap((s: any) => activity.itemsBySale.get(s.id) || []);
    const originalById = new Map<string, any>(activity.allSales.map((s: any) => [s.id, s]));
    for (const refund of activity.refunds) {
      const original = originalById.get(refund.sale_id);
      const ratio = num(original?.total) > 0 ? Math.min(1, num(refund.amount) / num(original.total)) : 1;
      const virtualId = `refund:${refund.id}`;
      filtered.push({ ...original, id: virtualId, status: "completed", total: -num(refund.amount) });
      for (const item of activity.itemsBySale.get(refund.sale_id) || []) {
        // Read-only signed view: original immutable records are never updated.
        items.push({ ...item, id: `${item.id}:${virtualId}`, sale_id: virtualId,
          quantity: -num(item.quantity) * ratio, line_total: -num(item.line_total) * ratio });
      }
    }
    const incompleteSaleCount = filtered.filter((s: any) => num(s.total) !== 0
      && !items.some((it: any) => it.sale_id === s.id)).length;
    const products = categoryId ? await readReportRows(service.entities.Product) : [];
    const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]));
    if (productId) items = items.filter((it: any) => it.product_id === productId);
    if (categoryId) {
      items = items.filter((it: any) => String(productMap.get(it.product_id)?.category_id || "") === categoryId);
    }

    // Resolve cost per sale item: immutable snapshot when present, else a current estimate.
    const costCache = new Map<string, any>();
    const costById = new Map<string, any>();
    for (const it of items) {
      const snap = Number(it.unit_cost_at_sale);
      if (Number.isFinite(snap) && snap >= 0 && it.cost_is_estimate === false) {
        costById.set(String(it.id), { unitCost: snap, isEstimate: false, unknown: false });
        continue;
      }
      if (it.sale_unit === "gram") {
        costById.set(String(it.id), { unitCost: 0, isEstimate: true, unknown: true });
        continue; // A per-piece recipe price must never be multiplied by grams.
      }
      if (!ingredientCosts) ingredientCosts = await loadIngredientCosts(service).catch(() => new Map());
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

    const expenses = activity.expenses.filter((m: any) => EXPENSE_CATEGORIES.has(m.expense_category));
    const cashflow = computeShopReport(activity.sales, activity.itemsBySale, {
      refunds: activity.refunds, orderPayments: activity.orderPayments, expenses: activity.expenses, allSales: activity.allSales,
    });
    const expensesTotal = Math.round(expenses.reduce((s: number, m: any) => s + num(m.amount), 0));

    const netRevenue = !productId && !categoryId ? cashflow.revenue : report.summary.net_revenue;
    const grossProfit = netRevenue - report.summary.cost_of_goods;
    const summary = {
      ...report.summary,
      net_revenue: netRevenue,
      gross_profit: grossProfit,
      margin: netRevenue > 0 ? Math.round(grossProfit / netRevenue * 10000) / 100 : 0,
      unknown_count: report.summary.unknown_count + incompleteSaleCount,
      expenses: expensesTotal,
      net_profit: grossProfit - expensesTotal,
      order_payment_total: cashflow.orderPayments,
      collections_total: cashflow.collections,
      incomplete_sale_count: incompleteSaleCount,
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
      { status: Number((error as any)?.status || 500) },
    );
  }
}
