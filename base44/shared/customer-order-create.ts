import { money, httpError } from "./shift-close-helpers.ts";
import { ensureCustomer } from "./customer-helpers.ts";
import { allocateCustomerOrderSequence } from "./customer-order-sequence.js";

const ORDER_RUNTIME_VERSION = "customer-orders-v6-2026-10-15";
export const PAYMENT_METHODS = new Set([
  "cash", "bank_card", "online", "uzcard", "humo", "click", "payme", "bank_transfer", "other",
]);
const ORDER_TYPES = new Set(["toy_va_bazmlar", "tugilgan_kun_va_boshqa"]);
const WEDDING_PIECES_PER_SHEET = 40;

function tashkentNowParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const o: any = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour === "24" ? "0" : o.hour),
    minute: Number(o.minute),
  };
}

export function tashkentStamp(): string {
  const np = tashkentNowParts();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${np.year}-${pad(np.month)}-${pad(np.day)}T${pad(np.hour)}:${pad(np.minute)}:00+05:00`;
}

export function methodToShiftField(method: string): string | null {
  if (method === "cash") return "cash_sales";
  if (method === "uzcard" || method === "bank_card") return "uzcard_sales";
  if (method === "humo") return "humo_sales";
  if (method === "bank_transfer") return "bank_transfer_sales";
  if (["online", "click", "payme", "other"].includes(method)) return "online_sales";
  return null;
}

export async function findOpenShift(service: any, userId: string, shopId: string) {
  const shifts = await service.entities.Shift.filter({
    user_id: userId, status: "open", shop_id: shopId,
  });
  return (shifts && shifts[0]) || null;
}

export async function applyPaymentToShift(
  service: any, shift: any, method: string, amount: number, paymentKey = "",
) {
  const field = methodToShiftField(method);
  const inc: Record<string, number> = { total_sales: amount, order_count: 1 };
  if (field) inc[field] = amount;
  if (method === "cash") inc.expected_cash = amount;
  if (paymentKey) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await service.entities.Shift.get(shift.id);
      // A known atomic increment remains valid after the shift has closed.
      // Reading it never changes the historical shift or its Budget settlement.
      if (current?.order_payment_keys?.includes(paymentKey)) return;
      if (!current || current.status !== "open") throw paymentPending("To‘lov smenasi yopilmoqda yoki yopilgan. Egasi tekshirishi kerak.");
      const operations = orderPaymentShiftJournal(current);
      if (!operations[paymentKey] || operations[paymentKey].amount !== amount || operations[paymentKey].method !== method) throw paymentPending();
      operations[paymentKey].state = "applied";
      try {
        const result = await service.entities.Shift.updateMany({ id: current.id, status: "open", order_payment_keys: { $nin: [paymentKey] },
          order_payment_operations_json: current.order_payment_operations_json ?? { $exists: false } },
          { $inc: inc, $push: { order_payment_keys: paymentKey }, $set: { order_payment_operations_json: JSON.stringify(operations) } });
        if (result?.success && Number(result.updated || 0) === 1) return;
      } catch {
        const saved = await service.entities.Shift.get(shift.id);
        if (saved?.order_payment_keys?.includes(paymentKey)) return;
      }
    }
    throw paymentPending("Smena bir vaqtda o‘zgardi. Shu to‘lovni qayta tekshiring.");
  }
  const update = await service.entities.Shift.updateMany(
    { id: shift.id, status: "open" },
    { $inc: inc },
  );
  if (!update?.success || Number(update.updated || 0) !== 1) {
    const current = paymentKey ? await service.entities.Shift.get(shift.id) : null;
    if (!current?.order_payment_keys?.includes(paymentKey)) throw httpError("Smena o‘zgardi. To‘lovni egasi tekshirishi kerak.", 409);
  }
}

export async function reversePaymentOnShift(
  service: any, shiftId: string, method: string, amount: number,
) {
  const field = methodToShiftField(method);
  const dec: Record<string, number> = { total_sales: -amount, order_count: -1 };
  if (field) dec[field] = -amount;
  if (method === "cash") dec.expected_cash = -amount;
  await service.entities.Shift.updateMany(
    { id: shiftId, status: "open" },
    { $inc: dec },
  ).catch(() => {});
}

export async function orderRequestFingerprint(payload: any): Promise<string> {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(payload))));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function paymentPending(message = "To‘lov natijasi tekshirilmoqda. Shu so‘rovni qayta tekshiring; yangi to‘lov kiritmang.") {
  return Object.assign(httpError(message, 503), { operation_pending: true });
}

function orderPaymentShiftJournal(shift: any) {
  try {
    const value = shift?.order_payment_operations_json ? JSON.parse(shift.order_payment_operations_json) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw paymentPending("Smenadagi buyurtma to‘lovlari holatini egasi tekshirishi kerak."); }
}

async function reserveOrderPaymentShift(service: any, order: any, user: any, intent: any, key: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const shift = await service.entities.Shift.get(intent.shift_id);
    if (!shift || shift.shop_id !== order.shop_id || shift.user_id !== user.id) throw paymentPending("To‘lov smenasi mos emas. Egasi tekshirishi kerak.");
    if (shift.order_payment_keys?.includes(key)) return;
    const operations = orderPaymentShiftJournal(shift);
    const prior = operations[key];
    if (prior) {
      if (prior.fingerprint !== intent.fingerprint || prior.actor_id !== user.id || prior.order_id !== order.id) throw paymentPending("Smena to‘lov so‘rovi mos emas.");
      if (shift.status !== "open") throw paymentPending("To‘lov smenasi yopilmoqda yoki yopilgan. Egasi tekshirishi kerak.");
      return;
    }
    if (shift.status !== "open") throw paymentPending("To‘lov smenasi yopilmoqda yoki yopilgan. Yangi to‘lov yozilmadi; egasi tekshirishi kerak.");
    operations[key] = { fingerprint: intent.fingerprint, actor_id: user.id, order_id: order.id,
      amount: intent.amount, method: intent.method, state: "pending" };
    try {
      const claimed = await service.entities.Shift.updateMany({ id: shift.id, status: "open",
        order_payment_operations_json: shift.order_payment_operations_json ?? { $exists: false } },
        { $set: { order_payment_operations_json: JSON.stringify(operations) } });
      if (claimed?.success && Number(claimed.updated || 0) === 1) return;
    } catch {
      const saved = await service.entities.Shift.get(shift.id);
      if (orderPaymentShiftJournal(saved)[key]?.fingerprint === intent.fingerprint) return;
    }
  }
  throw paymentPending("Smenadagi to‘lov boshqa oynada o‘zgardi. Shu so‘rovni qayta tekshiring.");
}

function assertPaymentRequest(payment: any, user: any, order: any, body: any, fingerprint: string) {
  if (payment.order_id !== order.id || payment.shop_id !== order.shop_id || payment.employee_id !== user.id
    || payment.payment_method !== body.method || money(payment.amount) !== money(body.amount)
    || payment.payment_kind !== String(body.payment_kind || "balance")
    || (payment.request_fingerprint && payment.request_fingerprint !== fingerprint)) {
    throw httpError("Bu so‘rov kaliti boshqa to‘lovga tegishli.", 409);
  }
}

// An order owns one persistent payment intent at a time. Financial increments
// carry their request marker in the same atomic update, so a lost reply is safe
// to reconcile. A missing reply to a ledger create is never retried blindly.
export async function recordCustomerOrderPayment(service: any, user: any, body: any, allowPendingCreation = false) {
  let requestStarted = false;
  try {
    const orderId = String(body.order_id || "");
    const key = String(body.idempotency_key || "");
    const amount = money(body.amount);
    const method = String(body.method || "");
    const kind = String(body.payment_kind || "balance");
    if (!orderId || !key || key.length > 200 || amount <= 0 || !PAYMENT_METHODS.has(method)
      || !["advance", "balance", "additional"].includes(kind)) throw httpError("To‘lov ma’lumotlari noto‘g‘ri.", 400);
    let order = await service.entities.CustomerOrder.get(orderId);
    if (!order) throw httpError("Buyurtma topilmadi.", 404);
    if (["cashier", "manager"].includes(user.role) && order.shop_id !== user.shop_id) throw httpError("Bu buyurtma boshqa do‘konga tegishli.", 403);
    if (order.creation_state === "pending" && !allowPendingCreation) throw paymentPending("Buyurtma yaratish hali tasdiqlanmadi. Avval shu so‘rovni tekshiring.");
    if (order.completion_key && order.order_status !== "yakunlandi" && order.completion_key !== key
      && order.payment_operation_key !== key) throw paymentPending("Buyurtmani yakunlash boshlangan. Avval shu amalni tekshiring.");
    const fingerprint = await orderRequestFingerprint({ order_id: order.id, shop_id: order.shop_id, actor_id: user.id, method, amount, payment_kind: kind });
    let rows = await service.entities.OrderPayment.filter({ idempotency_key: key });
    if (rows.length > 1) throw paymentPending("Takroriy to‘lov yozuvlari bor. Egasi tekshirishi kerak.");
    let payment = rows[0] || null;
    requestStarted = Boolean(payment);
    if (payment) {
      assertPaymentRequest(payment, user, order, body, fingerprint);
      if (!payment.request_fingerprint) {
        // Legacy financial snapshots have no atomic markers. Preserve a valid
        // completed payment; never guess whether its historical shift was posted.
        const ledger = await service.entities.OrderPayment.filter({ order_id: order.id }, "paid_at", 10000);
        const ledgerPaid = ledger.filter((row: any) => row.status === "completed").reduce((sum: number, row: any) => sum + money(row.amount), 0);
        if (money(order.paid_amount) < ledgerPaid) throw paymentPending("Oldingi to‘lov va buyurtma summalari mos emas. Egasi tekshirishi kerak.");
        return { payment, order, already_exists: true };
      }
      if (payment.reconciliation_state === "completed") {
        if (order.payment_operation_key === key) await service.entities.CustomerOrder.updateMany({ id: order.id, payment_operation_key: key }, { $set: { payment_operation_key: "", payment_operation_phase: "completed" } });
        const savedOrder = await service.entities.CustomerOrder.get(order.id);
        if (savedOrder?.payment_operation_key === key) throw paymentPending();
        return { payment, order: savedOrder, already_exists: true };
      }
    }
    if (order.payment_operation_key && order.payment_operation_key !== key) throw paymentPending("Bu buyurtmaning oldingi to‘lovi yakunlanmagan. Avval uni tekshiring.");
    let intent = order.payment_operation_key === key ? order.payment_operation_payload : null;
    if (intent) requestStarted = true;
    if (intent && intent.fingerprint !== fingerprint) throw httpError("Bu so‘rov kaliti boshqa to‘lov uchun ishlatilgan.", 409);
    if (!intent) {
      if (payment) throw paymentPending("To‘lov amali yozuvi to‘liq emas. Egasi tekshirishi kerak.");
      if (order.order_status === "bekor_qilindi" || order.order_status === "yakunlandi") throw httpError("Ushbu buyurtmaga yangi to‘lov qabul qilinmaydi.", 409);
      const before = money(order.paid_amount);
      if (amount > money(order.total) - before) throw httpError(`To‘lov qolgan qarzdan oshmasligi kerak: ${money(order.total) - before} UZS.`, 400);
      const pinnedCreationShift = allowPendingCreation && kind === "advance"
        && Object.prototype.hasOwnProperty.call(order, "creation_advance_shift_id");
      const shift = pinnedCreationShift
        ? (order.creation_advance_shift_id ? await service.entities.Shift.get(order.creation_advance_shift_id) : null)
        : await findOpenShift(service, user.id, order.shop_id);
      if (pinnedCreationShift && order.creation_advance_shift_id
        && (!shift || shift.user_id !== user.id || shift.shop_id !== order.shop_id || shift.status !== "open")) {
        throw paymentPending("Avansning dastlabki smenasi yopilmoqda yoki yopilgan. Egasi tekshirishi kerak.");
      }
      if (!shift && method === "cash") throw httpError("Naqd to‘lov uchun ushbu do‘konda smenani oching.", 409);
      intent = { fingerprint, actor_id: user.id, before, after: before + amount, remaining: money(order.total) - before - amount,
        shift_id: shift?.id || "", method, amount, kind, paid_at: new Date().toISOString() };
      // A key is globally bound to one actor/order/payload before its per-order
      // intent is claimed. Two orders cannot concurrently create the same key.
      const settingsRows = await service.entities.Settings.list("-created_date", 2);
      if (settingsRows.length !== 1) throw paymentPending("To‘lov sozlamasi tekshirilsin.");
      const requestKey = await orderRequestFingerprint({ payment_key: key });
      requestStarted = true;
      const requestBinding = `${requestKey}:${fingerprint}`;
      try {
        await service.entities.Settings.updateMany({ id: settingsRows[0].id, customer_order_payment_request_keys: { $nin: [requestKey] } },
          { $push: { customer_order_payment_request_keys: requestKey, customer_order_payment_request_fingerprints: requestBinding } });
      } catch { /* Read the binding before deciding whether this claim committed. */ }
      const claimedSettings = await service.entities.Settings.get(settingsRows[0].id);
      if (!claimedSettings?.customer_order_payment_request_fingerprints?.includes(requestBinding)) {
        if (claimedSettings?.customer_order_payment_request_keys?.includes(requestKey)) throw httpError("Bu so‘rov kaliti boshqa to‘lov uchun ishlatilgan.", 409);
        throw paymentPending();
      }
      const claim = await service.entities.CustomerOrder.updateMany({ id: order.id, paid_amount: before,
        $or: [{ payment_operation_key: { $exists: false } }, { payment_operation_key: "" }] },
        { $set: { payment_operation_key: key, payment_operation_payload: intent, payment_operation_phase: "claimed" } });
      if (!claim?.success || Number(claim.updated || 0) !== 1) throw paymentPending();
      order = await service.entities.CustomerOrder.get(order.id);
    }
    const appliedKey = `payment:${fingerprint}:${key}`;
    if (intent.shift_id) await reserveOrderPaymentShift(service, order, user, intent, appliedKey);
    if (!payment) {
      const writeClaim = await service.entities.CustomerOrder.updateMany({ id: order.id, payment_operation_key: key, payment_operation_phase: "claimed" },
        { $set: { payment_operation_phase: "ledger_writing" } });
      if (writeClaim?.success && Number(writeClaim.updated || 0) === 1) {
        try {
          payment = await service.entities.OrderPayment.create({ order_id: order.id, order_number_snapshot: order.order_number,
            payment_kind: kind, payment_method: method, amount, paid_at: intent.paid_at,
            shop_id: order.shop_id, shop_name_snapshot: order.shop_name_snapshot, employee_id: user.id,
            employee_name: user.full_name || user.email || "Noma’lum xodim", employee_role: user.role,
            shift_id: intent.shift_id, idempotency_key: key, status: "completed", request_fingerprint: fingerprint,
            reconciliation_state: "pending" });
        } catch {
          rows = await service.entities.OrderPayment.filter({ idempotency_key: key });
          if (rows.length !== 1) throw paymentPending();
          payment = rows[0];
        }
      } else {
        rows = await service.entities.OrderPayment.filter({ idempotency_key: key });
        if (rows.length !== 1) throw paymentPending();
        payment = rows[0];
      }
      assertPaymentRequest(payment, user, order, body, fingerprint);
    }
    try {
      await service.entities.CustomerOrder.updateMany({ id: order.id, payment_operation_key: key, paid_amount: intent.before, payment_applied_keys: { $nin: [appliedKey] } },
        { $set: { paid_amount: intent.after, remaining_balance: intent.remaining, payment_status: intent.remaining <= 0 ? "paid" : "partial", updated_at: new Date().toISOString() },
          $push: { payment_applied_keys: appliedKey } });
    } catch { /* A committed marker, read below, is the authoritative outcome. */ }
    order = await service.entities.CustomerOrder.get(order.id);
    if (!order?.payment_applied_keys?.includes(appliedKey)) throw paymentPending();
    if (intent.shift_id) {
      const shift = await service.entities.Shift.get(intent.shift_id);
      if (!shift || shift.shop_id !== order.shop_id || shift.user_id !== user.id) throw paymentPending("To‘lov smenasi mos emas. Egasi tekshirishi kerak.");
      try { await applyPaymentToShift(service, shift, method, amount, appliedKey); }
      catch {
        const saved = await service.entities.Shift.get(intent.shift_id);
        if (!saved?.order_payment_keys?.includes(appliedKey)) throw paymentPending("To‘lov saqlandi, smena hali tasdiqlanmadi. Shu so‘rovni qayta tekshiring.");
      }
    }
    await service.entities.OrderPayment.updateMany({ id: payment.id, request_fingerprint: fingerprint }, { $set: { reconciliation_state: "completed" } });
    const confirmedPayment = await service.entities.OrderPayment.get(payment.id);
    if (confirmedPayment?.reconciliation_state !== "completed") throw paymentPending();
    await service.entities.CustomerOrder.updateMany({ id: order.id, payment_operation_key: key },
      { $set: { payment_operation_key: "", payment_operation_phase: "completed" } });
    const confirmedOrder = await service.entities.CustomerOrder.get(order.id);
    if (!confirmedOrder || confirmedOrder.payment_operation_key === key) throw paymentPending();
    await service.entities.ActionHistory.create({ user_id: user.id, user_name: user.full_name || user.email,
      action: "order_payment", details: `${order.order_number} · ${kind} · ${method} · ${amount} UZS` }).catch(() => {});
    return { payment: confirmedPayment, order: confirmedOrder, already_exists: Boolean(rows[0]) };
  } catch (error) {
    if (!requestStarted && !(error as any)?.operation_pending) (error as any).request_not_started = true;
    if (requestStarted) (error as any).operation_pending = true;
    throw error;
  }
}

async function normalizeOrderItems(service: any, requestedItems: any[], orderType: string, shopId: string, botGuard: any = null) {
  const normalized: any[] = [];
  for (const requested of requestedItems) {
    const productId = String(requested?.product_id || "");
    const quantity = Number(requested?.quantity);
    // Only the authenticated internal Telegram bridge may create an unlisted cake.
    // The price comes from its validated draft, never from a browser item price.
    if (!productId && botGuard?.allowUnlistedCake === true) {
      const price = botGuard.expectedTotal;
      if (requestedItems.length !== 1 || quantity !== 1 || !Number.isSafeInteger(price) || price <= 0 || price > 1000000000) {
        throw httpError("Oddiy buyurtma narxi yoki miqdori noto‘g‘ri.", 400);
      }
      const products = await service.entities.Product.filter({ active: true, name: `TORT ${price}` });
      const matching = products.filter((p: any) => p.archived !== true && p.production_unit !== "sheet"
        && String(p.name).trim().toUpperCase() === `TORT ${price}`
        && Number(p.shop_prices?.[shopId] ?? p.price) === price);
      if (matching.length) throw httpError("Katalog o‘zgardi. Buyurtmani qayta tekshirish kerak.", 409);
      normalized.push({
        product_id: "", item_type: "custom", product_name_snapshot: "Oddiy buyurtma (tort)",
        product_image_snapshot: "", category_name_snapshot: "Buyurtmalar",
        unit_snapshot: "piece", quantity: 1, event_pieces_per_sheet_snapshot: 0,
        unit_price_snapshot: price, line_total: price,
        customization_note: String(requested?.customization_note || ""),
      });
      continue;
    }
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
      throw httpError("Har bir mahsulotda to‘g‘ri miqdor bo‘lishi kerak.", 400);
    }
    const product = await service.entities.Product.get(productId);
    if (!product || product.active === false || product.archived === true) {
      throw httpError("Tanlangan mahsulot hozir sotuvda mavjud emas.", 409);
    }
    const isSheet = product.production_unit === "sheet";
    const unit = isSheet ? "sheet" : "piece";
    const unitPrice = isSheet ? money(product.sheet_price) : money(product?.shop_prices?.[shopId] ?? product.price);
    if (!unitPrice || unitPrice <= 0) {
      throw httpError(`${product.name || "Mahsulot"} narxi sozlanmagan.`, 409);
    }
    const qty = Math.floor(quantity);
    const piecesPerSheet = isSheet
      ? (orderType === "toy_va_bazmlar"
        ? WEDDING_PIECES_PER_SHEET
        : Math.max(1, Number(product.pieces_per_sheet) || 20))
      : 0;
    normalized.push({
      product_id: product.id,
      product_name_snapshot: String(product.name || ""),
      product_image_snapshot: String(product.image_url || ""),
      category_name_snapshot: String(product.category_name || ""),
      unit_snapshot: unit,
      quantity: qty,
      event_pieces_per_sheet_snapshot: piecesPerSheet,
      unit_price_snapshot: unitPrice,
      line_total: unitPrice * qty,
      customization_note: String(requested?.customization_note || ""),
    });
  }
  return normalized;
}

// Internal only. Callers authenticate and authorize before invoking; never expose directly.
export async function createCustomerOrder(service: any, user: any, body: any, botGuard: null | { staffId: string; shopId: string; expectedTotal: number; allowUnlistedCake?: boolean; authorize: () => Promise<any> } = null): Promise<Response> {
  let createdOrder: any = null;
  let createdItems: any[] = [];
  let createdPayment: any = null;
  let requestStarted = false;
  try {
      const idempotencyKey = String(body?.idempotency_key || "");
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return Response.json({ request_not_started: !requestStarted, error: "Idempotency kaliti kerak." }, { status: 400 });
      }
      const requestFingerprint = await orderRequestFingerprint({ ...body, action: "create_order", actor_id: user.id,
        shop_id: ["cashier", "manager"].includes(user.role) ? user.shop_id : body.shop_id });
      const existingOrders = await service.entities.CustomerOrder.filter({ idempotency_key: idempotencyKey });
      if (existingOrders && existingOrders.length) {
        requestStarted = true;
        if (existingOrders.length !== 1) throw paymentPending("Takroriy buyurtma yozuvlari bor. Egasi tekshirishi kerak.");
        const existing = existingOrders[0];
        if (botGuard) {
          const current = await botGuard.authorize();
          if (!current || current.active !== true || current.data?.active === false || current.id !== user.id
            || current.shop_id !== botGuard.shopId || !["admin", "manager", "cashier"].includes(current.role)) {
            throw httpError("Xodim ruxsati o‘zgargan.", 403);
          }
        }
        if ((["cashier", "manager"].includes(user.role) && existing.shop_id !== user.shop_id) || existing.creator_id !== user.id) return Response.json({ request_not_started: !requestStarted, error: "Bu so‘rov boshqa xodim yoki do‘konga tegishli." }, { status: 403 });
        if (existing.request_fingerprint && existing.request_fingerprint !== requestFingerprint) throw httpError("Bu so‘rov kaliti boshqa buyurtma uchun ishlatilgan.", 409);
        const items = await service.entities.CustomerOrderItem.filter({ order_id: existing.id }, "id", 10000);
        if (!existing.request_fingerprint) return Response.json({ order: existing, items, already_exists: true });
        if (items.length !== existing.creation_item_count) throw paymentPending("Buyurtma mahsulotlari to‘liq tasdiqlanmadi. Egasi tekshirishi kerak.");
        if (body.advance_payment) {
          const result = await recordCustomerOrderPayment(service, user, { order_id: existing.id, payment_kind: "advance",
            method: body.advance_payment.method, amount: body.advance_payment.amount,
            idempotency_key: String(body.advance_payment.idempotency_key || `${idempotencyKey}-adv`) }, true);
          createdPayment = result.payment;
        }
        await service.entities.CustomerOrder.updateMany({ id: existing.id, request_fingerprint: requestFingerprint }, { $set: { creation_state: "completed" } });
        return Response.json({ order: await service.entities.CustomerOrder.get(existing.id), items, payment: createdPayment, already_exists: true });
      }

      const orderType = String(body?.order_type || "");
      if (!ORDER_TYPES.has(orderType)) {
        return Response.json({ request_not_started: !requestStarted, error: "Buyurtma turi noto‘g‘ri." }, { status: 400 });
      }
      const customerName = String(body?.customer_name || "").trim();
      const customerPhone = String(body?.customer_phone || "").trim();
      const requiredDate = String(body?.required_date || "");
      const requiredTime = String(body?.required_time || "");
      const fulfilmentType = String(body?.fulfilment_type || "");
      if (!customerName || !customerPhone || !requiredDate || !requiredTime) {
        return Response.json({ request_not_started: !requestStarted, error: "Mijoz ismi, telefoni, sana va vaqt majburiy." }, { status: 400 });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredDate) || !/^\d{2}:\d{2}$/.test(requiredTime)) {
        return Response.json({ request_not_started: !requestStarted, error: "Sana yoki vaqt formati noto‘g‘ri." }, { status: 400 });
      }
      {
        const [yy, mm, dd] = requiredDate.split("-").map(Number);
        const probe = new Date(Date.UTC(yy, mm - 1, dd));
        if (probe.getUTCFullYear() !== yy || probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) {
          return Response.json({ request_not_started: !requestStarted, error: "Noto‘g‘ri sana." }, { status: 400 });
        }
        const [hh, mi] = requiredTime.split(":").map(Number);
        if (hh > 23 || mi > 59) {
          return Response.json({ request_not_started: !requestStarted, error: "Noto‘g‘ri vaqt." }, { status: 400 });
        }
        const np = tashkentNowParts();
        const reqStamp = `${yy}${String(mm).padStart(2, "0")}${String(dd).padStart(2, "0")}${requiredTime.replace(":", "")}`;
        const nowStamp = `${np.year}${String(np.month).padStart(2, "0")}${String(np.day).padStart(2, "0")}${String(np.hour).padStart(2, "0")}${String(np.minute).padStart(2, "0")}`;
        if (reqStamp < nowStamp) {
          return Response.json({ request_not_started: !requestStarted, error: "Topshirish sanasi yoki vaqti o‘tib ketgan." }, { status: 400 });
        }
      }
      if (!["pickup", "delivery"].includes(fulfilmentType)) {
        return Response.json({ request_not_started: !requestStarted, error: "Yetkazib berish turi noto‘g‘ri." }, { status: 400 });
      }

      if (botGuard) {
        const current = await botGuard.authorize();
        if (!current || current.active !== true || current.data?.active === false || current.id !== user.id || current.shop_id !== botGuard.shopId || !["admin", "manager", "cashier"].includes(current.role)) {
          throw httpError("Xodim ruxsati o‘zgargan.", 403);
        }
      }

      let shopId = String(body?.shop_id || "");
      if (["cashier", "manager"].includes(user.role)) {
        if (!user.shop_id) {
          return Response.json({ request_not_started: !requestStarted, error: "Sizga do‘kon biriktirilmagan." }, { status: 403 });
        }
        shopId = user.shop_id;
      }
      if (!shopId) {
        return Response.json({ request_not_started: !requestStarted, error: "Do‘kon tanlanishi kerak." }, { status: 400 });
      }
      const shop = await service.entities.Shop.get(shopId);
      if (!shop || shop.active === false) {
        return Response.json({ request_not_started: !requestStarted, error: "Do‘kon topilmadi yoki faol emas." }, { status: 404 });
      }

      const { customer_id: resolvedCustomerId } = await ensureCustomer(service, {
        customer_id: String(body?.customer_id || ""), name: customerName, phone: customerPhone,
      });

      const requestedItems = Array.isArray(body?.items) ? body.items : [];
      if (!requestedItems.length) {
        return Response.json({ request_not_started: !requestStarted, error: "Kamida bitta mahsulot qo‘shing." }, { status: 400 });
      }
      const normalizedItems = await normalizeOrderItems(service, requestedItems, orderType, shop.id, botGuard);
      const subtotal = normalizedItems.reduce((sum, item) => sum + item.line_total, 0);

      let deliveryFee = 0;
      if (fulfilmentType === "delivery") {
        if (orderType === "toy_va_bazmlar") {
          deliveryFee = 0;
        } else {
          deliveryFee = money(body?.delivery_fee || 0);
          if (deliveryFee < 0) {
            return Response.json({ request_not_started: !requestStarted, error: "Yetkazib berish narxi manfiy bo‘lishi mumkin emas." }, { status: 400 });
          }
        }
      }

      const adjustmentAmount = money(body?.adjustment_amount || 0);
      const adjustmentReason = String(body?.adjustment_reason || "").trim();
      if (adjustmentAmount !== 0) {
        if (user.role !== "admin") {
          return Response.json({ request_not_started: !requestStarted, error: "Chegirma yoki qo‘shimcha faqat egasi tomonidan kiritiladi." }, { status: 403 });
        }
        if (adjustmentReason.length < 3) {
          return Response.json({ request_not_started: !requestStarted, error: "Chegirma/qo‘shimcha uchun izoh majburiy." }, { status: 400 });
        }
      }
      const originalCalculatedTotal = subtotal + deliveryFee;
      const total = Math.max(0, originalCalculatedTotal + adjustmentAmount);

      if (botGuard && (total !== botGuard.expectedTotal || body?.advance_payment || fulfilmentType !== "pickup" || adjustmentAmount !== 0 || normalizedItems.length !== 1 || normalizedItems[0].quantity !== 1)) {
        throw httpError("Buyurtma shartlari o‘zgardi. Qayta tekshirish kerak.", 409);
      }
      const advance = body?.advance_payment || null;
      let paidAmount = 0;
      let shiftForPayment: any = null;
      let advanceMethod = "";
      if (advance) {
        advanceMethod = String(advance?.method || "");
        const advanceAmount = money(advance?.amount || 0);
        if (!PAYMENT_METHODS.has(advanceMethod) || advanceAmount <= 0) {
          return Response.json({ request_not_started: !requestStarted, error: "Avans to‘lov usuli yoki summasi noto‘g‘ri." }, { status: 400 });
        }
        if (advanceAmount > total) {
          return Response.json({ request_not_started: !requestStarted, error: "Avans summasi buyurtma summasidan oshmasligi kerak." }, { status: 400 });
        }
        paidAmount = advanceAmount;
        shiftForPayment = await findOpenShift(service, user.id, shop.id);
        if (!shiftForPayment && advanceMethod === "cash") {
          return Response.json({ request_not_started: !requestStarted, error: "Naqd avans uchun ushbu do‘konda smenani oching." }, { status: 409 });
        }
      }
      const now = new Date().toISOString();
      const day = now.slice(0, 10).replaceAll("-", "");
      const orderNumber = `BO-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const userName = user.full_name || user.email || "Noma’lum xodim";

      if (botGuard) {
        const current = await botGuard.authorize();
        const currentShop = await service.entities.Shop.get(botGuard.shopId);
        if (!current || current.active !== true || current.data?.active === false || current.id !== user.id || current.shop_id !== shop.id || current.shop_id !== botGuard.shopId || !["admin", "manager", "cashier"].includes(current.role) || !currentShop || currentShop.active === false) {
          throw httpError("Xodim ruxsati yoki do‘koni o‘zgargan.", 403);
        }
      }

      const settingsRows = await service.entities.Settings.list("-created_date", 2);
      if (settingsRows.length !== 1) throw paymentPending("Buyurtma sozlamasi tekshirilsin.");
      const claimKey = await orderRequestFingerprint({ key: idempotencyKey });
      requestStarted = true;
      const creationClaim = await service.entities.Settings.updateMany({ id: settingsRows[0].id, customer_order_request_keys: { $nin: [claimKey] } },
        { $push: { customer_order_request_keys: claimKey } });
      if (!creationClaim?.success || Number(creationClaim.updated || 0) !== 1) throw paymentPending("Buyurtma oldin boshlangan. Natijani qayta tekshiring; yangi buyurtma yaratmang.");
      const orderSequence = await allocateCustomerOrderSequence(service);
      try {
        const orderPayload = {
          order_sequence: orderSequence,
          order_number: orderNumber,
          order_type: orderType,
          shop_id: shop.id,
          shop_name_snapshot: shop.name,
          customer_id: resolvedCustomerId || undefined,
          customer_name: customerName,
          customer_phone: customerPhone,
          required_date: requiredDate,
          required_time: requiredTime,
          fulfilment_type: fulfilmentType,
          delivery_address: fulfilmentType === "delivery" ? String(body?.delivery_address || "") : "",
          reference_image: String(body?.reference_image || ""),
          notes: String(body?.notes || ""),
          cake_shape: String(body?.cake_shape || ""),
          subtotal,
          delivery_fee: deliveryFee,
          adjustment_amount: adjustmentAmount,
          adjustment_reason: adjustmentReason || undefined,
          original_calculated_total: originalCalculatedTotal,
          total,
          paid_amount: 0,
          remaining_balance: total,
          payment_status: total <= 0 ? "paid" : "unpaid",
          order_status: "qabul_qilindi",
          ready_inventory_state: "pending",
          creator_id: user.id,
          creator_name: userName,
          creator_role: user.role,
          idempotency_key: idempotencyKey,
          request_fingerprint: requestFingerprint,
          creation_state: "pending",
          creation_item_count: normalizedItems.length,
          ...(advance ? { creation_advance_shift_id: shiftForPayment?.id || "" } : {}),
          created_at: now,
        };
        try { createdOrder = await service.entities.CustomerOrder.create(orderPayload); }
        catch {
          const saved = await service.entities.CustomerOrder.filter({ idempotency_key: idempotencyKey });
          if (saved.length !== 1 || saved[0].request_fingerprint !== requestFingerprint) throw paymentPending();
          createdOrder = saved[0];
        }

        const itemPayloads = normalizedItems.map((item) => ({
          order_id: createdOrder.id,
          order_number_snapshot: orderNumber,
          shop_id: shop.id,
          ...item,
        }));
        try { createdItems = await service.entities.CustomerOrderItem.bulkCreate(itemPayloads); }
        catch {
          createdItems = await service.entities.CustomerOrderItem.filter({ order_id: createdOrder.id }, "id", 10000);
          if (createdItems.length !== itemPayloads.length) throw paymentPending("Buyurtma mahsulotlari to‘liq tasdiqlanmadi. Egasi tekshirishi kerak.");
        }

        if (advance) {
          const paymentIdempotency = String(advance?.idempotency_key || `${idempotencyKey}-adv`);
          const result = await recordCustomerOrderPayment(service, user, { order_id: createdOrder.id, payment_kind: "advance", method: advanceMethod,
            amount: paidAmount, idempotency_key: paymentIdempotency }, true);
          createdPayment = result.payment;
          createdOrder = result.order;
        }
        await service.entities.CustomerOrder.updateMany({ id: createdOrder.id, request_fingerprint: requestFingerprint }, { $set: { creation_state: "completed" } });
        createdOrder = await service.entities.CustomerOrder.get(createdOrder.id);

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "order_created",
          details: `${orderNumber} · ${shop.name} · ${total} UZS${paidAmount ? ` · avans ${paidAmount}` : ""}`,
        }).catch(() => {});

        return Response.json({
          order: createdOrder,
          items: createdItems,
          payment: createdPayment,
          runtime_version: ORDER_RUNTIME_VERSION,
        });
      } catch (error) {
        // Preserve all financial snapshots and durable claims after any uncertain
        // reply. Retries reconcile known results; no destructive compensation.
        throw error;
      }
  } catch (error) {
    if (!requestStarted && !(error as any)?.operation_pending) (error as any).request_not_started = true;
    if (requestStarted) (error as any).operation_pending = true;
    throw error;
  }
}
