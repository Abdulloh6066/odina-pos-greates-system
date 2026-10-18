// Ingredient requisitions are intent until an authenticated receiver confirms a
// batch. Stock deltas and durable markers are committed together; interrupted
// batches resume forward instead of overwriting balances with old snapshots.
import { userLabel, userRole, userShopId } from "./user-helpers.ts";

const CREATE_ROLES = new Set(["admin", "manager", "cashier", "warehouse", "production"]);
const PURCHASE_ROLES = new Set(["admin", "manager", "warehouse"]);
const TRANSFER_RECEIVE_ROLES = new Set(["admin", "manager", "warehouse", "cashier", "production"]);
const READ_ROLES = new Set([...CREATE_ROLES, "accountant"]);
const JOURNAL = "ingredient_request_operations_json";
const CREATE_JOURNAL = "ingredient_request_creations_json";
const LEASE_MS = 120000;

const fail = (message: string, status = 400, started = false) => Object.assign(new Error(message), {
  status, request_not_started: !started, operation_pending: started,
});
const round = (n: number) => Math.round(n * 1000) / 1000;
const scalar = (v: any, zero = false) => {
  if ((typeof v !== "number" && typeof v !== "string") || String(v).trim() === ""
    || !/^\d+(\.\d{1,3})?$/.test(String(v).trim())) throw fail("Miqdorni to‘g‘ri kiriting.");
  const n = Number(v);
  if (!Number.isFinite(n) || n > 1000000 || (zero ? n < 0 : n <= 0)) throw fail("Miqdor ruxsat etilgan chegaradan tashqarida.");
  return round(n);
};
const price = (v: any) => {
  if ((typeof v !== "number" && typeof v !== "string") || !/^\d+$/.test(String(v).trim())) {
    throw fail("Kelgan mahsulotlarning birlik narxini kiriting; bepul bo‘lsa 0 yozing.");
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n > 1000000000) throw fail("Xarid narxi noto‘g‘ri.");
  return n;
};
const key = (v: any) => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/.test(v)) throw fail("Amal kaliti noto‘g‘ri. Oynani yangilang.");
  return v;
};
const clean = (v: any, max = 1000) => String(v || "").trim().slice(0, max);
const stable = (v: any): string => JSON.stringify(v, (_, x) => x && !Array.isArray(x) && typeof x === "object"
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const matches = (row: any, data: any) => row && Object.entries(data).every(([k, v]) => stable(row[k]) === stable(v));
const json = (raw: any, fallback: any = {}) => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  try { const value = JSON.parse(raw); if (!value || typeof value !== "object") throw 0; return value; }
  catch { throw fail("Saqlangan kirim ma’lumotlarini egasi tekshirishi kerak.", 409); }
};
const rawFilter = (row: any, field: string) => row[field] === undefined ? { $exists: false } : row[field];
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
  .map(b => b.toString(16).padStart(2, "0")).join("");
