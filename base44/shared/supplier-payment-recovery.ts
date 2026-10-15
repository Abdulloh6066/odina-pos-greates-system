// Durable financial request claims live on existing balance/shift records. Every
// balance/debt delta and its marker are committed in the same conditional write.
// A timeout never authorizes replaying an unconfirmed ledger create.
const money = (value: unknown) => Math.round(Number(value) || 0);
const JOURNAL = "financial_operations_json";
const SHIFT_JOURNAL = "supplier_payment_operations_json";
const DEBT_JOURNAL = "payment_operations_json";
const INIT_JOURNAL = "budget_account_initialization_json";

const fail = (message: string, status = 503, pending = true) =>
  Object.assign(new Error(message), { status, operation_pending: pending });
const journal = (row: any, field: string) => {
  if (!row?.[field]) return {};
  try {
    const parsed = JSON.parse(row[field]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw fail("Moliyaviy operatsiya holatini egasi tekshirishi kerak."); }
};
const journalPredicate = (row: any, field: string) =>
  row[field] === undefined ? { $exists: false } : row[field];
const rejected = (error: any) => [400, 401, 403, 404, 422].includes(
  Number(error?.response?.status || error?.status || 0),
);

export function financialRequestKey(body: any) {
  const key = String(body?.idempotency_key || body?.request_id || "");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw fail("Moliyaviy so‘rov kaliti majburiy yoki noto‘g‘ri.", 400, false);
  }
  return key;
}

// Also used by shift closing: first creation is claimed on an already existing
// app settings row, so concurrent first deposits cannot create two accounts.
export async function ensureBudgetAccount(service: any, account: string, label: string, user: any) {
  const find = async () => {
    const rows = await service.entities.BudgetBalance.filter({ account });
    if (rows.length > 1) throw fail(`${label} uchun takroriy Budget balansi topildi.`, 409);
    return rows[0] || null;
  };
  const found = await find();
  if (found) return found;
  const settings = await service.entities.Settings.list("created_date", 2);
  if (settings.length !== 1) throw fail("Budget hisobini yaratish uchun ilova sozlamasini egasi tekshirishi kerak.", 409);
  const entity = service.entities.Settings;
  const id = settings[0].id;
  const token = crypto.randomUUID();
  let claimed = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await entity.get(id);
    const operations = journal(row, INIT_JOURNAL);
    const prior = operations[account];
    if (prior && prior.status !== "rejected") {
      const existing = await find();
      if (existing) return existing;
      throw fail("Budget hisobi yaratilmoqda yoki javobi noaniq. Shu amalni qayta tekshiring.");
    }
    operations[account] = { token, status: "creating" };
    const result = await entity.updateMany(
      { id, [INIT_JOURNAL]: journalPredicate(row, INIT_JOURNAL) },
      { $set: { [INIT_JOURNAL]: JSON.stringify(operations) } },
    ).catch(async (error: any) => {
      const latest = await entity.get(id);
      if (journal(latest, INIT_JOURNAL)[account]?.token === token) return { success: true, updated: 1 };
      throw error;
    });
    if (result?.success && Number(result.updated) === 1) { claimed = true; break; }
  }
  if (!claimed) throw fail("Budget hisobi boshqa oynada yaratilmoqda.");
  // Re-read after claiming, in case an older writer initialized the account.
  const existing = await find();
  if (existing) return existing;
  try {
    return await service.entities.BudgetBalance.create({
      account, label, balance: 0, updated_at: new Date().toISOString(),
      updated_by_id: user.id, updated_by_name: user.full_name || user.email,
    });
  } catch (error) {
    const saved = await find();
    if (saved) return saved;
    if (rejected(error)) {
      const row = await entity.get(id);
      const operations = journal(row, INIT_JOURNAL);
      if (operations[account]?.token === token) {
        operations[account].status = "rejected";
        await entity.updateMany({ id, [INIT_JOURNAL]: journalPredicate(row, INIT_JOURNAL) },
          { $set: { [INIT_JOURNAL]: JSON.stringify(operations) } });
      }
      throw error;
    }
    throw fail("Budget hisobini yaratish javobi noaniq. Egasi tekshirishi kerak.");
  }
}

