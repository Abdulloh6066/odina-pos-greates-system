// Checkout regressions use only in-memory SDK records; no network or live sales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { BURGER_PRODUCT_IDS, FRIES_INGREDIENT_ID } from '../base44/shared/burger-fries.js';

const entry = 'base44/functions/complete-sale/entry.ts';
const branch = '6a96f0a4ecc85c2fc57f3174';
const burger = BURGER_PRODUCT_IDS[0];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture() {
  const products = [
    { id: 'coffee', name: 'Mock coffee', source_type: 'shop_prepared', price: 1000 },
    { id: burger, name: 'Mock burger', source_type: 'shop_prepared', price: 1000 },
    { id: 'cake', name: 'Mock sheet cake', source_type: 'central_produced', price: 1000,
      production_unit: 'sheet', pieces_per_sheet: 20 },
  ].map(row => ({ active: true, track_stock: true, ...row }));
  const recipes = products.map(p => ({ id: p.id + '-recipe', product_id: p.id,
    active: true, version: 1, output_quantity: p.id === burger ? 1 : 2,
    ...(p.id !== 'cake' ? { output_unit: 'piece' } : {}) }));
  recipes.push({ id: 'unrelated-recipe', product_id: 'not-in-cart', active: true, output_quantity: 1 });
  const items = [
    { id: 'milk', recipe_id: 'coffee-recipe', ingredient_id: 'milk', quantity: 400, unit: 'ml' },
    { id: 'cup', recipe_id: 'coffee-recipe', ingredient_id: 'cup', quantity: 2, unit: 'piece' },
    { id: 'beef', recipe_id: burger + '-recipe', ingredient_id: 'beef', quantity: 120, unit: 'g' },
    { id: 'bun', recipe_id: burger + '-recipe', ingredient_id: 'bun', quantity: 1, unit: 'piece' },
    { id: 'sugar', recipe_id: 'cake-recipe', ingredient_id: 'sugar', quantity: 600, unit: 'g' },
    { id: 'unrelated', recipe_id: 'unrelated-recipe', ingredient_id: 'missing', quantity: 999, unit: 'g' },
  ];
  const f = memoryBackend({
    User: [{ id: 'cashier', role: 'cashier', shop_id: branch, active: true }],
    Shop: [{ id: branch, name: 'Mock Branch', active: true, location_type: 'shop', allows_pos: true }],
    Shift: [{ id: 'shift', user_id: 'cashier', shop_id: branch, shop_name: 'Mock Branch',
      status: 'open', opened_at: '2026-09-27T06:00:00Z', expected_cash: 0, total_sales: 0,
      order_count: 0, sale_request_keys: [] }],
    Product: products,
    ProductStock: products.map(p => ({ id: p.id + '-stock', product_id: p.id, location_id: branch, quantity: 20 })),
    Recipe: recipes, RecipeItem: items,
    IngredientStock: [['milk', 1000, 'ml'], ['cup', 100, 'piece'], ['beef', 1000, 'g'],
      ['bun', 20, 'piece'], [FRIES_INGREDIENT_ID, 2000, 'g']].map(([ingredient_id, quantity, unit]) =>
      ({ id: ingredient_id + '-stock', ingredient_id, quantity, unit, location_id: branch })),
    SupplierReceipt: [{ id: 'receipt', status: 'confirmed' }],
    SupplierReceiptItem: [['milk', 1], ['cup', 100], ['beef', 2], ['bun', 200],
      [FRIES_INGREDIENT_ID, 10], ['sugar', 10]].map(([ingredient_id, price]) =>
      ({ id: ingredient_id + '-price', receipt_id: 'receipt', ingredient_id,
        base_quantity: 1000, line_total: price * 1000 })),
    Settings: [{ id: 'settings', allow_negative_stock: false }],
    Sale: [], SaleItem: [], Payment: [], StockMovement: [], ActionHistory: [],
  });
  f.request = { action: 'complete_sale', shift_id: 'shift', idempotency_key: 'mock-recipe-reuse-001',
    recorded_at: '2026-09-27T07:00:00Z', items: [{ product_id: 'coffee', quantity: 1 },
      { product_id: burger, quantity: 1, fries_option: 'without' },
      { product_id: burger, quantity: 1, fries_option: 'with' }, { product_id: 'cake', quantity: 1 }],
    payments: [{ method: 'cash', amount: 9000 }] };
  f.reads = { recipes: [], items: [] };
  for (const [entityName, key] of [['Recipe', 'recipes'], ['RecipeItem', 'items']]) {
    const filter = f.entities[entityName].filter;
    f.entities[entityName].filter = async (...args) => {
      f.reads[key].push(structuredClone(args[0]));
      return filter(...args);
    };
  }
  f.call = (request = f.request) => f.invoke(entry, request);
  return f;
}

