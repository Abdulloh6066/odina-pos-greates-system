// Memory-only checkout replay tests. No real transactions or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const file = 'base44/functions/complete-sale/entry.ts';
const body = { action: 'complete_sale', shift_id: 'shift', idempotency_key: 'pos-retry-lifecycle-001',
  recorded_at: '2026-09-27T07:00:00.000Z', items: [{ product_id: 'cake', quantity: 1 }],
  payments: [{ method: 'cash', amount: 100000 }] };
const make = () => memoryBackend({
  User: [{ id: 'cashier', role: 'cashier', shop_id: 'shop', active: true, full_name: 'Mock cashier' }],
  Shift: [{ id: 'shift', user_id: 'cashier', shop_id: 'shop', shop_name: 'Test shop', status: 'open',
    opened_at: '2026-09-27T06:00:00.000Z', expected_cash: 0, total_sales: 0, order_count: 0, sale_request_keys: [] }],
  Shop: [{ id: 'shop', name: 'Test shop', location_type: 'shop', allows_pos: true, active: true }],
  Product: [{ id: 'cake', name: 'Test cake', price: 100000, track_stock: false, active: true }],
  Settings: [{ id: 'settings', allow_negative_stock: false }],
  Sale: [], SaleItem: [], Payment: [], ActionHistory: [],
});

test('retry during item saving cannot acknowledge or discard an unfinished sale', async () => {
  const f = make(); let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const original = f.entities.SaleItem.bulkCreate;
  f.entities.SaleItem.bulkCreate = async items => { entered(); await gate; return original(items); };
  const first = f.invoke(file, body);
  await reached;
  assert.equal(f.db.Sale.length, 1);
  assert.equal(f.db.Shift[0].expected_cash, 0);
  assert.equal(f.db.Shift[0].sale_request_keys.includes('sale-completed:' + body.idempotency_key), false);
  const retry = await f.invoke(file, body);
  assert.equal(retry.status, 503); assert.equal(retry.data.sale, undefined);
  release();
  const completed = await first;
  assert.equal(completed.status, 200, JSON.stringify(completed));
  const acknowledged = await f.invoke(file, body);
  assert.equal(acknowledged.status, 200); assert.equal(acknowledged.data.already_processed, true);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.SaleItem.length, 1); assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.Shift[0].expected_cash, 100000); assert.equal(f.db.Shift[0].order_count, 1);
});
test('a normal checkout uses one final shift update to save totals and confirmation together', async () => {
  const f = make(); const result = await f.invoke(file, body);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.Shift[0].sale_request_keys.includes('sale-completed:' + body.idempotency_key), true);
  assert.equal(f.calls.filter(([name, action]) => name === 'Shift' && action === 'updateMany').length, 2,
    'one existing request claim and one existing final totals write; no extra checkout request');
});
test('legacy completed receipts still replay without altering historical snapshots', async () => {
  const f = make();
  f.db.Sale.push({ id: 'legacy', user_id: 'cashier', shift_id: 'shift', idempotency_key: body.idempotency_key,
    financial_records_version: 2, total: 100000, status: 'completed' });
  const result = await f.invoke(file, body);
  assert.equal(result.status, 200); assert.equal(result.data.already_processed, true);
  assert.equal(f.db.Sale[0].financial_records_version, 2); assert.equal(f.calls.length, 0);
});
