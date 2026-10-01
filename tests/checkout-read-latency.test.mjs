// Offline checkout concurrency regressions: in-memory SDK only, no live records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const file = 'base44/functions/complete-sale/entry.ts';
export function checkoutFixture(count = 5) {
  const products = Array.from({ length: count }, (_, i) => ({
    id: 'cake-' + i, name: 'Mock cake ' + i, price: 1000, active: true, track_stock: true,
  }));
  const fixture = memoryBackend({
    User: [{ id: 'cashier', role: 'cashier', shop_id: 'shop', active: true }],
    Shift: [{ id: 'shift', user_id: 'cashier', shop_id: 'shop', shop_name: 'Mock shop',
      status: 'open', opened_at: '2026-09-27T06:00:00.000Z',
      expected_cash: 0, total_sales: 0, order_count: 0, sale_request_keys: [] }],
    Shop: [{ id: 'shop', name: 'Mock shop', active: true, allows_pos: true, location_type: 'shop' }],
    Product: products,
    ProductStock: products.map(p => ({ id: p.id + '-stock', product_id: p.id, location_id: 'shop', quantity: 10 })),
    Settings: [{ id: 'settings', allow_negative_stock: false }],
    SupplierReceipt: [{ id: 'receipt', status: 'confirmed' }, { id: 'cancelled', status: 'cancelled' }],
    SupplierReceiptItem: [
      { id: 'ingredient-price', receipt_id: 'receipt', ingredient_id: 'sugar', base_quantity: 1000, line_total: 10000 },
      { id: 'excluded-price', receipt_id: 'cancelled', ingredient_id: 'sugar', base_quantity: 1, line_total: 999999 },
    ],
    Recipe: products.map(p => ({ id: p.id + '-recipe', product_id: p.id, active: true, output_quantity: 2, output_unit: 'piece' })),
    RecipeItem: products.map(p => ({ id: p.id + '-ingredient', recipe_id: p.id + '-recipe', ingredient_id: 'sugar', quantity: 100 })),
    Sale: [], SaleItem: [], Payment: [], StockMovement: [], ActionHistory: [],
  });
  fixture.request = { action: 'complete_sale', shift_id: 'shift',
    idempotency_key: 'checkout-concurrency-001', recorded_at: '2026-09-27T07:00:00.000Z',
    items: products.map(p => ({ product_id: p.id, quantity: 1 })),
    payments: [{ method: 'cash', amount: count * 1000 }] };
  return fixture;
}
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('independent recipe reads overlap with a four-product limit and preserve snapshots and retry safety', { timeout: 5000 }, async () => {
  const f = checkoutFixture();
  const gate = deferred(); const firstBatch = deferred();
  let active = 0; let maximum = 0; let started = 0;
  const original = f.entities.Recipe.filter;
  f.entities.Recipe.filter = async (...args) => {
    active++; started++; maximum = Math.max(maximum, active);
    if (started === 4) firstBatch.resolve();
    try { await gate.promise; return await original(...args); }
    finally { active--; }
  };
  const pending = f.invoke(file, f.request);
  try {
    await firstBatch.promise;
    assert.equal(started, 4);
    assert.equal(f.calls.length, 0, 'financial writes wait until snapshot reads settle');
  } finally { gate.resolve(); }
  const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(maximum, 4);
  assert.equal(started, 5);
  assert.equal(f.db.SaleItem.length, 5);
  for (const item of f.db.SaleItem) {
    assert.equal(item.unit_cost_at_sale, 500);
    assert.equal(item.total_cost_at_sale, 500);
    assert.equal(item.cost_is_estimate, false);
  }
  assert.equal(f.db.Shift[0].expected_cash, 5000);
  assert.equal(f.db.Shift[0].order_count, 1);
  assert.ok(f.db.ProductStock.every(row => row.quantity === 9));
  const retry = await f.invoke(file, f.request);
  assert.equal(retry.data.already_processed, true);
  assert.equal(f.db.Sale.length, 1);
  assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.StockMovement.length, 5);
  assert.equal(f.db.Shift[0].expected_cash, 5000);
});

test('one failed cost lookup does not race pending reads or discard other product snapshots', { timeout: 5000 }, async () => {
  const f = checkoutFixture(2);
  const gate = deferred(); const started = deferred();
  const original = f.entities.Recipe.filter;
  f.entities.Recipe.filter = async query => {
    if (query.product_id === 'cake-0') throw new Error('Mock cost lookup failure');
    started.resolve();
    await gate.promise;
    return original(query);
  };
  const pending = f.invoke(file, f.request);
  try {
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0);
  } finally { gate.resolve(); }
  const result = await pending;
  assert.equal(result.status, 200);
  const missing = f.db.SaleItem.find(item => item.product_id === 'cake-0');
  const known = f.db.SaleItem.find(item => item.product_id === 'cake-1');
  assert.equal(missing.unit_cost_at_sale, 0);
  assert.equal(missing.cost_is_estimate, true);
  assert.equal(known.unit_cost_at_sale, 500);
  assert.equal(known.cost_is_estimate, false);
  assert.equal(f.db.Shift[0].expected_cash, 2000);
});

test('a stock shortage still blocks checkout before any writes', async () => {
  const f = checkoutFixture(1);
  f.db.ProductStock[0].quantity = 0;
  const result = await f.invoke(file, f.request);
  assert.equal(result.status, 409);
  assert.equal(result.data.allow_negative_stock, false);
  assert.equal(f.calls.length, 0);
});

test('unavailable ingredient prices retain the existing estimate fallback', async () => {
  const f = checkoutFixture(1);
  f.entities.SupplierReceiptItem.list = async () => { throw new Error('Mock receipt lookup failure'); };
  const result = await f.invoke(file, f.request);
  assert.equal(result.status, 200);
  assert.equal(f.db.SaleItem[0].unit_cost_at_sale, 0);
  assert.equal(f.db.SaleItem[0].cost_is_estimate, true);
  assert.equal(f.db.Shift[0].expected_cash, 1000);
});
