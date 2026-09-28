import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { sortByShopOrder, productOrderBaseline, moveVisibleProduct } from '../src/lib/pos-product-order.js';
const path = 'base44/functions/pos-product-order/entry.ts';
const seed = (role = 'manager') => ({
 User: [{ id: 'u', role, shop_id: 'a', active: true, full_name: 'Test user' }],
 Shop: [{ id: 'a', name: 'A', active: true, restaurant_table_orders: [{ id: 'unpaid' }] }, { id: 'b', name: 'B', active: true, pos_product_order: ['p2'], pos_product_order_version: 8 }],
 Product: [{ id: 'p1', active: true, name: 'Tvarojniy', price: 12000 }, { id: 'p2', active: true, name: 'Spartak', price: 15000 }, { id: 'foreign', active: true, available_shop_ids: ['b'] }],
});
const save = { action: 'save', shop_id: 'a', order: ['p2', 'p1'], version: 0 };

test('manager saves own shop only; audit written; prices and unpaid orders preserved', async () => {
 const f = memoryBackend(seed());
 const result = await f.invoke(path, save);
 assert.equal(result.status, 200, JSON.stringify(result));
 assert.deepEqual(f.db.Shop[0].pos_product_order, ['p2', 'p1']);
 assert.equal(f.db.Shop[0].pos_product_order_version, 1);
 assert.deepEqual(f.db.Shop[0].restaurant_table_orders, [{ id: 'unpaid' }]);
 assert.deepEqual(f.db.Shop[1].pos_product_order, ['p2']);
 assert.equal(f.db.Shop[1].pos_product_order_version, 8);
 assert.equal(f.db.Product[0].price, 12000);
 assert.equal(f.db.ActionHistory[0].user_id, 'u');
 assert.equal(f.db.ActionHistory[0].action, 'pos_product_order_updated');
 assert.ok(!f.calls.some(([entity]) => entity === 'Product'));
});
test('admin may edit the selected shop', async () => {
 const f = memoryBackend(seed('admin'));
 assert.equal((await f.invoke(path, { ...save, shop_id: 'b', version: 8 })).status, 200);
 assert.equal(f.db.Shop[0].pos_product_order, undefined);
 assert.equal(f.db.Shop[1].pos_product_order_version, 9);
});
test('cashier reads own order but cannot write; foreign read and write rejected', async () => {
 for (const role of ['manager', 'cashier']) {
  const f = memoryBackend(seed(role));
  assert.equal((await f.invoke(path, { action: 'get', shop_id: 'a' })).status, 200);
  assert.equal((await f.invoke(path, { action: 'get', shop_id: 'b' })).status, 403);
  assert.equal((await f.invoke(path, { ...save, shop_id: 'b', version: 8 })).status, 403);
  if (role === 'cashier') assert.equal((await f.invoke(path, save)).status, 403);
  assert.equal(f.calls.length, 0);
 }
});
test('inactive, unassigned and other roles cannot write', async () => {
 for (const patch of [{ active: false }, { shop_id: '' }, { role: 'accountant' }, { role: 'production' }]) {
  const s = seed(); Object.assign(s.User[0], patch);
  const f = memoryBackend(s);
  assert.equal((await f.invoke(path, save)).status, 403);
  assert.equal(f.calls.length, 0);
 }
});
test('duplicate, unknown, restricted and malformed IDs are rejected before writes', async () => {
 for (const patch of [{ order: ['p1', 'p1'] }, { order: ['missing'] }, { order: ['foreign'] }, { order: ['p1', 3] }, { version: -1 }, { order: null }]) {
  const f = memoryBackend(seed());
  assert.equal((await f.invoke(path, { ...save, ...patch })).status, 400);
  assert.equal(f.calls.length, 0);
 }
});
test('a stale editor cannot overwrite a newer save', async () => {
 const f = memoryBackend(seed());
 assert.equal((await f.invoke(path, save)).status, 200);
 assert.equal((await f.invoke(path, { ...save, order: ['p1', 'p2'] })).status, 409);
 assert.deepEqual(f.db.Shop[0].pos_product_order, ['p2', 'p1']);
});
test('atomic version guard rejects a racing save after validation', async () => {
 const f = memoryBackend(seed());
 const update = f.entities.Shop.updateMany;
 f.entities.Shop.updateMany = async (query, ops) => {
  f.db.Shop[0].pos_product_order_version = 1;
  f.db.Shop[0].pos_product_order = ['p1'];
  return update(query, ops);
 };
 assert.equal((await f.invoke(path, save)).status, 409);
 assert.deepEqual(f.db.Shop[0].pos_product_order, ['p1']);
 assert.equal(f.db.ActionHistory?.length || 0, 0);
});
test('custom order overrides legacy variant placement and keeps new products at end', () => {
 const products = [{ id: 'original' }, { id: 'new' }, { id: 'variant', display_before_product_id: 'original' }];
 const baseline = productOrderBaseline(products);
 assert.deepEqual(baseline.map(p => p.id), ['variant', 'original', 'new']);
 assert.deepEqual(sortByShopOrder(baseline, ['original', 'variant']).map(p => p.id), ['original', 'variant', 'new']);
 assert.deepEqual(sortByShopOrder(products, []).map(p => p.id), ['original', 'new', 'variant']);
 assert.deepEqual(sortByShopOrder(products.filter(p => p.id !== 'original'), ['original', 'variant']).map(p => p.id), ['variant', 'new']);
});
test('category and search moves retain hidden slots without losing IDs', () => {
 const order = ['a', 'hidden-1', 'b', 'hidden-2', 'c'];
 assert.deepEqual(moveVisibleProduct(order, ['a', 'b', 'c'], 2, 0), ['c', 'hidden-1', 'a', 'hidden-2', 'b']);
 assert.deepEqual(moveVisibleProduct(order, ['a', 'b', 'c'], 0, 2), ['b', 'hidden-1', 'c', 'hidden-2', 'a']);
 assert.deepEqual(order, ['a', 'hidden-1', 'b', 'hidden-2', 'c']);
 assert.equal(moveVisibleProduct(order, ['a'], 0, 5), order);
});
