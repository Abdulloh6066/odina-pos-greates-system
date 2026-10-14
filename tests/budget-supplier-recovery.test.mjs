// Memory-only financial recovery tests. No network, live records or deletes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { memoryBackend } from './helpers/memory-backend.mjs';

const helper = 'base44/shared/supplier-payment-recovery.ts';
const supplierFile = 'base44/functions/supplier-ledger/entry.ts';
const labels = { cash: 'Naqd pul', bank: 'Bank' };
const make = () => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Mock owner', shop_id: 'shop' }],
  Settings: [{ id: 'settings', shop_name: 'Mock Odina' }],
  Shift: [{ id: 'shift', status: 'open', user_id: 'owner', shop_id: 'shop', shop_name: 'Mock shop', expected_cash: 10000, cash_removed: 0 }],
  BudgetBalance: [{ id: 'balance', account: 'cash', balance: 10000 }],
  CashRecipient: [{ id: 'supplier', active: true, name: 'Mock supplier', recipient_type: 'supplier' }],
  SupplierReceipt: [{ id: 'receipt', supplier_id: 'supplier', receipt_number: 'K-1', location_id: 'shop', debt_amount: 10000, remaining_debt: 10000, status: 'unpaid', received_at: '2026-09-01' }],
  SupplierPayment: [], CashMovement: [], BudgetTransaction: [], ActionHistory: [],
});
const adjustment = (f, overrides = {}) => f.load(helper).runBudgetAdjustment(f.service, f.db.User[0], {
  key: 'adjustment-first', account: 'cash', direction: 'out', amount: 1000, description: 'Mock adjustment', ...overrides,
}, labels);
const budgetPayment = (f, overrides = {}) => f.load(helper).runSupplierPayment(f.service, f.db.User[0], {
  key: 'budget-payment-first', action: 'pay_supplier', account: 'cash', supplier_id: 'supplier', amount: 1000, notes: 'Mock debt payment', ...overrides,
}, labels);
const cashBody = (overrides = {}) => ({ action: 'pay_debt', shift_id: 'shift', supplier_id: 'supplier', amount: 1000, notes: 'Mock debt payment', idempotency_key: 'cash-payment-first', ...overrides });
const cashPayment = (f, overrides) => f.invoke(supplierFile, cashBody(overrides));
const assertNoDeletes = f => assert.equal(f.calls.some(([, action]) => action === 'delete'), false);
const loseCreateReply = (f, entityName) => {
  const create = f.entities[entityName].create;
  f.entities[entityName].create = async data => { await create(data); throw new Error('Mock lost create reply'); };
};
const loseUpdateReply = (f, entityName, predicate) => {
  const update = f.entities[entityName].updateMany;
  let used = false;
  f.entities[entityName].updateMany = async (query, ops) => {
    const result = await update(query, ops);
    if (!used && result.updated === 1 && predicate(ops)) { used = true; throw new Error('Mock lost update reply'); }
    return result;
  };
};

test('Budget adjustment success and same-key retries change the balance once', async () => {
  const f = make();
  await adjustment(f);
  const again = await adjustment(f);
  assert.equal(again.already_processed, true);
  assert.equal(f.db.BudgetBalance[0].balance, 9000);
  assert.equal(f.db.BudgetTransaction.length, 1);
  assertNoDeletes(f);
});

test('Budget claims reject changed amounts, accounts and actors', async () => {
  const f = make();
  await adjustment(f);
  for (const change of [{ amount: 2000 }, { account: 'bank' }]) {
    await assert.rejects(adjustment(f, change), error => error.status === 409);
  }
  f.db.User[0].id = 'other-owner';
  await assert.rejects(adjustment(f), error => error.status === 409);
  assert.equal(f.db.BudgetTransaction.length, 1);
});