const get = async (entity: any, id: string) => {
  try { return await entity.get(id); }
  catch (e) { if (Number(e?.status || e?.response?.status) === 404) return null; throw e; }
};
const one = async (entity: any, query: any) => {
  const rows = await entity.filter(query, "id", 2);
  if (!Array.isArray(rows) || rows.length > 1) throw fail("Takroriy yoki noto‘g‘ri yozuv topildi. Egasi tekshirishi kerak.", 409);
  return rows[0] || null;
};
const setKnown = async (entity: any, filter: any, data: any) => {
  try {
    const r = await entity.updateMany(filter, { $set: data });
    if (r?.success && Number(r.updated) === 1) return { ...(await get(entity, filter.id)), ...data };
  } catch { /* Inspect the durable state after an uncertain reply. */ }
  const saved = await get(entity, filter.id);
  if (matches(saved, data)) return saved;
  throw fail("Ma’lumot boshqa oynada o‘zgardi. Yangilang va qayta tekshiring.", 409);
};
const ensure = async (entity: any, query: any, data: any) => {
  let saved = await one(entity, query);
  if (!saved) {
    try { saved = await entity.create(data); }
    catch (e) { saved = await one(entity, query); if (!saved) throw e; }
    const durable = await one(entity, query);
    if (!durable || durable.id !== saved.id) throw fail("Kirim yozuvini tekshirish kerak.", 409, true);
    saved = durable;
  }
  const immutable = Object.fromEntries(Object.entries(data).filter(([k]) => !["status", "debt_amount", "remaining_debt", "paid_at_receipt"].includes(k)));
  if (!matches(saved, immutable)) throw fail("Amal kaliti boshqa ma’lumot bilan qayta ishlatilgan.", 409, true);
  return saved;
};
const permission = (user: any, locationId: string) => {
  if (userRole(user) !== "admin" && (!userShopId(user) || locationId !== userShopId(user))) throw fail("Faqat biriktirilgan do‘kon uchun ruxsat berilgan.", 403);
};
const canReceive = (user: any, request: any) => (request.source_kind === "purchase" ? PURCHASE_ROLES : TRANSFER_RECEIVE_ROLES).has(userRole(user));
const visibleAt = (user: any, request: any) => userRole(user) === "admin" || [request.location_id, request.source_location_id].includes(userShopId(user));
const activeLocation = async (service: any, id: string) => {
  const shop = id ? await get(service.entities.Shop, id) : null;
  if (!shop || shop.active === false) throw fail("Faol do‘kon yoki omborni tanlang.", 404);
  return shop;
};
const unitSnapshot = (ingredient: any) => {
  if (!ingredient) throw fail("Mahsulot topilmadi.", 404);
  const factors: any = { g: { g: 1, kg: 1000 }, ml: { ml: 1, l: 1000 }, piece: { piece: 1 } };
  const factor = factors[ingredient.base_unit]?.[ingredient.purchase_unit];
  if (!ingredient || ingredient.active === false || ingredient.is_cake_layer === true || !factor
    || Number(ingredient.conversion_to_base) !== factor) throw fail("Mahsulotning o‘lchov birligini egasi tekshirishi kerak.", 409);
  return { ingredient_id: ingredient.id, ingredient_name: ingredient.name, category: ingredient.category,
    purchase_unit: ingredient.purchase_unit, base_unit: ingredient.base_unit, conversion_to_base: factor };
};

async function receiptMap(service: any, requests: any[]) {
  const ids = [...new Set(requests.flatMap(r => json(r.history_json, []).map((h: any) => h.supplier_receipt_id).filter(Boolean)))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await service.entities.SupplierReceipt.filter({ id: { $in: ids.slice(i, i + 500) } }, "id", 500);
    for (const row of rows) map.set(row.id, row);
  }
  return map;
}

function hydrate(request: any, receipts: Map<any, any>) {
  const history = json(request.history_json, []);
  let cancellationPending = false;
  const effective = history.map((h: any) => {
    const receipt = h.supplier_receipt_id ? receipts.get(h.supplier_receipt_id) : null;
    if (h.supplier_receipt_id && !receipt) throw fail("Talabnomaga bog‘langan kirim topilmadi. Egasi tekshirishi kerak.", 409);
    if (receipt?.status === "cancelling") cancellationPending = true;
    return { ...h, cancelled: receipt?.status === "cancelled", cancelling: receipt?.status === "cancelling" };
  });
  const items = request.items.map((item: any) => {
    const received = round(effective.filter((h: any) => !h.cancelled).reduce((sum: number, h: any) =>
      sum + Number(h.items.find((line: any) => line.ingredient_id === item.ingredient_id)?.quantity || 0), 0));
    if (received > Number(item.requested_quantity) + 0.0001) throw fail("Talabnoma qabul miqdorini tekshirish kerak.", 409);
    return { ...item, received_quantity: received, remaining_quantity: round(item.requested_quantity - received) };
  });
  const received = items.some((i: any) => i.received_quantity > 0);
  const complete = items.every((i: any) => i.remaining_quantity === 0);
  return { ...request, items, history: effective, cancellation_pending: cancellationPending,
    status: request.status === "cancelled" ? "cancelled" : complete ? "received" : received ? "partial" : "waiting" };
}

