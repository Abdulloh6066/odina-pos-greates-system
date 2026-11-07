// Offline fixtures only. No network, credentials, live records or real payments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { memoryBackend } from './helpers/memory-backend.mjs';

const helper = 'base44/shared/supplier-payment-recovery.ts';
const endpoint = 'base44/functions/budget-ledger/entry.ts';
const make = () => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Mock owner' }],
  Settings: [{ id: 'settings' }],
  CashRecipient: [{ id: 'supplier', name: 'Mock supplier', active: true, recipient_type: 'company' }],
  SupplierOpeningDebt: [
    { id: 'other-opening', supplier_id: 'supplier', debt_number: 'BQ-OTHER', debt_amount: 2000,
      remaining_debt: 2000, status: 'unpaid', location_id: 'other-warehouse', created_date: '2026-09-01' },
    { id: 'opening', supplier_id: 'supplier', debt_number: 'BQ-SELECTED', debt_amount: 5000,
      remaining_debt: 5000, status: 'unpaid', location_id: 'warehouse', location_name_snapshot: 'Mock warehouse', created_date: '2026-09-02' },
  ],
  SupplierReceipt: [{ id: 'receipt', supplier_id: 'supplier', receipt_number: 'K-OTHER', debt_amount: 3000,
    remaining_debt: 3000, status: 'unpaid', location_id: 'other-warehouse', received_at: '2026-09-01' }],
  BudgetBalance: [{ id: 'cash', account: 'cash', balance: 10000 }],
  BudgetTransaction: [], SupplierPayment: [], ActionHistory: [],
});
const request = changes => ({ key: 'targeted-payment-one', action: 'pay_supplier', supplier_id: 'supplier',
  opening_debt_id: 'opening', location_id: 'warehouse', account: 'cash', amount: 1000, notes: 'Mock selected payment', ...changes });
const pay = (f, changes = {}) => f.load(helper).runSupplierPayment(f.service, f.db.User[0], request(changes), { cash: 'Naqd pul' });
const invoke = (f, changes = {}) => f.invoke(endpoint, { ...request(), idempotency_key: 'targeted-payment-one', owner_pin: '2468', ...changes });
const target = f => f.db.SupplierOpeningDebt.find(row => row.id === 'opening');
const assertUntouched = f => {
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 2000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 3000);
  assert.ok(f.calls.every(([name, action]) => action !== 'delete' && !['Shift', 'CashMovement', 'StockMovement', 'StockBalance'].includes(name)));
};
const setupPin = async f => {
  const salt = 'mock-only-salt';
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('2468'), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  f.db.SecuritySettings = [{ id: 'security', key: 'owner_approval_pin', pin_hash: Buffer.from(bits).toString('hex'),
    pin_salt: salt, pin_algorithm: 'PBKDF2-SHA256', pin_iterations: 100000 }];
};

test('selected opening debt alone is paid from global Budget with location snapshots', async () => {
  const f = make(); const result = await pay(f);
  assert.equal(f.db.BudgetBalance[0].balance, 9000);
  assert.equal(target(f).remaining_debt, 4000); assert.equal(target(f).status, 'partial');
  assert.equal(target(f).debt_amount, 5000);
  assert.equal(result.opening_debt_id, 'opening'); assert.equal(result.amount, 1000);
  assert.equal(result.account, 'cash'); assert.equal(result.location_id, 'warehouse');
  assert.equal(result.opening_remaining_debt, 4000); assert.equal(result.remaining_debt, 9000);
  assert.equal(result.payments.length, 1); assert.equal(result.payments[0].opening_debt_id, 'opening');
  assert.equal(result.payments[0].shop_id, 'warehouse'); assert.equal(result.payments[0].shop_name_snapshot, 'Mock warehouse');
  assert.equal(result.transaction.shop_id, 'warehouse'); assert.equal(result.transaction.shop_name, 'Mock warehouse');
  assert.equal(result.transaction.account, 'cash'); assertUntouched(f);
});

