// Pure, offline-testable computation for the daily per-shop sales export.
// No DB, no network — safe to unit-test without touching live records.

export type ReportMetrics = {
  revenue: number;
  cost: number;
  realProfit: number;
  saleCount: number;
  refundCount: number;
  cash: number;
  uzcard: number;
  humo: number;
  online: number;
  bank_transfer: number;
  grossSales: number;
  refundTotal: number;
  orderPayments: number;
  orderPaymentCount: number;
  collections: number;
  expenses: number;
  netProfit: number;
  unknownCostCount: number;
};

// Inputs are already scoped to the reporting dates and shop. Original sales
// stay positive on their sale day; separate refunds are negative on refund day.
// Customer-order payments are cash flow, NOT additional POS sale profit.
export function computeShopReport(
  sales: any[],
  saleItemsBySaleId: Map<string, any[]>,
  options: { refunds?: any[]; orderPayments?: any[]; expenses?: any[]; allSales?: any[] } = {},
): ReportMetrics {
  const num = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  let grossSales = 0;
  let refundTotal = 0;
  let cost = 0;
  let saleCount = 0;
  let unknownCostCount = 0;
  const payments: Record<string, number> = { cash: 0, uzcard: 0, humo: 0, online: 0, bank_transfer: 0 };
  const addPayment = (method: string, amount: number) => {
    const key = method === "bank_card" ? "uzcard"
      : ["click", "payme", "other"].includes(method) ? "online" : method;
    if (Object.prototype.hasOwnProperty.call(payments, key)) payments[key] += amount;
  };
  const saleMap = new Map<string, any>((options.allSales || sales).map((row: any) => [row.id, row]));
  const knownCost = (sale: any) => {
    const items = saleItemsBySaleId.get(sale.id) || [];
    if (!items.length || (sale.sale_items_count && items.length !== sale.sale_items_count)) unknownCostCount++;
    for (const item of items) {
      if (item.cost_is_estimate !== false || !Number.isFinite(Number(item.total_cost_at_sale))) unknownCostCount++;
    }
    return items.reduce((sum, item) => sum + num(item.total_cost_at_sale), 0);
  };
  for (const sale of sales) {
    if (!["completed", "refunded"].includes(sale.status)) continue;
    grossSales += num(sale.total);
    saleCount++;
    cost += knownCost(sale);
    for (const payment of sale.payments || []) addPayment(String(payment.method || ""), num(payment.amount));
  }
  // Compatibility for callers without a separately loaded refund ledger: a
  // fully refunded sale nets to zero, never minus its original selling price.
  const refunds = options.refunds ?? sales.filter(s => s.status === "refunded").map(s => ({
    sale_id: s.id, amount: s.total, payments: s.payments,
  }));
  for (const refund of refunds) {
    const original = saleMap.get(refund.sale_id);
    const amount = num(refund.amount);
    refundTotal += amount;
    const ratio = original && num(original.total) > 0 ? Math.min(1, amount / num(original.total)) : 1;
    if (original) cost -= knownCost(original) * ratio;
    else unknownCostCount++;
    const refundPayments = Array.isArray(refund.payments) ? refund.payments
      : (original?.payments || []).map((p: any) => ({ ...p, amount: num(p.amount) * ratio }));
    for (const payment of refundPayments) addPayment(String(payment.method || ""), -num(payment.amount));
  }
  const orderRows = (options.orderPayments || []).filter(row => row.status === "completed");
  const orderPayments = orderRows.reduce((sum, row) => sum + num(row.amount), 0);
  for (const row of orderRows) addPayment(String(row.payment_method || ""), num(row.amount));
  const expenses = (options.expenses || []).filter(row => row.type === "withdrawal"
    && ["shop_expense", "other_expense", "other"].includes(row.expense_category))
    .reduce((sum, row) => sum + num(row.amount), 0);
  const revenue = grossSales - refundTotal;
  return {
    revenue, cost, realProfit: revenue - cost, saleCount, refundCount: refunds.length,
    cash: payments.cash, uzcard: payments.uzcard, humo: payments.humo,
    online: payments.online, bank_transfer: payments.bank_transfer,
    grossSales, refundTotal, orderPayments, orderPaymentCount: orderRows.length,
    collections: revenue + orderPayments, expenses, netProfit: revenue - cost - expenses, unknownCostCount,
  };
}

function csvCell(v: any): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const REPORT_HEADERS = [
  "Sana",
  "Do'kon",
  "Kassa sof savdo (UZS)",
  "Kassa tannarxi (UZS)",
  "Kassa yalpi foyda (UZS)",
  "Sotuv soni",
  "Qaytar soni",
  "Naqd",
  "Bank card / Uzcard",
  "Humo (old)",
  "Online",
  "Bank",
  "Yuborildi",
  "Yuborilgan vaqt",
  "Buyurtma to‘lovlari (UZS)",
  "Jami olingan pul (UZS)",
  "Do‘kon xarajatlari (UZS)",
  "Kassa xarajatlardan keyingi natija (UZS)",
  "Noma’lum yoki taxminiy tannarx soni",
  "Do‘kon ID",
];

export function reportToRow(r: any, sentLabel?: string): any[] {
  return [
    r.business_date,
    r.shop_name,
    Math.round(r.total_revenue || 0),
    Math.round(r.total_cost || 0),
    Math.round(r.real_profit || 0),
    r.sale_count || 0,
    r.refund_count || 0,
    Math.round(r.cash_total || 0),
    Math.round(r.uzcard_total || 0),
    Math.round(r.humo_total || 0),
    Math.round(r.online_total || 0),
    Math.round(r.bank_transfer_total || 0),
    sentLabel || (r.email_sent ? "ha" : "yoq"),
    r.sent_at || "",
    Math.round(r.order_payment_total || 0),
    Math.round(r.collections_total ?? r.total_revenue ?? 0),
    Math.round(r.expenses_total || 0),
    Math.round(r.net_profit ?? r.real_profit ?? 0),
    r.unknown_cost_count || 0,
    r.shop_id || "",
  ];
}

export function reportsToCsv(reports: any[]): string {
  const lines = [REPORT_HEADERS, ...reports.map((r) => reportToRow(r))];
  return lines.map((cols) => cols.map(csvCell).join(",")).join("\n");
}