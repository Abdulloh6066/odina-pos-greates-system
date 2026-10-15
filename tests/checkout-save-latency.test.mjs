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

const branch = '6a96f0a4ecc85c2fc57f3174';
function ingredientCheckoutFixture() {
  const f = checkoutFixture(2);
  f.db.User[0].shop_id = branch;
  f.db.Shop[0].id = branch;
  f.db.Shift[0].shop_id = branch;
  for (const row of f.db.ProductStock) row.location_id = branch;
  f.db.Product[0].source_type = 'shop_prepared';
  f.db.RecipeItem[0].unit = 'g';
  f.db.IngredientStock = [{ id: 'sugar-stock', ingredient_id: 'sugar', location_id: branch,
    ingredient_name: 'Mock sugar', quantity: 1000, unit: 'g' }];
  return f;
}
function assertUncommitted(f) {
  assert.equal(f.db.Shift[0].expected_cash, 0);
  assert.equal(f.db.Shift[0].order_count, 0);
  assert.equal(f.db.Shift[0].sale_request_keys.includes('sale-completed:' + f.request.idempotency_key), false);
}
function assertCompensated(f) {
  for (const name of ['Sale', 'SaleItem', 'Payment', 'StockMovement']) assert.equal(f.db[name].length, 0, name);
  assert.ok(f.db.ProductStock.every(row => row.quantity === 10));
  assert.equal(f.db.IngredientStock[0].quantity, 1000);
  assertUncommitted(f);
  assert.deepEqual(f.db.Shift[0].sale_request_keys, []);
}
function observeSaleCreation(f) {
  const created = deferred(), create = f.entities.Sale.create;
  f.entities.Sale.create = async row => { const sale = await create(row); created.resolve(); return sale; };
  return created.promise;
}

test('financial and ingredient saves overlap, but neither response nor retry confirms until both finish', { timeout: 5000 }, async () => {
  const f = ingredientCheckoutFixture(), financialGate = deferred(), ingredientGate = deferred();
  const started = new Set();
  const items = f.entities.SaleItem.bulkCreate, stock = f.entities.IngredientStock.updateMany;
  f.entities.SaleItem.bulkCreate = async rows => { started.add('financial'); await financialGate.promise; return items(rows); };
  f.entities.IngredientStock.updateMany = async (...args) => {
    if (args[1].$set) { started.add('ingredient'); await ingredientGate.promise; }
    return stock(...args);
  };
  const saleCreated = observeSaleCreation(f);
  let finished = false;
  const pending = f.invoke(file, f.request).then(result => { finished = true; return result; });
  try {
    await Promise.race([saleCreated, pending]); await tick();
    assert.deepEqual([...started].sort(), ['financial', 'ingredient']);
    assertUncommitted(f);
    assert.equal((await f.invoke(file, f.request)).status, 503);
    financialGate.resolve(); await tick();
    assert.equal(finished, false, 'the ingredient ledger is still required');
    assertUncommitted(f);
  } finally { financialGate.resolve(); ingredientGate.resolve(); await pending; }
  const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.IngredientStock[0].quantity, 950);
  assert.deepEqual(f.db.ProductStock.map(row => row.quantity), [10, 9]);
  assert.equal(f.db.StockMovement.filter(row => row.item_kind === 'ingredient').length, 1);
  assert.equal(f.db.Shift[0].expected_cash, 2000);
  assert.equal(f.db.Shift[0].order_count, 1);
  assert.equal((await f.invoke(file, f.request)).data.already_processed, true);
  assert.equal(f.db.IngredientStock[0].quantity, 950);
});

