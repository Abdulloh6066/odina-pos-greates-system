// Isolated regressions: no live SDK, auth, database or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { basketCheckoutFixture } from './helpers/basket-checkout.mjs';
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

for (const store of ['Central', 'Branch']) {
  test(store + ': cappuccino reads only milk/coffee costs and their receipts; balances and replay stay exact', async () => {
    const f = basketCheckoutFixture(store);
    const result = await f.call();
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(f.db.SaleItem[0].unit_cost_at_sale, 280);
    assert.equal(f.db.SaleItem[0].cost_is_estimate, false);
    const items = f.reads.filter(row => row.entityName === 'SupplierReceiptItem');
    const parents = f.reads.filter(row => row.entityName === 'SupplierReceipt');
    assert.ok(f.reads.every(row => row.method === 'filter'));
    assert.equal(items.length, 1); assert.equal(items[0].rows, 2);
    assert.deepEqual([...items[0].args[0].ingredient_id.$in].sort(), ['coffee', 'milk']);
    assert.equal(parents.length, 1); assert.equal(parents[0].rows, 2);
    assert.deepEqual([...parents[0].args[0].id.$in].sort(), ['coffee-receipt', 'milk-receipt']);
    assert.deepEqual(parents[0].args[4], ['id', 'status']);
    assert.ok(items[0].args[4].includes('purchase_unit'));
    const callCount = f.calls.length, readCount = f.reads.length;
    assert.equal((await f.call()).data.already_processed, true);
    assert.equal(f.calls.length, callCount); assert.equal(f.reads.length, readCount);
    assert.equal(f.db.Shift[0].expected_cash, 20000);
    assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
    assert.equal(f.db.IngredientStock.find(row => row.ingredient_id === 'milk').quantity, store === 'Branch' ? 99900 : 100000);
    assert.equal(f.db.ProductStock[0].quantity, store === 'Branch' ? 100 : 99);
  });

  test(store + ': later checkout refreshes costs without changing the earlier sale snapshot', async () => {
    const f = basketCheckoutFixture(store);
    assert.equal((await f.call()).status, 200);
    f.db.SupplierReceiptItem.find(row => row.ingredient_id === 'milk').line_total = 2000;
    assert.equal((await f.call({ ...f.request, idempotency_key: 'mock-basket-checkout-002' })).status, 200);
    assert.deepEqual(f.db.SaleItem.map(row => row.unit_cost_at_sale), [280, 380]);
    assert.equal(f.db.Shift[0].expected_cash, 40000);
  });

  test(store + ': cancelled/cancelling/missing parents cannot inflate ingredient cost', async () => {
    const f = basketCheckoutFixture(store);
    for (const status of ['cancelled', 'cancelling', 'missing']) {
      if (status !== 'missing') f.db.SupplierReceipt.push({ id: status, status });
      f.db.SupplierReceiptItem.push({ id: status + '-milk', receipt_id: status, ingredient_id: 'milk', base_quantity: 1, line_total: 999999 });
    }
    assert.equal((await f.call()).status, 200);
    assert.equal(f.db.SaleItem[0].unit_cost_at_sale, 280);
    assert.equal(f.db.SaleItem[0].cost_is_estimate, false);
  });

  test(store + ': unavailable scoped costs keep explicit estimates and valid payment totals', async () => {
    const f = basketCheckoutFixture(store);
    f.entities.SupplierReceiptItem.filter = async () => { throw new Error('Mock scoped read unavailable'); };
    assert.equal((await f.call()).status, 200);
    assert.equal(f.db.SaleItem[0].cost_is_estimate, true);
    assert.equal(f.db.SaleItem[0].unit_cost_at_sale, 0);
    assert.equal(f.db.Shift[0].expected_cash, 20000);
  });

  test(store + ': baskets without recipes make no supplier queries', async () => {
    const f = basketCheckoutFixture(store, 0);
    assert.equal((await f.call()).status, 200);
    assert.equal(f.reads.length, 0);
  });
}

test('scoped weighted averages include every matching page and resolve over 500 parent receipts', async () => {
  const f = basketCheckoutFixture('Central', 1, 0);
  f.db.SupplierReceiptItem = Array.from({ length: 1003 }, (_, index) => ({
    id: 'line-' + String(index).padStart(4, '0'), ingredient_id: 'milk', receipt_id: 'receipt-' + index,
    purchase_quantity: 1, purchase_unit: 'l', line_total: index % 2 ? 3000 : 1000,
  }));
  f.db.SupplierReceipt = f.db.SupplierReceiptItem.map(row => ({ id: row.receipt_id, status: 'confirmed' }));
  const { loadIngredientCosts } = f.load('base44/shared/cost-engine.ts');
  const result = await loadIngredientCosts(f.service, ['milk', 'milk']);
  assert.equal(result.size, 1);
  const expected = f.db.SupplierReceiptItem.reduce((sum, row) => sum + row.line_total, 0) / (1003 * 1000);
  assert.equal(result.get('milk').cost, expected); assert.equal(result.get('milk').hasPrice, true);
  const pages = f.reads.filter(row => row.entityName === 'SupplierReceiptItem');
  assert.deepEqual(pages.map(row => row.args[3]), [0, 500, 1000]);
  assert.equal(f.reads.filter(row => row.entityName === 'SupplierReceipt').length, 3);
});