test('overlapping same-key Budget adjustments cannot debit twice', async () => {
  const f = make();
  const results = await Promise.allSettled([adjustment(f), adjustment(f)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(f.db.BudgetBalance[0].balance, 9000);
  assert.equal(f.db.BudgetTransaction.length, 1);
});

test('a simultaneous changed-account key is rejected before either duplicate source debit', async () => {
  const f = make(); f.db.BudgetBalance.push({ id: 'bank-balance', account: 'bank', balance: 10000 });
  const results = await Promise.allSettled([adjustment(f), adjustment(f, { account: 'bank' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.db.BudgetBalance.reduce((sum, row) => sum + row.balance, 0), 19000);
  assert.equal(f.db.BudgetTransaction.length, 1);
});

test('the same supplier payment key on another owned shift is rejected before any debit', async () => {
  const f = make(); f.db.Shift.push({ ...structuredClone(f.db.Shift[0]), id: 'other-shift' });
  const results = await Promise.all([cashPayment(f), cashPayment(f, { shift_id: 'other-shift' })]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(f.db.Shift.reduce((sum, row) => sum + row.expected_cash, 0), 19000);
  assert.equal(f.db.CashMovement.length, 1);
  assert.equal(f.db.SupplierPayment.length, 1);
});

test('global readable settings guard contains no financial payload', async () => {
  const f = make(); await budgetPayment(f, { amount: 987, notes: 'Private payment note' });
  const operations = JSON.parse(f.db.Settings[0].budget_account_initialization_json);
  const scope = operations['request:budget-payment-first'];
  assert.equal(scope.actor, 'owner');
  assert.match(scope.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(f.db.Settings[0].budget_account_initialization_json, /987|Private payment note|supplier|cash/);
});

test('overlapping different Budget adjustments preserve both deltas and snapshots', async () => {
  const f = make();
  await Promise.all([adjustment(f), adjustment(f, { key: 'adjustment-second', amount: 2000 })]);
  assert.equal(f.db.BudgetBalance[0].balance, 7000);
  assert.equal(f.db.BudgetTransaction.length, 2);
  const ordered = [...f.db.BudgetTransaction].sort((a, b) => b.balance_before - a.balance_before);
  assert.equal(ordered[0].balance_before, 10000);
  assert.equal(ordered[0].balance_after, ordered[1].balance_before);
  assert.equal(ordered[1].balance_after, 7000);
});

for (const [label, predicate] of [
  ['request claim', ops => !ops.$inc && JSON.parse(ops.$set.financial_operations_json || '{}')['adjustment-first']?.worker],
  ['balance debit', ops => ops.$inc?.balance === -1000],
  ['completion marker', ops => JSON.parse(ops.$set.financial_operations_json || '{}')['adjustment-first']?.status === 'completed'],
]) {
  test(`Budget reconciles a lost ${label} reply without duplicate money`, async () => {
    const f = make(); loseUpdateReply(f, 'BudgetBalance', predicate);
    await adjustment(f); await adjustment(f);
    assert.equal(f.db.BudgetBalance[0].balance, 9000);
    assert.equal(f.db.BudgetTransaction.length, 1);
  });
}

test('Budget reconciles a saved transaction whose create reply was lost', async () => {
  const f = make(); loseCreateReply(f, 'BudgetTransaction');
  await adjustment(f); await adjustment(f);
  assert.equal(f.db.BudgetBalance[0].balance, 9000);
  assert.equal(f.db.BudgetTransaction.length, 1);
});

test('definite Budget ledger rejection compensates only its debit', async () => {
  const f = make();
  f.entities.BudgetTransaction.create = async () => {
    f.db.BudgetBalance[0].balance += 500;
    throw Object.assign(new Error('Mock validation rejection'), { status: 400 });
  };
  await assert.rejects(adjustment(f), error => error.operation_reversed === true);
  assert.equal(f.db.BudgetBalance[0].balance, 10500);
  await assert.rejects(adjustment(f), error => error.operation_reversed === true);
  assertNoDeletes(f);
});

test('a rejected deposit cannot compensate below zero after another withdrawal used it', async () => {
  const f = make(); f.db.BudgetBalance[0].balance = 0;
  f.entities.BudgetTransaction.create = async () => {
    f.db.BudgetBalance[0].balance = 0;
    throw Object.assign(new Error('Mock validation rejection'), { status: 400 });
  };
  await assert.rejects(adjustment(f, { direction: 'in' }), error => error.operation_pending === true);
  assert.equal(f.db.BudgetBalance[0].balance, 0);
  assertNoDeletes(f);
});

test('uncertain empty Budget writes retain a pending claim and never replay create', async () => {
  const f = make(); let creates = 0;
  f.entities.BudgetTransaction.create = async () => { creates += 1; throw new Error('Mock timeout'); };
  await assert.rejects(adjustment(f), error => error.operation_pending === true);
  await assert.rejects(adjustment(f), error => error.operation_pending === true);
  assert.equal(creates, 1); assert.equal(f.db.BudgetBalance[0].balance, 9000);
  assertNoDeletes(f);
});

test('a first Budget account is claimed once even with overlapping initialization', async () => {
  const f = make(); f.db.BudgetBalance = [];
  const ensure = f.load(helper).ensureBudgetAccount;
  const results = await Promise.allSettled([
    ensure(f.service, 'cash', 'Naqd pul', f.db.User[0]),
    ensure(f.service, 'cash', 'Naqd pul', f.db.User[0]),
  ]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(f.db.BudgetBalance.length, 1);
  assert.equal(f.db.BudgetBalance[0].balance, 0);
});

test('a first Budget account with a lost create reply is reconciled without recreating', async () => {
  const f = make(); f.db.BudgetBalance = []; loseCreateReply(f, 'BudgetBalance');
  await adjustment(f, { direction: 'in' });
  assert.equal(f.db.BudgetBalance.length, 1);
  assert.equal(f.db.BudgetBalance[0].balance, 1000);
});

test('an uncertain missing first account is never blindly recreated', async () => {
  const f = make(); f.db.BudgetBalance = []; let creates = 0;
  f.entities.BudgetBalance.create = async () => { creates += 1; throw new Error('Mock timeout'); };
  await assert.rejects(adjustment(f, { direction: 'in' }));
  await assert.rejects(adjustment(f, { direction: 'in' }));
  assert.equal(creates, 1); assert.equal(f.db.BudgetBalance.length, 0);
});

test('Budget supplier payments return the saved result after the entire debt is paid', async () => {
  const f = make();
  await budgetPayment(f, { amount: 10000 });
  const result = await budgetPayment(f, { amount: 10000 });
  assert.equal(result.already_processed, true);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 0);
  assert.equal(f.db.BudgetBalance[0].balance, 0);
  assert.equal(f.db.SupplierPayment.length, 1);
  assert.equal(f.db.BudgetTransaction.length, 1);
  assertNoDeletes(f);
});

test('Budget supplier payments reconcile both lost source-ledger and payment replies', async () => {
  const f = make(); loseCreateReply(f, 'BudgetTransaction'); loseCreateReply(f, 'SupplierPayment');
  await budgetPayment(f); await budgetPayment(f);
  assert.equal(f.db.BudgetBalance[0].balance, 9000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9000);
  assert.equal(f.db.SupplierPayment.length, 1);
  assert.equal(f.db.BudgetTransaction.length, 1);
});

test('supplier cash payment preserves existing shift ownership and rejects missing keys', async () => {
  const f = make();
  assert.equal((await cashPayment(f, { idempotency_key: '' })).status, 400);
  f.db.Shift[0].user_id = 'different-owner';
  assert.equal((await cashPayment(f)).status, 403);
  assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.equal(f.db.SupplierPayment.length, 0);
});

test('a shift-close claim winning before a supplier request claim prevents the request journal and debit', async () => {
  const f = make(); const update = f.entities.Shift.updateMany; let closed = false;
  f.entities.Shift.updateMany = async (query, ops) => {
    if (!closed && ops.$set?.supplier_payment_operations_json && !ops.$inc) {
      closed = true; f.db.Shift[0].status = 'closing';
      assert.equal(query.status, 'open');
    }
    return update(query, ops);
  };
  const result = await cashPayment(f);
  assert.equal(result.status, 409);
  assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.equal(f.db.Shift[0].cash_removed, 0);
  assert.equal(f.db.Shift[0].supplier_payment_operations_json, undefined);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 10000);
  assert.equal(f.db.CashMovement.length, 0);
});

test('supplier debit CAS cannot change a shift after it starts closing', async () => {
  const f = make(); const update = f.entities.Shift.updateMany; let closed = false;
  f.entities.Shift.updateMany = async (query, ops) => {
    if (!closed && ops.$inc?.expected_cash === -1000) {
      closed = true; f.db.Shift[0].status = 'closing';
      assert.equal(query.status, 'open');
    }
    return update(query, ops);
  };
  const result = await cashPayment(f);
  assert.equal(result.data.operation_pending, true);
  assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.equal(f.db.Shift[0].cash_removed, 0);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 10000);
  assert.equal(f.db.CashMovement.length, 0);
});

test('a stale closing predicate cannot claim a shift once a supplier journal changed', async () => {
  const f = make();
  const observedJournal = f.db.Shift[0].supplier_payment_operations_json;
  assert.equal((await cashPayment(f)).status, 200);
  // Isolate the journal predicate from the cash predicate to prove the journal
  // fence itself blocks a stale close request, even with current cash totals.
  const result = await f.entities.Shift.updateMany({ id: 'shift', status: 'open',
    supplier_payment_operations_json: observedJournal === undefined ? { $exists: false } : observedJournal },
  { $set: { status: 'closing' } });
  assert.equal(result.updated, 0); assert.equal(f.db.Shift[0].status, 'open');
});

test('supplier cash payments keep legacy four-digit PIN verification and reject wrong PINs', async () => {
  const f = make(); f.db.User[0].role = 'cashier';
  const salt = 'offline-only-pin-salt';
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('2468'), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  f.db.SecuritySettings = [{ id: 'security', key: 'owner_approval_pin', pin_hash: Buffer.from(bits).toString('hex'), pin_salt: salt, pin_algorithm: 'PBKDF2-SHA256', pin_iterations: 100000 }];
  assert.equal((await cashPayment(f, { owner_pin: '0000' })).status, 403);
  assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.equal(f.db.SupplierPayment.length, 0);
  assert.equal((await cashPayment(f, { owner_pin: '2468' })).status, 200);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
});

test('a deactivated supplier-payment actor cannot debit money or debt', async () => {
  const f = make(); f.db.User[0].active = false;
  assert.equal((await cashPayment(f)).status, 403);
  assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 10000);
  assert.equal(f.db.SupplierPayment.length, 0);
});

test('supplier cash payment retries do not double debit or change historical snapshots', async () => {
  const f = make();
  assert.equal((await cashPayment(f)).status, 200);
  const snapshots = structuredClone(f.db.SupplierPayment);
  const result = await cashPayment(f);
  assert.equal(result.status, 200); assert.equal(result.data.already_processed, true);
  assert.equal((await cashPayment(f, { amount: 2000 })).status, 409);
  assert.deepEqual(f.db.SupplierPayment, snapshots);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal(f.db.Shift[0].cash_removed, 1000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9000);
  assertNoDeletes(f);
});

for (const [label, entityName, predicate] of [
  ['shift debit', 'Shift', ops => ops.$inc?.expected_cash === -1000],
  ['debt delta', 'SupplierReceipt', ops => ops.$inc?.remaining_debt === -1000],
]) {
  test(`supplier payment reconciles a lost ${label} reply`, async () => {
    const f = make(); loseUpdateReply(f, entityName, predicate);
    assert.equal((await cashPayment(f)).status, 200);
    assert.equal((await cashPayment(f)).status, 200);
    assert.equal(f.db.Shift[0].expected_cash, 9000);
    assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9000);
    assert.equal(f.db.SupplierPayment.length, 1);
    assert.equal(f.db.CashMovement.length, 1);
  });
}

test('supplier payment reconciles lost cash movement and payment creation replies', async () => {
  const f = make(); loseCreateReply(f, 'CashMovement'); loseCreateReply(f, 'SupplierPayment');
  assert.equal((await cashPayment(f)).status, 200);
  assert.equal((await cashPayment(f)).status, 200);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9000);
  assert.equal(f.db.SupplierPayment.length, 1);
  assert.equal(f.db.CashMovement.length, 1);
  assert.equal(f.db.SupplierPayment[0].cash_movement_id, f.db.CashMovement[0].id);
});

test('a saved source delta followed by another payment before response loss is never repeated', async () => {
  const f = make(); const update = f.entities.Shift.updateMany; let used = false;
  f.entities.Shift.updateMany = async (query, ops) => {
    const result = await update(query, ops);
    if (!used && result.updated === 1 && ops.$inc?.expected_cash === -1000) {
      used = true;
      assert.equal((await cashPayment(f, { idempotency_key: 'interleaved-payment', amount: 2000 })).status, 200);
      throw new Error('Mock first reply lost after a later journal revision');
    }
    return result;
  };
  assert.equal((await cashPayment(f)).status, 200);
  assert.equal(f.db.Shift[0].expected_cash, 7000);
  assert.equal(f.db.Shift[0].cash_removed, 3000);
  assert.equal(f.db.SupplierPayment.length, 2);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 7000);
});

test('concurrent supplier payments preserve both payments and a concurrent cash sale', async () => {
  const f = make();
  const update = f.entities.Shift.updateMany; let saleAdded = false;
  f.entities.Shift.updateMany = async (query, ops) => {
    const result = await update(query, ops);
    if (!saleAdded && ops.$inc?.expected_cash) { f.db.Shift[0].expected_cash += 500; saleAdded = true; }
    return result;
  };
  const results = await Promise.all([cashPayment(f), cashPayment(f, { idempotency_key: 'cash-payment-second', amount: 2000 })]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(f.db.Shift[0].expected_cash, 7500);
  assert.equal(f.db.Shift[0].cash_removed, 3000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 7000);
  assert.equal(f.db.SupplierPayment.length, 2);
});

test('definite supplier ledger rejection compensates its own debt and cash, preserving other work', async () => {
  const f = make();
  f.entities.CashMovement.create = async () => {
    f.db.Shift[0].expected_cash += 500;
    f.db.SupplierReceipt[0].remaining_debt -= 700; // Another valid supplier payment.
    throw Object.assign(new Error('Mock validation rejection'), { status: 400 });
  };
  loseUpdateReply(f, 'Shift', ops => ops.$inc?.expected_cash === 1000);
  loseUpdateReply(f, 'SupplierReceipt', ops => ops.$inc?.remaining_debt === 1000);
  const result = await cashPayment(f);
  assert.equal(result.data.operation_reversed, true);
  assert.equal(f.db.Shift[0].expected_cash, 10500);
  assert.equal(f.db.Shift[0].cash_removed, 0);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9300);
  assert.equal(f.db.SupplierReceipt[0].status, 'partial');
  assert.equal(f.db.SupplierPayment.length, 0);
  assertNoDeletes(f);
});

test('interrupted two-receipt refunds resume compensation without a forward replay', async () => {
  const f = make();
  Object.assign(f.db.SupplierReceipt[0], { debt_amount: 1000, remaining_debt: 1000 });
  f.db.SupplierReceipt.push({ ...structuredClone(f.db.SupplierReceipt[0]), id: 'receipt-two', receipt_number: 'K-2', received_at: '2026-09-02' });
  let creates = 0;
  f.entities.CashMovement.create = async () => { creates++; throw Object.assign(new Error('Mock ledger rejection'), { status: 400 }); };
  const update = f.entities.SupplierReceipt.updateMany; let rejectRefund = true;
  f.entities.SupplierReceipt.updateMany = async (query, ops) => {
    if (rejectRefund && query.id === 'receipt' && ops.$inc?.remaining_debt === 1000) throw Object.assign(new Error('Mock first receipt refund rejected'), { status: 400 });
    return update(query, ops);
  };
  const first = await cashPayment(f, { amount: 2000 });
  assert.equal(first.status, 503); assert.equal(first.data.operation_pending, true);
  assert.equal(f.db.Shift[0].expected_cash, 8000);
  assert.deepEqual(f.db.SupplierReceipt.map(row => row.remaining_debt), [0, 1000]);
  assert.equal(JSON.parse(f.db.Shift[0].supplier_payment_operations_json)['cash-payment-first'].compensation_requested, true);
  rejectRefund = false;
  const retry = await cashPayment(f, { amount: 2000 });
  assert.equal(retry.data.operation_reversed, true);
  assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.equal(f.db.Shift[0].cash_removed, 0);
  assert.deepEqual(f.db.SupplierReceipt.map(row => row.remaining_debt), [1000, 1000]);
  assert.equal(creates, 1); assert.equal(f.db.SupplierPayment.length, 0);
  assert.equal((await cashPayment(f, { amount: 2000 })).data.operation_reversed, true);
  assert.equal(f.db.Shift[0].expected_cash, 10000);
  assertNoDeletes(f);
});

test('an interrupted cash refund retries only compensation and preserves a later cash sale', async () => {
  const f = make(); let creates = 0;
  f.entities.CashMovement.create = async () => { creates++; throw Object.assign(new Error('Mock ledger rejection'), { status: 400 }); };
  const update = f.entities.Shift.updateMany; let rejectRefund = true;
  f.entities.Shift.updateMany = async (query, ops) => {
    if (rejectRefund && ops.$inc?.expected_cash === 1000) throw Object.assign(new Error('Mock cash refund rejection'), { status: 400 });
    return update(query, ops);
  };
  const first = await cashPayment(f);
  assert.equal(first.data.operation_pending, true);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 10000);
  f.db.Shift[0].expected_cash += 500;
  rejectRefund = false;
  assert.equal((await cashPayment(f)).data.operation_reversed, true);
  assert.equal(f.db.Shift[0].expected_cash, 10500);
  assert.equal(f.db.Shift[0].cash_removed, 0);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 10000);
  assert.equal(creates, 1); assertNoDeletes(f);
});