test('financial failure drains a late successful ingredient movement before compensating and retrying', { timeout: 5000 }, async () => {
  const f = ingredientCheckoutFixture(), gate = deferred();
  const payment = f.entities.Payment.bulkCreate, movement = f.entities.StockMovement.create;
  let ingredientReached = false;
  f.entities.Payment.bulkCreate = async () => { throw new Error('Mock payment failure'); };
  f.entities.StockMovement.create = async row => {
    if (row.item_kind === 'ingredient') { ingredientReached = true; await gate.promise; }
    return movement(row);
  };
  const saleCreated = observeSaleCreation(f);
  let finished = false;
  const pending = f.invoke(file, f.request).then(result => { finished = true; return result; });
  try {
    await Promise.race([saleCreated, pending]); await tick();
    assert.equal(ingredientReached, true);
    assert.equal(finished, false, 'rollback must wait for the late ingredient movement');
    assert.equal(f.db.IngredientStock[0].quantity, 950);
    assert.equal(f.db.Sale.length, 1);
    assertUncommitted(f);
  } finally { gate.resolve(); await pending; }
  assert.equal((await pending).status, 500);
  assertCompensated(f);
  f.entities.Payment.bulkCreate = payment;
  f.entities.StockMovement.create = movement;
  assert.equal((await f.invoke(file, f.request)).status, 200);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.IngredientStock[0].quantity, 950);
  assert.equal(f.db.Shift[0].expected_cash, 2000); assert.equal(f.db.Shift[0].order_count, 1);
});

test('partial ingredient failure drains a late payment before restoring every journaled mutation', { timeout: 5000 }, async () => {
  const f = ingredientCheckoutFixture(), gate = deferred();
  const payment = f.entities.Payment.bulkCreate, movement = f.entities.StockMovement.create;
  let paymentReached = false, ingredientFailed = false;
  f.entities.Payment.bulkCreate = async rows => { paymentReached = true; await gate.promise; return payment(rows); };
  f.entities.StockMovement.create = async row => {
    if (row.item_kind === 'ingredient') { ingredientFailed = true; throw new Error('Mock ingredient movement failure'); }
    return movement(row);
  };
  const saleCreated = observeSaleCreation(f);
  let finished = false;
  const pending = f.invoke(file, f.request).then(result => { finished = true; return result; });
  try {
    await Promise.race([saleCreated, pending]); await tick();
    assert.equal(paymentReached, true); assert.equal(ingredientFailed, true);
    assert.equal(finished, false, 'the late payment must become visible to compensation');
    assert.equal(f.db.IngredientStock[0].quantity, 950);
    assert.equal(f.db.SaleItem.length, 2);
    assertUncommitted(f);
  } finally { gate.resolve(); await pending; }
  assert.equal((await pending).status, 500);
  assertCompensated(f);
  f.entities.Payment.bulkCreate = payment;
  f.entities.StockMovement.create = movement;
  assert.equal((await f.invoke(file, f.request)).status, 200);
  assert.equal(f.db.StockMovement.length, 2);
  assert.equal(f.db.IngredientStock[0].quantity, 950);
  assert.equal(f.db.Shift[0].order_count, 1);
});

function tableCheckoutFixture() {
  const f = checkoutFixture(1);
  Object.assign(f.db.Shop[0], { restaurant_table_count: 2, restaurant_table_orders_version: 1,
    restaurant_table_orders: [{ id: 'table-order', number: 1, state: 'occupied', revision: 1,
      ticket_number: 8, items: [{ product_id: 'cake-0', product_name: 'Mock cake 0', price: 1000,
        quantity: 1, source_type: 'central_produced', stock_tracked: true }] }] });
  Object.assign(f.request, { table_shop_id: 'shop', table_number: 1,
    table_order_id: 'table-order', table_order_revision: 1 });
  return f;
}
const clearsTable = ops => Array.isArray(ops.$set?.restaurant_table_orders)
  && ops.$set.restaurant_table_orders.length === 0;

test('postcommit table release and audit overlap, and the response still awaits both', { timeout: 5000 }, async () => {
  const f = tableCheckoutFixture(), tableGate = deferred(), auditGate = deferred();
  const table = f.entities.Shop.updateMany, audit = f.entities.ActionHistory.create;
  const started = new Set();
  f.entities.Shop.updateMany = async (query, ops) => {
    if (clearsTable(ops)) { started.add('table'); await tableGate.promise; }
    return table(query, ops);
  };
  f.entities.ActionHistory.create = async row => {
    if (row.action === 'sale_completed') { started.add('audit'); await auditGate.promise; }
    return audit(row);
  };
  const saleCreated = observeSaleCreation(f);
  let finished = false;
  const pending = f.invoke(file, f.request).then(result => { finished = true; return result; });
  try {
    await Promise.race([saleCreated, pending]); await tick();
    assert.deepEqual([...started].sort(), ['audit', 'table']);
    assert.equal(f.db.Shift[0].expected_cash, 1000);
    assert.equal(f.db.Shift[0].sale_request_keys.includes('sale-completed:' + f.request.idempotency_key), true);
    assert.equal(f.db.Shop[0].restaurant_table_orders[0].state, 'paying');
    auditGate.resolve(); await tick(); assert.equal(finished, false);
  } finally { tableGate.resolve(); auditGate.resolve(); await pending; }
  const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.data.table_released, true);
  assert.equal(f.db.Shop[0].restaurant_table_orders.length, 0);
  assert.equal(f.db.ActionHistory.filter(row => row.action === 'sale_completed').length, 1);
});

