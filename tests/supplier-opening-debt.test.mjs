// Offline only. All names, identifiers and amounts below are mock fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';
const file = 'base44/functions/supplier-ledger/entry.ts';
const make = () => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Mock owner', shop_id: 'shop' }],
  Settings: [{ id: 'settings', shop_name: 'Mock shop' }],
  CashRecipient: [{ id: 'supplier', name: 'Mock supplier', active: true, recipient_type: 'company' }],
  SupplierOpeningDebt: [], SupplierReceipt: [], SupplierPayment: [], ActionHistory: [],
  BudgetBalance: [{ id: 'cash', account: 'cash', balance: 10000 }],
  Shift: [{ id: 'shift', user_id: 'owner', shop_id: 'shop', status: 'open', expected_cash: 10000, cash_removed: 0 }],
});
const body = (changes = {}) => ({ action: 'create_opening_debt', supplier_id: 'supplier', amount: 5000,
  effective_date: '2026-09-20', notes: 'Mock opening liability', idempotency_key: 'opening-request-1', ...changes });
const create = (f, changes) => f.invoke(file, body(changes));
const pay = (f, changes = {}) => f.load('base44/shared/supplier-payment-recovery.ts').runSupplierPayment(f.service, f.db.User[0], {
  key: 'opening-payment-1', action: 'pay_supplier', supplier_id: 'supplier', account: 'cash', amount: 1000, notes: 'Mock payment', ...changes,
}, { cash: 'Naqd' });
const noOtherWrites = f => assert.ok(f.calls.every(([entity, action]) =>
  ['CashRecipient', 'SupplierOpeningDebt'].includes(entity) && ['create', 'updateMany'].includes(action)));

test('opening entry preserves money, purchases and stock; returns immutable original and remaining', async () => {
  const f = make(); const result = await create(f);
  assert.equal(result.status, 200); assert.equal(result.data.opening_debt.debt_amount, 5000);
  assert.equal(result.data.opening_debt.remaining_debt, 5000);
  assert.equal(result.data.opening_debt.supplier_name_snapshot, 'Mock supplier');
  assert.equal(result.data.opening_debt.created_by_id, 'owner');
  assert.equal(result.data.opening_debt.request_fingerprint, undefined);
  assert.equal(f.db.BudgetBalance[0].balance, 10000); assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.equal(f.db.SupplierReceipt.length, 0); noOtherWrites(f);
  assert.doesNotMatch(f.db.CashRecipient[0].opening_debt_claim, /5000|Mock opening liability/);
});

test('same request reconciles once; changed amount, key, notes or actor cannot replace the opening debt', async () => {
  const f = make(); await create(f);
  assert.equal((await create(f)).data.already_processed, true);
  for (const change of [{ amount: 6000 }, { idempotency_key: 'opening-request-2' }, { notes: 'changed' }]) {
    assert.equal((await create(f, change)).status, 409);
  }
  f.db.User[0].id = 'other'; assert.equal((await create(f)).status, 409);
  assert.equal(f.db.SupplierOpeningDebt.length, 1); assert.equal(f.db.SupplierOpeningDebt[0].debt_amount, 5000);
});

test('simultaneous same and different keys cannot create two entries', async () => {
  for (const different of [false, true]) {
    const f = make(); const results = await Promise.all([create(f), create(f, different ? { idempotency_key: 'opening-request-2' } : {})]);
    assert.ok(results.some(r => r.status === 200)); assert.equal(f.db.SupplierOpeningDebt.length, 1);
  }
});

test('invalid amounts, dates and inactive suppliers are rejected before any mutation', async () => {
  for (const change of [{ amount: 0 }, { amount: -5 }, { amount: 1.5 }, { amount: '100' }, { amount: Number.MAX_SAFE_INTEGER + 1 },
    { effective_date: '2026-02-30' }, { effective_date: 'bad' }, { notes: 'x'.repeat(2001) }]) {
    const f = make(); assert.equal((await create(f, change)).status, 400); assert.equal(f.calls.length, 0);
  }
  const f = make(); f.db.CashRecipient[0].active = false;
  assert.equal((await create(f)).status, 404); assert.equal(f.calls.length, 0);
});

test('non-admin roles cannot create or list unallocated opening debts', async () => {
  for (const role of ['cashier', 'accountant', 'production', 'warehouse', 'manager']) {
    const f = make(); f.db.User[0].role = role;
    assert.equal((await create(f)).status, 403);
    assert.equal((await f.invoke(file, { action: 'list_opening_debts' })).status, 403);
    assert.equal(f.calls.length, 0);
  }
});

test('lost claim reply and lost create reply reconcile without duplicate', async () => {
  const f = make(); const update = f.entities.CashRecipient.updateMany;
  f.entities.CashRecipient.updateMany = async (...args) => { await update(...args); throw new Error('lost claim reply'); };
  const original = f.entities.SupplierOpeningDebt.create;
  f.entities.SupplierOpeningDebt.create = async data => { await original(data); throw new Error('lost create reply'); };
  assert.equal((await create(f)).status, 200); assert.equal((await create(f)).status, 200);
  assert.equal(f.db.SupplierOpeningDebt.length, 1);
});

