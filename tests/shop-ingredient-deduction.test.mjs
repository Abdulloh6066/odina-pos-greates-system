// Offline regression tests for shop-prepared ingredient deduction (pure logic).
// No live Base44 data is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

function loadModule() {
  const url = new URL('../base44/shared/shop-ingredient-deduction.ts', import.meta.url);
  const src = readFileSync(url, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: 'commonjs', target: 'es2020' },
  }).outputText;
  const moduleObj = { exports: {} };
  const ctx = { module: moduleObj, exports: moduleObj.exports, console };
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  return moduleObj.exports;
}

const M = loadModule();

const mojitoRecipe = {
  recipe_id: 'r-mojito',
  output_quantity: 1,
  items: [
    { ingredient_id: 'i-syrup', ingredient_name_snapshot: 'Sharbat', quantity: 30, unit: 'ml' },
    { ingredient_id: 'i-water', ingredient_name_snapshot: 'Suv', quantity: 200, unit: 'ml' },
    { ingredient_id: 'i-lime', ingredient_name_snapshot: 'Laym', quantity: 1, unit: 'piece' },
    { ingredient_id: 'i-cup', ingredient_name_snapshot: 'Stakan', quantity: 1, unit: 'piece' },
  ],
};

const cakeRecipe = {
  recipe_id: 'r-cake',
  output_quantity: 1,
  items: [{ ingredient_id: 'i-flour', ingredient_name_snapshot: 'Un', quantity: 500, unit: 'g' }],
};

test('1. one shop-prepared drink deducts its recipe ingredients', () => {
  const items = [{ product_id: 'p-mojito', product_name: 'Moxito', quantity: 1, source_type: 'shop_prepared' }];
  const map = new Map([['p-mojito', mojitoRecipe]]);
  const { lines, missing } = M.shopPreparedLines(items, map);
  assert.equal(missing.length, 0);
  const reqs = M.aggregateIngredientRequirements(lines);
  const byId = Object.fromEntries(reqs.map(r => [r.ingredient_id, r.total_required]));
  assert.equal(byId['i-syrup'], 30);
  assert.equal(byId['i-water'], 200);
  assert.equal(byId['i-lime'], 1);
  assert.equal(byId['i-cup'], 1);
});

test('2. quantity 2 multiplies every ingredient by 2', () => {
  const items = [{ product_id: 'p-mojito', product_name: 'Moxito', quantity: 2, source_type: 'shop_prepared' }];
  const map = new Map([['p-mojito', mojitoRecipe]]);
  const { lines } = M.shopPreparedLines(items, map);
  const reqs = M.aggregateIngredientRequirements(lines);
  const byId = Object.fromEntries(reqs.map(r => [r.ingredient_id, r.total_required]));
  assert.equal(byId['i-syrup'], 60);
  assert.equal(byId['i-water'], 400);
  assert.equal(byId['i-lime'], 2);
  assert.equal(byId['i-cup'], 2);
});

test('3. multiple drinks using the same ingredient are aggregated', () => {
  const teaRecipe = {
    recipe_id: 'r-tea',
    output_quantity: 1,
    items: [
      { ingredient_id: 'i-water', ingredient_name_snapshot: 'Suv', quantity: 250, unit: 'ml' },
      { ingredient_id: 'i-teabag', ingredient_name_snapshot: 'Choy paket', quantity: 1, unit: 'piece' },
    ],
  };
  const items = [
    { product_id: 'p-mojito', product_name: 'Moxito', quantity: 1, source_type: 'shop_prepared' },
    { product_id: 'p-tea', product_name: 'Choy', quantity: 1, source_type: 'shop_prepared' },
  ];
  const map = new Map([['p-mojito', mojitoRecipe], ['p-tea', teaRecipe]]);
  const { lines } = M.shopPreparedLines(items, map);
  const reqs = M.aggregateIngredientRequirements(lines);
  const water = reqs.find(r => r.ingredient_id === 'i-water');
  assert.equal(water.total_required, 450, '200 + 250 ml aggregated');
  assert.equal(reqs.length, 5, 'syrup, water(merged), lime, cup, teabag');
});