test('empty scoped costs read nothing; report callers retain the existing unscoped loader', async () => {
  const f = basketCheckoutFixture('Central');
  const { loadIngredientCosts } = f.load('base44/shared/cost-engine.ts');
  assert.equal((await loadIngredientCosts(f.service, [])).size, 0);
  assert.equal(f.reads.length, 0);
  const all = await loadIngredientCosts(f.service);
  assert.ok(all.has('milk')); assert.ok(all.has('not-in-basket-0'));
  assert.deepEqual(f.reads.map(row => row.method), ['list', 'list']);
});

test('malformed or repeated receipt pages cannot create a falsely exact partial cost', async () => {
  for (const damage of ['missing ID', 'repeated page', 'unrelated ingredient']) {
    const f = basketCheckoutFixture('Central');
    f.entities.SupplierReceiptItem.filter = async () => damage === 'missing ID'
      ? [{ ingredient_id: 'milk', receipt_id: 'milk-receipt', line_total: 1000, base_quantity: 1000 }]
      : damage === 'unrelated ingredient' ? [{ id: 'wrong', ingredient_id: 'not-in-basket', receipt_id: 'milk-receipt' }]
      : Array.from({ length: 500 }, (_, index) => ({ id: 'repeat-' + index, ingredient_id: 'milk', receipt_id: 'milk-receipt',
          line_total: 1000, base_quantity: 1000 }));
    assert.equal((await f.call()).status, 200);
    assert.equal(f.db.SaleItem[0].cost_is_estimate, true, damage);
  }
});

test('ingredient writes overlap in bounded groups; finance waits for all and replays never deduct twice', { timeout: 10000 }, async () => {
  const f = basketCheckoutFixture('Branch', 6), release = gate(), reached = gate();
  const original = f.entities.IngredientStock.updateMany;
  let active = 0, maximum = 0, started = 0, finished = false;
  f.entities.IngredientStock.updateMany = async (...args) => {
    if (!args[1].$set) return original(...args);
    active++; maximum = Math.max(maximum, active);
    if (++started === 4) reached.resolve();
    try { await release.promise; return await original(...args); }
    finally { active--; }
  };
  const pending = f.call().then(result => { finished = true; return result; });
  try {
    await reached.promise; await tick();
    assert.equal(started, 4); assert.equal(finished, false);
    assert.equal(f.db.Shift[0].expected_cash, 0);
    assert.equal(f.db.Shift[0].sale_request_keys.includes('sale-completed:' + f.request.idempotency_key), false);
    assert.equal((await f.call()).status, 503);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal(maximum, 4); assert.equal(started, 6);
  const moves = f.db.StockMovement.filter(row => row.item_kind === 'ingredient');
  assert.equal(moves.length, 6);
  for (const movement of moves) {
    assert.equal(movement.balance_after, f.db.IngredientStock.find(row => row.ingredient_id === movement.item_id).quantity);
  }
  assert.equal((await f.call()).data.already_processed, true);
  assert.equal(f.db.StockMovement.length, 6); assert.equal(f.db.Shift[0].expected_cash, 20000);
});

for (const failure of ['stock conflict', 'movement failure']) {
  test('failed ingredient batch waits for late siblings before compensation: ' + failure, { timeout: 10000 }, async () => {
    const f = basketCheckoutFixture('Branch', 6), release = gate(), reached = gate();
    const stock = f.entities.IngredientStock.updateMany, movement = f.entities.StockMovement.create;
    if (failure === 'stock conflict') {
      f.entities.IngredientStock.updateMany = async (query, ops) => {
        if (ops.$set && query.id === 'milk-stock') return { success: true, updated: 0 };
        if (ops.$set) { reached.resolve(); await release.promise; }
        return stock(query, ops);
      };
    } else {
      f.entities.StockMovement.create = async row => {
        if (row.item_kind === 'ingredient' && row.item_id === 'milk') throw new Error('Mock ingredient movement failure');
        if (row.item_kind === 'ingredient') { reached.resolve(); await release.promise; }
        return movement(row);
      };
    }
    let finished = false;
    const pending = f.call().then(result => { finished = true; return result; });
    try { await reached.promise; await tick(); assert.equal(finished, false); }
    finally { release.resolve(); }
    const result = await pending;
    assert.equal(result.status, failure === 'stock conflict' ? 409 : 500);
    assert.ok(f.db.IngredientStock.every(row => row.quantity === 100000));
    for (const name of ['Sale', 'SaleItem', 'Payment', 'StockMovement']) assert.equal(f.db[name].length, 0, name);
    assert.equal(f.db.Shift[0].expected_cash, 0); assert.equal(f.db.Shift[0].sale_request_keys.length, 0);
    f.entities.IngredientStock.updateMany = stock; f.entities.StockMovement.create = movement;
    assert.equal((await f.call()).status, 200);
    assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Shift[0].expected_cash, 20000);
  });
}