// Conditional journal updates serialize workers while $inc keeps unrelated
// concurrent sales, withdrawals, and other supplier payments intact.
async function mutate(entity: any, id: string, field: string, key: string,
  change: (operation: any, row: any) => any) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const row = await entity.get(id);
    if (!row) throw fail("Moliyaviy yozuv topilmadi.", 404);
    const operations = journal(row, field);
    const original = operations[key];
    const next = original ? structuredClone(original) : null;
    const update = change(next, row);
    if (update?.skip) return { row, operation: original };
    const operation = update.operation || next;
    operation.revision = crypto.randomUUID();
    operations[key] = operation;
    const query = { id, [field]: journalPredicate(row, field), ...(update.query || {}) };
    const values = { ...(update.set || {}), [field]: JSON.stringify(operations) };
    let result;
    try { result = await entity.updateMany(query, { $set: values, ...(update.inc ? { $inc: update.inc } : {}) }); }
    catch (error) {
      const saved = await entity.get(id);
      const recorded = journal(saved, field)[key];
      if (recorded?.revision === operation.revision) return { row: saved, operation: recorded };
      // The read confirms this conditional revision did not save. A transient
      // transport error can be retried against the next fresh snapshot.
      if (rejected(error)) throw error;
      continue;
    }
    if (result?.success && Number(result.updated) === 1) {
      const saved = await entity.get(id);
      return { row: saved, operation: journal(saved, field)[key] };
    }
  }
  throw fail("Moliyaviy yozuv bir vaqtda o‘zgardi. Shu so‘rovni qayta tekshiring.");
}

function own(operation: any, token: string) {
  if (!operation || operation.worker !== token) throw fail("Bu to‘lov boshqa oynada yakunlanmoqda.");
}

async function claim(source: any, field: string, key: string, fingerprint: string,
  actor: string, create: () => Promise<any>) {
  const token = crypto.randomUUID();
  const initial = journal(source.row, field)[key];
  if (initial && (initial.fingerprint !== fingerprint || initial.actor !== actor)) {
    throw fail("Bu so‘rov kaliti boshqa to‘lov ma’lumotlari uchun ishlatilgan.", 409, false);
  }
  // Validation/planning uses only a new request. Retries use the stored plan,
  // including debts that have since become fully paid or a shift now closed.
  const blueprint = initial ? null : await create();
  const result = await mutate(source.entity, source.row.id, field, key, (operation: any, row: any) => {
    if (operation) {
      if (operation.fingerprint !== fingerprint || operation.actor !== actor) {
        throw fail("Bu so‘rov kaliti boshqa to‘lov ma’lumotlari uchun ishlatilgan.", 409, false);
      }
      if (operation.status === "completed") return { skip: true };
      if (operation.status === "reversed") {
        throw Object.assign(fail("To‘lov yozilmadi va mablag‘ qaytarildi. Yangi so‘rov bilan urinib ko‘ring.", 409, false), { operation_reversed: true });
      }
      if (operation.worker) throw fail("To‘lov yakunlanmoqda. Shu so‘rovni qayta tekshiring.");
      operation.worker = token;
      operation.status = "processing";
      return { operation };
    }
    if (source.kind === "shift" && row.status !== "open") {
      throw fail("Smena yopilmoqda yoki yopilgan. Yangi to‘lov boshlanmaydi.", 409, false);
    }
    return { operation: { ...blueprint, fingerprint, actor, worker: token, status: "processing" },
      query: source.kind === "shift" ? { status: "open" } : {} };
  });
  return { ...result, token, already: result.operation.status === "completed" };
}

async function stage(source: any, field: string, key: string, token: string, values: any) {
  return mutate(source.entity, source.row.id, field, key, (operation: any) => {
    own(operation, token);
    Object.assign(operation, values);
    return { operation };
  });
}