test('postcommit table or audit outages never compensate completed money', async () => {
  for (const failure of ['table', 'audit', 'both']) {
    const f = tableCheckoutFixture(), table = f.entities.Shop.updateMany, audit = f.entities.ActionHistory.create;
    f.entities.Shop.updateMany = async (query, ops) => {
      if (clearsTable(ops) && failure !== 'audit') throw new Error('Mock table outage');
      return table(query, ops);
    };
    f.entities.ActionHistory.create = async row => {
      if (row.action === 'sale_completed' && failure !== 'table') throw new Error('Mock audit outage');
      return audit(row);
    };
    const result = await f.invoke(file, f.request);
    assert.equal(result.status, 200, failure);
    assert.equal(result.data.table_released, failure === 'audit');
    assert.equal(f.db.Sale.length, 1); assert.equal(f.db.SaleItem.length, 1); assert.equal(f.db.Payment.length, 1);
    assert.equal(f.db.Shift[0].expected_cash, 1000); assert.equal(f.db.Shift[0].order_count, 1);
    assert.equal(f.db.ProductStock[0].quantity, 9);
    assert.equal(f.calls.some(([, method]) => method === 'delete'), false);
  }
});

// Real entry/helper operations pass through a deterministic mock DB scheduler.
// Calls queued in the same event-loop turn share one roundtrip; dependent calls
// wait for another pump. For p finished products and m distinct ingredients,
// current upstream already batches ingredients, so save waves change from
// F+2*ceil(m/4) to max(F,2*ceil(m/4)), F=max(1,ceil(p/4)). The original
// checkout checkpoint used F+2*m; report that separately, not as today's delta.
// Every stock and movement write remains required; only their waits overlap.
function mockSaveRoundtrips() {
  const pending = [];
  let scheduled = false, saveWaves = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(async () => {
      const batch = pending.splice(0);
      saveWaves++;
      const results = await Promise.allSettled(batch.map(async task => task.run()));
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') batch[index].resolve(result.value);
        else batch[index].reject(result.reason);
      }
      scheduled = false;
      if (pending.length) schedule();
    });
  };
  return {
    enqueue: run => new Promise((resolve, reject) => { pending.push({ run, resolve, reject }); schedule(); }),
    waves: () => saveWaves,
  };
}
test('mock DB-wave benchmark asserts financial and ingredient wait collapse', async t => {
  for (const count of [1, 4, 8]) {
    const f = ingredientCheckoutFixture();
    f.db.RecipeItem = [
      ...Array.from({ length: count }, (_, i) => ({ id: 'ingredient-' + i,
        recipe_id: 'cake-0-recipe', ingredient_id: 'sugar-' + i, quantity: 100, unit: 'g' })),
      f.db.RecipeItem.find(row => row.recipe_id === 'cake-1-recipe'),
    ];
    f.db.IngredientStock = Array.from({ length: count }, (_, i) => ({ id: 'sugar-' + i + '-stock',
      ingredient_id: 'sugar-' + i, location_id: branch, quantity: 1000, unit: 'g' }));
    f.db.SupplierReceiptItem.push(...Array.from({ length: count }, (_, i) => ({ id: 'price-' + i,
      receipt_id: 'receipt', ingredient_id: 'sugar-' + i, base_quantity: 1000, line_total: 10000 })));
    const roundtrips = mockSaveRoundtrips();
    let ingredientStockWrites = 0, ingredientMovementWrites = 0;
    for (const [name, method] of [['SaleItem', 'bulkCreate'], ['Payment', 'bulkCreate'],
      ['StockMovement', 'create'], ['IngredientStock', 'updateMany']]) {
      const original = f.entities[name][method];
      f.entities[name][method] = (...args) => roundtrips.enqueue(() => {
        if (name === 'IngredientStock') ingredientStockWrites++;
        if (name === 'StockMovement' && args[0].item_kind === 'ingredient') ingredientMovementWrites++;
        return original(...args);
      });
    }
    const result = await f.invoke(file, f.request);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.ok(f.db.IngredientStock.every(row => row.quantity === 950));
    assert.equal(f.db.StockMovement.filter(row => row.item_kind === 'ingredient').length, count);
    assert.equal(ingredientStockWrites, count); assert.equal(ingredientMovementWrites, count);
    assert.equal(f.db.Payment[0].amount, 2000); assert.equal(f.db.Shift[0].order_count, 1);
    const expectedWaves = Math.max(1, 2 * Math.ceil(count / 4));
    assert.equal(roundtrips.waves(), expectedWaves, count + ' ingredients must retain bounded batching and financial overlap');
    t.diagnostic(JSON.stringify({ mocked_ingredients: count,
      original_checkpoint_save_waves: 1 + 2 * count,
      current_upstream_save_waves: 1 + 2 * Math.ceil(count / 4),
      observed_save_waves: roundtrips.waves(),
      ingredient_stock_writes: ingredientStockWrites, ingredient_movement_writes: ingredientMovementWrites,
    }));
  }
});