test('targeted partial and full retries preserve exact history and never debit twice', async () => {
  const f = make(); await pay(f); const saved = structuredClone(f.db.SupplierPayment);
  assert.equal((await pay(f)).already_processed, true); assert.deepEqual(f.db.SupplierPayment, saved);
  await pay(f, { key: 'targeted-payment-two', amount: 4000 });
  assert.equal(target(f).status, 'paid'); assert.equal(f.db.BudgetBalance[0].balance, 5000);
  assert.equal((await pay(f, { key: 'targeted-payment-two', amount: 4000 })).already_processed, true);
  assert.equal(f.db.SupplierPayment.length, 2); assert.equal(f.db.BudgetTransaction.length, 2); assertUntouched(f);
});

test('stale source and overlapping planning recover completed same-key requests instead of reporting not started', async () => {
  const f = make(); const stale = structuredClone(f.db.BudgetBalance[0]);
  await pay(f, { amount: 5000 });
  const filter = f.entities.BudgetBalance.filter;
  f.entities.BudgetBalance.filter = async (...args) => args[0].account === 'cash' ? [structuredClone(stale)] : filter(...args);
  assert.equal((await pay(f, { amount: 5000 })).already_processed, true);
  assert.equal(f.db.BudgetBalance[0].balance, 5000); assert.equal(f.db.SupplierPayment.length, 1);

  const g = make(); const get = g.entities.SupplierOpeningDebt.get; let interleaved = false;
  g.entities.SupplierOpeningDebt.get = async id => {
    if (id === 'opening' && !interleaved) { interleaved = true; await pay(g, { amount: 5000 }); }
    return get(id);
  };
  assert.equal((await pay(g, { amount: 5000 })).already_processed, true);
  assert.equal(g.db.BudgetBalance[0].balance, 5000); assert.equal(g.db.SupplierPayment.length, 1);
});

test('unallocated target can be paid and omitted location freezes its real scope', async () => {
  for (const allocated of [true, false]) {
    const f = make(); if (!allocated) { delete target(f).location_id; delete target(f).location_name_snapshot; }
    const result = await pay(f, { location_id: undefined });
    assert.equal(result.location_id, allocated ? 'warehouse' : '');
    assert.equal(result.payments[0].shop_id, allocated ? 'warehouse' : '');
    assert.equal(f.db.BudgetBalance[0].balance, 9000); assertUntouched(f);
  }
});

test('wrong debt, supplier, location, overpayment and paid target never debit Budget or fall back to FIFO', async () => {
  for (const changes of [{ opening_debt_id: 'missing' }, { supplier_id: 'other-supplier' },
    { location_id: 'other-warehouse' }, { amount: 5001 }]) {
    const f = make(); f.db.CashRecipient.push({ id: 'other-supplier', active: true, recipient_type: 'company' });
    await assert.rejects(pay(f, changes), error => [400, 404, 409].includes(error.status) && error.request_not_started === true);
    assert.equal(f.db.BudgetBalance[0].balance, 10000); assert.equal(target(f).remaining_debt, 5000);
    assert.equal(f.db.SupplierPayment.length, 0); assert.equal(f.db.BudgetTransaction.length, 0); assertUntouched(f);
  }
  const f = make(); target(f).remaining_debt = 0; target(f).status = 'paid';
  await assert.rejects(pay(f), error => error.request_not_started === true);
  assert.equal(f.db.BudgetBalance[0].balance, 10000); assertUntouched(f);
});

test('insufficient global Budget preserves both debts and returns a reversible final failure', async () => {
  const f = make(); f.db.BudgetBalance[0].balance = 500;
  await assert.rejects(pay(f), error => error.operation_reversed === true && error.operation_pending === false);
  assert.equal(f.db.BudgetBalance[0].balance, 500); assert.equal(target(f).remaining_debt, 5000);
  assert.equal(f.db.SupplierPayment.length, 0); assert.equal(f.db.BudgetTransaction.length, 0); assertUntouched(f);
});

