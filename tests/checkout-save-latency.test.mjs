// Offline SDK fixtures only. No production transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutFixture } from './checkout-read-latency.test.mjs';
const file = 'base44/functions/complete-sale/entry.ts';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

test('financial records save together but checkout confirms only after every save', { timeout: 5000 }, async () => {
  const f = checkoutFixture(2); const gate = deferred(); const reached = deferred();
  let started = 0;
  for (const [name, method] of [['SaleItem', 'bulkCreate'], ['Payment', 'bulkCreate'], ['StockMovement', 'create']]) {
    const original = f.entities[name][method];
    f.entities[name][method] = async (...args) => {
      if (++started === 4) reached.resolve();
      await gate.promise; return original(...args);
    };
  }
  const pending = f.invoke(file, f.request);
  try {
    await reached.promise;
    assert.equal(f.db.Shift[0].expected_cash, 0);
    assert.equal(f.db.Shift[0].sale_request_keys.includes('sale-completed:' + f.request.idempotency_key), false);
    assert.equal((await f.invoke(file, f.request)).status, 503);
  } finally { gate.resolve(); }
  const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.Shift[0].expected_cash, 2000);
  assert.equal(f.db.SaleItem.length, 2); assert.equal(f.db.Payment.length, 1); assert.equal(f.db.StockMovement.length, 2);
  assert.equal((await f.invoke(file, f.request)).data.already_processed, true);
  assert.equal(f.db.Sale.length, 1);
});

test('failed stock batch waits for late successful writes before restoring stock', { timeout: 5000 }, async () => {
  const f = checkoutFixture(2); const gate = deferred(); const reached = deferred();
  const original = f.entities.ProductStock.updateMany;
  f.entities.ProductStock.updateMany = async (query, ops) => {
    if (ops.$set) {
      if (query.id === 'cake-0-stock') throw new Error('Mock stock failure');
      reached.resolve(); await gate.promise;
    }
    return original(query, ops);
  };
  let finished = false;
  const pending = f.invoke(file, f.request).then(r => { finished = true; return r; });
  try {
    await reached.promise; await tick();
    assert.equal(finished, false); assert.equal(f.db.Sale.length, 0);
    assert.equal(f.calls.some(([name, action]) => name === 'Shift' && action === 'updateMany' && f.db.Shift[0].sale_request_keys.length === 0), false);
  } finally { gate.resolve(); }
  assert.equal((await pending).status, 500);
  assert.ok(f.db.ProductStock.every(row => row.quantity === 10));
  assert.equal(f.db.Shift[0].expected_cash, 0);
  assert.equal(f.db.Shift[0].sale_request_keys.length, 0);
});

test('failed movement waits for payment and sibling movement before compensating; same key can retry', { timeout: 5000 }, async () => {
  const f = checkoutFixture(2); const gate = deferred(); const reached = deferred(); let started = 0;
  const movement = f.entities.StockMovement.create; const payment = f.entities.Payment.bulkCreate;
  f.entities.StockMovement.create = async row => {
    if (row.item_id === 'cake-0') throw new Error('Mock movement failure');
    if (++started === 2) reached.resolve();
    await gate.promise; return movement(row);
  };
  f.entities.Payment.bulkCreate = async rows => {
    if (++started === 2) reached.resolve();
    await gate.promise; return payment(rows);
  };
  let finished = false;
  const pending = f.invoke(file, f.request).then(r => { finished = true; return r; });
  try { await reached.promise; await tick(); assert.equal(finished, false); assert.equal(f.db.Sale.length, 1); }
  finally { gate.resolve(); }
  assert.equal((await pending).status, 500);
  for (const name of ['Sale', 'SaleItem', 'Payment', 'StockMovement']) assert.equal(f.db[name].length, 0, name);
  assert.ok(f.db.ProductStock.every(row => row.quantity === 10));
  assert.equal(f.db.Shift[0].expected_cash, 0);
  f.entities.StockMovement.create = movement; f.entities.Payment.bulkCreate = payment;
  assert.equal((await f.invoke(file, f.request)).status, 200);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.Shift[0].expected_cash, 2000); assert.equal(f.db.Shift[0].order_count, 1);
});

test('stock writes stay bounded at four and response retains basket order', { timeout: 5000 }, async () => {
  const f = checkoutFixture(5); const gate = deferred(); const reached = deferred();
  const original = f.entities.ProductStock.updateMany; let started = 0; let active = 0; let maximum = 0;
  f.entities.ProductStock.updateMany = async (...args) => {
    active++; maximum = Math.max(maximum, active);
    if (++started === 4) reached.resolve();
    try { await gate.promise; return await original(...args); } finally { active--; }
  };
  const pending = f.invoke(file, f.request);
  try { await reached.promise; assert.equal(started, 4); } finally { gate.resolve(); }
  const result = await pending;
  assert.equal(result.status, 200); assert.equal(maximum, 4);
  assert.deepEqual(result.data.stock_updates.map(row => row.product_id), f.request.items.map(row => row.product_id));
});

test('checkout reuses validated products and recipes; baskets without recipes skip supplier reads', async () => {
  const f = checkoutFixture(2); let products = 0; let recipes = 0;
  const get = f.entities.Product.get; const filter = f.entities.Recipe.filter;
  f.entities.Product.get = async (...args) => { products++; return get(...args); };
  f.entities.Recipe.filter = async (...args) => { recipes++; return filter(...args); };
  assert.equal((await f.invoke(file, f.request)).status, 200);
  assert.equal(products, 2); assert.equal(recipes, 1);
  assert.ok(f.db.SaleItem.every(row => row.unit_cost_at_sale === 500 && !row.cost_is_estimate));
  const noRecipes = checkoutFixture(1); noRecipes.db.Recipe = []; let supplierReads = 0;
  noRecipes.entities.SupplierReceipt.list = async () => { supplierReads++; throw new Error('Unexpected supplier read'); };
  assert.equal((await noRecipes.invoke(file, noRecipes.request)).status, 200);
  assert.equal(supplierReads, 0); assert.equal(noRecipes.db.SaleItem[0].unit_cost_at_sale, 0);
  assert.equal(noRecipes.db.SaleItem[0].cost_is_estimate, true);
});

test('stale shop counter snapshot rereads after failed atomic claim', async () => {
  const f = checkoutFixture(1);
  Object.assign(f.db.Shop[0], { service_ticket_cycle_active: true, service_ticket_counter: 8, service_ticket_version: 4 });
  const stale = { ...f.db.Shop[0], service_ticket_counter: 7, service_ticket_version: 3 };
  let reads = 0; const get = f.entities.Shop.get;
  f.entities.Shop.get = async (...args) => { reads++; return get(...args); };
  const helper = f.load('base44/shared/shift-close-helpers.ts');
  assert.equal(await helper.allocateServiceTicketNumber(f.service, 'shop', stale), 9);
  assert.equal(reads, 1); assert.equal(f.db.Shop[0].service_ticket_counter, 9);
  assert.equal(f.db.Shop[0].service_ticket_version, 5);
});
