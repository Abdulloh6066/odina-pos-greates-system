import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';

const manager = { id: 'manager-a', role: 'manager', shop_id: 'shop-a', active: true, full_name: 'Manager A' };
const seed = () => ({
  User: [manager],
  Shop: [{ id: 'shop-a', name: 'A', active: true, location_type: 'shop', allows_pos: true, restaurant_table_count: 2, restaurant_table_layout_version: 0 },
    { id: 'shop-b', name: 'B', active: true, location_type: 'shop', allows_pos: true, restaurant_table_count: 2, restaurant_table_layout_version: 0 }],
  Shift: [{ id: 'other-shift', shop_id: 'shop-b', user_id: 'manager-a', status: 'open' }],
  Sale: [{ id: 'other-sale', shop_id: 'shop-b', status: 'completed' }],
  CustomerOrder: [{ id: 'other-order', shop_id: 'shop-b' }],
  SupplierReceipt: [{ id: 'other-receipt', location_id: 'shop-b', supplier_id: 'supplier', remaining_debt: 9000 },
    { id: 'own-receipt', location_id: 'shop-a', supplier_id: 'supplier', remaining_debt: 2000 }],
  StockCount: [{ id: 'other-count', location_id: 'shop-b', status: 'draft' }, { id: 'own-count', location_id: 'shop-a', status: 'draft' }],
  Product: [{ id: 'p', name: 'Cake', price: 10000, active: true, shop_prices: { 'shop-b': 15000 } }],
});

test('manager table settings use own active shop only', async () => {
  const f = memoryBackend(seed());
  const path = 'base44/functions/restaurant-tables/entry.ts';
  let handler;
  f.load(path, { Deno: { serve: (fn) => { handler = fn; } } });
  const invoke = async (_path, body) => { const r = await handler({ json: async () => body }); return { status: r.status, data: await r.json() }; };
  const status = await invoke(path, { action: 'status', shop_id: 'shop-b' });
  assert.equal(status.status, 200);
  assert.equal(status.data.can_manage, true);
  assert.deepEqual(status.data.shops.map(s => s.id), ['shop-a']);
  assert.equal((await invoke(path, { action: 'set_table_count', shop_id: 'shop-b', table_count: 3 })).status, 403);
  assert.equal((await invoke(path, { action: 'set_table_count', shop_id: 'shop-a', table_count: 3 })).status, 200);
  assert.equal(f.db.Shop[1].restaurant_table_count, 2);
});

test('manager requests reject foreign sale, shift, order, receipt and count before writes', async () => {
  for (const [path, body] of [
    ['complete-sale', { action: 'refund_sale', sale_id: 'other-sale' }],
    ['complete-sale', { action: 'cash_withdrawal', shift_id: 'other-shift' }],
    ['shift-close-v2', { action: 'close_shift', shift_id: 'other-shift' }],
    ['customer-orders', { action: 'complete_order', order_id: 'other-order' }],
    ['supplier-ledger', { action: 'cancel_receipt', receipt_id: 'other-receipt' }],
    ['stock-count', { action: 'approve_count', count_id: 'other-count' }],
  ]) {
    const f = memoryBackend(seed());
    const result = await f.invoke('base44/functions/' + path + '/entry.ts', body);
    assert.equal(result.status, 403, path + JSON.stringify(result));
    assert.equal(f.calls.length, 0, path + ' performed writes');
  }
});

test('manager can open own shop shift and cannot use a requested other shop', async () => {
  const data = seed(); data.Shift = [];
  const f = memoryBackend(data);
  const path = 'base44/functions/complete-sale/entry.ts';
  assert.equal((await f.invoke(path, { action: 'open_shift', shop_id: 'shop-b', starting_cash: 0 })).status, 403);
  const result = await f.invoke(path, { action: 'open_shift', shop_id: 'shop-a', starting_cash: 0 });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.Shift[0].shop_id, 'shop-a');
});

test('manager debts and count lists contain only assigned location', async () => {
  const f = memoryBackend(seed());
  const debts = await f.invoke('base44/functions/supplier-ledger/entry.ts', { action: 'get_debts' });
  assert.equal(debts.status, 200, JSON.stringify(debts));
  assert.equal(debts.data.debts.supplier, 2000);
  const counts = await f.invoke('base44/functions/stock-count/entry.ts', { action: 'list_counts' });
  assert.equal(counts.status, 200);
  assert.deepEqual(counts.data.counts.map(c => c.id), ['own-count']);
});