async function debit(source: any, field: string, key: string, token: string, user: any) {
  return mutate(source.entity, source.row.id, field, key, (operation: any, row: any) => {
    own(operation, token);
    if (operation.source_applied) return { skip: true };
    const column = source.kind === "budget" ? "balance" : "expected_cash";
    const before = money(row[column]);
    const delta = operation.direction === "in" ? operation.amount : -operation.amount;
    if (before + delta < 0) throw fail("Tanlangan hisobda pul yetarli emas.", 400, false);
    if (source.kind === "shift" && row.status !== "open") throw fail("Smena ochiq emas.", 409, false);
    operation.source_applied = true;
    operation.balance_before = before;
    operation.balance_after = before + delta;
    return { operation, query: { [column]: Number(row[column] || 0), ...(source.kind === "shift" ? { status: "open" } : {}) },
      inc: { [column]: delta, ...(source.kind === "shift" ? { cash_removed: operation.amount } : {}) },
      set: source.kind === "budget" ? { updated_at: new Date().toISOString(), updated_by_id: user.id, updated_by_name: user.full_name || user.email } : {} };
  });
}

async function debtDelta(service: any, allocation: any, marker: string, reverse = false) {
  return mutate(service.entities.SupplierReceipt, allocation.receipt_id, DEBT_JOURNAL, marker,
    (operation: any, row: any) => {
      if (operation?.amount && operation.amount !== allocation.amount) throw fail("Qarz operatsiyasi ma’lumotlari mos emas.", 409);
      if (reverse && operation?.state !== "applied") return { skip: true };
      if (!reverse && operation?.state === "applied") return { skip: true };
      if (!reverse && operation?.state === "reversed") throw fail("Bu qarz operatsiyasi avval qaytarilgan.", 409);
      const before = money(row.remaining_debt);
      if (["cancelled", "cancelling"].includes(row.status)) throw fail("Kirim bekor qilingan yoki bekor qilinmoqda.", 409, false);
      const after = before + (reverse ? allocation.amount : -allocation.amount);
      if (after < 0) throw fail("Qarz boshqa to‘lov bilan o‘zgardi. Shu to‘lovni tekshiring.", 409, false);
      return { operation: { amount: allocation.amount, state: reverse ? "reversed" : "applied" },
        query: { remaining_debt: Number(row.remaining_debt || 0), status: row.status },
        inc: { remaining_debt: reverse ? allocation.amount : -allocation.amount },
        set: { status: after <= 0 ? "paid" : after < money(row.debt_amount) ? "partial" : "unpaid" } };
    });
}

// The create intent is persisted before sending the write. A pending retry may
// reconcile a saved row but must never resubmit an ambiguous empty create.
async function ledger(source: any, field: string, key: string, token: string,
  stageName: string, entity: any, query: any, data: () => any) {
  const existing = await entity.filter(query, "created_date", 2);
  if (existing.length > 1) throw fail("Takroriy to‘lov tarixi topildi. Egasi tekshirishi kerak.", 409);
  if (existing[0]) {
    if (existing[0].request_fingerprint !== data().request_fingerprint) throw fail("To‘lov tarixi so‘rovga mos emas.", 409);
    await stage(source, field, key, token, { [stageName]: "saved" });
    return existing[0];
  }
  const current = journal(await source.entity.get(source.row.id), field)[key];
  own(current, token);
  if (current[stageName] === "creating" || current[stageName] === "uncertain") {
    throw fail("To‘lov yozuvi javobi noaniq. Yangi to‘lov yubormang; egasi tekshirishi kerak.");
  }
  await stage(source, field, key, token, { [stageName]: "creating" });
  try {
    const saved = await entity.create(data());
    await stage(source, field, key, token, { [stageName]: "saved" });
    return saved;
  } catch (error) {
    const saved = await entity.filter(query, "created_date", 2);
    if (saved.length === 1 && saved[0].request_fingerprint === data().request_fingerprint) {
      await stage(source, field, key, token, { [stageName]: "saved" });
      return saved[0];
    }
    if (rejected(error) && saved.length === 0) {
      await stage(source, field, key, token, { [stageName]: "rejected" });
      throw error;
    }
    await stage(source, field, key, token, { [stageName]: "uncertain" });
    throw fail("To‘lov yozuvi javobi noaniq. Shu so‘rovni qayta tekshiring.");
  }
}