function dto(request: any, user: any) {
  const { pending_json, history_json, request_key, create_fingerprint, lease_token, lease_until, ...result } = request;
  const pending = json(pending_json, null);
  result.pending_receipt = pending ? { key: pending.key, actor_name: pending.actor_name, received_at: pending.received_at,
    total_amount: PURCHASE_ROLES.has(userRole(user)) ? pending.total_amount : undefined } : null;
  if (!PURCHASE_ROLES.has(userRole(user))) result.history = result.history.map((h: any) => ({
    key: h.key, received_at: h.received_at, actor_name: h.actor_name, cancelled: h.cancelled,
    items: h.items.map((i: any) => ({ ingredient_id: i.ingredient_id, quantity: i.quantity })),
  }));
  return result;
}

async function createRequest(service: any, user: any, body: any) {
  if (!CREATE_ROLES.has(userRole(user))) throw fail("Talabnoma yaratishga ruxsat yo‘q.", 403);
  const clientKey = key(body.idempotency_key);
  const locationId = clean(body.location_id, 100);
  permission(user, locationId);
  const location = await activeLocation(service, locationId);
  const sourceKind = body.source_kind;
  if (!["purchase", "warehouse"].includes(sourceKind)) throw fail("Xarid yoki markaziy omborni tanlang.");
  const requiredDate = clean(body.required_date, 10);
  const parsedDate = new Date(requiredDate + "T00:00:00Z");
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(requiredDate) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== requiredDate) throw fail("Kerakli sanani to‘g‘ri kiriting.");
  let source: any = null;
  if (sourceKind === "warehouse") {
    source = await activeLocation(service, clean(body.source_location_id, 100));
    if (source.id === location.id || source.location_type !== "production") throw fail("Boshqa markaziy omborni tanlang.");
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) throw fail("1 tadan 50 tagacha mahsulot tanlang.");
  const seen = new Set();
  const items = [];
  for (const input of body.items) {
    const id = clean(input.ingredient_id, 100);
    if (!id || seen.has(id)) throw fail("Bir mahsulotni ikki marta qo‘shmang.");
    seen.add(id);
    const ingredient = await get(service.entities.Ingredient, id);
    if (!ingredient) throw fail("Mahsulot topilmadi.", 404);
    const snapshot = unitSnapshot(ingredient);
    const amount = scalar(input.quantity);
    if (snapshot.base_unit === "piece" && !Number.isSafeInteger(amount)) throw fail("Dona miqdorini butun son kiriting.");
    items.push({ ...snapshot, requested_quantity: amount });
  }
  const payload = { location_id: location.id, location_name: location.name, source_kind: sourceKind,
    source_location_id: source?.id || "", source_location_name: source?.name || "", required_date: requiredDate,
    notes: clean(body.notes), items };
  const fingerprint = stable(payload);
  const requestKey = await digest(user.id + ":" + clientKey);
  const existing = await one(service.entities.IngredientRequisition, { request_key: requestKey });
  if (existing) {
    if (existing.create_fingerprint !== fingerprint) throw fail("Bu talabnoma kaliti boshqa ma’lumotga tegishli.", 409);
    return { request: dto(hydrate(existing, await receiptMap(service, [existing])), user), already_processed: true };
  }
  // Claim creation on the existing destination Shop: parallel submissions cannot
  // both pass an empty collection lookup and create the same requisition.
  const token = crypto.randomUUID();
  let claimed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const shop = await get(service.entities.Shop, location.id);
    const journal = json(shop[CREATE_JOURNAL]);
    const prior = journal[requestKey];
    if (prior && prior.fingerprint !== fingerprint) throw fail("Bu talabnoma kaliti boshqa ma’lumotga tegishli.", 409);
    if (prior?.until > Date.now()) throw fail("Talabnoma saqlanmoqda. Shu so‘rovni qayta tekshiring.", 409, true);
    journal[requestKey] = { fingerprint, token, until: Date.now() + LEASE_MS };
    const next = JSON.stringify(journal);
    try {
      const r = await service.entities.Shop.updateMany({ id: shop.id, [CREATE_JOURNAL]: rawFilter(shop, CREATE_JOURNAL) }, { $set: { [CREATE_JOURNAL]: next } });
      if (r?.success && Number(r.updated) === 1) { claimed = true; break; }
    } catch {
      const saved = await get(service.entities.Shop, shop.id);
      if (json(saved[CREATE_JOURNAL])[requestKey]?.token === token) { claimed = true; break; }
    }
  }
  if (!claimed) throw fail("Talabnoma boshqa oynada saqlanmoqda. Qayta tekshiring.", 409, true);
  let saved: any;
  try {
    const createdAt = new Date().toISOString();
    saved = await ensure(service.entities.IngredientRequisition, { request_key: requestKey }, {
      ...payload, request_key: requestKey, create_fingerprint: fingerprint,
      request_number: `EK-${createdAt.slice(0, 10).replaceAll("-", "")}-${requestKey.slice(0, 8).toUpperCase()}`,
      status: "waiting", version: 0, history_json: "[]", pending_json: "", lease_token: "", lease_until: "",
      approved_at: "", approved_by: "", approved_by_name: "", created_at: createdAt,
      created_by: user.id, created_by_name: userLabel(user),
    });
  } catch (e) {
    const found = await one(service.entities.IngredientRequisition, { request_key: requestKey });
    if (found && found.create_fingerprint === fingerprint) saved = found;
    else throw fail(e.message || "Talabnomani qayta tekshiring.", 409, true);
  } finally {
    // Release only our creation claim, preserving other simultaneous requests.
    for (let attempt = 0; attempt < 4; attempt++) {
      const shop = await get(service.entities.Shop, location.id);
      const journal = json(shop[CREATE_JOURNAL]);
      if (journal[requestKey]?.token !== token) break;
      delete journal[requestKey];
      try {
        const r = await service.entities.Shop.updateMany({ id: shop.id, [CREATE_JOURNAL]: rawFilter(shop, CREATE_JOURNAL) }, { $set: { [CREATE_JOURNAL]: JSON.stringify(journal) } });
        if (r?.success && Number(r.updated) === 1) break;
      } catch { /* Durable request_key lookup remains the replay authority. */ }
    }
  }
  return { request: dto(hydrate(saved, new Map()), user) };
}

