// Memory-only tests; no live records or network are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const file = 'base44/functions/complete-sale/entry.ts';
const make = () => memoryBackend({
  User: [{ id: 'cashier', role: 'cashier', shop_id: 'shop', active: true, full_name: 'Mock cashier' }],
  Shift: [{ id: 'shift', user_id: 'cashier', shop_id: 'shop', status: 'open', expected_cash: 100000, cash_removed: 0, sale_request_keys: [] }],
  CashMovement: [], ActionHistory: [],
});
const body = (amount = 20000, key = 'withdrawal-test-one') => ({ action: 'cash_withdrawal', shift_id: 'shift',
  amount, reason: 'Mock expense', expense_category: 'shop_expense', idempotency_key: key });

test('two overlapping withdrawals preserve both debits and the complete ledger', async () => {
  const f = make();
  const results = await Promise.all([f.invoke(file, body(20000, 'first-request')), f.invoke(file, body(30000, 'second-request'))]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(f.db.Shift[0].expected_cash, 50000);
  assert.equal(f.db.Shift[0].cash_removed, 50000);
  assert.equal(f.db.CashMovement.reduce((s, r) => s + r.amount, 0), 50000);
});
test('repeating the same request after success does not pay or record it twice', async () => {
  const f = make();
  assert.equal((await f.invoke(file, body())).status, 200);
  const repeat = await f.invoke(file, body());
  assert.equal(repeat.status, 200); assert.equal(repeat.data.already_processed, true);
  assert.equal(f.db.CashMovement.length, 1); assert.equal(f.db.Shift[0].expected_cash, 80000);
});
test('concurrent requests sharing a key cannot double debit even with changed amounts', async () => {
  const f = make();
  await Promise.all([f.invoke(file, body(20000)), f.invoke(file, body(30000))]);
  assert.equal(f.db.CashMovement.length, 1);
  assert.equal(f.db.Shift[0].expected_cash, 100000 - f.db.CashMovement[0].amount);
});
test('concurrent withdrawals cannot overdraw the drawer', async () => {
  const f = make();
  const results = await Promise.all([f.invoke(file, body(70000, 'first-request')), f.invoke(file, body(60000, 'second-request'))]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.ok(f.db.Shift[0].expected_cash >= 0);
  assert.equal(f.db.CashMovement.length, 1);
});
test('another cashier cannot debit this shift', async () => {
  const f = make(); f.db.Shift[0].user_id = 'different-worker';
  assert.equal((await f.invoke(file, body())).status, 403);
  assert.equal(f.db.Shift[0].expected_cash, 100000); assert.equal(f.db.CashMovement.length, 0);
});
test('a known rejected ledger write reverses only its own debit, preserving concurrent sales', async () => {
  const f = make();
  f.entities.CashMovement.create = async () => {
    f.db.Shift[0].expected_cash += 5000;
    throw Object.assign(new Error('Mock validation rejection'), { status: 400 });
  };
  const result = await f.invoke(file, body());
  assert.equal(result.status, 400);
  assert.equal(f.db.Shift[0].expected_cash, 105000);
  assert.equal(f.db.Shift[0].cash_removed, 0);
  assert.deepEqual(f.db.Shift[0].sale_request_keys, []);
});
test('a lost ledger response is reconciled from the saved record, without a second debit', async () => {
  const f = make(); const create = f.entities.CashMovement.create;
  f.entities.CashMovement.create = async data => { await create(data); throw new Error('Mock lost response'); };
  assert.equal((await f.invoke(file, body())).status, 200);
  assert.equal((await f.invoke(file, body())).status, 200);
  assert.equal(f.db.CashMovement.length, 1); assert.equal(f.db.Shift[0].expected_cash, 80000);
});
test('an uncertain ledger failure is flagged and cannot debit again on retry', async () => {
  const f = make(); f.entities.CashMovement.create = async () => { throw new Error('Mock timeout'); };
  const first = await f.invoke(file, body()); const again = await f.invoke(file, body());
  assert.equal(first.status, 503); assert.equal(first.data.operation_pending, true);
  assert.equal(again.status, 503); assert.equal(f.db.Shift[0].expected_cash, 80000);
  assert.ok(f.db.ActionHistory.some(row => row.action === 'cash_withdrawal_needs_review'));
});
test('an audit-log error cannot turn a saved withdrawal into a false payment failure', async () => {
  const f = make(); f.entities.ActionHistory.create = async () => { throw new Error('Mock audit unavailable'); };
  assert.equal((await f.invoke(file, body())).status, 200);
  assert.equal(f.db.Shift[0].expected_cash, 80000);
});
