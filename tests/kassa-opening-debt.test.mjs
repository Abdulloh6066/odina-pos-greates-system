// Offline regression fixtures only. No production records or transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { memoryBackend } from './helpers/memory-backend.mjs';

const file = 'base44/functions/supplier-ledger/entry.ts';
const make = (role = 'admin', location = 'shop-a') => memoryBackend({
  User: [{ id: 'actor', role, active: true, full_name: 'Mock actor', shop_id: 'shop-a' }],
  Settings: [{ id: 'settings', shop_name: 'Mock shops' }],
  Shop: ['shop-a', 'shop-b'].map(id => ({ id, name: `Mock ${id}`, active: true })),
  Shift: ['a', 'b'].map(id => ({ id: `shift-${id}`, user_id: 'actor', shop_id: `shop-${id}`,
    shop_name: `Mock shop ${id}`, status: 'open', expected_cash: 10000, cash_removed: 0 })),
  CashRecipient: [{ id: 'supplier', name: 'Mock supplier', active: true, recipient_type: 'supplier' }],
  SupplierOpeningDebt: [{ id: 'opening', supplier_id: 'supplier', supplier_name_snapshot: 'Mock supplier',
    debt_number: 'O-1', debt_amount: 5000, remaining_debt: 5000, status: 'unpaid', effective_date: '2020-01-01',
    ...(location ? { location_id: location } : {}) }],
  BudgetBalance: [{ id: 'budget', account: 'cash', balance: 10000 }],
  SupplierReceipt: [], SupplierPayment: [], CashMovement: [], BudgetTransaction: [], ActionHistory: [],
  SecuritySettings: [{ id: 'security', key: 'owner_approval_pin', pin_salt: 'offline-fixture',
    pin_hash: pbkdf2Sync('2468', 'offline-fixture', 100000, 32, 'sha256').toString('hex'),
    pin_algorithm: 'PBKDF2-SHA256', pin_iterations: 100000 }],
});
const cash = (f, changes = {}) => f.invoke(file, { action: 'pay_debt', supplier_id: 'supplier',
  shift_id: 'shift-a', amount: 1000, notes: 'Mock repayment', idempotency_key: 'cash-opening-a', owner_pin: '2468', ...changes });
const budget = (f, changes = {}) => f.load('base44/shared/supplier-payment-recovery.ts').runSupplierPayment(f.service, f.db.User[0], {
  action: 'pay_supplier', supplier_id: 'supplier', account: 'cash', amount: 1000, key: 'budget-opening', notes: 'Mock repayment', ...changes,
}, { cash: 'Naqd' });
const untouchedBudget = f => {
  assert.equal(f.db.BudgetBalance[0].balance, 10000);
  assert.equal(f.db.BudgetTransaction.length, 0);
  assert.equal(f.calls.some(([entity, operation]) => entity === 'BudgetBalance' && ['create', 'update', 'updateMany'].includes(operation)), false);
};

for (const role of ['admin', 'manager', 'cashier']) {
  for (const location of ['', 'shop-a', 'shop-b']) {
    test(`${role} sees and pays shared opening liability from either Kassa (opening location ${location || 'unassigned'})`, async () => {
      const f = make(role, location);
      assert.deepEqual((await f.invoke(file, { action: 'get_debts' })).data.debts, { supplier: 5000 });
      assert.equal((await cash(f)).status, 200);
      f.db.User[0].shop_id = 'shop-b';
      assert.deepEqual((await f.invoke(file, { action: 'get_debts' })).data.debts, { supplier: 4000 });
      assert.equal((await cash(f, { shift_id: 'shift-b', amount: 4000, idempotency_key: 'cash-opening-b' })).status, 200);
      assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 0);
      assert.equal(f.db.SupplierOpeningDebt[0].debt_amount, 5000);
      assert.equal(f.db.SupplierOpeningDebt[0].status, 'paid');
      assert.deepEqual(f.db.Shift.map(s => [s.expected_cash, s.cash_removed]), [[9000, 1000], [6000, 4000]]);
      assert.deepEqual(f.db.SupplierPayment.map(p => [p.opening_debt_id, p.payment_source, p.shift_id, p.shop_id]),
        [['opening', 'shift_cash', 'shift-a', 'shop-a'], ['opening', 'shift_cash', 'shift-b', 'shop-b']]);
      assert.equal(f.db.CashMovement.length, 2);
      assert.deepEqual((await f.invoke(file, { action: 'get_debts' })).data.debts, {});
      untouchedBudget(f);
    });
  }
}