test('Branch shares one scoped RAW recipe/items read; optional fries costs and stock remain exact', async () => {
  const f = fixture();
  const originalCards = structuredClone(f.db.RecipeItem);
  const r = await f.call();
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(f.reads.recipes.length, 1);
  assert.deepEqual([...f.reads.recipes[0].product_id.$in].sort(), ['coffee', burger, 'cake'].sort());
  assert.equal(f.reads.items.length, 1);
  assert.deepEqual([...f.reads.items[0].recipe_id.$in].sort(), ['coffee-recipe', burger + '-recipe', 'cake-recipe'].sort());
  assert.deepEqual(f.db.RecipeItem, originalCards, 'neither deduction nor costing mutates RAW cached cards');
  const byKey = Object.fromEntries(f.db.SaleItem.map(row => [row.product_id + ':' + (row.fries_option || ''), row]));
  for (const [key, cost, price] of [['coffee:', 300, 1000], [burger + ':without', 440, 1000],
    [burger + ':with', 1940, 6000], ['cake:', 150, 1000]]) {
    assert.equal(byKey[key].unit_cost_at_sale, cost, key);
    assert.equal(byKey[key].total_cost_at_sale, cost, key);
    assert.equal(byKey[key].unit_price, price, key);
    assert.equal(byKey[key].cost_is_estimate, false, key);
  }
  const stocks = Object.fromEntries(f.db.IngredientStock.map(row => [row.ingredient_id, row.quantity]));
  assert.equal(stocks.milk, 800); assert.equal(stocks.cup, 99);
  assert.equal(stocks.beef, 760); assert.equal(stocks.bun, 18);
  assert.equal(stocks[FRIES_INGREDIENT_ID], 1850);
  assert.equal(f.db.Shift[0].expected_cash, 9000);
  assert.equal((await f.call()).data.already_processed, true);
  assert.equal(f.reads.recipes.length, 1, 'idempotent retry skips recipe reads and new deductions');
});

test('precheck and successive sales have separate caches and use changed recipe quantities', async () => {
  const f = fixture();
  const request = { ...f.request, items: [{ product_id: 'coffee', quantity: 1 }], payments: [{ method: 'cash', amount: 1000 }] };
  assert.equal((await f.call({ ...request, action: 'check_stock' })).status, 200);
  assert.equal(f.calls.length, 0);
  f.db.RecipeItem.find(row => row.id === 'milk').quantity = 600;
  assert.equal((await f.call(request)).status, 200);
  assert.equal(f.db.SaleItem[0].unit_cost_at_sale, 400);
  f.db.RecipeItem.find(row => row.id === 'milk').quantity = 800;
  assert.equal((await f.call({ ...request, idempotency_key: 'mock-recipe-reuse-002' })).status, 200);
  assert.equal(f.db.SaleItem[1].unit_cost_at_sale, 500);
  assert.equal(f.db.IngredientStock.find(row => row.ingredient_id === 'milk').quantity, 300);
  assert.equal(f.reads.recipes.length, 3); assert.equal(f.reads.items.length, 3);
});

test('mandatory Branch recipe/item lookup failures block before any mutation', async () => {
  for (const entity of ['Recipe', 'RecipeItem']) {
    const f = fixture();
    f.entities[entity].filter = async () => { throw new Error('Mock required lookup failure'); };
    assert.equal((await f.call()).status, 500);
    assert.equal(f.calls.length, 0, entity);
    assert.equal(f.db.IngredientStock.find(row => row.ingredient_id === 'milk').quantity, 1000);
  }
});

