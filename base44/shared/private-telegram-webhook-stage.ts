// STAGED ONLY: not imported by the current telegram-webhook, not a deployed endpoint.
// The existing webhook and Telegram's setWebhook configuration remain untouched.
// Future integration MUST verify X-Telegram-Bot-Api-Secret-Token before calling this.
// Owner binding: TELEGRAM_OWNER_USER_ID must be set by the authenticated owner in
// Base44 Secrets after independently verifying their numeric Telegram ID.
// NEVER claim the first /start sender as owner, trust usernames, or send to groups.
import { approvedOwnerId, routePrivateReport, reportShops, renderPrivateReport } from "./private-telegram-report-logic.ts";

type Dependencies = {
  ownerId: unknown;
  service: any;
  now: number;
};
type Reply =
  | { kind: "ignore" }
  | { kind: "message"; chatId: string; text: string; replyMarkup?: any; callbackId?: string };

// Authenticate BEFORE any service-role database read, including the shop list.
// Telegram user IDs, not phone numbers or usernames, identify the owner.
function isOwnerPrivate(update: any, rawOwner: unknown): boolean {
  const owner = approvedOwnerId(rawOwner);
  if (!owner) return false;
  const cb = update?.callback_query;
  const msg = cb ? cb.message : update?.message;
  const sender = cb ? cb.from : msg?.from;
  return msg?.chat?.type === "private"
    && String(msg?.chat?.id ?? "") === owner
    && String(sender?.id ?? "") === owner
    && sender?.is_bot !== true;
}

async function readAll(entity: any, query: any = {}): Promise<any[]> {
  const result: any[] = [];
  for (let skip = 0; skip < 10000; skip += 500) {
    const page = await entity.filter(query, "id", 500, skip);
    if (!Array.isArray(page)) throw Error("Invalid report data");
    result.push(...page);
    if (page.length < 500) return result;
  }
  throw Error("Report data limit reached");
}

// Produces a reply, never performs Telegram network calls, changes settings, or
// writes business records. A separately approved integration can deliver replies.
export async function preparePrivateTelegramReply(update: any, deps: Dependencies): Promise<Reply> {
  if (!isOwnerPrivate(update, deps.ownerId)) return { kind: "ignore" };
  const cb = update?.callback_query;
  const command = cb ? String(cb.data || "") : String(update?.message?.text || "");
  if (cb ? !/^pr:(?:s|p):/.test(command) : !/^\/(?:start|hisobot)(?:@[A-Za-z0-9_]{5,32})?\s*$/i.test(command)) {
    return { kind: "ignore" };
  }
  const shops = reportShops(await readAll(deps.service.entities.Shop));
  const plan = routePrivateReport(update, deps.ownerId, shops, deps.now);
  if (plan.kind === "ignore" || plan.kind === "deny") return { kind: "ignore" };
  const callbackId = cb?.id ? String(cb.id) : undefined;
  if (plan.kind === "choose_shop") {
    return { kind: "message", chatId: plan.chatId, text: "🏪 Hisobot uchun do‘konni tanlang:", replyMarkup: plan.keyboard, callbackId };
  }
  if (plan.kind === "choose_period") {
    return { kind: "message", chatId: plan.chatId, text: "📅 Hisobot davrini tanlang:", replyMarkup: plan.keyboard, callbackId };
  }
  // The plan comes exclusively from a verified private Telegram owner update.
  // Query only the bounded business dates and selected POS shops.
  const selected = shops.filter((shop: any) => plan.shopId === "all" || shop.id === plan.shopId);
  if (!selected.length) return { kind: "ignore" };
  const sales = await readAll(deps.service.entities.Sale, {
    business_date: { $gte: plan.from, $lte: plan.to },
    shop_id: { $in: selected.map((shop: any) => shop.id) },
  });
  const ids = sales.map((sale: any) => sale.id).filter(Boolean);
  const saleItems = ids.length ? await readAll(deps.service.entities.SaleItem, { sale_id: { $in: ids } }) : [];
  return { kind: "message", chatId: plan.chatId, text: renderPrivateReport(plan, shops, sales, saleItems), callbackId };
}