test('interrupted Budget refunds resume only compensation and do not create a replacement ledger', async () => {
  const f = make(); let creates = 0;
  f.entities.BudgetTransaction.create = async () => { creates++; throw Object.assign(new Error('Mock ledger rejection'), { status: 400 }); };
  const update = f.entities.BudgetBalance.updateMany; let rejectRefund = true;
  f.entities.BudgetBalance.updateMany = async (query, ops) => {
    if (rejectRefund && ops.$inc?.balance === 1000) throw Object.assign(new Error('Mock balance refund rejection'), { status: 400 });
    return update(query, ops);
  };
  await assert.rejects(adjustment(f), error => error.operation_pending === true);
  assert.equal(f.db.BudgetBalance[0].balance, 9000);
  rejectRefund = false;
  await assert.rejects(adjustment(f), error => error.operation_reversed === true);
  assert.equal(f.db.BudgetBalance[0].balance, 10000);
  assert.equal(creates, 1); assert.equal(f.db.BudgetTransaction.length, 0);
  assertNoDeletes(f);
});

test('supplier compensation keeps a closed shift and its historical cash snapshot unchanged', async () => {
  const f = make(); let creates = 0;
  f.entities.CashMovement.create = async () => {
    creates++; f.db.Shift[0].status = 'closed';
    throw Object.assign(new Error('Mock ledger rejection after close'), { status: 400 });
  };
  const first = await cashPayment(f); const retry = await cashPayment(f);
  assert.equal(first.data.operation_pending, true); assert.equal(retry.data.operation_pending, true);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal(f.db.Shift[0].cash_removed, 1000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9000);
  assert.equal(creates, 1); assert.equal(f.db.SupplierPayment.length, 0);
  assertNoDeletes(f);
});

