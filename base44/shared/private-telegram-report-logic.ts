// DORMANT / OFFLINE-ONLY: private report protocol. Do not attach to a live webhook
// or call Telegram until the owner separately approves deployment and owner ID binding.
import { computeShopReport } from "./daily-report-logic.ts";

const PERIODS = ["today", "yesterday", "week", "month"] as const;
type Period = typeof PERIODS[number];
type Shop = { id: string; name: string; active?: boolean; allows_pos?: boolean; location_type?: string };
export type ReportPlan = { kind: "report"; chatId: string; shopId: string; period: Period; from: string; to: string };
export type ReportRoute =
  | { kind: "ignore" }
  | { kind: "deny"; chatId: string }
  | { kind: "choose_shop"; chatId: string; keyboard: any }
  | { kind: "choose_period"; chatId: string; shopId: string; keyboard: any }
  | ReportPlan;

// Server must provide a verified, explicitly configured numeric Telegram user ID.
// Never authorize via Telegram username, group membership or chat title.
export function approvedOwnerId(raw: unknown): string | null {
  const id = String(raw ?? "").trim();
  return /^[1-9][0-9]{0,19}$/.test(id) ? id : null;
}

export function reportShops(shops: Shop[]): Shop[] {
  return shops.filter(s => s.active !== false && s.allows_pos === true && s.location_type === "shop"
    && /^[A-Za-z0-9_-]{1,40}$/.test(String(s.id || "")));
}

function dateAtUzbekistan(now: number): Date { return new Date(now + 5 * 60 * 60 * 1000); }
function iso(date: Date): string { return date.toISOString().slice(0, 10); }
export function periodDates(period: Period, now: number): { from: string; to: string } {
  const local = dateAtUzbekistan(now);
  const end = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const start = new Date(end);
  if (period === "yesterday") { start.setUTCDate(start.getUTCDate() - 1); end.setUTCDate(end.getUTCDate() - 1); }
  if (period === "week") start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (period === "month") start.setUTCDate(1);
  return { from: iso(start), to: iso(end) };
}

function keyboard(rows: { text: string; callback_data: string }[][]) {
  return { inline_keyboard: rows };
}

export function routePrivateReport(update: any, configuredOwnerId: unknown, allShops: Shop[], now: number): ReportRoute {
  const owner = approvedOwnerId(configuredOwnerId);
  // Fail closed before using any private data when owner binding is absent.
  if (!owner) return { kind: "ignore" };
  const cb = update?.callback_query;
  const msg = cb ? cb.message : update?.message;
  const sender = cb ? cb.from : msg?.from;
  const chat = msg?.chat;
  const chatId = String(chat?.id ?? "");
  const senderId = String(sender?.id ?? "");
  // No response in groups, channels or supergroups, even for the owner.
  if (chat?.type !== "private" || !chatId || !senderId) return { kind: "ignore" };
  if (senderId !== owner || chatId !== owner || sender?.is_bot === true) return { kind: "deny", chatId };
  const shops = reportShops(allShops);
  if (cb) {
    const data = String(cb.data || "");
    const chooseShop = /^pr:s:([A-Za-z0-9_-]{1,40}|all)$/.exec(data);
    if (chooseShop) {
      const shopId = chooseShop[1];
      if (shopId !== "all" && !shops.some(s => s.id === shopId)) return { kind: "ignore" };
      return { kind: "choose_period", chatId, shopId, keyboard: keyboard([
        [{ text: "Bugun", callback_data: `pr:p:${shopId}:today` }, { text: "Kecha", callback_data: `pr:p:${shopId}:yesterday` }],
        [{ text: "Hafta", callback_data: `pr:p:${shopId}:week` }, { text: "Oy", callback_data: `pr:p:${shopId}:month` }],
      ]) };
    }
    const choosePeriod = /^pr:p:([A-Za-z0-9_-]{1,40}|all):(today|yesterday|week|month)$/.exec(data);
    if (choosePeriod) {
      const shopId = choosePeriod[1];
      if (shopId !== "all" && !shops.some(s => s.id === shopId)) return { kind: "ignore" };
      const period = choosePeriod[2] as Period;
      return { kind: "report", chatId, shopId, period, ...periodDates(period, now) };
    }
    return { kind: "ignore" };
  }
  if (!/^\/(?:hisobot|start)(?:@[A-Za-z0-9_]{5,32})?\s*$/i.test(String(msg?.text || ""))) return { kind: "ignore" };
  return { kind: "choose_shop", chatId, keyboard: keyboard([
    ...shops.map(s => [{ text: s.name.slice(0, 50), callback_data: `pr:s:${s.id}` }]),
    [{ text: "Ikkala do‘kon", callback_data: "pr:s:all" }],
  ]) };
}