test('ambiguous create with no visible result is never replayed, even on a new key', async () => {
  const f = make(); let calls = 0;
  f.entities.SupplierOpeningDebt.create = async () => { calls++; throw new Error('unknown'); };
  assert.equal((await create(f)).data.operation_pending, true);
  assert.equal((await create(f)).data.operation_pending, true);
  assert.equal((await create(f, { idempotency_key: 'opening-request-2' })).data.operation_pending, true);
  assert.equal(calls, 1); assert.equal(f.db.SupplierOpeningDebt.length, 0);
});

test('definite create rejection releases claim; a corrected request may proceed', async () => {
  const f = make(); const original = f.entities.SupplierOpeningDebt.create;
  f.entities.SupplierOpeningDebt.create = async () => { throw Object.assign(new Error('rejected'), { status: 422 }); };
  const result = await create(f); assert.equal(result.status, 422); assert.equal(result.data.request_not_started, true);
  f.entities.SupplierOpeningDebt.create = original;
  assert.equal((await create(f)).status, 200); assert.equal(f.db.SupplierOpeningDebt.length, 1);
});

test('owner can list opening history without private recovery journal', async () => {
  const f = make(); await create(f); await pay(f);
  const result = await f.invoke(file, { action: 'list_opening_debts' });
  assert.equal(result.status, 200); assert.equal(result.data.opening_debts.length, 1);
  assert.equal(result.data.payments.length, 1); assert.equal(result.data.opening_debts[0].remaining_debt, 4000);
  assert.equal(result.data.opening_debts[0].payment_operations_json, undefined);
  assert.equal(result.data.payments[0].request_fingerprint, undefined);
});

test('Budget partial and full payment preserves original; retries debit once', async () => {
  const f = make(); await create(f); const paid = await pay(f);
  assert.equal(paid.remaining_debt, 4000); assert.equal(f.db.SupplierOpeningDebt[0].debt_amount, 5000);
  assert.equal(f.db.SupplierOpeningDebt[0].status, 'partial');
  assert.equal(f.db.SupplierPayment[0].receipt_id, '');
  assert.equal(f.db.SupplierPayment[0].opening_debt_id, f.db.SupplierOpeningDebt[0].id);
  assert.equal(f.db.SupplierPayment[0].debt_type, 'opening');
  assert.equal((await pay(f)).already_processed, true); assert.equal(f.db.BudgetBalance[0].balance, 9000);
  await pay(f, { key: 'opening-payment-2', amount: 4000 });
  assert.equal(f.db.SupplierOpeningDebt[0].status, 'paid'); assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 0);
  assert.equal(f.db.BudgetBalance[0].balance, 5000); assert.equal(f.db.SupplierReceipt.length, 0);
});

test('mixed payment allocates opening before purchase, without confusing payment targets', async () => {
  const f = make(); await create(f);
  f.db.SupplierReceipt.push({ id: 'receipt', supplier_id: 'supplier', receipt_number: 'K-1', remaining_debt: 3000, debt_amount: 3000, status: 'unpaid', received_at: '2026-09-22' });
  await pay(f, { amount: 6000 });
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 0); assert.equal(f.db.SupplierReceipt[0].remaining_debt, 2000);
  assert.equal(f.db.SupplierPayment.length, 2); assert.equal(f.db.BudgetBalance[0].balance, 4000);
  assert.equal((await pay(f, { amount: 6000 })).already_processed, true);
  assert.equal(f.db.SupplierPayment.length, 2);
});

test('overpayment and shift payment cannot consume unallocated opening liability', async () => {
  const f = make(); await create(f);
  await assert.rejects(pay(f, { amount: 5001 }), e => e.status === 400);
  const cash = await f.invoke(file, { action: 'pay_debt', supplier_id: 'supplier', shift_id: 'shift', amount: 1000, idempotency_key: 'shift-opening-test' });
  assert.equal(cash.status, 400); assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 5000);
  assert.equal(f.db.BudgetBalance[0].balance, 10000); assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.deepEqual((await f.invoke(file, { action: 'get_debts' })).data.debts, {});
});

test('lost payment/debt update replies recover once, including opening target', async () => {
  const f = make(); await create(f);
  const update = f.entities.SupplierOpeningDebt.updateMany; let lost = false;
  f.entities.SupplierOpeningDebt.updateMany = async (...args) => { const r = await update(...args); if (!lost && r.updated) { lost = true; throw new Error('lost'); } return r; };
  const save = f.entities.SupplierPayment.create;
  f.entities.SupplierPayment.create = async data => { await save(data); throw new Error('lost'); };
  await pay(f); await pay(f);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 4000); assert.equal(f.db.BudgetBalance[0].balance, 9000); assert.equal(f.db.SupplierPayment.length, 1);
});

