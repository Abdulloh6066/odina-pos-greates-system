// Read-only reporting inputs. No mutations, integrations, or live-client creation.
// The authenticated caller supplies its service client; tests supply memory mocks.
export const reportDate = (value: unknown): string => {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms + 5 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
};

export function reportRange(from: string, to: string) {
  const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(date + "T00:00:00Z"))
    && new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date;
  if (!valid(from) || !valid(to)) throw new Error("Hisobot sanasi noto‘g‘ri.");
  const first = from <= to ? from : to;
  const last = from <= to ? to : from;
  return { from: first, to: last,
    start: new Date(first + "T00:00:00+05:00").toISOString(),
    end: new Date(Date.parse(last + "T00:00:00+05:00") + 86400000).toISOString(),
  };
}

export async function readReportRows(entity: any, query: any = {}, sort = "id"): Promise<any[]> {
  if (!entity?.filter) throw new Error("Hisobot ma’lumot manbasi mavjud emas.");
  const result: any[] = [];
  const seen = new Set<string>();
  for (let skip = 0; skip < 10000; skip += 500) {
    const rows = await entity.filter(query, sort, 500, skip);
    if (!Array.isArray(rows)) throw new Error("Hisobot javobi noto‘g‘ri.");
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) throw new Error("Hisobot sahifalari takrorlandi. To‘liq bo‘lmagan natija ko‘rsatilmaydi.");
      seen.add(row.id); result.push(row);
    }
    if (rows.length < 500) return result;
  }
  throw new Error("Hisobot juda katta. Sana oralig‘ini qisqartiring; to‘liq bo‘lmagan jami ko‘rsatilmaydi.");
}

export async function loadReportActivity(service: any, from: string, to: string, shopIds: string[] = []) {
  const range = reportRange(from, to);
  const shop = shopIds.length ? { shop_id: { $in: shopIds } } : {};
  const timestamps = { $gte: range.start, $lt: range.end };
  const [sales, rawRefunds, orderPayments, expenses] = await Promise.all([
    readReportRows(service.entities.Sale, { ...shop, business_date: { $gte: range.from, $lte: range.to } }),
    readReportRows(service.entities.Refund, { ...shop, created_at: timestamps }),
    readReportRows(service.entities.OrderPayment, { ...shop, status: "completed", paid_at: timestamps }),
    readReportRows(service.entities.CashMovement, { ...shop, type: "withdrawal", created_at: timestamps,
      expense_category: { $in: ["shop_expense", "other_expense", "other"] } }),
  ]);
  const saleMap = new Map<string, any>(sales.map((sale: any) => [sale.id, sale]));
  const missingIds = [...new Set<string>(rawRefunds.map((row: any) => String(row.sale_id || "")))]
    .filter(id => id && !saleMap.has(id));
  for (let start = 0; start < missingIds.length; start += 200) {
    const originals = await readReportRows(service.entities.Sale, { id: { $in: missingIds.slice(start, start + 200) } });
    for (const sale of originals) saleMap.set(sale.id, sale);
  }
  const refunds = rawRefunds.filter((refund: any) => {
    const original = saleMap.get(refund.sale_id);
    if (!original) throw new Error("Qaytarilgan savdoning asl yozuvi topilmadi. Hisobotni tekshiring.");
    // A Refund can be written just before its sale is claimed. Do not count a
    // still-processing or rolled-back refund as completed financial activity.
    return original.status === "refunded" && original.shop_id === refund.shop_id
      && (!original.refund_id || original.refund_id === refund.id);
  });
  const ids = [...saleMap.keys()];
  const items: any[] = [];
  for (let start = 0; start < ids.length; start += 200) {
    items.push(...await readReportRows(service.entities.SaleItem, { sale_id: { $in: ids.slice(start, start + 200) } }));
  }
  const itemsBySale = new Map<string, any[]>();
  for (const item of items) {
    if (!itemsBySale.has(item.sale_id)) itemsBySale.set(item.sale_id, []);
    itemsBySale.get(item.sale_id)!.push(item);
  }
  return { ...range, sales, refunds, orderPayments, expenses, allSales: [...saleMap.values()], items, itemsBySale };
}