test('partial supplier ledger failures retain immutable evidence and finish forward on retry', async () => {
  const f = make(); const create = f.entities.SupplierPayment.create; let failOnce = true;
  f.entities.SupplierPayment.create = async data => {
    if (failOnce) { failOnce = false; throw Object.assign(new Error('Mock validation rejection'), { status: 400 }); }
    return create(data);
  };
  const first = await cashPayment(f);
  assert.equal(first.data.operation_pending, true);
  assert.equal(f.db.CashMovement.length, 1);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal((await cashPayment(f)).status, 200);
  assert.equal(f.db.SupplierPayment.length, 1);
  assert.equal(f.db.CashMovement.length, 1);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9000);
  assertNoDeletes(f);
});

test('uncertain supplier ledger writes do not resubmit or erase evidence', async () => {
  const f = make(); let creates = 0;
  f.entities.CashMovement.create = async () => { creates += 1; throw new Error('Mock timeout'); };
  const first = await cashPayment(f); const second = await cashPayment(f);
  assert.equal(first.data.operation_pending, true);
  assert.equal(second.data.operation_pending, true);
  assert.equal(creates, 1);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9000);
  assertNoDeletes(f);
});

test('supplier audit failures cannot roll back a completed valid payment', async () => {
  const f = make();
  f.entities.ActionHistory.create = async () => { throw new Error('Mock audit outage'); };
  assert.equal((await cashPayment(f)).status, 200);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal(f.db.SupplierReceipt[0].remaining_debt, 9000);
  assert.equal(f.db.SupplierPayment.length, 1);
  assert.equal(f.db.CashMovement.length, 1);
  assertNoDeletes(f);
});