async function compensate(service: any, source: any, field: string, key: string, token: string) {
  // Persist the reversal phase before its first financial write. An interrupted
  // reversal must resume refunds rather than returning to forward payment work.
  await stage(source, field, key, token, { compensation_requested: true });
  const sourceRow = await source.entity.get(source.row.id);
  const operation = journal(sourceRow, field)[key];
  own(operation, token);
  if (source.kind === "shift" && sourceRow.status !== "open") {
    throw fail("To‘lov smenasi yopilmoqda yoki yopilgan. Tarixni o‘zgartirmasdan egasi tekshirishi kerak.");
  }
  for (const allocation of [...(operation.allocations || [])].reverse()) {
    await debtDelta(service, allocation, operation.marker, true);
  }
  return mutate(source.entity, source.row.id, field, key, (current: any, row: any) => {
    own(current, token);
    if (source.kind === "shift" && row.status !== "open") {
      throw fail("To‘lov smenasi yopilmoqda yoki yopilgan. Egasi tekshirishi kerak.");
    }
    const applied = current.source_applied;
    current.source_applied = false;
    current.status = "reversed";
    current.worker = "";
    // A withdrawal may already have used a pending deposit. The conditional
    // compensation keeps that evidence for review instead of overdrawing.
    return { operation: current,
      query: source.kind === "shift" ? { status: "open" }
        : applied && current.direction === "in" ? { balance: { $gte: current.amount } } : {},
      inc: !applied ? {} : source.kind === "budget"
      ? { balance: current.direction === "in" ? -current.amount : current.amount }
      : { expected_cash: current.amount, cash_removed: -current.amount } };
  });
}

async function resumeCompensation(service: any, source: any, field: string, key: string, claimed: any) {
  if (!claimed.operation.compensation_requested || claimed.already) return;
  try { await compensate(service, source, field, key, claimed.token); }
  catch {
    await release(source, field, key, claimed.token).catch(() => {});
    throw fail("To‘lovni qaytarish yakunlanmadi. Shu so‘rovni tekshiring.");
  }
  throw Object.assign(fail("To‘lov yozilmadi va mablag‘ qaytarildi. Yangi so‘rov bilan urinib ko‘ring.", 409, false), {
    operation_reversed: true,
  });
}

async function release(source: any, field: string, key: string, token: string) {
  await mutate(source.entity, source.row.id, field, key, (operation: any) => {
    if (!operation || operation.worker !== token || operation.status === "completed") return { skip: true };
    operation.worker = "";
    operation.status = "pending";
    return { operation };
  });
}