test('Kassa opening retries preserve snapshots and reject changed amount or paying shift', async () => {
  const f = make();
  assert.equal((await cash(f)).status, 200);
  const snapshot = structuredClone(f.db.SupplierPayment);
  assert.equal((await cash(f)).data.already_processed, true);
  for (const changes of [{ amount: 2000 }, { shift_id: 'shift-b' }]) assert.equal((await cash(f, changes)).status, 409);
  assert.deepEqual(f.db.SupplierPayment, snapshot);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal(f.db.Shift[0].cash_removed, 1000);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 4000);
  untouchedBudget(f);
});

for (const source of ['another shift', 'Budget']) {
  test(`concurrent Kassa and ${source} cannot overpay the same opening liability`, async () => {
    const f = make();
    const results = await Promise.allSettled([cash(f, { amount: 4000 }), source === 'Budget'
      ? budget(f, { amount: 4000 })
      : cash(f, { shift_id: 'shift-b', amount: 4000, idempotency_key: 'cash-opening-b' })]);
    assert.ok(results.some(r => r.status === 'fulfilled' && (r.value.status === undefined || r.value.status === 200)));
    assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 1000);
    assert.equal(f.db.SupplierPayment.reduce((sum, p) => sum + p.amount, 0), 4000);
    assert.equal(f.db.Shift.reduce((sum, s) => sum + s.expected_cash, 0) + f.db.BudgetBalance[0].balance, 26000);
    assert.equal(f.db.Shift.reduce((sum, s) => sum + s.cash_removed, 0), 20000 - f.db.Shift.reduce((sum, s) => sum + s.expected_cash, 0));
    assert.equal(f.db.CashMovement.length + f.db.BudgetTransaction.length, 1);
  });
}

test('simultaneous identical opening Kassa requests debit and allocate only once', async () => {
  const f = make(); const results = await Promise.all([cash(f), cash(f)]);
  assert.ok(results.some(r => r.status === 200));
  assert.equal((await cash(f)).data.already_processed, true);
  assert.equal(f.db.SupplierPayment.length, 1); assert.equal(f.db.CashMovement.length, 1);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 4000);
  assert.equal(f.db.Shift[0].expected_cash, 9000); untouchedBudget(f);
});

for (const entity of ['CashMovement', 'SupplierPayment']) {
  test(`lost ${entity} create reply recovers an opening Kassa payment without duplicate`, async () => {
    const f = make(); const create = f.entities[entity].create;
    f.entities[entity].create = async data => { await create(data); throw new Error('Mock lost reply'); };
    assert.equal((await cash(f)).status, 200); assert.equal((await cash(f)).data.already_processed, true);
    assert.equal(f.db.SupplierPayment.length, 1); assert.equal(f.db.CashMovement.length, 1);
    assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 4000);
    assert.equal(f.db.Shift[0].expected_cash, 9000); untouchedBudget(f);
  });
  test(`ambiguous ${entity} creation is not blindly replayed for an opening Kassa payment`, async () => {
    const f = make(); let attempts = 0;
    f.entities[entity].create = async () => { attempts++; throw new Error('Mock timeout'); };
    assert.equal((await cash(f)).data.operation_pending, true);
    assert.equal((await cash(f)).data.operation_pending, true);
    assert.equal(attempts, 1);
    assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 4000);
    assert.equal(f.db.Shift[0].expected_cash, 9000); untouchedBudget(f);
  });
}

for (const [entity, field] of [['Shift', 'expected_cash'], ['SupplierOpeningDebt', 'remaining_debt']]) {
  test(`lost ${entity} debit reply reconciles opening Kassa payment`, async () => {
    const f = make(); const update = f.entities[entity].updateMany; let lost = false;
    f.entities[entity].updateMany = async (query, ops) => {
      const result = await update(query, ops);
      if (!lost && result.updated === 1 && ops.$inc?.[field] === -1000) { lost = true; throw new Error('Mock lost reply'); }
      return result;
    };
    assert.equal((await cash(f)).status, 200); assert.equal((await cash(f)).data.already_processed, true);
    assert.equal(lost, true); assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 4000);
    assert.equal(f.db.Shift[0].expected_cash, 9000); assert.equal(f.db.Shift[0].cash_removed, 1000);
    assert.equal(f.db.SupplierPayment.length, 1); untouchedBudget(f);
  });
}

test('definite cash ledger rejection restores opening liability and paying shift once', async () => {
  const f = make();
  f.entities.CashMovement.create = async () => { throw Object.assign(new Error('Mock rejection'), { status: 422 }); };
  assert.equal((await cash(f)).data.operation_reversed, true);
  assert.equal((await cash(f)).data.operation_reversed, true);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 5000);
  assert.equal(f.db.SupplierOpeningDebt[0].status, 'unpaid');
  assert.equal(f.db.Shift[0].expected_cash, 10000); assert.equal(f.db.Shift[0].cash_removed, 0);
  assert.equal(f.db.SupplierPayment.length, 0); assert.equal(f.db.CashMovement.length, 0); untouchedBudget(f);
});