test('manager cannot access budget or global report configuration', async () => {
  const f = memoryBackend(seed());
  assert.equal((await f.invoke('base44/functions/budget-ledger/entry.ts', { action: 'summary' })).status, 403);
  assert.equal((await f.invoke('base44/functions/daily-sales-export/entry.ts', { action: 'getConfig' })).status, 403);
});

test('manager reports scope shops before generating totals and ignore a forged shop selection', async () => {
  const data = seed(); data.Sale = [];
  const f = memoryBackend(data);
  for (const action of ['preview', 'range']) {
    const result = await f.invoke('base44/functions/daily-sales-export/entry.ts', {
      action, shop_id: 'shop-b', business_date: '2026-09-27', date_from: '2026-09-27', date_to: '2026-09-27',
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    const rows = action === 'preview' ? result.data.reports : result.data.shops;
    assert.deepEqual(rows.map(r => r.shop_id), ['shop-a']);
    assert.ok(!JSON.stringify(result.data).includes('shop-b'));
  }
});

test('manager price changes write only the assigned shop price key', async () => {
  const f = memoryBackend(seed());
  const path = 'base44/functions/manager-shop/entry.ts';
  assert.equal((await f.invoke(path, { action: 'set_product_price', product_id: 'p', shop_id: 'shop-b', price: 20000 })).status, 403);
  let set;
  f.entities.Product.updateMany = async (query, ops) => { assert.equal(query.id, 'p'); set = ops.$set; return { success: true, updated: 1 }; };
  const result = await f.invoke(path, { action: 'set_product_price', product_id: 'p', price: 20000 });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(set), ['shop_prices.shop-a']);
  assert.equal(set['shop_prices.shop-a'], 20000);
  assert.equal(f.db.Product[0].price, 10000);
  assert.equal(f.db.Product[0].shop_prices['shop-b'], 15000);
});

test('inactive and unassigned manager cannot open operational backend access', async () => {
  for (const patch of [{ active: false }, { shop_id: '' }]) {
    const data = seed(); data.User[0] = { ...manager, ...patch };
    const f = memoryBackend(data);
    assert.equal((await f.invoke('base44/functions/manager-shop/entry.ts', { action: 'set_product_price', product_id: 'p', price: 10 })).status, 403);
    assert.equal(f.calls.length, 0);
  }
});

function permits(rule, user, row) {
  if (typeof rule === 'boolean') return rule;
  return Object.entries(rule).every(([key, value]) => {
    if (key === '$or') return value.some(r => permits(r, user, row));
    if (key === '$and') return value.every(r => permits(r, user, row));
    if (key === '$nor') return !value.some(r => permits(r, user, row));
    if (key === 'user_condition') return Object.entries(value).every(([k,v]) => user[k] === v);
    const actual = row[key.startsWith('data.') ? key.slice(5) : key];
    if (value && typeof value === 'object') return Object.entries(value).every(([op,v]) => op === '$nin' ? !v.includes(actual ?? null) : op === '$ne' ? actual !== v : false);
    const expected = value === '{{user.data.shop_id}}' ? user.shop_id : value === '{{user.id}}' ? user.id : value;
    return actual === expected;
  });
}
test('entity RLS rejects other shops even when manager is the row creator', () => {
  for (const [entity, field] of Object.entries({Shop:'id', Sale:'shop_id', SaleItem:'shop_id', Payment:'shop_id', Refund:'shop_id', Shift:'shop_id', CashMovement:'shop_id', CustomerOrder:'shop_id', CustomerOrderItem:'shop_id', OrderPayment:'shop_id', ShiftProductSnapshot:'shop_id', StockMovement:'location_id', ProductionBatch:'location_id', SupplierReceipt:'location_id'})) {
    const schema = JSON.parse(readFileSync('base44/entities/' + entity + '.jsonc', 'utf8'));
    const row = { [field]: 'shop-a', user_id: manager.id, cashier_id: manager.id };
    assert.equal(permits(schema.rls.read, manager, row), true, entity + ' own');
    assert.equal(permits(schema.rls.read, manager, { ...row, [field]: 'shop-b' }), false, entity + ' foreign');
    assert.equal(permits(schema.rls.read, { ...manager, active: false }, row), false, entity + ' inactive');
  }
});