test('opening entity is admin-read/backend-write only; purchase schema unchanged', () => {
  const schema = JSON.parse(readFileSync('base44/entities/SupplierOpeningDebt.jsonc', 'utf8'));
  assert.deepEqual(schema.rls, { read: { user_condition: { role: 'admin' } }, create: false, update: false, delete: false });
  assert.deepEqual(schema.properties.location_id, { type: 'string' });
  assert.equal(schema.required.includes('location_id'), false);
});

test('mixed opening and purchase payment restores both debts when the source ledger is rejected', async () => {
  const f = make(); await create(f);
  f.db.SupplierReceipt.push({ id: 'receipt', supplier_id: 'supplier', receipt_number: 'K-1',
    remaining_debt: 3000, debt_amount: 3000, status: 'unpaid', received_at: '2026-09-22' });
  f.entities.BudgetTransaction.create = async () => {
    throw Object.assign(new Error('Mock definite source ledger rejection'), { status: 422 });
  };

  await assert.rejects(pay(f, { amount: 6000 }), error => error.operation_reversed === true);
  assert.equal(f.db.BudgetBalance[0].balance, 10000);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 5000);
  assert.equal(f.db.SupplierOpeningDebt[0].debt_amount, 5000);
  assert.equal(f.db.SupplierOpeningDebt[0].status, 'unpaid');
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 3000);
  assert.equal(f.db.SupplierReceipt[0].status, 'unpaid');
  assert.equal(f.db.SupplierPayment.length, 0);
  assert.equal(f.db.BudgetTransaction.length, 0);
  await assert.rejects(pay(f, { amount: 6000 }), error => error.operation_reversed === true);
  assert.equal(f.db.BudgetBalance[0].balance, 10000);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 5000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 3000);
});

test('mixed payment preserves saved evidence and completes forward after the second allocation is rejected', async () => {
  const f = make(); await create(f);
  f.db.SupplierReceipt.push({ id: 'receipt', supplier_id: 'supplier', receipt_number: 'K-1',
    remaining_debt: 3000, debt_amount: 3000, status: 'unpaid', received_at: '2026-09-22' });
  const save = f.entities.SupplierPayment.create;
  let rejected = false;
  f.entities.SupplierPayment.create = async data => {
    if (!rejected && data.receipt_id === 'receipt') {
      rejected = true;
      throw Object.assign(new Error('Mock definite second payment rejection'), { status: 422 });
    }
    return save(data);
  };

  await assert.rejects(pay(f, { amount: 6000 }), error => error.operation_pending === true);
  assert.equal(f.db.BudgetBalance[0].balance, 4000);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 0);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 2000);
  assert.equal(f.db.SupplierPayment.length, 1);
  assert.equal(f.db.BudgetTransaction.length, 1);
  const savedPayment = structuredClone(f.db.SupplierPayment[0]);
  const savedTransaction = structuredClone(f.db.BudgetTransaction[0]);

  await pay(f, { amount: 6000 });
  assert.equal(f.db.SupplierPayment.length, 2);
  assert.deepEqual(f.db.SupplierPayment[0], savedPayment);
  assert.deepEqual(f.db.BudgetTransaction, [savedTransaction]);
  assert.equal(f.db.BudgetBalance[0].balance, 4000);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 0);
  assert.equal(f.db.SupplierOpeningDebt[0].debt_amount, 5000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 2000);
  assert.equal((await pay(f, { amount: 6000 })).already_processed, true);
  assert.equal(f.db.SupplierPayment.length, 2);
  assert.equal(f.db.BudgetBalance[0].balance, 4000);
});

test('global opening ledger paginates all debts and returns only their Budget payment kind without writes', async () => {
  const f = make();
  f.db.SupplierOpeningDebt = Array.from({ length: 501 }, (_, index) => ({
    id: `opening-${index}`, supplier_id: `supplier-${index}`, supplier_name_snapshot: `Mock ${index}`,
    debt_amount: 10, remaining_debt: 8, effective_date: '2020-01-01', status: 'partial',
    created_date: `2020-01-${String(index).padStart(4, '0')}`, request_fingerprint: 'private', payment_operations_json: '{}',
  }));
  f.db.SupplierPayment = [
    { id: 'opening-payment', opening_debt_id: 'opening-0', debt_type: 'opening', payment_source: 'budget', amount: 2 },
    { id: 'purchase-payment', receipt_id: 'receipt', debt_type: 'receipt', payment_source: 'budget', amount: 2 },
    { id: 'shift-payment', receipt_id: 'receipt', payment_source: 'shift_cash', amount: 2 },
  ];
  const result = await f.invoke(file, { action: 'list_opening_debts' });
  assert.equal(result.status, 200); assert.equal(result.data.opening_debts.length, 501);
  assert.equal(result.data.opening_debts.reduce((sum, debt) => sum + debt.remaining_debt, 0), 4008);
  assert.equal(result.data.payments.length, 1); assert.equal(result.data.payments[0].id, 'opening-payment');
  assert.equal(result.data.opening_debts.some(debt => debt.request_fingerprint || debt.payment_operations_json), false);
  assert.equal(f.calls.length, 0);
});
