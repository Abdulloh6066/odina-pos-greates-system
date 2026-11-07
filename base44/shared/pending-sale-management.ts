// Review the device queue without turning uncertain requests into duplicate sales.
// The resolution and the original checkout fence are written atomically on Shift.
import { userShopId, userLabel } from "./user-helpers.ts";

const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
export function pendingSaleResolutions(shift: any) {
  const raw = shift?.pos_queue_resolutions_json;
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch { throw fail("Navbat qarorlari tarixini o‘qib bo‘lmadi. Egasi tekshirishi kerak."); }
}

export async function managePendingSale(service: any, user: any, body: any, deps: any) {
  const original = body?.original_request;
  const key = String(original?.idempotency_key || "");
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(key) || !original?.shift_id
    || !Array.isArray(original.items) || !original.items.length || original.items.length > 100
    || !Array.isArray(original.payments) || original.payments.length > 10) {
    throw fail("Saqlangan savdo ma’lumoti to‘liq emas.", 400);
  }
  // Restaurant orders have their own server locks/cancellation workflow.
  if (original.table_number != null || original.table_order_id || original.takeaway_order_id) {
    throw fail("Stol yoki saqlangan buyurtmani o‘z oynasidan tekshiring.");
  }
  const shift = await service.entities.Shift.get(String(original.shift_id));
  if (!shift || shift.user_id !== user.id || (user.role !== "admin" && userShopId(user) !== shift.shop_id)) {
    throw fail("Faqat o‘z smenangizdagi savdolarni tekshirishingiz mumkin.", 403);
  }
  const shop = await service.entities.Shop.get(shift.shop_id);
  if (!shop || shop.active === false) throw fail("Faol do‘kon topilmadi.", 403);
  const fingerprint = await deps.fingerprint(original);
  const resolving = body.action === "resolve_pending_sale";
  const operation = String(body.operation || "");
  if (resolving && !["edit", "cancel"].includes(operation)) throw fail("Amal noto‘g‘ri.", 400);
  if (resolving && !await deps.verifyPin(service, body.owner_pin, user)) {
    throw fail("Tahrirlash yoki bekor qilish uchun egasi PIN-kodi kerak.", 403);
  }
  const resolutions = pendingSaleResolutions(shift);
  const prior = resolutions[key];
  if (prior) {
    if (prior.original_fingerprint !== fingerprint || prior.user_id !== user.id
      || (resolving && (prior.state !== (operation === "edit" ? "edited" : "cancelled")
        || (operation === "edit" && prior.final_total !== body.final_total)))) {
      throw fail("Bu savdo uchun boshqa qaror saqlangan. Holatini qayta tekshiring.");
    }
    return { ...prior, original_key: key, shift_status: shift.status };
  }
  const matches = await service.entities.Sale.filter({ idempotency_key: key }, "-created_date", 2);
  if ((matches || []).length > 1) throw fail("Takroriy savdo yozuvi topildi. Egasi tekshirishi kerak.");
  const sale = matches?.[0];
  if (sale) {
    if (sale.user_id !== user.id || sale.shift_id !== shift.id || sale.shop_id !== shift.shop_id
      || (sale.request_fingerprint && sale.request_fingerprint !== fingerprint)) {
      throw fail("Savdo kaliti boshqa yozuvga tegishli.", 403);
    }
    if (resolving) throw fail("Savdo serverda mavjud. Uni navbatdan tahrirlab yoki bekor qilib bo‘lmaydi; savdolar tarixini tekshiring.");
    const complete = sale.financial_records_version < 3 || !sale.financial_records_version
      || (shift.sale_request_keys || []).includes("sale-completed:" + key);
    return { state: complete ? "confirmed" : "processing", original_key: key,
      shift_status: shift.status, ...(complete ? { sale, shift } : {}) };
  }
  if ((shift.sale_request_keys || []).includes(key)) {
    if (resolving) throw fail("Savdo serverda yakunlanmoqda yoki tekshiruv talab qiladi. Hozir tahrirlamang yoki bekor qilmang.");
    return { state: "processing", original_key: key, shift_status: shift.status };
  }
  let items: any[] = [], pricingError = "";
  try { items = await deps.normalizeItems(service, original.items, shift.shop_id); }
  catch (error) { pricingError = error instanceof Error ? error.message : "Narxni tekshirib bo‘lmadi."; }
  const subtotal = items.reduce((sum: number, row: any) => sum + row.subtotal, 0);
  const paidTotal = original.payments.reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0);
  if (!resolving) return { state: "pending", original_key: key, shift_status: shift.status,
    subtotal: pricingError ? null : subtotal, paid_total: paidTotal, items, pricing_error: pricingError };

  const reason = String(body.reason || "").trim();
  if (!reason || reason.length > 500) throw fail("Sababni kiriting (500 belgigacha).", 400);
  if (!["open", "closed"].includes(shift.status)) throw fail("Smena yopilmoqda. Tugashini kuting.");
  const now = new Date().toISOString();
  const result: any = { state: operation === "edit" ? "edited" : "cancelled", original_key: key,
    original_fingerprint: fingerprint, original_request_json: deps.canonical(original),
    user_id: user.id, user_name: userLabel(user), shop_id: shift.shop_id, shift_id: shift.id,
    reason, resolved_at: now, shift_status: shift.status };
  if (operation === "edit") {
    if (shift.status !== "open") throw fail("Smena yopilgan. Tahrirlab qayta yuborish yopiq smena hisobotini o‘zgartiradi; egasi alohida tekshirishi kerak.");
    if (pricingError) throw fail(pricingError);
    const total = body.final_total;
    if (!Number.isSafeInteger(total) || total <= 0 || total > subtotal || !Number.isSafeInteger(subtotal)) {
      throw fail("Yakuniy summa musbat bo‘lsin va mahsulotlar jamidan oshmasin.", 400);
    }
    const methods = deps.paymentMethods;
    if (!original.payments.length || original.payments.some((row: any) => !methods.has(row.method)
      || !Number.isFinite(row.amount) || row.amount <= 0) || !Number.isFinite(paidTotal) || paidTotal <= 0) {
      throw fail("Saqlangan to‘lov usullari yoki summasi noto‘g‘ri.", 400);
    }
    let assigned = 0;
    const payments = original.payments.map((row: any, index: number) => {
      const amount = index === original.payments.length - 1 ? deps.money(total - assigned)
        : Math.floor(total * 100 * row.amount / paidTotal) / 100;
      assigned = deps.money(assigned + amount);
      return { method: row.method, amount, reference: String(row.reference || "").slice(0, 200) };
    }).filter((row: any) => row.amount > 0);
    result.final_total = total;
    result.subtotal = subtotal;
    result.items = items;
    result.request = { action: "complete_sale", shift_id: shift.id,
      items: JSON.parse(deps.canonical(original)).items, payments,
      ...(original.is_delivery === true ? { is_delivery: true } : {}),
      ...(subtotal > total ? { manual_discount_amount: subtotal - total } : {}),
      idempotency_key: "pos-repair-" + crypto.randomUUID(), recorded_at: original.recorded_at };
  }
  // The same original key is used by checkout's CAS. Either checkout wins, or
  // this tombstone wins, including a delayed original request in another tab.
  const journalQuery = shift.pos_queue_resolutions_json == null
    ? { $or: [{ pos_queue_resolutions_json: { $exists: false } }, { pos_queue_resolutions_json: null }] }
    : { pos_queue_resolutions_json: shift.pos_queue_resolutions_json };
  const claim = await service.entities.Shift.updateMany({
    id: shift.id, user_id: user.id, status: shift.status,
    sale_request_keys: { $ne: key }, ...journalQuery,
  }, { $push: { sale_request_keys: key },
    $set: { pos_queue_resolutions_json: JSON.stringify({ ...resolutions, [key]: result }) } });
  if (!claim?.success || Number(claim.updated) !== 1) {
    throw fail("Savdo yoki smena holati o‘zgardi. Holatini qayta tekshiring.");
  }
  // The atomic journal above is the durable audit; a secondary log is optional.
  try { await service.entities.ActionHistory.create({ user_id: user.id, user_name: userLabel(user),
    action: operation === "edit" ? "pending_sale_edited" : "pending_sale_cancelled",
    details: JSON.stringify({ original_key: key, shift_id: shift.id, shop_id: shift.shop_id,
      final_total: result.final_total, reason }) }); } catch { /* Already durably journaled. */ }
  return result;
}