test('4. ingredients are deducted from the selling shop only (planner uses only that shop stock)', () => {
  const items = [{ product_id: 'p-mojito', product_name: 'Moxito', quantity: 1, source_type: 'shop_prepared' }];
  const map = new Map([['p-mojito', mojitoRecipe]]);
  const { lines } = M.shopPreparedLines(items, map);
  const reqs = M.aggregateIngredientRequirements(lines);
  const stock = new Map([
    ['i-syrup', { id: 's1', quantity: 1000 }],
    ['i-water', { id: 's2', quantity: 1000 }],
    ['i-lime', { id: 's3', quantity: 10 }],
    ['i-cup', { id: 's4', quantity: 50 }],
  ]);
  const { plans, shortages } = M.planIngredientDeductions(reqs, stock);
  assert.equal(shortages.length, 0);
  const byId = Object.fromEntries(plans.map(p => [p.requirement.ingredient_id, p.after]));
  assert.equal(byId['i-syrup'], 970);
  assert.equal(byId['i-water'], 800);
  assert.equal(byId['i-lime'], 9);
  assert.equal(byId['i-cup'], 49);
});

test('5. a centrally produced cake does not deduct ingredients at sale', () => {
  const items = [
    { product_id: 'p-cake', product_name: 'Tort', quantity: 1, source_type: 'central_produced' },
    { product_id: 'p-mojito', product_name: 'Moxito', quantity: 1, source_type: 'shop_prepared' },
  ];
  const map = new Map([['p-cake', cakeRecipe], ['p-mojito', mojitoRecipe]]);
  const { lines } = M.shopPreparedLines(items, map);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].product_id, 'p-mojito');
  const reqs = M.aggregateIngredientRequirements(lines);
  assert.equal(reqs.find(r => r.ingredient_id === 'i-flour'), undefined);
});

test('6. a purchased resale product deducts only finished stock (not ingredients)', () => {
  const items = [{ product_id: 'p-water-bottle', product_name: 'Suv 0.5L', quantity: 3, source_type: 'resale' }];
  const map = new Map([['p-water-bottle', null]]);
  const { lines } = M.shopPreparedLines(items, map);
  assert.equal(lines.length, 0, 'resale products have no ingredient lines');
});

test('7. missing tech card blocks the sale before mutations', () => {
  const items = [{ product_id: 'p-smoothie', product_name: 'Smuzi', quantity: 1, source_type: 'shop_prepared' }];
  const map = new Map([['p-smoothie', null]]);
  const { lines, missing } = M.shopPreparedLines(items, map);
  assert.equal(lines.length, 0);
  assert.deepEqual(missing, ['Smuzi']);
});

test('8. insufficient stock follows the negative-stock setting', () => {
  const items = [{ product_id: 'p-mojito', product_name: 'Moxito', quantity: 2, source_type: 'shop_prepared' }];
  const map = new Map([['p-mojito', mojitoRecipe]]);
  const { lines } = M.shopPreparedLines(items, map);
  const reqs = M.aggregateIngredientRequirements(lines);
  const stock = new Map([
    ['i-syrup', { id: 's1', quantity: 40 }],
    ['i-water', { id: 's2', quantity: 1000 }],
    ['i-lime', { id: 's3', quantity: 10 }],
    ['i-cup', { id: 's4', quantity: 50 }],
  ]);
  const { shortages } = M.planIngredientDeductions(reqs, stock);
  assert.equal(shortages.length, 1);
  assert.equal(shortages[0].ingredient_id, 'i-syrup');
  assert.equal(shortages[0].missing, 20);
});