function receiptInput(request: any, body: any) {
  const operationKey = key(body.idempotency_key);
  if (body.verified !== true) throw fail("Kelgan mahsulotlarni tekshirib, tasdiqlash katagini belgilang.");
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0) throw fail("Talabnoma versiyasi noto‘g‘ri.");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) throw fail("Kelgan mahsulotlar miqdorini kiriting.");
  const purchase = request.source_kind === "purchase";
  const items = body.items.map((i: any) => ({ ingredient_id: clean(i.ingredient_id, 100), quantity: scalar(i.quantity), unit_price: purchase ? price(i.unit_price) : null }))
    .sort((a: any, b: any) => a.ingredient_id.localeCompare(b.ingredient_id));
  if (new Set(items.map((i: any) => i.ingredient_id)).size !== items.length) throw fail("Bir mahsulotni ikki marta qabul qilmang.");
  const input = { key: operationKey, expected_version: body.expected_version, items,
    supplier_id: purchase ? clean(body.supplier_id, 100) : "",
    payment_state: purchase ? body.payment_state : "transfer",
    invoice_reference: purchase ? clean(body.invoice_reference, 200) : "" };
  return { ...input, fingerprint: stable([request.id, input]) };
}

async function acquireLease(service: any, request: any) {
  if (request.lease_token && Date.parse(request.lease_until) > Date.now()) throw fail("Qabul qilish boshqa oynada davom etmoqda. Bir ozdan so‘ng tekshiring.", 409, true);
  const token = crypto.randomUUID();
  await setKnown(service.entities.IngredientRequisition, { id: request.id, pending_json: request.pending_json,
    lease_token: rawFilter(request, "lease_token"), lease_until: rawFilter(request, "lease_until") }, {
    lease_token: token, lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
  });
  return token;
}