test('scope and account are bound into targeted idempotency, while legacy fingerprints stay unchanged', async () => {
  const f = make(); await pay(f);
  const fingerprint = JSON.parse(f.db.BudgetTransaction[0].request_fingerprint);
  assert.deepEqual(fingerprint.slice(-3), ['opening_debt', 'opening', 'warehouse']);
  for (const changes of [{ opening_debt_id: 'other-opening' }, { location_id: undefined },
    { opening_debt_id: undefined, location_id: undefined }, { account: 'bank' }, { amount: 2000 }, { notes: 'changed' }]) {
    await assert.rejects(pay(f, changes), error => error.status === 409);
  }
  assert.equal(f.db.BudgetBalance[0].balance, 9000); assert.equal(f.db.SupplierPayment.length, 1);
  const g = make(); await pay(g, { opening_debt_id: undefined, location_id: undefined });
  const legacy = JSON.stringify(['pay_supplier', 'owner', 'supplier', '', 'cash', 1000, 'Mock selected payment']);
  assert.equal(g.db.BudgetTransaction[0].request_fingerprint, legacy);
  assert.equal((await pay(g, { opening_debt_id: undefined, location_id: undefined })).already_processed, true);
  assert.equal(g.db.SupplierOpeningDebt[0].remaining_debt, 1000); assert.equal(target(g).remaining_debt, 5000);
});

test('location or supplier change between planning and debit refunds only the global Budget debit', async () => {
  for (const field of ['location_id', 'supplier_id']) {
    const f = make(); const update = f.entities.BudgetBalance.updateMany; let changed = false;
    f.entities.BudgetBalance.updateMany = async (query, ops) => {
      const result = await update(query, ops);
      if (!changed && ops.$inc?.balance === -1000) { changed = true; target(f)[field] = 'other'; }
      return result;
    };
    await assert.rejects(pay(f), error => error.operation_reversed === true);
    assert.equal(f.db.BudgetBalance[0].balance, 10000); assert.equal(target(f).remaining_debt, 5000);
    assert.equal(f.db.SupplierPayment.length, 0); assertUntouched(f);
  }
});

test('location CAS rejects an assignment racing an unallocated target, without corrupting the assignment', async () => {
  const f = make(); delete target(f).location_id; delete target(f).location_name_snapshot;
  const update = f.entities.SupplierOpeningDebt.updateMany; let assigned = false;
  f.entities.SupplierOpeningDebt.updateMany = async (query, ops) => {
    if (!assigned && ops.$inc?.remaining_debt === -1000) {
      assert.equal(query.location_id.$exists, false); assigned = true;
      target(f).location_id = 'new-warehouse'; target(f).location_name_snapshot = 'New mock warehouse';
    }
    return update(query, ops);
  };
  await assert.rejects(pay(f, { location_id: undefined }), error => error.operation_reversed === true);
  assert.equal(target(f).location_id, 'new-warehouse'); assert.equal(target(f).remaining_debt, 5000);
  assert.equal(f.db.BudgetBalance[0].balance, 10000); assert.equal(f.db.SupplierPayment.length, 0); assertUntouched(f);
});