for (const [label, configure, changes, status] of [
  ['invalid PIN', f => { f.db.User[0].role = 'cashier'; }, { owner_pin: '0000' }, 403],
  ['missing PIN', f => { f.db.User[0].role = 'cashier'; }, { owner_pin: '' }, 403],
  ['inactive supplier', f => { f.db.CashRecipient[0].active = false; }, {}, 404],
  ['another actor shift', f => { f.db.Shift[0].user_id = 'other'; }, {}, 403],
  ['wrong shop shift', f => { f.db.User[0].role = 'cashier'; }, { shift_id: 'shift-b' }, 403],
  ['closed shift', f => { f.db.Shift[0].status = 'closed'; }, {}, 409],
  ['overpayment', () => {}, { amount: 5001 }, 400],
  ['insufficient cash', f => { f.db.Shift[0].expected_cash = 500; }, {}, 400],
]) {
  test(`${label} prevents opening Kassa debt and cash mutations`, async () => {
    const f = make(); configure(f); const expected = f.db.Shift.map(s => s.expected_cash);
    assert.equal((await cash(f, changes)).status, status);
    assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 5000);
    assert.deepEqual(f.db.Shift.map(s => s.expected_cash), expected);
    assert.ok(f.db.Shift.every(s => s.cash_removed === 0));
    assert.equal(f.db.SupplierPayment.length, 0); assert.equal(f.db.CashMovement.length, 0); untouchedBudget(f);
  });
}

test('owner opening audit includes both Kassa and Budget payment evidence without recovery journals', async () => {
  const f = make();
  assert.equal((await cash(f)).status, 200);
  await budget(f);
  const result = await f.invoke(file, { action: 'list_opening_debts' });
  assert.equal(result.status, 200);
  assert.equal(result.data.opening_debts[0].remaining_debt, 3000);
  assert.deepEqual(result.data.payments.map(p => p.payment_source).sort(), ['budget', 'shift_cash']);
  assert.equal(result.data.payments.every(p => p.opening_debt_id === 'opening'), true);
  assert.equal(result.data.payments.some(p => p.request_fingerprint), false);
  assert.equal(result.data.opening_debts[0].payment_operations_json, undefined);
});

test('shared opening totals and Kassa allocations paginate beyond 500 and exclude cancelled liabilities', async () => {
  const f = make();
  f.db.SupplierOpeningDebt = Array.from({ length: 501 }, (_, index) => ({
    id: `opening-${index}`, supplier_id: 'supplier', debt_number: `O-${index}`, debt_amount: 1,
    remaining_debt: 1, status: 'unpaid', effective_date: '2020-01-01', location_id: 'shop-b',
  }));
  f.db.SupplierOpeningDebt.push(...['cancelled', 'cancelling'].map(status => ({
    id: status, supplier_id: 'supplier', debt_amount: 9999, remaining_debt: 9999, status,
  })));
  assert.deepEqual((await f.invoke(file, { action: 'get_debts' })).data.debts, { supplier: 501 });
  assert.equal((await cash(f, { amount: 501 })).status, 200);
  assert.equal(f.db.SupplierPayment.length, 501);
  assert.equal(f.db.SupplierOpeningDebt.slice(0, 501).every(d => d.remaining_debt === 0), true);
  assert.deepEqual(f.db.SupplierOpeningDebt.slice(501).map(d => d.remaining_debt), [9999, 9999]);
  assert.deepEqual((await f.invoke(file, { action: 'get_debts' })).data.debts, {});
  assert.equal(f.db.Shift[0].expected_cash, 9499); untouchedBudget(f);
});

test('manager totals and mixed Kassa repayment combine shared opening debt with own-shop purchases only', async () => {
  const f = make('manager', 'shop-b');
  f.db.SupplierReceipt = ['a', 'b'].map(id => ({ id: `receipt-${id}`, supplier_id: 'supplier',
    receipt_number: `K-${id}`, location_id: `shop-${id}`, debt_amount: 2000, remaining_debt: 2000,
    status: 'unpaid', received_at: '2026-01-01' }));
  assert.deepEqual((await f.invoke(file, { action: 'get_debts' })).data.debts, { supplier: 7000 });
  assert.equal((await cash(f, { amount: 6000 })).status, 200);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 0);
  assert.deepEqual(f.db.SupplierReceipt.map(r => r.remaining_debt), [1000, 2000]);
  assert.deepEqual(f.db.SupplierPayment.map(p => [p.opening_debt_id || '', p.receipt_id || '', p.amount]),
    [['opening', '', 5000], ['', 'receipt-a', 1000]]);
  assert.deepEqual((await f.invoke(file, { action: 'get_debts' })).data.debts, { supplier: 1000 });
  untouchedBudget(f);
});
