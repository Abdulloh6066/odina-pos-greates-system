import { createOpeningDebt, assignOpeningDebtLocation } from './supplier-opening-debt.ts';
const fail = (message: string, status = 400, pending = false) => Object.assign(new Error(message), {
  status, operation_pending: pending, request_not_started: !pending,
});
const pending = () => fail('Qabul qiluvchi yaratish so‘rovi yakunlanmagan. Aynan shu so‘rovni qayta tekshiring; yangi yozuv yaratmang.', 503, true);
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
  .map(b => b.toString(16).padStart(2, '0')).join('');

// All debt intent stays in an admin-only journal. Public entities hold only
// opaque correlation identifiers. Creation is attempted once per claimed stage.
export async function createRecipient(service: any, user: any, input: any) {
  if (user.role !== 'admin' || user.active === false) throw fail('Qabul qiluvchini faqat egasi yaratadi.', 403);
  const value = input.recipient;
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 200 ||
    !['supplier', 'company'].includes(value.recipient_type) || typeof value.notes !== 'string' || value.notes.length > 2000 ||
    typeof value.active !== 'boolean' || !Array.isArray(value.supplier_location_ids) || value.supplier_location_ids.length > 100 ||
    value.supplier_location_ids.some((id: any) => typeof id !== 'string' || !id.trim()) ||
    typeof input.key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.key)) throw fail('Qabul qiluvchi ma’lumotlari noto‘g‘ri.');
  const recipient = { name: value.name.trim(), recipient_type: value.recipient_type, notes: value.notes.trim(), active: value.active,
    supplier_location_ids: [...new Set(value.supplier_location_ids)].sort() };
  const opening = input.opening_debt === undefined || input.opening_debt === null ? null : input.opening_debt;
  if (opening !== null && (typeof opening !== 'object' || Array.isArray(opening))) throw fail('Boshlang‘ich qarz ma’lumotlari noto‘g‘ri.');
  if (opening && (!recipient.active || !Number.isSafeInteger(opening.amount) || opening.amount <= 0 ||
    typeof opening.effective_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(opening.effective_date) ||
    !Number.isFinite(Date.parse(opening.effective_date + 'T00:00:00Z')) ||
    new Date(opening.effective_date + 'T00:00:00Z').toISOString().slice(0, 10) !== opening.effective_date ||
    typeof opening.location_id !== 'string' || !recipient.supplier_location_ids.includes(opening.location_id))) {
    throw fail('Boshlang‘ich qarz uchun musbat butun summa, haqiqiy sana va biriktirilgan ombor kerak.');
  }
  const frozen = JSON.stringify({ actor: user.id, recipient, opening: opening ? {
    amount: opening.amount, effective_date: opening.effective_date, location_id: opening.location_id,
  } : null });
  const token = await digest(JSON.stringify([user.id, input.key]));
  const requests = service.entities.RecipientCreationRequest;
  const findRequest = async () => {
    const rows = await requests.filter({ request_token: token }, 'created_date', 2);
    if (rows.length > 1) throw pending();
    if (rows[0] && rows[0].request_fingerprint !== frozen) throw fail('Saqlangan so‘rov o‘zgargan. Avvalgi ma’lumot bilan qayta tekshiring.', 409, true);
    return rows[0] || null;
  };
  let request = await findRequest();
  const settingsRows = await service.entities.Settings.list('created_date', 2);
  if (settingsRows.length !== 1) throw fail('Yaratish uchun yagona tizim sozlamasi kerak.', 409, Boolean(request));
  const settings = settingsRows[0];
  if (!request) {
    // Validate every selected destination before the first write.
    for (const id of recipient.supplier_location_ids) {
      const location = await service.entities.Shop.get(id);
      if (!location || location.active !== true) throw fail('Faqat faol joylashuvni tanlang.');
    }
    if ((settings.recipient_creation_request_keys || []).includes(token)) throw pending();
    let claim;
    try {
      claim = await service.entities.Settings.updateMany({ id: settings.id,
        recipient_creation_request_keys: { $nin: [token] },
      }, { $push: { recipient_creation_request_keys: token } });
    } catch (_) { throw pending(); } // No request record => do not replay an uncertain create.
    if (!claim?.success || claim.updated !== 1) throw pending();
    try { request = await requests.create({ request_token: token, request_fingerprint: frozen, actor_id: user.id, recipient_state: 'not_started', completed: false }); }
    catch (_) { request = await findRequest(); if (!request) throw pending(); }
  }
  try {
    const findRecipient = async () => {
      const rows = await service.entities.CashRecipient.filter({ creation_request_id: request.id }, 'created_date', 2);
      if (rows.length > 1) throw pending();
      return rows[0] || null;
    };
    let savedRecipient = await findRecipient();
    if (!savedRecipient) {
      const current = await requests.get(request.id);
      if (current?.recipient_state !== 'not_started') throw pending();
      // Only the caller that observes successful CAS can attempt create.
      const claimed = await requests.updateMany({ id: request.id, recipient_state: 'not_started' }, { $set: { recipient_state: 'started' } });
      if (!claimed?.success || claimed.updated !== 1) throw pending();
      try { savedRecipient = await service.entities.CashRecipient.create({ ...recipient, creation_request_id: request.id,
        created_by: user.id, created_by_name: user.full_name || user.email || 'Egasi' }); }
      catch (error) {
        savedRecipient = await findRecipient();
        if (!savedRecipient) {
          if ([400, 401, 403, 404, 422].includes(Number(error?.response?.status || error?.status))) {
            // Definite rejection proves no create occurred; preserve frozen intent.
            await requests.updateMany({ id: request.id, recipient_state: 'started' }, { $set: { recipient_state: 'not_started' } });
          }
          throw pending();
        }
      }
    }
    let debt = null;
    if (opening) {
      const created = await createOpeningDebt(service, user, { supplier_id: savedRecipient.id, amount: opening.amount,
        effective_date: opening.effective_date, notes: '', key: input.key });
      const assigned = await assignOpeningDebtLocation(service, user, { opening_debt_id: created.opening_debt.id,
        location_id: opening.location_id, key: input.key });
      debt = assigned.opening_debt;
    }
    await requests.updateMany({ id: request.id, request_fingerprint: frozen }, { $set: { recipient_id: savedRecipient.id,
      opening_debt_id: debt?.id || '', completed: true } });
    const final = await requests.get(request.id);
    if (!final?.completed || final.recipient_id !== savedRecipient.id || final.opening_debt_id !== (debt?.id || '')) throw pending();
    return { recipient: savedRecipient, opening_debt: debt, already_processed: Boolean(request.completed) };
  } catch (error) {
    // A recipient or debt may already exist. Never tell the UI to discard intent.
    throw fail(error instanceof Error ? error.message : 'Yaratish yakunlanmadi.', Number(error?.status) || 503, true);
  }
}