const paymentNumber = (prefix: string) => `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

async function claimRequestScope(service: any, key: string, fingerprint: string, actor: string) {
  const settings = await service.entities.Settings.list("created_date", 2);
  if (settings.length !== 1) throw fail("Moliyaviy so‘rov uchun ilova sozlamasini egasi tekshirishi kerak.", 409, false);
  // Settings is readable by staff. Store only a one-way digest here; amounts,
  // accounts, notes and supplier snapshots remain on restricted source records.
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(fingerprint),
  ))).map(byte => byte.toString(16).padStart(2, "0")).join("");
  await mutate(service.entities.Settings, settings[0].id, INIT_JOURNAL, `request:${key}`, (operation: any) => {
    if (operation) {
      if (operation.actor !== actor || operation.digest !== digest) {
        throw fail("Bu so‘rov kaliti boshqa moliyaviy amal uchun ishlatilgan.", 409, false);
      }
      return { skip: true };
    }
    return { operation: { actor, digest } };
  });
}

export async function runBudgetAdjustment(service: any, user: any, input: any, labels: any) {
  const key = input.key;
  const fingerprint = JSON.stringify(["manual_adjustment", user.id, input.account, input.direction, input.amount, input.description]);
  // Detect reuse across Budget accounts before selecting the source row.
  const balances = await service.entities.BudgetBalance.list("account", 20);
  for (const balance of balances) {
    const prior = journal(balance, JOURNAL)[key];
    if (prior && (prior.actor !== user.id || prior.fingerprint !== fingerprint)) throw fail("Bu so‘rov kaliti boshqa Budget amali uchun ishlatilgan.", 409, false);
  }
  await claimRequestScope(service, key, fingerprint, user.id);
  const row = await ensureBudgetAccount(service, input.account, labels[input.account], user);
  const source = { row, entity: service.entities.BudgetBalance, kind: "budget" };
  const claimed = await claim(source, JOURNAL, key, fingerprint, user.id, async () => ({
    ...input, created_at: new Date().toISOString(), payment_number: paymentNumber(input.direction === "in" ? "BK" : "BC"), marker: crypto.randomUUID(),
  }));
  const token = claimed.token;
  await resumeCompensation(service, source, JOURNAL, key, claimed);
  try {
    if (!claimed.already) await debit(source, JOURNAL, key, token, user);
    const operation = journal(await source.entity.get(row.id), JOURNAL)[key];
    const query = { idempotency_key: key, performed_by_id: user.id };
    let transaction;
    if (claimed.already) transaction = (await service.entities.BudgetTransaction.filter(query, "created_date", 2))[0];
    else transaction = await ledger(source, JOURNAL, key, token, "transaction", service.entities.BudgetTransaction, query, () => ({
      transaction_number: operation.payment_number, type: input.direction === "in" ? "manual_deposit" : "manual_withdrawal",
      direction: input.direction, account: input.account, amount: input.amount,
      balance_before: operation.balance_before, balance_after: operation.balance_after,
      reference_type: "manual_adjustment", description: input.description, performed_by_id: user.id,
      performed_by_name: user.full_name || user.email, created_at: operation.created_at, status: "completed",
      idempotency_key: key, request_fingerprint: fingerprint,
    }));
    if (!transaction) throw fail("Budget tarixi topilmadi. Egasi tekshirishi kerak.");
    if (!claimed.already) {
      await stage(source, JOURNAL, key, token, { status: "completed", worker: "" });
      await service.entities.ActionHistory.create({ user_id: user.id, user_name: user.full_name || user.email,
        action: input.direction === "in" ? "budget_manual_deposit" : "budget_manual_withdrawal",
        details: `${labels[input.account]} · ${input.amount} UZS · ${input.description}` }).catch(() => {});
    }
    return { transaction, balance: await source.entity.get(row.id), already_processed: claimed.already };
  } catch (error) {
    const recorded = await service.entities.BudgetTransaction.filter({ idempotency_key: key, performed_by_id: user.id }, "created_date", 1).catch(() => null);
    if (rejected(error) && recorded && recorded.length === 0) {
      try {
        await compensate(service, source, JOURNAL, key, token);
        throw Object.assign(error, { operation_pending: false, operation_reversed: true });
      } catch (rollbackError) {
        if ((rollbackError as any)?.operation_reversed) throw rollbackError;
        await release(source, JOURNAL, key, token).catch(() => {});
        throw fail("Budget qaytarilishi yakunlanmadi. Shu so‘rovni tekshiring.");
      }
    }
    await release(source, JOURNAL, key, token).catch(() => {});
    throw Object.assign(error, { operation_pending: true });
  }
}

export async function runSupplierPayment(service: any, user: any, input: any, labels: any = {}) {
  const budget = input.action === "pay_supplier";
  const field = budget ? JOURNAL : SHIFT_JOURNAL;
  const key = input.key;
  const fingerprint = JSON.stringify([input.action, user.id, input.supplier_id, input.shift_id || "", input.account || "", input.amount, input.notes]);
  let row;
  if (budget) {
    const balances = await service.entities.BudgetBalance.list("account", 20);
    for (const balance of balances) {
      const prior = journal(balance, field)[key];
      if (prior && (prior.actor !== user.id || prior.fingerprint !== fingerprint)) throw fail("Bu so‘rov kaliti boshqa Budget amali uchun ishlatilgan.", 409, false);
    }
    await claimRequestScope(service, key, fingerprint, user.id);
    row = await ensureBudgetAccount(service, input.account, labels[input.account], user);
  } else {
    row = await service.entities.Shift.get(input.shift_id);
    if (!row || row.user_id !== user.id) throw fail("Bu smena boshqa xodimga tegishli yoki topilmadi.", 403, false);
    if (["cashier", "manager"].includes(user.role) && user.shop_id !== row.shop_id) throw fail("Bu smena boshqa do‘konga tegishli.", 403, false);
    await claimRequestScope(service, key, fingerprint, user.id);
  }
  const source = { row, entity: budget ? service.entities.BudgetBalance : service.entities.Shift, kind: budget ? "budget" : "shift" };
  const claimed = await claim(source, field, key, fingerprint, user.id, async () => {
    if (!budget && row.status !== "open") throw fail("Smena ochiq emas.", 409, false);
    const supplier = await service.entities.CashRecipient.get(input.supplier_id);
    if (!supplier || supplier.active === false || (budget && !["supplier", "company"].includes(supplier.recipient_type))) throw fail("Yetkazib beruvchi topilmadi yoki faol emas.", 404, false);
    const receipts = await service.entities.SupplierReceipt.filter({ supplier_id: supplier.id,
      remaining_debt: { $gt: 0 }, status: { $nin: ["cancelled", "cancelling"] },
      ...(user.role === "manager" ? { location_id: user.shop_id } : {}) }, "received_at", 500);
    const total = receipts.reduce((sum: number, receipt: any) => sum + money(receipt.remaining_debt), 0);
    if (input.amount > total || total <= 0) throw fail(`To‘lov qolgan qarzdan oshmasligi kerak: ${total} UZS.`, 400, false);
    let remaining = input.amount;
    const allocations = [];
    for (const receipt of receipts) {
      if (remaining <= 0) break;
      const amount = Math.min(money(receipt.remaining_debt), remaining);
      allocations.push({ receipt_id: receipt.id, receipt_number: receipt.receipt_number, amount });
      remaining -= amount;
    }
    return { ...input, direction: "out", created_at: new Date().toISOString(), supplier: { id: supplier.id, name: supplier.name },
      shop_id: budget ? "" : row.shop_id, shop_name: budget ? `Budget · ${labels[input.account]}` : row.shop_name,
      payment_number: paymentNumber(budget ? "BQ" : "QT"), allocations, marker: crypto.randomUUID() };
  });
  const token = claimed.token;
  await resumeCompensation(service, source, field, key, claimed);
  try {
    if (!claimed.already) await debit(source, field, key, token, user);
    const operation = journal(await source.entity.get(row.id), field)[key];
    if (!claimed.already) {
      for (const allocation of operation.allocations) {
        await debtDelta(service, allocation, operation.marker);
      }
    }
    const query = { idempotency_key: key, user_id: user.id };
    let sourceLedger;
    const sourceEntity = budget ? service.entities.BudgetTransaction : service.entities.CashMovement;
    const sourceQuery = budget ? { idempotency_key: key, performed_by_id: user.id } : { ...query, shift_id: row.id };
    if (claimed.already) sourceLedger = (await sourceEntity.filter(sourceQuery, "created_date", 2))[0];
    else sourceLedger = await ledger(source, field, key, token, "source_ledger", sourceEntity, sourceQuery, () => budget ? {
      transaction_number: operation.payment_number, type: "supplier_payment", direction: "out", account: input.account,
      amount: input.amount, balance_before: operation.balance_before, balance_after: operation.balance_after,
      supplier_id: operation.supplier.id, supplier_name: operation.supplier.name, reference_id: operation.payment_number,
      reference_type: "supplier_payment", description: input.notes || `${operation.supplier.name} qarzini to‘lash`,
      performed_by_id: user.id, performed_by_name: user.full_name || user.email, created_at: operation.created_at,
      status: "completed", idempotency_key: key, request_fingerprint: fingerprint,
    } : {
      shift_id: row.id, shop_id: operation.shop_id, user_id: user.id, user_name: user.full_name || user.email,
      employee_name: user.full_name || user.email || "Noma’lum xodim", type: "withdrawal", expense_category: "goods_payment",
      recipient_id: operation.supplier.id, recipient_name_snapshot: operation.supplier.name, amount: input.amount,
      reason: input.notes || `${operation.supplier.name} qarzini to‘lash`, reference_id: operation.payment_number,
      reference_type: "supplier_payment", created_at: operation.created_at, idempotency_key: key, request_fingerprint: fingerprint,
    });
    if (!sourceLedger) throw fail("To‘lovning pul tarixi topilmadi. Egasi tekshirishi kerak.");
    const payments = [];
    for (let index = 0; index < operation.allocations.length; index += 1) {
      const allocation = operation.allocations[index];
      const paymentQuery = { ...query, receipt_id: allocation.receipt_id };
      let payment;
      if (claimed.already) payment = (await service.entities.SupplierPayment.filter(paymentQuery, "created_date", 2))[0];
      else payment = await ledger(source, field, key, token, `payment_${index}`, service.entities.SupplierPayment, paymentQuery, () => ({
        payment_number: operation.payment_number, receipt_id: allocation.receipt_id,
        receipt_number_snapshot: allocation.receipt_number, supplier_id: operation.supplier.id,
        supplier_name_snapshot: operation.supplier.name, amount: allocation.amount, shop_id: operation.shop_id,
        shop_name_snapshot: operation.shop_name, shift_id: budget ? "" : row.id,
        cash_movement_id: budget ? "" : sourceLedger.id, payment_source: budget ? "budget" : "shift_cash",
        ...(budget ? { budget_account: input.account, budget_transaction_id: sourceLedger.id, authorized_by_id: user.id, authorized_by_name: user.full_name || user.email } : {}),
        user_id: user.id, user_name: user.full_name || user.email, notes: input.notes || undefined,
        paid_at: operation.created_at, idempotency_key: key, request_fingerprint: fingerprint,
      }));
      if (!payment) throw fail("Qarz to‘lovi tarixi topilmadi. Egasi tekshirishi kerak.");
      payments.push(payment);
    }
    if (!claimed.already) {
      await stage(source, field, key, token, { status: "completed", worker: "" });
      await service.entities.ActionHistory.create({ user_id: user.id, user_name: user.full_name || user.email,
        action: budget ? "supplier_debt_paid_from_budget" : "supplier_debt_paid",
        details: `${operation.payment_number}. ${operation.supplier.name}. ${operation.shop_name}. ${input.amount} UZS.` }).catch(() => {});
    }
    const receipts = await service.entities.SupplierReceipt.filter({ supplier_id: input.supplier_id,
      remaining_debt: { $gt: 0 }, ...(user.role === "manager" ? { location_id: user.shop_id } : {}) }, "received_at", 500);
    const remaining = receipts.reduce((sum: number, receipt: any) => sum + money(receipt.remaining_debt), 0);
    const latest = await source.entity.get(row.id);
    return { paid: true, payment_number: operation.payment_number, supplier: operation.supplier,
      payments, remaining_debt: remaining, already_processed: claimed.already,
      ...(budget ? { transaction: sourceLedger, budget_balance: latest.balance } : { cash_movement: sourceLedger, shift: latest }) };
  } catch (error) {
    // Before any ledger saved, a definite validation rejection can be safely
    // compensated. Once a ledger exists, preserve it and complete forward on retry.
    const sourceEntity = budget ? service.entities.BudgetTransaction : service.entities.CashMovement;
    const query = budget ? { idempotency_key: key, performed_by_id: user.id } : { idempotency_key: key, user_id: user.id, shift_id: row.id };
    const recorded = await sourceEntity.filter(query, "created_date", 1).catch(() => null);
    if ((rejected(error) || (error as any)?.operation_pending === false) && recorded && recorded.length === 0) {
      try {
        await compensate(service, source, field, key, token);
        throw Object.assign(error, { operation_pending: false, operation_reversed: true });
      } catch (rollbackError) {
        if ((rollbackError as any)?.operation_reversed) throw rollbackError;
        await release(source, field, key, token).catch(() => {});
        throw fail("To‘lovni qaytarish yakunlanmadi. Shu so‘rovni tekshiring.");
      }
    }
    await release(source, field, key, token).catch(() => {});
    throw Object.assign(error, { operation_pending: true });
  }
}
