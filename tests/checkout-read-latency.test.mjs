// Offline checkout concurrency regressions: in-memory SDK only, no live records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { createCheckoutReadTracker } from '../base44/shared/checkout-reads.ts';

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

test('one scoped recipe read settles before financial writes and preserves snapshots and retry safety', { timeout: 5000 }, async () => {
  const f = checkoutFixture();
  const gate = deferred(); const firstBatch = deferred();
  let active = 0; let maximum = 0; let started = 0;
  const original = f.entities.Recipe.filter;
  f.entities.Recipe.filter = async (...args) => {
    active++; started++; maximum = Math.max(maximum, active);
    if (started === 1) firstBatch.resolve();
    try { await gate.promise; return await original(...args); }
    finally { active--; }
  };
  const pending = f.invoke(file, f.request);
  try {
    await firstBatch.promise;
    assert.equal(started, 1);
    assert.equal(f.calls.length, 0, 'financial writes wait until snapshot reads settle');
  } finally { gate.resolve(); }
  const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(maximum, 1);
  assert.equal(started, 1);
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
    if (query.product_id?.$in) throw new Error('Mock bulk cost lookup failure');
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
  f.entities.SupplierReceiptItem.filter = async () => { throw new Error('Mock receipt lookup failure'); };
  const result = await f.invoke(file, f.request);
  assert.equal(result.status, 200);
  assert.equal(f.db.SaleItem[0].unit_cost_at_sale, 0);
  assert.equal(f.db.SaleItem[0].cost_is_estimate, true);
  assert.equal(f.db.Shift[0].expected_cash, 1000);
});

test('Shop metadata reuse stays request-local while Ingredient reads remain fresh after settling', async () => {
  const records = { Shop: { id: 'shop', active: true }, Ingredient: { id: 'milk', base_unit: 'ml' } };
  const reads = { Shop: 0, Ingredient: 0 };
  const service = { entities: Object.fromEntries(Object.keys(records).map(entity => [entity, {
    get: async () => { reads[entity]++; return structuredClone(records[entity]); },
  }])) };
  const first = createCheckoutReadTracker(service);
  await Promise.all([first.service.entities.Shop.get('shop'), first.service.entities.Shop.get('shop')]);
  await first.service.entities.Shop.get('shop');
  await Promise.all([first.service.entities.Ingredient.get('milk'), first.service.entities.Ingredient.get('milk')]);
  assert.deepEqual(reads, { Shop: 1, Ingredient: 1 });
  records.Shop.active = false; records.Ingredient.base_unit = 'piece';
  assert.equal((await first.service.entities.Ingredient.get('milk')).base_unit, 'piece');
  const second = createCheckoutReadTracker(service);
  assert.equal((await second.service.entities.Shop.get('shop')).active, false);
  assert.equal((await second.service.entities.Ingredient.get('milk')).base_unit, 'piece');
  assert.deepEqual(reads, { Shop: 2, Ingredient: 3 });
});

test('identical pending stock reads coalesce by full query while settled reads stay fresh and shop scoped', async () => {
  const gate = deferred(); let reads = 0; let quantity = 10;
  const tracker = createCheckoutReadTracker({ entities: { IngredientStock: {
    filter: async query => { reads++; await gate.promise; return [{ location_id: query.location_id, quantity }]; },
  } } });
  const stock = tracker.service.entities.IngredientStock;
  const first = stock.filter({ location_id: 'shop-a', ingredient_id: 'milk' }, 'id', 500, 0);
  const same = stock.filter({ ingredient_id: 'milk', location_id: 'shop-a' }, 'id', 500, 0);
  const other = stock.filter({ location_id: 'shop-b', ingredient_id: 'milk' }, 'id', 500, 0);
  assert.equal(reads, 2);
  gate.resolve();
  assert.deepEqual(await first, await same);
  assert.equal((await other)[0].location_id, 'shop-b');
  quantity = 3;
  assert.equal((await stock.filter({ location_id: 'shop-a', ingredient_id: 'milk' }, 'id', 500, 0))[0].quantity, 3);
  assert.equal(reads, 3, 'stock is never retained after its pending read settles');
  assert.equal(tracker.snapshot().cached_reads, 1);
});

