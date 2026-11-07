// Opening liabilities are not purchases: no receipt, stock, shift or money
// ledger is written here. One immutable opening entry is allowed per recipient.
const fail = (message: string, status = 400, pending = false) => Object.assign(
  new Error(message), { status, operation_pending: pending, request_not_started: !pending },
);
const CLAIM = 'opening_debt_claim';
const fingerprint = (user: any, input: any) => JSON.stringify([
  user.id, input.supplier_id, input.amount, input.effective_date, input.notes,
]);
const emptyPaymentJournal = (value: any) => {
  if (value === undefined || value === null || value === '') return true;
  try { const parsed = JSON.parse(value); return parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object' && Object.keys(parsed).length === 0; } catch (_) { return false; }
};
const pristineAmount = (row: any) => row.corrected_debt_amount === undefined && row.amount_correction_key === undefined &&
  Number.isSafeInteger(row.debt_amount) && row.debt_amount > 0 && row.remaining_debt === row.debt_amount &&
  row.status === 'unpaid' && emptyPaymentJournal(row.payment_operations_json);
const exactField = (value: any) => value === undefined ? { $exists: false } : value;
const publicDebt = ({ request_fingerprint: _fingerprint, payment_operations_json: _journal, ...row }: any) => row;

export async function allOpeningDebts(service: any, query: any = {}) {
  const rows: any[] = [];
  for (let skip = 0; ; skip += 500) {
    const page = await service.entities.SupplierOpeningDebt.filter(query, 'created_date', 500, skip);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

export async function listOpeningDebts(service: any, user: any, locationId?: unknown) {
  if (user.role !== 'admin' || user.active === false) throw fail('Boshlang‘ich qarzlar faqat egasi uchun ochiq.', 403);
  if (locationId !== undefined && (typeof locationId !== 'string' || !locationId.trim())) {
    throw fail('Joylashuv noto‘g‘ri.');
  }
  const opening = await allOpeningDebts(service, locationId ? { location_id: locationId } : {});
  const openingIds = new Set(opening.map(row => row.id));
  const payments: any[] = [];
  const paymentDebtIds = new Set();
  // Page all opening payment evidence once, including non-budget/legacy rows.
  // Only Budget opening payments are returned to the owner's payment panel.
  if (openingIds.size) for (let skip = 0; ; skip += 500) {
    const page = await service.entities.SupplierPayment.filter({ opening_debt_id: { $in: [...openingIds] } }, '-paid_at', 500, skip);
    for (const row of page) paymentDebtIds.add(row.opening_debt_id);
    payments.push(...page.filter(row => row.debt_type === 'opening' && row.payment_source === 'budget')
      .map(({ request_fingerprint: _fingerprint, ...row }: any) => row));
    if (page.length < 500) break;
  }
  const opening_debts = opening.map(row => ({ ...publicDebt(row),
    can_correct_amount: pristineAmount(row) && !paymentDebtIds.has(row.id),
  }));
  return { opening_debts, payments };
}

export async function createOpeningDebt(service: any, user: any, input: any) {
  if (user.role !== 'admin' || user.active === false) throw fail('Boshlang‘ich qarzni faqat egasi kiritadi.', 403);
  if (typeof input.supplier_id !== 'string' || !input.supplier_id ||
    typeof input.amount !== 'number' || !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
    typeof input.effective_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.effective_date) ||
    !Number.isFinite(Date.parse(input.effective_date + 'T00:00:00Z')) ||
    new Date(input.effective_date + 'T00:00:00Z').toISOString().slice(0, 10) !== input.effective_date ||
    typeof input.notes !== 'string' || input.notes.length > 2000) {
    throw fail('Qabul qiluvchi, musbat butun summa va haqiqiy sana majburiy.');
  }
  const expected = fingerprint(user, input);
  const find = async () => {
    const rows = await service.entities.SupplierOpeningDebt.filter({ supplier_id: input.supplier_id }, 'created_date', 2);
    if (rows.length > 1) throw fail('Takroriy boshlang‘ich qarz topildi. Egasi tekshirishi kerak.', 409, true);
    if (!rows.length) return null;
    const row = rows[0];
    if (row.idempotency_key !== input.key || row.request_fingerprint !== expected) {
      throw fail('Bu qabul qiluvchining boshlang‘ich qarzi allaqachon kiritilgan. Uni qayta qo‘shmang.', 409);
    }
    return { opening_debt: publicDebt(row), already_processed: true };
  };
  const existing = await find();
  if (existing) return existing;
  const recipient = await service.entities.CashRecipient.get(input.supplier_id);
  if (!recipient || recipient.active === false || !['supplier', 'company'].includes(recipient.recipient_type)) {
    throw fail('Faol kompaniya yoki yetkazib beruvchini tanlang.', 404);
  }
  // CashRecipient is staff-readable. Store only a random opaque token, never
  // an amount-derived digest (small monetary domains can be brute-forced).
  const claim = crypto.randomUUID();
  if (recipient[CLAIM]) {
    const saved = await find();
    if (saved) return saved;
    throw fail('Boshlang‘ich qarz so‘rovi yakunlanmoqda yoki javobi noaniq. Yangi yozuv yaratmang; egasi tekshirishi kerak.', 409, true);
  }
  let result;
  try {
    result = await service.entities.CashRecipient.updateMany({ id: recipient.id,
      [CLAIM]: recipient[CLAIM] === undefined ? { $exists: false } : recipient[CLAIM],
    }, { $set: { [CLAIM]: claim } });
  } catch (error) {
    const saved = await service.entities.CashRecipient.get(recipient.id);
    if (saved?.[CLAIM] !== claim) throw fail('Boshlang‘ich qarz so‘rovi tasdiqlanmadi. Shu so‘rovni qayta tekshiring.', 503, true);
    result = { success: true, updated: 1 };
  }
  if (!result?.success || result.updated !== 1) {
    const saved = await find();
    if (saved) return saved;
    throw fail('Boshqa oynada boshlang‘ich qarz kiritilmoqda. Shu so‘rovni qayta tekshiring.', 409, true);
  }
  // A durable claim precedes the single create attempt. After timeout, only
  // reconcile; never automatically repeat a create whose outcome is unknown.
  try {
    const row = await service.entities.SupplierOpeningDebt.create({
      supplier_id: recipient.id, supplier_name_snapshot: recipient.name,
      debt_number: 'BQ-' + crypto.randomUUID().slice(0, 12).toUpperCase(),
      debt_amount: input.amount, remaining_debt: input.amount,
      effective_date: input.effective_date, notes: input.notes, status: 'unpaid',
      created_at: new Date().toISOString(), created_by_id: user.id,
      created_by_name: user.full_name || user.email || 'Egasi',
      idempotency_key: input.key, request_fingerprint: expected,
    });
    return { opening_debt: publicDebt(row), already_processed: false };
  } catch (error) {
    const saved = await find();
    if (saved) return saved;
    const status = Number(error?.response?.status || error?.status);
    if ([400, 401, 403, 404, 422].includes(status)) {
      // Only a definite rejection with no saved row may release this exact claim.
      const released = await service.entities.CashRecipient.updateMany({ id: recipient.id, [CLAIM]: claim }, { $set: { [CLAIM]: '' } });
      if (released?.success && released.updated === 1) throw fail('Boshlang‘ich qarz yozilmadi: ' + (error?.message || 'So‘rov rad etildi.'), status);
    }
    throw fail('Boshlang‘ich qarz yozuvi javobi noaniq. Yangi yozuv yaratmang; egasi tekshirishi kerak.', 503, true);
  }
}

// Attribution is an audited one-time metadata assignment, never a new liability.
// The conditional write changes no amount, effective date, payment or journal.
export async function assignOpeningDebtLocation(service: any, user: any, input: any) {
  if (user.role !== 'admin' || user.active === false) throw fail('Qarzni joylashuvga faqat egasi biriktiradi.', 403);
  if (typeof input.opening_debt_id !== 'string' || !input.opening_debt_id.trim() ||
    typeof input.location_id !== 'string' || !input.location_id.trim() ||
    typeof input.key !== 'string' || !input.key.trim()) throw fail('Qarz, joylashuv va so‘rov kaliti majburiy.');
  const entity = service.entities.SupplierOpeningDebt;
  const reconcile = (row: any) => {
    if (!row) throw fail('Boshlang‘ich qarz topilmadi.', 404);
    if (row.location_id === input.location_id) return { opening_debt: publicDebt(row), already_processed: true };
    if (row.location_id) throw fail('Qarz boshqa joylashuvga allaqachon biriktirilgan. Qayta biriktirish mumkin emas.', 409);
    return null;
  };
  const debt = await entity.get(input.opening_debt_id);
  const existing = reconcile(debt);
  if (existing) return existing;
  const location = await service.entities.Shop.get(input.location_id);
  if (!location || location.active !== true) throw fail('Faol joylashuvni tanlang.', 404);
  const recipient = await service.entities.CashRecipient.get(debt.supplier_id);
  if (!recipient || recipient.active === false || !Array.isArray(recipient.supplier_location_ids) ||
    !recipient.supplier_location_ids.includes(location.id)) throw fail('Yetkazib beruvchi bu joylashuvga biriktirilmagan.', 400);
  const fields = {
    location_id: location.id, location_name_snapshot: location.name,
    location_assigned_at: new Date().toISOString(), location_assigned_by_id: user.id,
    location_assigned_by_name: user.full_name || user.email || 'Egasi', location_assignment_key: input.key,
  };
  let result;
  try {
    result = await entity.updateMany({ id: debt.id,
      location_id: debt.location_id === undefined ? { $exists: false } : debt.location_id,
    }, { $set: fields });
  } catch (_) {
    // A lost reply may already have committed. Only reconcile observed state.
    let current;
    try { current = await entity.get(debt.id); } catch (_) {
      throw fail('Biriktirish natijasi noaniq. Shu so‘rovni qayta tekshiring.', 503, true);
    }
    const saved = reconcile(current);
    if (saved) return saved;
    throw fail('Biriktirish tasdiqlanmadi. Shu so‘rovni qayta tekshiring.', 503, true);
  }
  // Read back rather than manufacture a successful response from the payload.
  let current;
  try { current = await entity.get(debt.id); } catch (_) {
    throw fail('Biriktirish natijasi noaniq. Shu so‘rovni qayta tekshiring.', 503, true);
  }
  const saved = reconcile(current);
  if (saved) return { ...saved, already_processed: !(result?.success && result.updated === 1) };
  throw fail('Biriktirish tasdiqlanmadi. Shu so‘rovni qayta tekshiring.', 503, true);
}

// One audited principal correction before any payment activity. Original amount,
// creation claim, effective date and location remain immutable. No cash/stock writes.
export async function correctOpeningDebtAmount(service: any, user: any, input: any) {
  if (user.role !== 'admin' || user.active === false) throw fail('Qarz summasini faqat egasi tuzatadi.', 403);
  if (typeof input.opening_debt_id !== 'string' || !input.opening_debt_id.trim() ||
    typeof input.amount !== 'number' || !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
    typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000 ||
    typeof input.key !== 'string' || !input.key.trim()) throw fail('Qarz, musbat butun summa, sabab va so‘rov kaliti majburiy.');
  const entity = service.entities.SupplierOpeningDebt;
  const reconcile = (row: any) => {
    if (!row) throw fail('Boshlang‘ich qarz topilmadi.', 404);
    if (row.corrected_debt_amount !== undefined || row.amount_correction_key !== undefined) {
      if (row.corrected_debt_amount === input.amount && row.amount_correction_key === input.key &&
        row.amount_correction_reason === input.reason && row.amount_corrected_by_id === user.id) {
        return { opening_debt: { ...publicDebt(row), can_correct_amount: false }, already_processed: true };
      }
      throw fail('Qarz summasi avval tuzatilgan. Yana tuzatish mumkin emas.', 409);
    }
    return null;
  };
  const debt = await entity.get(input.opening_debt_id);
  const existing = reconcile(debt);
  if (existing) return existing;
  if (!pristineAmount(debt) || (await service.entities.SupplierPayment.filter({ opening_debt_id: debt.id }, 'created_date', 1)).length) {
    throw fail('To‘lov faoliyati bor qarz summasini tuzatish mumkin emas.', 409);
  }
  if (input.amount === debt.debt_amount) throw fail('Yangi summa avvalgi summadan farq qilishi kerak.');
  const fields = {
    corrected_debt_amount: input.amount, remaining_debt: input.amount,
    amount_correction_reason: input.reason, amount_correction_key: input.key,
    amount_corrected_at: new Date().toISOString(), amount_corrected_by_id: user.id,
    amount_corrected_by_name: user.full_name || user.email || 'Egasi',
  };
  let result;
  try {
    result = await entity.updateMany({ id: debt.id, debt_amount: debt.debt_amount,
      remaining_debt: debt.remaining_debt, status: debt.status,
      payment_operations_json: exactField(debt.payment_operations_json),
      corrected_debt_amount: { $exists: false }, amount_correction_key: { $exists: false },
    }, { $set: fields });
  } catch (_) {
    let current;
    try { current = await entity.get(debt.id); } catch (_) { throw fail('Tuzatish natijasi noaniq. Shu so‘rovni qayta tekshiring.', 503, true); }
    const saved = reconcile(current);
    if (saved) return saved;
    throw fail('Tuzatish tasdiqlanmadi. Shu so‘rovni qayta tekshiring.', 503, true);
  }
  let current;
  try { current = await entity.get(debt.id); } catch (_) { throw fail('Tuzatish natijasi noaniq. Shu so‘rovni qayta tekshiring.', 503, true); }
  const saved = reconcile(current);
  if (saved) return { ...saved, already_processed: !(result?.success && result.updated === 1) };
  throw fail('Qarz boshqa operatsiya bilan o‘zgardi. Tuzatish yozilmadi.', 409);
}