const clean = (value: unknown): string => String(value ?? "").replace(/[\r\n\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 70);
const uzs = (value: number) => `${Math.round(value).toLocaleString("en-US")} so‘m`;

// Caller must query Sale by business_date within plan.from/to, and SaleItem for
// returned sale IDs; this function repeats both date and shop filters defensively.
// The report is read-only and never sends messages or queries live data itself.
export function renderPrivateReport(plan: ReportPlan, allShops: Shop[], sales: any[], saleItems: any[], activity: any = {}): string {
  const shops = reportShops(allShops).filter(s => plan.shopId === "all" || s.id === plan.shopId);
  if (!shops.length) return "Do‘kon topilmadi.";
  const eligible = sales.filter(s => s.business_date >= plan.from && s.business_date <= plan.to && shops.some(shop => shop.id === s.shop_id));
  const originalSales = (activity.allSales || sales).filter((s: any) => shops.some(shop => shop.id === s.shop_id));
  const saleIds = new Set(originalSales.map((s: any) => s.id));
  const withinPeriod = (value: unknown) => {
    const ms = Date.parse(String(value || ''));
    const date = Number.isFinite(ms) ? new Date(ms + 5 * 60 * 60 * 1000).toISOString().slice(0, 10) : '';
    return date >= plan.from && date <= plan.to;
  };
  const bySale = new Map<string, any[]>();
  for (const item of saleItems) {
    if (!saleIds.has(item.sale_id)) continue;
    if (!bySale.has(item.sale_id)) bySale.set(item.sale_id, []);
    bySale.get(item.sale_id)!.push(item);
  }
  const lines = [`📊 Odina hisobot · ${plan.from} — ${plan.to}`];
  const totals = { revenue: 0, cost: 0, saleCount: 0, refundCount: 0, cash: 0, uzcard: 0, humo: 0, online: 0, bank_transfer: 0, collections: 0 };
  for (const shop of shops) {
    const metrics = computeShopReport(eligible.filter(s => s.shop_id === shop.id), bySale, {
      allSales: originalSales,
      refunds: activity.refunds?.filter((r: any) => r.shop_id === shop.id && withinPeriod(r.created_at || r.created_date)),
      orderPayments: (activity.orderPayments || []).filter((r: any) => r.shop_id === shop.id && withinPeriod(r.paid_at)),
      expenses: (activity.expenses || []).filter((r: any) => r.shop_id === shop.id && withinPeriod(r.created_at || r.created_date)),
    });
    lines.push("", `🏪 ${clean(shop.name)}`, `Tushum: ${uzs(metrics.collections)}`,
      `Kassa sof savdo: ${uzs(metrics.revenue)} · Buyurtma to‘lovlari: ${uzs(metrics.orderPayments)}`,
      `Savdolar: ${metrics.saleCount} · Qaytarishlar: ${metrics.refundCount}`,
      `Naqd: ${uzs(metrics.cash)} · Bank card/Uzcard: ${uzs(metrics.uzcard)}`, `Humo (old): ${uzs(metrics.humo)} · Online: ${uzs(metrics.online)} · Bank: ${uzs(metrics.bank_transfer)}`,
      `Kassa yalpi foydasi${metrics.unknownCostCount ? ' (taxminiy)' : ''}: ${uzs(metrics.realProfit)}`,
      `Do‘kon xarajatlari: ${uzs(metrics.expenses)}`);
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += metrics[key];
  }
  if (shops.length > 1) lines.push("", `JAMI: ${uzs(totals.collections)} · ${totals.saleCount} ta savdo`);
  lines.push("", "Izoh: buyurtma avansi va qoldig‘i olingan kunida tushumga kiradi, Kassa foydasiga qo‘shilmaydi. Bu sof foyda emas; noma’lum tannarx bo‘lsa natija taxminiy.");
  return lines.join("\n");
}
