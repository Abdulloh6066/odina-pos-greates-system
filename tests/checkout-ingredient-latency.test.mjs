// Deferred in-memory entity methods only; never invokes the real SDK or printer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

function fixture(count = 5, missing = false) {
  const stock = Array.from({ length: count }, (_, i) => ({ id: `stock-${i}`, ingredient_id: `ingredient-${i}`,
    location_id: 'shop', quantity: 100, unit: ['g', 'ml', 'piece'][i % 3] }));
  const f = memoryBackend({ IngredientStock: missing ? [] : stock, StockMovement: [] });
  f.params = { shopId: 'shop', shopName: 'Mock shop', saleId: 'sale', saleNumber: 'mock-sale',
    userId: 'cashier', userName: 'Mock cashier', now: '2026-09-27T07:00:00.000Z', applied: [], movements: [],
    plans: stock.map((s, i) => ({ stock: missing ? null : { id: s.id, quantity: s.quantity }, before: missing ? 0 : 100,
      after: (missing ? 0 : 100) - i - 1, unit: s.unit,
      requirement: { ingredient_id: s.ingredient_id, ingredient_name: `Ingredient ${i}`, total_required: i + 1 } })),
    lines: [{ product_name: 'Mock drink', recipe: { items: stock.map(s => ({ ingredient_id: s.ingredient_id })) } }],
  };
  f.apply = () => f.load('base44/shared/sale-ingredient-flow.ts').applySaleIngredientDeduction(f.service, f.params);
  return f;
}

test('ingredient updates overlap at four; each movement waits for its own stock and retains exact units and journals', { timeout: 5000 }, async () => {
  const f = fixture(), gate = deferred(), reached = deferred();
  let started = 0, active = 0, maximum = 0;
  const original = f.entities.IngredientStock.updateMany;
  f.entities.IngredientStock.updateMany = async (...args) => {
    started++; active++; maximum = Math.max(maximum, active);
    if (started === 4) reached.resolve();
    try { await gate.promise; return await original(...args); } finally { active--; }
  };
  const pending = f.apply();
  try {
    await reached.promise;
    assert.equal(started, 4);
    assert.equal(f.db.StockMovement.length, 0, 'movements cannot precede stock');
    assert.equal(f.params.applied.length, 0);
  } finally { gate.resolve(); }
  await pending;
  assert.equal(maximum, 4); assert.equal(started, 5);
  assert.equal(f.params.applied.length, 5); assert.equal(f.params.movements.length, 5);
  for (let i = 0; i < 5; i++) {
    const stock = f.db.IngredientStock.find(row => row.id === `stock-${i}`);
    const movement = f.db.StockMovement.find(row => row.item_id === `ingredient-${i}`);
    assert.equal(stock.quantity, 99 - i);
    assert.equal(movement.balance_before, 100); assert.equal(movement.balance_after, stock.quantity);
    assert.equal(movement.quantity_change, -i - 1); assert.equal(movement.unit, stock.unit);
    assert.equal(movement.location_id, 'shop'); assert.equal(movement.reference_id, 'sale');
  }
});

for (const failure of ['stock', 'movement']) {
  test(`ingredient ${failure} failure drains late siblings into rollback journals and never starts the next batch`, { timeout: 5000 }, async () => {
    const f = fixture(), gate = deferred(), reached = deferred();
    const update = f.entities.IngredientStock.updateMany, movement = f.entities.StockMovement.create;
    let finished = false;
    f.entities.IngredientStock.updateMany = async (query, ops) => {
      if (query.id === 'stock-0' && failure === 'stock') throw new Error('Mock stock failure');
      if (query.id === 'stock-3') { reached.resolve(); await gate.promise; }
      return update(query, ops);
    };
    f.entities.StockMovement.create = async row => {
      if (row.item_id === 'ingredient-0' && failure === 'movement') throw new Error('Mock movement failure');
      return movement(row);
    };
    const pending = f.apply().then(() => { finished = true; }, error => { finished = true; return error; });
    try {
      await reached.promise; await tick();
      assert.equal(finished, false);
      assert.equal(f.db.IngredientStock[4].quantity, 100);
    } finally { gate.resolve(); }
    const error = await pending;
    assert.match(error.message, new RegExp(`Mock ${failure} failure`));
    assert.equal(f.params.applied.length, failure === 'stock' ? 3 : 4);
    assert.equal(f.params.movements.length, 3);
    assert.ok(f.params.applied.some(row => row.stockId === 'stock-3'), 'late successful update is compensatable');
    assert.ok(f.params.movements.some(row => row.item_id === 'ingredient-3'));
    assert.equal(f.db.IngredientStock[4].quantity, 100);
  });
}

test('ingredient CAS conflicts retain a concurrent device quantity and create no movement for the rejected row', async () => {
  const f = fixture(2);
  f.db.IngredientStock[0].quantity = 90;
  await assert.rejects(f.apply(), error => error.status === 409);
  assert.equal(f.db.IngredientStock[0].quantity, 90);
  assert.equal(f.db.StockMovement.some(row => row.item_id === 'ingredient-0'), false);
  assert.equal(f.params.applied.length, 1);
  assert.equal(f.params.applied[0].stockId, 'stock-1');
});

test('missing ingredient rows retain the configured negative-stock plans and exact created-row journals', async () => {
  const f = fixture(2, true);
  await f.apply();
  assert.equal(f.db.IngredientStock.length, 2);
  for (let i = 0; i < 2; i++) {
    const stock = f.db.IngredientStock.find(row => row.ingredient_id === `ingredient-${i}`);
    assert.equal(stock.quantity, -i - 1); assert.equal(stock.location_id, 'shop');
    assert.ok(f.params.applied.some(row => row.stockId === stock.id && row.before === 0));
  }
});
