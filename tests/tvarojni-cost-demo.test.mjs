// Offline-only cost demo regression; no Base44 connection and no production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

const read = (path) => readFileSync(path, 'utf8');
const demo = read('src/components/profit/TvarojniCostDemo.jsx');
const profitPage = read('src/pages/ProfitReport.jsx');
const engineSource = read('base44/shared/cost-engine.ts');

const moduleObj = { exports: {} };
const engineCode = ts.transpileModule(engineSource, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
vm.runInNewContext(engineCode, { module: moduleObj, exports: moduleObj.exports, console });
const engine = moduleObj.exports;

const ingredientsMatch = demo.match(/const EXAMPLE_INGREDIENTS = (\[[\s\S]*?\]);/);
assert.ok(ingredientsMatch, 'Demo ingredient fixture must remain inspectable');
const ingredients = vm.runInNewContext(ingredientsMatch[1]);

const fixtureCosts = new Map(ingredients.map((item) => [item.id, engine.weightedAvgIngredientCost([{
  purchase_quantity: item.purchaseQuantity,
  purchase_unit: item.purchaseUnit,
  line_total: item.purchasePrice,
}])]));
const recipe = engine.recipeCostFromMap(ingredients.map((item) => ({
  ingredient_id: item.id,
  ingredient_name_snapshot: item.name,
  quantity: item.quantity,
  unit: item.unit,
})), fixtureCosts);

const count = (name) => ingredients.find((item) => item.id === name)?.quantity;

test('demo uses only fictitious local entries and is visually separate from real reports', () => {
  assert.match(profitPage, /<TvarojniCostDemo\s*\/>/);
  assert.match(profitPage, /<TvarojniCostDemo\s*\/>[\s\S]*\/\* Filters \*\//);
  assert.match(demo, /Sinov · faqat ko‘rish uchun/);
  assert.match(demo, /Haqiqiy ma’lumot emas/);
  assert.match(demo, /bazaga yozmaydi/);
  assert.doesNotMatch(demo, /base44\.entities|base44\.functions|\.create\(|\.update\(|\.delete\(|bulkCreate|updateMany/);
  assert.match(demo, /from '\.\.\/\.\.\/\.\.\/base44\/shared\/cost-engine\.ts'/);
});

test('demo uses agreed quantities and weighted average unit conversion in actual cost engine', () => {
  assert.equal(count('flour'), 1000);
  assert.equal(count('curd'), 1000);
  assert.equal(ingredients.length, 7);
  assert.equal(fixtureCosts.get('flour').cost, 16);
  assert.equal(fixtureCosts.get('sugar').cost, 14);
  assert.equal(recipe.hasAllPrices, true);
  assert.equal(recipe.batchCost, 99600);
  assert.equal(engine.costPerPiece(recipe.batchCost, 1, 'sheet', 20), 4980);
});

test('sample 3-piece cost and illustrative gross profit never create a sale record', () => {
  const cost = engine.costPerPiece(recipe.batchCost, 1, 'sheet', 20);
  const simulated = engine.aggregateReport(
    [{ id: 'mock', status: 'completed' }],
    [{ id: 'mock-item', sale_id: 'mock', product_id: 'mock-product', product_name_snapshot: 'Tvarojni', quantity: 3, line_total: 15000 }],
    new Map([['mock-item', { unitCost: cost, isEstimate: false, unknown: false }]]),
  );
  assert.equal(simulated.summary.cost_of_goods, 14940);
  assert.equal(simulated.summary.net_revenue, 15000);
  assert.equal(simulated.summary.gross_profit, 60);
  assert.match(demo, /Bu haqiqiy savdo emas/);
});

test('missing demo purchase price is marked incomplete by cost engine', () => {
  const incompleteCosts = new Map(fixtureCosts);
  incompleteCosts.set('sugar', { cost: 0, hasPrice: false });
  const result = engine.recipeCostFromMap(ingredients.map((item) => ({
    ingredient_id: item.id, ingredient_name_snapshot: item.name, quantity: item.quantity,
  })), incompleteCosts);
  assert.equal(result.hasAllPrices, false);
  assert.equal(Array.from(result.missing).join(','), 'Shakar');
});
