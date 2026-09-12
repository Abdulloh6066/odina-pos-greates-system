// Offline regression tests for tomorrow's production ingredient forecast (no SDK / no live data).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

function loadLogic() {
  const url = new URL('../../base44/shared/production-forecast-logic.ts', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: 'commonjs', target: 'es2020' },
  }).outputText;
  const moduleObject = { exports: {} };
  const context = { module: moduleObject, exports: moduleObject.exports, console };
  vm.createContext(context);
  vm.runInContext(javascript, context);
  return moduleObject.exports;
}

const L = loadLogic();
const TODAY = '2026-09-12';
const TOMORROW = '2026-09-13';

const product = (id, name) => ({
  id,
  name,
  source_type: 'central_produced',
  production_unit: 'piece',
  track_stock: true,
});

const recipe = (id, productId, output = 1) => ({
  id,
  product_id: productId,
  active: true,
  output_quantity: output,
  output_unit: 'piece',
  version: 1,
});

const recipeItem = (recipeId, productId, ingredientId, name, quantity, unit = 'g') => ({
  recipe_id: recipeId,
  product_id: productId,
  ingredient_id: ingredientId,
  ingredient_name_snapshot: name,
  quantity,
  unit,
});

const order = (id, date, status = 'qabul_qilindi') => ({
  id,
  required_date: date,
  order_status: status,
});

const orderItem = (orderId, productId, name, quantity) => ({
  order_id: orderId,
  product_id: productId,
  product_name_snapshot: name,
  unit_snapshot: 'piece',
  quantity,
});

test('8 Medovik + 5 Snickers aggregates shared ingredients and finds shortages', () => {
  const result = L.buildProductionIngredientForecast({
    todayDate: TODAY,
    tomorrowDate: TOMORROW,
    orders: [order('o1', TOMORROW), order('o2', TOMORROW)],
    orderItems: [
      orderItem('o1', 'med', 'Medovik', 8),
      orderItem('o2', 'sni', 'Snickers', 5),
    ],
    products: [product('med', 'Medovik'), product('sni', 'Snickers')],
    recipes: [recipe('r-med', 'med'), recipe('r-sni', 'sni')],
    recipeItems: [
      recipeItem('r-med', 'med', 'flour', 'Un', 100),
      recipeItem('r-med', 'med', 'sugar', 'Shakar', 50),
      recipeItem('r-sni', 'sni', 'flour', 'Un', 120),
      recipeItem('r-sni', 'sni', 'sugar', 'Shakar', 30),
    ],
    ingredientStocks: [
      { ingredient_id: 'flour', ingredient_name: 'Un', unit: 'g', quantity: 1000 },
      { ingredient_id: 'sugar', ingredient_name: 'Shakar', unit: 'g', quantity: 600 },
    ],
  });

  const flour = result.ingredient_requirements.find((row) => row.ingredient_id === 'flour');
  const sugar = result.ingredient_requirements.find((row) => row.ingredient_id === 'sugar');
  assert.equal(flour.required_tomorrow, 1400);
  assert.equal(flour.missing, 400);
  assert.equal(sugar.required_tomorrow, 550);
  assert.equal(sugar.missing, 0);
  assert.equal(result.shortages.length, 1);
  assert.equal(result.tomorrow_product_count, 2);
});

test('today remaining demand is reserved before deciding tomorrow shortage', () => {
  const result = L.buildProductionIngredientForecast({
    todayDate: TODAY,
    tomorrowDate: TOMORROW,
    orders: [order('today', TODAY), order('tomorrow', TOMORROW)],
    orderItems: [
      orderItem('today', 'med', 'Medovik', 3),
      orderItem('tomorrow', 'med', 'Medovik', 8),
    ],
    products: [product('med', 'Medovik')],
    recipes: [recipe('r-med', 'med')],
    recipeItems: [recipeItem('r-med', 'med', 'flour', 'Un', 100)],
    ingredientStocks: [{ ingredient_id: 'flour', ingredient_name: 'Un', unit: 'g', quantity: 1000 }],
  });

  const flour = result.ingredient_requirements[0];
  assert.equal(flour.required_today, 300);
  assert.equal(flour.required_tomorrow, 800);
  assert.equal(flour.required_total, 1100);
  assert.equal(flour.missing, 100);
});

