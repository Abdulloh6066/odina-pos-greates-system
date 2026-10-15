import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";

// Diagnostics are append-only and independent of every financial mutation.
// Service-role writes need admin RLS access; workers never receive entity rows.
const OUTCOMES = new Set(["confirmed", "rechecked", "queued", "unconfirmed"]);
const KEY_PATTERN = /^[A-Za-z0-9:_-]{16,128}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_MS = 86_400_000;
const MAX_SCAN = 250_000;
const FIELDS = ["id", "event_id", "actor_id", "actor_name", "shop_id", "shop_name", "shift_id", "sale_id", "sale_number",
  "request_key", "total_ms", "api_round_trip_ms", "outcome", "client_completed_at", "received_at", "source"];

const problem = (message: string, status = 400) => Object.assign(new Error(message), { status, publicMessage: true });
function id(value: unknown, label: string, optional = false) {
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw problem(`${label} noto‘g‘ri.`);
  return value;
}
function key(value: unknown, label: string) {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) throw problem(`${label} noto‘g‘ri.`);
  return value;
}
function iso(value: unknown) {
  if (typeof value !== "string" || value.length > 30) throw problem("Urinish vaqti noto‘g‘ri.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw problem("Urinish vaqti noto‘g‘ri.");
  return value;
}
function duration(value: unknown, optional = false) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MS || (!optional && !Number.isInteger(value))) {
    throw problem("Yakunlash davomiyligi noto‘g‘ri.");
  }
  return value;
}
function recordInput(body: any) {
  const outcome = body.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) throw problem("Urinish natijasi noto‘g‘ri.");
  const saleId = id(body.sale_id, "Savdo", true);
  if (["queued", "unconfirmed"].includes(outcome) && saleId) throw problem("Tasdiqlanmagan urinish savdo tasdig‘i sifatida yuborilmaydi.");
  return {
    event_id: key(body.event_id, "Urinish kaliti"), shift_id: id(body.shift_id, "Smena"),
    request_key: key(body.request_key, "Savdo so‘rovi kaliti"), sale_id: saleId,
    total_ms: duration(body.total_ms), api_round_trip_ms: duration(body.api_round_trip_ms, true),
    outcome, client_completed_at: iso(body.client_completed_at),
  };
}
function sameInput(row: any, input: any, actorId: string, shopId: string) {
  return row.actor_id === actorId && row.shop_id === shopId && row.event_id === input.event_id
    && row.shift_id === input.shift_id && row.request_key === input.request_key
    && row.total_ms === input.total_ms && (row.api_round_trip_ms ?? null) === (input.api_round_trip_ms ?? null)
    && row.outcome === input.outcome && row.client_completed_at === input.client_completed_at
    && (!input.sale_id || row.sale_id === input.sale_id)
    && (["confirmed", "rechecked"].includes(input.outcome) ? Boolean(row.sale_id) : !row.sale_id)
    && row.source === "browser";
}
function ack(input: any, alreadyRecorded: boolean) {
  return { saved: true, event_id: input.event_id, already_recorded: alreadyRecorded };
}

async function record(service: any, user: any, body: any) {
  if (!["admin", "manager", "cashier"].includes(user.role)) throw problem("Yakunlash vaqtini yuborishga ruxsat yo‘q.", 403);
  const input = recordInput(body);
  const shift = await service.entities.Shift.get(input.shift_id);
  if (!shift || shift.user_id !== user.id) throw problem("Smena ushbu xodimga tegishli emas.", 403);
  if (["cashier", "manager"].includes(user.role) && (!user.shop_id || user.shop_id !== shift.shop_id)) {
    throw problem("Smena biriktirilgan do‘konga mos emas.", 403);
  }
  const shop = await service.entities.Shop.get(shift.shop_id);
  if (!shop || shop.active === false || shop.allows_pos === false || shop.location_type === "production") {
    throw problem("Smena do‘koni faol kassa emas.", 403);
  }
  const query = { actor_id: user.id, event_id: input.event_id };
  const existing = await service.entities.CheckoutTiming.filter(query, "received_at", 100);
  if (existing.length) {
    if (!existing.every((row: any) => sameInput(row, input, user.id, shop.id))) throw problem("Urinish kaliti boshqa ma’lumotlar bilan yuborilgan.", 409);
    return ack(input, true);
  }

  let sale: any = null;
  if (["confirmed", "rechecked"].includes(input.outcome)) {
    if (input.sale_id) sale = await service.entities.Sale.get(input.sale_id);
    else {
      const matches = await service.entities.Sale.filter({ idempotency_key: input.request_key,
        user_id: user.id, shift_id: shift.id, shop_id: shop.id }, "created_date", 2);
      if (matches.length === 1) sale = matches[0];
    }
    const version = Number(sale?.financial_records_version || 0);
    // A delayed first upload may arrive after a refund. A v3 completion marker
    // still proves that original checkout; recording its duration does not
    // change the refund or claim that this sale is currently paid. Legacy
    // refunds have no such marker, so require completed status for those rows.
    const completedStatus = sale?.status === "completed" || (sale?.status === "refunded" && version >= 3);
    if (!sale || sale.user_id !== user.id || sale.shift_id !== shift.id || sale.shop_id !== shop.id
      || sale.idempotency_key !== input.request_key || !completedStatus) {
      throw problem("Savdo tasdig‘i ushbu xodim, smena va so‘rovga mos emas.", 409);
    }
    if (version >= 3
      && !(shift.sale_request_keys || []).includes(`sale-completed:${input.request_key}`)) {
      throw problem("Savdoning moliyaviy yozuvlari hali tasdiqlanmagan.", 409);
    }
  }
  const data = {
    event_id: input.event_id, actor_id: user.id, actor_name: String(user.full_name || user.email || "Xodim").slice(0, 200),
    shop_id: shop.id, shop_name: String(shop.name || shift.shop_name || "Do‘kon").slice(0, 200), shift_id: shift.id,
    sale_id: sale?.id || "", sale_number: String(sale?.sale_number || "").slice(0, 200), request_key: input.request_key,
    total_ms: input.total_ms, ...(input.api_round_trip_ms === undefined ? {} : { api_round_trip_ms: input.api_round_trip_ms }),
    outcome: input.outcome, client_completed_at: input.client_completed_at, received_at: new Date().toISOString(), source: "browser",
  };
  try { await service.entities.CheckoutTiming.create(data); }
  catch {
    // A saved diagnostic whose response was lost needs only an acknowledgment.
    // No financial idempotency marker or business record is ever changed here.
    const saved = await service.entities.CheckoutTiming.filter(query, "received_at", 100);
    if (saved.length && saved.every((row: any) => sameInput(row, input, user.id, shop.id))) return ack(input, true);
    if (saved.length) throw problem("Urinish kaliti boshqa ma’lumotlar bilan yuborilgan.", 409);
    throw problem("Yakunlash vaqtini hozir saqlab bo‘lmadi.", 503);
  }
  return ack(input, false);
}