test('duplicate active Branch cards still reject before writes, while unrelated cards stay outside lookup', async () => {
  const f = fixture();
  f.db.Recipe.push({ ...f.db.Recipe[0], id: 'duplicate', version: 2 });
  assert.equal((await f.call()).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal(f.reads.items.length, 0);
});

test('failed optional bulk lookup falls back at four reads; one failed card preserves other snapshots', { timeout: 5000 }, async () => {
  const f = fixture();
  // Central products have optional cost cards, so failed cost reads do not bypass
  // a mandatory Branch deduction or invent a successful ingredient check.
  f.db.User[0].shop_id = 'central'; f.db.Shop[0].id = 'central'; f.db.Shift[0].shop_id = 'central';
  f.db.Product = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, name: 'Mock ' + i, price: 1000, active: true, track_stock: true }));
  f.db.ProductStock = f.db.Product.map(p => ({ id: p.id + '-stock', product_id: p.id, location_id: 'central', quantity: 10 }));
  f.db.Recipe = f.db.Product.map(p => ({ id: p.id + '-recipe', product_id: p.id, active: true, output_quantity: 1 }));
  f.db.RecipeItem = f.db.Recipe.map(r => ({ id: r.id + '-item', recipe_id: r.id, ingredient_id: 'milk', quantity: 100 }));
  f.request.items = f.db.Product.map(p => ({ product_id: p.id, quantity: 1 }));
  f.request.payments[0].amount = 6000;
  const gate = deferred(); const started = deferred();
  let active = 0; let maximum = 0; let count = 0;
  const recipeFilter = f.entities.Recipe.filter;
  f.entities.Recipe.filter = async (...args) => {
    if (args[0].product_id?.$in) throw new Error('Mock bulk lookup failure');
    active++; maximum = Math.max(maximum, active);
    if (++count === 4) started.resolve();
    try {
      await gate.promise;
      if (args[0].product_id === 'p0') throw new Error('Mock individual lookup failure');
      return await recipeFilter(...args);
    } finally { active--; }
  };
  const pending = f.call();
  try { await started.promise; assert.equal(count, 4); assert.equal(f.calls.length, 0); }
  finally { gate.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal(maximum, 4); assert.equal(count, 6);
  assert.equal(f.db.SaleItem.find(row => row.product_id === 'p0').cost_is_estimate, true);
  assert.ok(f.db.SaleItem.filter(row => row.product_id !== 'p0').every(row => row.unit_cost_at_sale === 100 && !row.cost_is_estimate));
});

test('optional fallback cache never turns a failed mandatory read into a successful deduction', async () => {
  const f = fixture(); const original = f.entities.Recipe.filter;
  f.entities.Recipe.filter = async (...args) => {
    if (args[0].product_id?.$in) throw new Error('Mock failed bulk');
    return original(...args);
  };
  const { createCheckoutRecipeLoader } = f.load('base44/shared/checkout-recipes.ts');
  const reader = createCheckoutRecipeLoader(f.service, ['coffee']);
  assert.equal((await reader.recipesForProduct('coffee'))[0].id, 'coffee-recipe');
  await assert.rejects(reader.recipesForProduct('coffee', true), /Mock failed bulk/);
});

test('one optional item failure preserves another product cost and the payment totals', async () => {
  const f = fixture();
  f.db.User[0].shop_id = 'central'; f.db.Shop[0].id = 'central'; f.db.Shift[0].shop_id = 'central';
  for (const row of f.db.ProductStock) row.location_id = 'central';
  f.request.items = [{ product_id: 'coffee', quantity: 1 }, { product_id: 'cake', quantity: 1 }];
  f.request.payments[0].amount = 2000;
  const filter = f.entities.RecipeItem.filter;
  f.entities.RecipeItem.filter = async (...args) => {
    if (args[0].recipe_id?.$in || args[0].recipe_id === 'coffee-recipe') throw new Error('Mock item read failure');
    return filter(...args);
  };
  assert.equal((await f.call()).status, 200);
  assert.equal(f.db.SaleItem.find(row => row.product_id === 'coffee').cost_is_estimate, true);
  const cake = f.db.SaleItem.find(row => row.product_id === 'cake');
  assert.equal(cake.unit_cost_at_sale, 150); assert.equal(cake.cost_is_estimate, false);
  assert.equal(f.db.Shift[0].expected_cash, 2000); assert.equal(f.db.Payment[0].amount, 2000);
});