test('idempotency lookup and the requested shift read overlap before any write', { timeout: 5000 }, async () => {
  const f = checkoutFixture(1), saleGate = deferred(), shiftGate = deferred(), saleStarted = deferred();
  const sales = f.entities.Sale.filter, shift = f.entities.Shift.get;
  let shiftStarted = false;
  f.entities.Sale.filter = async (...args) => { saleStarted.resolve(); await saleGate.promise; return sales(...args); };
  f.entities.Shift.get = async (...args) => { shiftStarted = true; await shiftGate.promise; return shift(...args); };
  const pending = f.invoke(file, f.request);
  try {
    await Promise.race([saleStarted.promise, pending]); await tick();
    assert.equal(shiftStarted, true, 'the independent Shift read must not wait for Sale.filter');
    assert.equal(f.calls.length, 0);
    saleGate.resolve(); await tick(); assert.equal(f.calls.length, 0);
  } finally { saleGate.resolve(); shiftGate.resolve(); await pending; }
  assert.equal((await pending).status, 200);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Shift[0].expected_cash, 1000);
});

test('settled preflight reads preserve sale-key and required-input error precedence', async () => {
  for (const mode of ['shift failure', 'sale failure', 'mismatched key', 'duplicate key', 'missing items', 'missing shift', 'invalid key']) {
    const f = checkoutFixture(1);
    let shiftReads = 0;
    f.entities.Shift.get = async () => { shiftReads++; throw Object.assign(new Error('Mock shift unavailable'), { status: 418 }); };
    if (mode === 'sale failure') f.entities.Sale.filter = async () => { throw Object.assign(new Error('Mock sale lookup denied'), { status: 403 }); };
    if (mode === 'mismatched key' || mode === 'duplicate key') {
      f.db.Sale.push({ id: 'prior', idempotency_key: f.request.idempotency_key, user_id: 'other', shift_id: 'shift' });
      if (mode === 'duplicate key') f.db.Sale.push({ ...f.db.Sale[0], id: 'duplicate' });
    }
    if (mode === 'missing items') f.request.items = [];
    if (mode === 'missing shift') f.request.shift_id = '';
    if (mode === 'invalid key') f.request.idempotency_key = 'short';
    const result = await f.invoke(file, f.request);
    const expected = mode === 'shift failure' ? 418 : mode === 'sale failure' ? 403
      : ['mismatched key', 'duplicate key'].includes(mode) ? 409 : 400;
    assert.equal(result.status, expected, mode + ': ' + JSON.stringify(result));
    assert.equal(f.calls.length, 0, mode);
    if (['missing shift', 'invalid key'].includes(mode)) assert.equal(shiftReads, 0, mode);
  }
});