function dateBoundary(value: unknown, label: string) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw problem(`${label} noto‘g‘ri.`);
  const time = Date.parse(`${value}T00:00:00+05:00`);
  if (!Number.isFinite(time) || new Date(time + 5 * 60 * 60 * 1000).toISOString().slice(0, 10) !== value) throw problem(`${label} noto‘g‘ri.`);
  return { key: value, time };
}
function pageInteger(value: unknown, defaultValue: number, min: number, max: number) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw problem("Sahifa chegarasi noto‘g‘ri.");
  return value;
}
async function list(service: any, user: any, body: any) {
  // Check the stored role before any timing query, including malformed filters.
  if (user.role !== "admin") throw problem("Yakunlash vaqtlari faqat egasi uchun ochiq.", 403);
  const limit = pageInteger(body.limit, 50, 1, 100);
  const skip = pageInteger(body.skip, 0, 0, 100_000);
  const query: any = { source: "browser" };
  for (const [input, field, label] of [["shop_id", "shop_id", "Do‘kon"], ["user_id", "actor_id", "Xodim"], ["shift_id", "shift_id", "Smena"]]) {
    const value = id(body[input], label, true);
    if (value) query[field] = value;
  }
  if (body.outcome !== undefined && body.outcome !== "") {
    if (typeof body.outcome !== "string" || !OUTCOMES.has(body.outcome)) throw problem("Urinish natijasi filtri noto‘g‘ri.");
    query.outcome = body.outcome;
  }
  const from = dateBoundary(body.from_date, "Boshlanish sanasi");
  const to = dateBoundary(body.to_date, "Tugash sanasi");
  if (from && to && from.key > to.key) throw problem("Sana oralig‘i noto‘g‘ri.");
  if (from || to) query.received_at = {
    ...(from ? { $gte: new Date(from.time).toISOString() } : {}),
    ...(to ? { $lt: new Date(to.time + 24 * 60 * 60 * 1000).toISOString() } : {}),
  };

  // Filter on the server and page unique events rather than raw rows, so an
  // overlapping upload cannot surface twice at a page boundary. No deletions.
  const unique: any[] = [];
  const seen = new Set<string>();
  const target = skip + limit + 1;
  let scanned = 0;
  while (unique.length < target && scanned < MAX_SCAN) {
    const take = Math.min(1000, Math.max(limit + 1, target - unique.length), MAX_SCAN - scanned);
    const rows = await service.entities.CheckoutTiming.filter(query, "-received_at", take, scanned);
    for (const row of rows) {
      const eventKey = JSON.stringify([row.actor_id, row.event_id]);
      if (seen.has(eventKey)) continue;
      seen.add(eventKey);
      unique.push(row);
    }
    scanned += rows.length;
    if (rows.length < take) break;
  }
  if (scanned >= MAX_SCAN && unique.length < target) throw problem("Yozuvlar juda ko‘p. Do‘kon, xodim yoki sana filtrini toraytiring.", 503);
  const records = unique.slice(skip, skip + limit).map(row => Object.fromEntries(FIELDS
    .filter(field => row[field] !== undefined).map(field => [field, row[field]])));
  const hasMore = unique.length > skip + limit;
  return { records, has_more: hasMore, next_skip: hasMore ? skip + records.length : null };
}

export default async function(req: Request) {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth) throw problem("Tizimga kirish talab qilinadi.", 401);
    const service = client.asServiceRole;
    let user: any;
    try { user = await resolveAppUser(service, auth); }
    catch (error) {
      if (Number((error as any)?.status) === 403) throw problem("Faol xodim ruxsati topilmadi.", 403);
      throw error;
    }
    if (user.role !== "admin" && !["cashier", "manager"].includes(user.role)) throw problem("Bu amal uchun ruxsat yo‘q.", 403);
    let body: any;
    try { body = await req.json(); } catch { throw problem("So‘rov noto‘g‘ri."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw problem("So‘rov noto‘g‘ri.");
    if (body.action === "record") return Response.json(await record(service, user, body));
    if (body.action === "list") return Response.json(await list(service, user, body));
    throw problem("Noto‘g‘ri amal.");
  } catch (error) {
    const status = Number((error as any)?.status);
    if ((error as any)?.publicMessage) {
      return Response.json({ error: (error as Error).message }, { status: status || 400 });
    }
    return Response.json({ error: "Yakunlash vaqti xizmati vaqtincha ishlamayapti." }, { status: 503 });
  }
}