async function applyStock(service: any, op: any, item: any, location: any, delta: number, direction: string, guard: () => Promise<any>) {
  const marker = `${op.id}:${direction}:${item.ingredient_id}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await guard();
    const stock = await one(service.entities.IngredientStock, { location_id: location.id, ingredient_id: item.ingredient_id });
    if (stock && stock.unit !== item.base_unit) throw fail(`${item.ingredient_name}: ombor birligi mos emas.`, 409, true);
    const journal = json(stock?.[JOURNAL]);
    if (journal[marker]) {
      if (journal[marker].delta !== delta) throw fail("Kirim miqdori oldingi amalga mos emas.", 409, true);
      return journal[marker];
    }
    const before = Number(stock?.quantity || 0);
    const after = round(before + delta);
    if (!Number.isFinite(before) || (delta < 0 && after < 0)) throw fail(`${item.ingredient_name}: markaziy omborda qoldiq yetarli emas.`, 409, true);
    const entry = { delta, before, after };
    journal[marker] = entry;
    const data = { location_name: location.name, ingredient_name: item.ingredient_name, unit: item.base_unit,
      updated_at: op.received_at, updated_by: op.actor_id, updated_by_name: op.actor_name, [JOURNAL]: JSON.stringify(journal) };
    let failure: any;
    try {
      if (stock) {
        const result = await service.entities.IngredientStock.updateMany({ id: stock.id, quantity: before, [JOURNAL]: rawFilter(stock, JOURNAL) },
          { $set: { ...data, quantity: after } });
        if (result?.success && Number(result.updated) === 1) return entry;
      } else {
        await service.entities.IngredientStock.create({ ...data, location_id: location.id, ingredient_id: item.ingredient_id,
          quantity: after, low_stock_level: 0 });
        const saved = await one(service.entities.IngredientStock, { location_id: location.id, ingredient_id: item.ingredient_id });
        if (json(saved?.[JOURNAL])[marker]) return entry;
      }
    } catch (e) { failure = e; }
    const saved = await one(service.entities.IngredientStock, { location_id: location.id, ingredient_id: item.ingredient_id });
    if (json(saved?.[JOURNAL])[marker]) return json(saved[JOURNAL])[marker];
    if (failure) throw failure;
  }
  throw fail("Qoldiq bir vaqtda o‘zgardi. Qabulni davom ettiring.", 409, true);
}

async function movement(service: any, request: any, op: any, item: any, location: any, entry: any, type: string, direction: string, guard: () => Promise<any>) {
  await guard();
  const number = `ST-EK-${op.id}-${direction}-${item.ingredient_id}`;
  await ensure(service.entities.StockMovement, { movement_number: number }, {
    movement_number: number, location_id: location.id, location_name: location.name,
    item_kind: "ingredient", item_id: item.ingredient_id, item_name: item.ingredient_name, unit: item.base_unit,
    movement_type: type, quantity_change: entry.delta, balance_before: entry.before, balance_after: entry.after,
    reason: `${request.request_number} · ${request.source_kind === "purchase" ? "Xarid qabul qilindi" : direction === "out" ? request.location_name + " uchun" : request.source_location_name + "dan"}`,
    reference_id: op.id, reference_type: "ingredient_requisition", user_id: op.actor_id, user_name: op.actor_name, created_at: op.received_at,
  });
}

async function finishReceipt(service: any, user: any, request: any) {
  const op = json(request.pending_json, null);
  if (!op) return { request: dto(hydrate(request, await receiptMap(service, [request])), user), already_processed: true };
  const token = await acquireLease(service, request);
  const guard = async () => setKnown(service.entities.IngredientRequisition, { id: request.id, lease_token: token, pending_json: request.pending_json }, {
    lease_token: token, lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
  });
  try {
    const destination = await activeLocation(service, request.location_id);
    const source = request.source_kind === "warehouse" ? await activeLocation(service, request.source_location_id) : null;
    if (source) {
      // Source authorization is frozen by its own warehouse employee/owner.
      if (!request.approved_by || source.location_type !== "production") throw fail("Markaziy ombor tasdig‘i kerak.", 403, true);
      for (const item of op.items) {
        const entry = await applyStock(service, op, item, source, -item.base_quantity, "out", guard);
        await movement(service, request, op, item, source, entry, "transfer_out", "out", guard);
      }
    }
    for (const item of op.items) {
      const entry = await applyStock(service, op, item, destination, item.base_quantity, "in", guard);
      await movement(service, request, op, item, destination, entry, source ? "transfer_in" : "receipt", "in", guard);
    }
    let supplierReceipt: any = null;
    if (!source) {
      await guard();
      supplierReceipt = await ensure(service.entities.SupplierReceipt, { receipt_number: op.receipt_number }, {
        receipt_number: op.receipt_number, supplier_id: op.supplier_id, supplier_name_snapshot: op.supplier_name,
        location_id: destination.id, location_name_snapshot: destination.name, total_amount: op.total_amount,
        paid_at_receipt: 0, debt_amount: 0, remaining_debt: 0, status: "receiving",
        invoice_reference: op.invoice_reference || request.request_number, notes: `${request.request_number} · Ertaga kerak`,
        received_at: op.received_at, created_by: op.actor_id, created_by_name: op.actor_name,
        requisition_id: request.id,
      });
      for (const item of op.items) {
        await guard();
        await ensure(service.entities.SupplierReceiptItem, { receipt_id: supplierReceipt.id, ingredient_id: item.ingredient_id }, {
          receipt_id: supplierReceipt.id, location_id: destination.id, ingredient_id: item.ingredient_id,
          ingredient_name_snapshot: item.ingredient_name, purchase_quantity: item.quantity, purchase_unit: item.purchase_unit,
          base_quantity: item.base_quantity, base_unit: item.base_unit, unit_price: item.unit_price, line_total: item.line_total,
        });
      }
      await guard();
      const paid = op.payment_state === "paid_external";
      const final = { status: paid || op.total_amount === 0 ? "paid" : "unpaid", paid_at_receipt: paid ? op.total_amount : 0,
        debt_amount: paid ? 0 : op.total_amount, remaining_debt: paid ? 0 : op.total_amount };
      if (supplierReceipt.status === "receiving") await setKnown(service.entities.SupplierReceipt, { id: supplierReceipt.id, status: "receiving" }, final);
      else if (!["paid", "partial", "unpaid"].includes(supplierReceipt.status)) throw fail("Kirimning moliyaviy holatini tekshirish kerak.", 409, true);
    }
    await guard();
    const history = json(request.history_json, []);
    const entry = { key: op.key, fingerprint: op.fingerprint, operation_id: op.id, items: op.items,
      supplier_receipt_id: supplierReceipt?.id || "", total_amount: op.total_amount,
      received_at: op.received_at, actor_id: op.actor_id, actor_name: op.actor_name, payment_state: op.payment_state };
    history.push(entry);
    const candidate = { ...request, history_json: JSON.stringify(history), pending_json: "" };
    const hydrated = hydrate(candidate, await receiptMap(service, [candidate]));
    const final = { history_json: candidate.history_json, pending_json: "", lease_token: "", lease_until: "",
      status: hydrated.status, version: Number(request.version) + 1, updated_at: new Date().toISOString() };
    const saved = await setKnown(service.entities.IngredientRequisition, { id: request.id, lease_token: token, pending_json: request.pending_json }, final);
    return { request: dto(hydrate(saved, await receiptMap(service, [saved])), user) };
  } catch (e) {
    const saved = await get(service.entities.IngredientRequisition, request.id);
    if (json(saved?.history_json, []).some((h: any) => h.key === op.key && h.fingerprint === op.fingerprint)) {
      return { request: dto(hydrate(saved, await receiptMap(service, [saved])), user), already_processed: true };
    }
    throw fail(`${e.message || "Qabul tugamadi."} Talabnomadagi “Qabulni davom ettirish” tugmasini bosing.`, 409, true);
  } finally {
    await service.entities.IngredientRequisition.updateMany({ id: request.id, lease_token: token }, { $set: { lease_token: "", lease_until: "" } }).catch(() => {});
  }
}

export async function handleIngredientRequest(service: any, user: any, body: any) {
  const role = userRole(user);
  if (!READ_ROLES.has(role)) throw fail("Talabnomalar bilan ishlashga ruxsat yo‘q.", 403);
  const action = body?.action;
  if (action === "catalog" || action === "list") {
    const locationId = clean(body.location_id, 100);
    permission(user, locationId);
    await activeLocation(service, locationId);
    if (action === "catalog") {
      const [ingredients, warehouses, suppliers] = await Promise.all([
        service.entities.Ingredient.filter({ active: { $ne: false } }, "name", 1000),
        service.entities.Shop.filter({ active: { $ne: false }, location_type: "production" }, "name", 100),
        PURCHASE_ROLES.has(role) ? service.entities.CashRecipient.filter({ active: { $ne: false }, recipient_type: { $in: ["supplier", "company"] } }, "name", 1000) : [],
      ]);
      const available = [], unavailable = [];
      for (const ingredient of ingredients.filter((i: any) => i.is_cake_layer !== true)) {
        try { available.push({ id: ingredient.id, ...unitSnapshot(ingredient) }); }
        catch { unavailable.push(ingredient.name); }
      }
      return { ingredients: available, unavailable_ingredients: unavailable,
        warehouses: warehouses.map((s: any) => ({ id: s.id, name: s.name })), suppliers: suppliers.map((s: any) => ({ id: s.id, name: s.name })),
        can_create: CREATE_ROLES.has(role), can_purchase_receive: PURCHASE_ROLES.has(role), can_transfer_receive: TRANSFER_RECEIVE_ROLES.has(role) };
    }
    const skip = Number.isSafeInteger(body.skip) && body.skip >= 0 ? body.skip : 0;
    if (skip > 100000) throw fail("Sahifa noto‘g‘ri.");
    const filter: any = { $or: [{ location_id: locationId }, { source_location_id: locationId }] };
    const search = clean(body.search, 100);
    if (search) filter.request_number = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const rows = await service.entities.IngredientRequisition.filter(filter, "-created_at", 100, skip);
    const map = await receiptMap(service, rows);
    return { requests: rows.map((r: any) => dto(hydrate(r, map), user)), has_more: rows.length === 100 };
  }
  if (action === "create") return createRequest(service, user, body);
  const requestId = clean(body.request_id, 100);
  let request = requestId ? await get(service.entities.IngredientRequisition, requestId) : null;
  if (!request || !visibleAt(user, request)) throw fail("Talabnoma topilmadi yoki ruxsat yo‘q.", 404);
  if (action === "get") return { request: dto(hydrate(request, await receiptMap(service, [request])), user) };
  if (action === "approve") {
    if (request.source_kind !== "warehouse" || !PURCHASE_ROLES.has(role)) throw fail("Markaziy ombor tasdig‘iga ruxsat yo‘q.", 403);
    permission(user, request.source_location_id);
    if (request.status === "cancelled" || request.pending_json) throw fail("Bu talabnomani hozir tasdiqlab bo‘lmaydi.", 409);
    if (request.approved_by) return { request: dto(hydrate(request, await receiptMap(service, [request])), user), already_processed: true };
    if (body.expected_version !== request.version) throw fail("Talabnoma o‘zgargan. Yangilang.", 409);
    request = await setKnown(service.entities.IngredientRequisition, { id: request.id, version: request.version, pending_json: "" }, {
      approved_by: user.id, approved_by_name: userLabel(user), approved_at: new Date().toISOString(), version: request.version + 1,
    });
    return { request: dto(hydrate(request, await receiptMap(service, [request])), user) };
  }
  permission(user, request.location_id);
  if (action === "cancel") {
    if (!CREATE_ROLES.has(role)) throw fail("Bekor qilishga ruxsat yo‘q.", 403);
    if (request.pending_json) throw fail("Avval boshlangan qabulni yakunlang.", 409, true);
    if (request.status === "cancelled") return { request: dto(hydrate(request, await receiptMap(service, [request])), user) };
    if (body.expected_version !== request.version) throw fail("Talabnoma o‘zgargan. Yangilang.", 409);
    request = await setKnown(service.entities.IngredientRequisition, { id: request.id, version: request.version, pending_json: "" }, {
      status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by_name: userLabel(user), version: request.version + 1,
    });
    return { request: dto(hydrate(request, await receiptMap(service, [request])), user) };
  }
  if (!["receive", "resume"].includes(action)) throw fail("Noma’lum talabnoma amali.");
  if (!canReceive(user, request)) throw fail("Kirimni boshqaruvchi yoki omborchi tasdiqlaydi.", 403);
  if (action === "resume") return finishReceipt(service, user, request);
  const input = receiptInput(request, body);
  const prior = json(request.history_json, []).find((h: any) => h.key === input.key);
  if (prior) {
    if (prior.fingerprint !== input.fingerprint) throw fail("Bu qabul kaliti boshqa miqdor yoki narxga tegishli.", 409);
    return { request: dto(hydrate(request, await receiptMap(service, [request])), user), already_processed: true };
  }
  const pending = json(request.pending_json, null);
  if (pending) {
    if (pending.key !== input.key || pending.fingerprint !== input.fingerprint) throw fail("Oldingi qabul hali yakunlanmagan. Uni davom ettiring.", 409, true);
    return finishReceipt(service, user, request);
  }
  const hydrated = hydrate(request, await receiptMap(service, [request]));
  if (hydrated.cancellation_pending) throw fail("Oldingi kirim bekor qilinmoqda. Tugashini kuting.", 409);
  if (["received", "cancelled"].includes(hydrated.status)) throw fail("Talabnoma yopilgan.", 409);
  if (input.expected_version !== request.version) throw fail("Talabnoma boshqa oynada o‘zgargan. Yangilang.", 409);
  if (request.source_kind === "warehouse" && !request.approved_by) throw fail("Avval markaziy ombor tasdiqlashi kerak.", 409);
  let supplier: any = null;
  if (request.source_kind === "purchase") {
    if (!["unpaid", "paid_external"].includes(input.payment_state)) throw fail("To‘lov holatini tanlang.");
    supplier = input.supplier_id ? await get(service.entities.CashRecipient, input.supplier_id) : null;
    if (!supplier || supplier.active === false || !["supplier", "company"].includes(supplier.recipient_type)) throw fail("Faol yetkazib beruvchini tanlang.");
  }
  const items = [];
  for (const row of input.items) {
    const wanted = hydrated.items.find((i: any) => i.ingredient_id === row.ingredient_id);
    if (!wanted || row.quantity > wanted.remaining_quantity + 0.0001) throw fail("Kelgan miqdor talabnomadagi qoldiqdan oshmasligi kerak.");
    if (wanted.base_unit === "piece" && !Number.isSafeInteger(row.quantity)) throw fail("Dona miqdorini butun son kiriting.");
    const ingredient = await get(service.entities.Ingredient, row.ingredient_id);
    if (!ingredient || !matches(unitSnapshot(ingredient), Object.fromEntries(Object.entries(wanted).filter(([k]) => ["ingredient_id", "ingredient_name", "category", "purchase_unit", "base_unit", "conversion_to_base"].includes(k))))) {
      throw fail("Mahsulot yoki o‘lchov birligi o‘zgargan. Talabnomani qayta tuzing.", 409);
    }
    const baseQuantity = round(row.quantity * wanted.conversion_to_base);
    if (request.source_kind === "warehouse") {
      const stock = await one(service.entities.IngredientStock, { location_id: request.source_location_id, ingredient_id: row.ingredient_id });
      if (!stock || stock.unit !== wanted.base_unit || Number(stock.quantity) < baseQuantity) throw fail(`${wanted.ingredient_name}: markaziy omborda qoldiq yetarli emas.`, 409);
    }
    const lineTotal = request.source_kind === "purchase" ? Math.round(row.quantity * row.unit_price) : 0;
    if (!Number.isSafeInteger(lineTotal) || lineTotal > 1000000000000) throw fail("Kirim summasi juda katta.");
    items.push({ ...wanted, quantity: row.quantity, unit_price: row.unit_price, base_quantity: baseQuantity, line_total: lineTotal });
  }
  const id = (await digest(request.id + ":" + input.key)).slice(0, 24);
  const op = { ...input, id, items, total_amount: items.reduce((s: number, i: any) => s + i.line_total, 0),
    supplier_name: supplier?.name || "", actor_id: user.id, actor_name: userLabel(user), received_at: new Date().toISOString(), receipt_number: `KR-EK-${id.toUpperCase()}` };
  request = await setKnown(service.entities.IngredientRequisition, { id: request.id, version: request.version, pending_json: "" }, {
    pending_json: JSON.stringify(op), version: request.version + 1,
  });
  return finishReceipt(service, user, request);
}