test('frozen table prices keep live sheet conversion metadata for existing cost snapshots', async () => {
  const f = fixture();
  const product = f.db.Product.find(row => row.id === 'cake');
  product.price = 2000; // Frozen table price stays 1000, existing cost uses live sheet metadata.
  Object.assign(f.db.Shop[0], { restaurant_table_count: 2, restaurant_table_orders_version: 1,
    restaurant_table_orders: [{ id: 'table-order', number: 1, state: 'occupied', revision: 1,
      items: [{ product_id: 'cake', product_name: 'Mock sheet cake', price: 1000,
        quantity: 1, source_type: 'central_produced', stock_tracked: true }] }] });
  f.request.items = [{ product_id: 'cake', quantity: 1 }]; f.request.payments[0].amount = 1000;
  Object.assign(f.request, { table_shop_id: branch, table_number: 1,
    table_order_id: 'table-order', table_order_revision: 1 });
  const r = await f.call(); assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(f.db.SaleItem[0].unit_price, 1000);
  assert.equal(f.db.SaleItem[0].unit_cost_at_sale, 150);
  assert.equal(f.db.SaleItem[0].cost_is_estimate, false);
  assert.equal(f.db.Shift[0].expected_cash, 1000);
});

test('more than 500 items page by unique ID and restore per-card position order', async () => {
  const f = fixture();
  f.db.RecipeItem = ['coffee-recipe', burger + '-recipe'].flatMap((recipe_id, card) =>
    Array.from({ length: 301 }, (_, index) => ({ id: `${card}-item-${String(index).padStart(3, '0')}`,
      recipe_id, position: 301 - index, ingredient_id: 'milk', quantity: index + 1, unit: 'ml' })));
  const pages = []; const original = f.entities.RecipeItem.filter;
  f.entities.RecipeItem.filter = async (...args) => { pages.push(args.slice(1)); return original(...args); };
  const { createCheckoutRecipeLoader } = f.load('base44/shared/checkout-recipes.ts');
  const reader = createCheckoutRecipeLoader(f.service, ['coffee', burger]);
  const [coffee, burgerItems] = await Promise.all([
    reader.itemsForRecipe('coffee-recipe', true), reader.itemsForRecipe(burger + '-recipe', true),
  ]);
  assert.deepEqual(pages, [['id', 500, 0], ['id', 500, 500]]);
  for (const items of [coffee, burgerItems]) {
    assert.equal(items.length, 301);
    assert.equal(new Set(items.map(row => row.id)).size, 301);
    assert.equal(items[0].position, 1); assert.equal(items[300].position, 301);
    assert.equal(items.reduce((sum, row) => sum + row.quantity, 0), 301 * 302 / 2);
  }
});

test('required item reads reject missing IDs and repeated pagination instead of partial cards', async () => {
  for (const damage of ['missing ID', 'repeated page']) {
    const f = fixture();
    f.entities.RecipeItem.filter = async () => damage === 'missing ID'
      ? [{ recipe_id: 'coffee-recipe', quantity: 100, unit: 'ml' }]
      : Array.from({ length: 500 }, (_, index) => ({ id: 'item-' + index,
          recipe_id: 'coffee-recipe', quantity: 1, unit: 'ml' }));
    const { createCheckoutRecipeLoader } = f.load('base44/shared/checkout-recipes.ts');
    const reader = createCheckoutRecipeLoader(f.service, ['coffee']);
    await assert.rejects(reader.itemsForRecipe('coffee-recipe', true), /sahifalari takrorlandi/);
    assert.equal(f.calls.length, 0);
  }
});