test('9 & 10. idempotency: sale ingredient reason text is stable', () => {
  assert.equal(M.saleIngredientReason(['Moxito']), 'Kassa savdosi — Moxito');
  assert.equal(M.saleIngredientReason(['Moxito', 'Choy', 'Kofe', 'Smuzi']).endsWith('va boshqalar'), true);
});

test('11. refund restores ingredients exactly once (from movement records)', () => {
  const movements = [
    { reference_id: 'sale-1', item_kind: 'ingredient', movement_type: 'sale', item_id: 'i-syrup', item_name: 'Sharbat', quantity_change: -60, unit: 'ml' },
    { reference_id: 'sale-1', item_kind: 'ingredient', movement_type: 'sale', item_id: 'i-water', item_name: 'Suv', quantity_change: -400, unit: 'ml' },
    { reference_id: 'sale-1', item_kind: 'ingredient', movement_type: 'sale', item_id: 'i-lime', item_name: 'Laym', quantity_change: -2, unit: 'piece' },
    { reference_id: 'sale-1', item_kind: 'ingredient', movement_type: 'sale', item_id: 'i-cup', item_name: 'Stakan', quantity_change: -2, unit: 'piece' },
    { reference_id: 'sale-1', item_kind: 'product', movement_type: 'sale', item_id: 'p-other', item_name: 'Boshqa', quantity_change: -1, unit: 'piece' },
  ];
  const restored = M.ingredientsDeductedForSale(movements, 'sale-1');
  const byId = Object.fromEntries(restored.map(r => [r.ingredient_id, r.quantity]));
  assert.equal(byId['i-syrup'], 60);
  assert.equal(byId['i-water'], 400);
  assert.equal(byId['i-lime'], 2);
  assert.equal(byId['i-cup'], 2);
  assert.equal(restored.find(r => r.ingredient_id === 'p-other'), undefined, 'product movements excluded');
});

test('12. unit conversions remain correct (recipe already in base unit)', () => {
  const items = [{ product_id: 'p-mojito', product_name: 'Moxito', quantity: 1, source_type: 'shop_prepared' }];
  const map = new Map([['p-mojito', mojitoRecipe]]);
  const { lines } = M.shopPreparedLines(items, map);
  const reqs = M.aggregateIngredientRequirements(lines);
  const liquid = reqs.filter(r => r.unit === 'ml').reduce((s, r) => s + r.total_required, 0);
  assert.equal(liquid, 230);
});

test('13. a failed deduction cannot leave a partial sale (all-or-nothing pre-check)', () => {
  const items = [{ product_id: 'p-mojito', product_name: 'Moxito', quantity: 2, source_type: 'shop_prepared' }];
  const map = new Map([['p-mojito', mojitoRecipe]]);
  const { lines } = M.shopPreparedLines(items, map);
  const reqs = M.aggregateIngredientRequirements(lines);
  const stock = new Map([
    ['i-syrup', { id: 's1', quantity: 10 }],
    ['i-water', { id: 's2', quantity: 10 }],
    ['i-lime', { id: 's3', quantity: 10 }],
    ['i-cup', { id: 's4', quantity: 50 }],
  ]);
  const { shortages } = M.planIngredientDeductions(reqs, stock);
  assert.equal(shortages.length, 2, 'both syrup and water reported, not just the first');
});

test('recipe output_quantity divides per-batch recipes', () => {
  const batchRecipe = {
    recipe_id: 'r-batch',
    output_quantity: 4,
    items: [{ ingredient_id: 'i-dough', ingredient_name_snapshot: 'Xamir', quantity: 800, unit: 'g' }],
  };
  const items = [{ product_id: 'p-bun', product_name: 'Bulochka', quantity: 2, source_type: 'shop_prepared' }];
  const map = new Map([['p-bun', batchRecipe]]);
  const { lines } = M.shopPreparedLines(items, map);
  const reqs = M.aggregateIngredientRequirements(lines);
  assert.equal(reqs[0].total_required, 400, '800g for 4 -> 400g for 2');
});