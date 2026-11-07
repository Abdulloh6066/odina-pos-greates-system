// Opening liabilities are not purchases: no receipt, stock, shift or money
// ledger is written here. One immutable opening entry is allowed per recipient.
const fail = (message: string, status = 400, pending = false) => Object.assign(
  new Error(message), { status, operation_pending: pending, request_not_started: !pending },
);
const CLAIM = 'opening_debt_claim';
const fingerprint = (user: any, input: any) => JSON.stringify([
  user.id, input.supplier_id, input.amount, input.effective_date, input.notes,
]);
const publicDebt = ({ request_fingerprint: _fingerprint, payment_operations_json: _journal, ...row }: any) => row;

export async function allOpeningDebts(service: any, query: any = {}) {
  const rows: any[] = [];
  for (let skip = 0; ; skip += 500) {
    const page = await service.entities.SupplierOpeningDebt.filter(query, 'created_date', 500, skip);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

export async function listOpeningDebts(service: any, user: any) {
  if (user.role !== 'admin' || user.active === false) throw fail('Boshlang‘ich qarzlar faqat egasi uchun ochiq.', 403);
  const opening = await allOpeningDebts(service);
  const payments: any[] = [];
  for (let skip = 0; ; skip += 500) {
    const page = await service.entities.SupplierPayment.filter({ debt_type: 'opening', payment_source: 'budget' }, '-paid_at', 500, skip);
    payments.push(...page.map(({ request_fingerprint: _fingerprint, ...row }: any) => row));
    if (page.length < 500) break;
  }
  return { opening_debts: opening.map(publicDebt), payments };
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