test('completed receipts still replay after shift closing, with the original unavailable-shift semantics', async () => {
  for (const version of [2, 3]) for (const unavailable of [false, true]) {
    const f = checkoutFixture(1);
    f.db.Shift[0].status = 'closed';
    f.db.Shift[0].sale_request_keys = ['sale-completed:' + f.request.idempotency_key];
    f.db.Sale.push({ id: 'saved', user_id: 'cashier', shift_id: 'shift', status: 'completed',
      idempotency_key: f.request.idempotency_key, financial_records_version: version, total: 1000 });
    const original = structuredClone(f.db.Sale[0]);
    if (unavailable) f.entities.Shift.get = async () => { throw Object.assign(new Error('Mock shift unavailable'), { status: 418 }); };
    const result = await f.invoke(file, f.request);
    assert.equal(result.status, unavailable && version === 3 ? 503 : 200);
    if (result.status === 200) {
      assert.equal(result.data.already_processed, true);
      assert.equal(result.data.shift?.status ?? null, unavailable ? null : 'closed');
    }
    assert.deepEqual(f.db.Sale[0], original);
    assert.equal(f.calls.length, 0);
  }
});

test('optional coupon lookup overlaps shop, product and policy reads without early writes', { timeout: 5000 }, async () => {
  const f = checkoutFixture(1), gate = deferred(), shopStarted = deferred();
  f.db.DiscountCode = [{ id: 'coupon', code: 'TEN', active: true, percentage: 10, single_use: false, usage_count: 0 }];
  f.request.discount_code = 'TEN'; f.request.payments[0].amount = 900;
  const started = new Set();
  for (const [name, method] of [['Shop', 'get'], ['Product', 'get'], ['Settings', 'list'], ['DiscountCode', 'filter']]) {
    const original = f.entities[name][method];
    f.entities[name][method] = async (...args) => {
      started.add(name); if (name === 'Shop') shopStarted.resolve();
      await gate.promise; return original(...args);
    };
  }
  const pending = f.invoke(file, f.request);
  try {
    await Promise.race([shopStarted.promise, pending]); await tick();
    assert.deepEqual([...started].sort(), ['DiscountCode', 'Product', 'Settings', 'Shop']);
    assert.equal(f.calls.length, 0);
  } finally { gate.resolve(); await pending; }
  assert.equal((await pending).status, 200);
  assert.equal(f.db.Shift[0].expected_cash, 900);
  assert.equal(f.db.DiscountCode[0].usage_count, 1);
  assert.equal(f.db.DiscountCode[0].used_by_sale_id, f.db.Sale[0].id);
});

test('coupon lookup errors remain deferred behind stock shortage validation', async () => {
  for (const shortage of [false, true]) {
    const f = checkoutFixture(1);
    f.request.discount_code = 'TEN';
    if (shortage) f.db.ProductStock[0].quantity = 0;
    f.entities.DiscountCode.filter = async () => { throw Object.assign(new Error('Mock coupon unavailable'), { status: 418 }); };
    const result = await f.invoke(file, f.request);
    assert.equal(result.status, shortage ? 409 : 418);
    if (shortage) assert.equal(result.data.allow_negative_stock, false);
    assert.equal(f.calls.length, 0);
  }
});

test('role, active-user, shift-owner and shop guards still deny before coupon reads or writes', async () => {
  for (const mode of ['role', 'inactive', 'shift owner', 'cashier shop', 'manager shop']) {
    const f = checkoutFixture(1); let couponReads = 0;
    f.request.discount_code = 'TEN';
    f.entities.DiscountCode.filter = async () => { couponReads++; return []; };
    if (mode === 'role') f.db.User[0].role = 'production';
    if (mode === 'inactive') f.db.User[0].active = false;
    if (mode === 'shift owner') f.db.Shift[0].user_id = 'another-cashier';
    if (mode === 'cashier shop') f.db.User[0].shop_id = 'other-shop';
    if (mode === 'manager shop') { f.db.User[0].role = 'manager'; f.db.Shift[0].shop_id = 'other-shop'; }
    assert.equal((await f.invoke(file, f.request)).status, 403, mode);
    assert.equal(couponReads, 0, mode); assert.equal(f.calls.length, 0, mode);
  }
});