test('concurrent targets cannot overspend global Budget or overpay the selected debt', async () => {
  for (const balance of [10000, 4000]) {
    const f = make(); f.db.BudgetBalance[0].balance = balance;
    const results = await Promise.allSettled([pay(f, { amount: 4000 }), pay(f, { key: 'targeted-payment-two', amount: 4000 })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.db.BudgetBalance[0].balance, balance - 4000); assert.equal(target(f).remaining_debt, 1000);
    assert.equal(f.db.SupplierPayment.length, 1); assertUntouched(f);
  }
});

test('lost target and ledger replies reconcile once and uncertain empty creates never replay', async () => {
  const f = make(); const update = f.entities.SupplierOpeningDebt.updateMany; let lost = false;
  f.entities.SupplierOpeningDebt.updateMany = async (...args) => { const result = await update(...args); if (!lost && result.updated) { lost = true; throw new Error('Mock lost target reply'); } return result; };
  for (const name of ['BudgetTransaction', 'SupplierPayment']) {
    const create = f.entities[name].create;
    f.entities[name].create = async data => { await create(data); throw new Error('Mock lost create reply'); };
  }
  await pay(f); await pay(f);
  assert.equal(f.db.BudgetBalance[0].balance, 9000); assert.equal(target(f).remaining_debt, 4000);
  assert.equal(f.db.SupplierPayment.length, 1); assert.equal(f.db.BudgetTransaction.length, 1); assertUntouched(f);

  const g = make(); let creates = 0;
  g.entities.BudgetTransaction.create = async () => { creates++; throw new Error('Mock unknown create outcome'); };
  await assert.rejects(pay(g), error => error.operation_pending === true);
  await assert.rejects(pay(g), error => error.operation_pending === true);
  assert.equal(creates, 1); assert.equal(g.db.BudgetBalance[0].balance, 9000); assert.equal(target(g).remaining_debt, 4000); assertUntouched(g);
});

test('interrupted target refunds only resume compensation, preserving corrections and other balance changes', async () => {
  const f = make(); target(f).debt_amount = 9000; target(f).corrected_debt_amount = 5000;
  let creates = 0; let rejectRefund = true;
  f.entities.BudgetTransaction.create = async () => { creates++; throw Object.assign(new Error('Mock source ledger rejection'), { status: 422 }); };
  const update = f.entities.SupplierOpeningDebt.updateMany;
  f.entities.SupplierOpeningDebt.updateMany = async (query, ops) => {
    if (rejectRefund && ops.$inc?.remaining_debt === 1000) throw Object.assign(new Error('Mock refund failure'), { status: 422 });
    return update(query, ops);
  };
  await assert.rejects(pay(f), error => error.operation_pending === true);
  assert.equal(f.db.BudgetBalance[0].balance, 9000); assert.equal(target(f).remaining_debt, 4000);
  f.db.BudgetBalance[0].balance += 200; rejectRefund = false;
  await assert.rejects(pay(f), error => error.operation_reversed === true);
  assert.equal(f.db.BudgetBalance[0].balance, 10200); assert.equal(target(f).remaining_debt, 5000);
  assert.equal(target(f).status, 'unpaid'); assert.equal(target(f).debt_amount, 9000);
  assert.equal(creates, 1); assert.equal(f.db.SupplierPayment.length, 0); assertUntouched(f);
});

test('saved source ledger completes forward after a payment failure, even if the target becomes inactive', async () => {
  const f = make(); const create = f.entities.SupplierPayment.create; let rejected = false;
  f.entities.SupplierPayment.create = async data => {
    if (!rejected) { rejected = true; throw Object.assign(new Error('Mock payment rejection'), { status: 422 }); }
    return create(data);
  };
  await assert.rejects(pay(f, { amount: 5000 }), error => error.operation_pending === true);
  const transaction = structuredClone(f.db.BudgetTransaction[0]);
  f.db.CashRecipient[0].active = false;
  const result = await pay(f, { amount: 5000 }); assert.equal(result.paid, true);
  assert.equal(result.opening_remaining_debt, 0); assert.deepEqual(f.db.BudgetTransaction, [transaction]);
  assert.equal(f.db.SupplierPayment.length, 1); assert.equal(f.db.BudgetBalance[0].balance, 5000); assertUntouched(f);
});

test('endpoint enforces owner role, PIN and strict target contract; summary remains private', async () => {
  const f = make(); await setupPin(f);
  assert.equal((await invoke(f, { owner_pin: '0000' })).status, 403);
  assert.equal(f.db.BudgetBalance[0].balance, 10000); assert.equal(f.db.SupplierPayment.length, 0);
  for (const changes of [{ opening_debt_id: '' }, { opening_debt_id: null }, { location_id: '' },
    { location_id: null }, { opening_debt_id: undefined }, { amount: 1.5 }, { amount: '1000' }]) {
    const result = await invoke(f, changes); assert.equal(result.status, 400); assert.notEqual(result.data.request_not_started, true);
  }
  const result = await invoke(f); assert.equal(result.status, 200); assert.equal(result.data.opening_debt_id, 'opening');
  assert.equal(f.db.BudgetBalance[0].balance, 9000);
  const wrongPinRetry = await invoke(f, { owner_pin: '0000' });
  assert.equal(wrongPinRetry.status, 403); assert.notEqual(wrongPinRetry.data.request_not_started, true);
  assert.equal((await invoke(f)).data.already_processed, true); assert.equal(f.db.BudgetBalance[0].balance, 9000);
  for (const role of ['manager', 'cashier', 'warehouse', 'accountant', 'production']) {
    const g = make(); g.db.User[0].role = role;
    assert.equal((await invoke(g)).status, 403);
    assert.equal((await g.invoke(endpoint, { action: 'summary' })).status, 403);
    assert.equal(g.calls.length, 0);
    await assert.rejects(pay(g), error => error.status === 403);
  }
  const g = make(); g.db.User[0].active = false;
  assert.equal((await invoke(g)).status, 403); assert.equal(g.calls.length, 0);
});