test('read argument types and list pagination never share a pending result', async () => {
  const gate = deferred(); let reads = 0;
  const tracker = createCheckoutReadTracker({ entities: { StockMovement: {
    list: async (...args) => { reads++; await gate.promise; return args; },
  } } });
  const list = tracker.service.entities.StockMovement.list;
  const pending = [list('id', 500, 0), list('id', 500, 500), list(undefined, 500, 0), list(null, 500, 0)];
  assert.equal(reads, 4);
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), [
    ['id', 500, 0], ['id', 500, 500], [undefined, 500, 0], [null, 500, 0],
  ]);
});

test('reads bypass reuse until every concurrent write settles, including an uncertain write', async () => {
  const firstWrite = deferred(), secondWrite = deferred(); let value = 0, reads = 0, writes = 0;
  const tracker = createCheckoutReadTracker({ entities: { Shop: {
    get: async () => { reads++; return { value }; },
    update: async (_id, next) => {
      writes++;
      await (next === 1 ? firstWrite : secondWrite).promise;
      value = next;
      if (next === 1) throw new Error('Response lost after committed update');
      return { value };
    },
  } } });
  const shop = tracker.service.entities.Shop;
  await shop.get('shop'); await shop.get('shop'); assert.equal(reads, 1);
  const one = shop.update('shop', 1);
  const two = shop.update('shop', 2);
  const settledWrites = Promise.allSettled([one, two]);
  const rejected = assert.rejects(one, /Response lost/);
  await Promise.all([shop.get('shop'), shop.get('shop')]); assert.equal(reads, 3);
  firstWrite.resolve(); await rejected;
  await Promise.all([shop.get('shop'), shop.get('shop')]); assert.equal(reads, 5);
  secondWrite.resolve();
  assert.deepEqual((await settledWrites).map(row => row.status), ['rejected', 'fulfilled']);
  assert.equal((await shop.get('shop')).value, 2);
  await shop.get('shop'); assert.equal(reads, 6); assert.equal(writes, 2);
});

test('a failed pending read is evicted and a synchronous mutation failure also invalidates metadata', async () => {
  const gate = deferred(); let attempts = 0, reads = 0;
  const tracker = createCheckoutReadTracker({ entities: {
    Recipe: { filter: async () => {
      attempts++; await gate.promise;
      if (attempts === 1) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return [{ id: 'fresh' }];
    } },
    Shop: {
      get: async () => { reads++; return { id: 'shop' }; },
      update: () => { throw new Error('Synchronous failure'); },
    },
  } });
  const recipe = tracker.service.entities.Recipe;
  const one = recipe.filter({ active: true }), two = recipe.filter({ active: true });
  const settled = Promise.allSettled([one, two]);
  gate.resolve();
  assert.ok((await settled).every(row => row.status === 'rejected'));
  assert.equal(attempts, 1, 'denied reads are not retried');
  assert.equal((await recipe.filter({ active: true }))[0].id, 'fresh');
  const shop = tracker.service.entities.Shop;
  await shop.get('shop'); await shop.get('shop'); assert.equal(reads, 1);
  assert.throws(() => tracker.service.entities.Shop.update('shop', {}), /Synchronous failure/);
  await shop.get('shop'); assert.equal(reads, 2);
});

test('a read started before a mutation cannot repopulate the cache after a newer read', async () => {
  const oldRead = deferred(); let value = 0, reads = 0;
  const tracker = createCheckoutReadTracker({ entities: { Shop: {
    get: async () => {
      const snapshot = { value }; reads++;
      if (reads === 1) await oldRead.promise;
      return snapshot;
    },
    update: async (_id, next) => { value = next; return { value }; },
  } } });
  const shop = tracker.service.entities.Shop;
  const before = shop.get('shop');
  await shop.update('shop', 1);
  assert.equal((await shop.get('shop')).value, 1);
  oldRead.resolve();
  assert.equal((await before).value, 0, 'the existing caller may finish its own old read');
  assert.equal((await shop.get('shop')).value, 1, 'old completion never replaces the post-write result');
  assert.equal(reads, 2);
});
