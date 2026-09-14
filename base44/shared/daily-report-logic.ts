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
};

// Aggregates a shop's sales for one business date into revenue, cost-of-goods,
// real profit (revenue - cost) and a payment-method breakdown. Refunded sales
// are subtracted (their payments and costs are reversed too).
export function computeShopReport(
  sales: any[],
  saleItemsBySaleId: Map<string, any[]>,
): ReportMetrics {
  let revenue = 0;
  let cost = 0;
  let saleCount = 0;
  let refundCount = 0;
  const payments: Record<string, number> = {
    cash: 0,
    uzcard: 0,
    humo: 0,
    online: 0,
    bank_transfer: 0,
  };

  for (const sale of sales) {
    const sign = sale.status === "refunded" ? -1 : 1;
    revenue += Number(sale.total || 0) * sign;
    if (sale.status === "refunded") refundCount += 1;
    else saleCount += 1;

    const items = saleItemsBySaleId.get(sale.id) || [];
    for (const it of items) cost += Number(it.total_cost_at_sale || 0) * sign;

    for (const p of sale.payments || []) {
      const amt = Number(p.amount || 0) * sign;
      const method = String(p.method || "");
      if (method === "cash") payments.cash += amt;
      else if (method === "uzcard") payments.uzcard += amt;
      else if (method === "humo") payments.humo += amt;
      else if (method === "bank_transfer") payments.bank_transfer += amt;
      else if (method === "click" || method === "payme" || method === "other")
        payments.online += amt;
    }
  }

  return {
    revenue,
    cost,
    realProfit: revenue - cost,
    saleCount,
    refundCount,
    cash: payments.cash,
    uzcard: payments.uzcard,
    humo: payments.humo,
    online: payments.online,
    bank_transfer: payments.bank_transfer,
  };
}

function csvCell(v: any): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const REPORT_HEADERS = [
  "Sana",
  "Do'kon",
  "Tushum (UZS)",
  "Tannarx (UZS)",
  "Real foyda (UZS)",
  "Sotuv soni",
  "Qaytar soni",
  "Naqd",
  "Uzcard",
  "Humo",
  "Online",
  "Bank",
  "Yuborildi",
  "Yuborilgan vaqt",
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
  ];
}

export function reportsToCsv(reports: any[]): string {
  const lines = [REPORT_HEADERS, ...reports.map((r) => reportToRow(r))];
  return lines.map((cols) => cols.map(csvCell).join(",")).join("\n");
}