test('ready, delivered, completed and cancelled orders do not reserve ingredients', () => {
  const statuses = ['tayyor', 'yuborildi_olib_ketildi', 'yakunlandi', 'bekor_qilindi'];
  const result = L.buildProductionIngredientForecast({
    todayDate: TODAY,
    tomorrowDate: TOMORROW,
    orders: statuses.map((status, index) => order(`o${index}`, TOMORROW, status)),
    orderItems: statuses.map((_, index) => orderItem(`o${index}`, 'med', 'Medovik', 10)),
    products: [product('med', 'Medovik')],
    recipes: [recipe('r-med', 'med')],
    recipeItems: [recipeItem('r-med', 'med', 'flour', 'Un', 100)],
    ingredientStocks: [],
  });

  assert.equal(result.tomorrow_order_count, 0);
  assert.equal(result.ingredient_requirements.length, 0);
  assert.equal(result.shortages.length, 0);
});

test('recipe output quantity scales ingredient need correctly', () => {
  const result = L.buildProductionIngredientForecast({
    todayDate: TODAY,
    tomorrowDate: TOMORROW,
    orders: [order('o1', TOMORROW)],
    orderItems: [orderItem('o1', 'med', 'Medovik', 5)],
    products: [product('med', 'Medovik')],
    recipes: [recipe('r-med', 'med', 10)],
    recipeItems: [recipeItem('r-med', 'med', 'flour', 'Un', 1000)],
    ingredientStocks: [{ ingredient_id: 'flour', unit: 'g', quantity: 500 }],
  });

  assert.equal(result.ingredient_requirements[0].required_tomorrow, 500);
  assert.equal(result.ingredient_requirements[0].missing, 0);
});

test('missing active recipe is clearly reported and never treated as enough stock', () => {
  const result = L.buildProductionIngredientForecast({
    todayDate: TODAY,
    tomorrowDate: TOMORROW,
    orders: [order('o1', TOMORROW)],
    orderItems: [orderItem('o1', 'med', 'Medovik', 8)],
    products: [product('med', 'Medovik')],
    recipes: [],
    recipeItems: [],
    ingredientStocks: [],
  });

  assert.equal(result.is_complete, false);
  assert.equal(result.issues.some((issue) => issue.type === 'missing_recipe'), true);
  assert.equal(result.product_requirements.length, 0);
});

test('shop-prepared and resale products are skipped without false recipe warnings', () => {
  const result = L.buildProductionIngredientForecast({
    todayDate: TODAY,
    tomorrowDate: TOMORROW,
    orders: [order('o1', TOMORROW)],
    orderItems: [orderItem('o1', 'coffee', 'Coffee', 5)],
    products: [{ ...product('coffee', 'Coffee'), source_type: 'shop_prepared' }],
    recipes: [],
    recipeItems: [],
    ingredientStocks: [],
  });

  assert.equal(result.skipped_products.length, 1);
  assert.equal(result.issues.length, 0);
  assert.equal(result.ingredient_requirements.length, 0);
});

test('missing stock record means zero available and full requirement missing', () => {
  const result = L.buildProductionIngredientForecast({
    todayDate: TODAY,
    tomorrowDate: TOMORROW,
    orders: [order('o1', TOMORROW)],
    orderItems: [orderItem('o1', 'med', 'Medovik', 2)],
    products: [product('med', 'Medovik')],
    recipes: [recipe('r-med', 'med')],
    recipeItems: [recipeItem('r-med', 'med', 'cream', 'Qaymoq', 250, 'ml')],
    ingredientStocks: [],
  });

  const cream = result.ingredient_requirements[0];
  assert.equal(cream.required_tomorrow, 500);
  assert.equal(cream.available, 0);
  assert.equal(cream.missing, 500);
});
