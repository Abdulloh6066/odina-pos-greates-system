// Offline regression tests for the "Tannarx va foyda" cost engine (pure math).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

function loadEngine() {
  const url = new URL('../../base44/shared/cost-engine.ts', import.meta.url);
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
const E = loadEngine();

test('example 1: 1 kg @ 20,000 UZS, recipe uses 100 g -> 2,000 UZS', () => {
  const lines = [{ line_total: 20000, base_quantity: 1000, purchase_quantity: 1, purchase_unit: 'kg' }];
  const avg = E.weightedAvgIngredientCost(lines);
  assert.equal(Math.round(avg.cost), 20, 'cost per gram = 20 UZS');
  assert.equal(avg.hasPrice, true);
  const costs = new Map([['i1', avg]]);
  const r = E.recipeCostFromMap([{ ingredient_id: 'i1', quantity: 100, ingredient_name_snapshot: 'Un', unit: 'g' }], costs);
  assert.equal(Math.round(r.batchCost), 2000, 'recipe cost = 2000 UZS');
  assert.equal(r.hasAllPrices, true);
});

test('example 1b: purchase in kg without base_quantity still converts (1 kg = 1000 g)', () => {
  const base = E.receiptBaseQuantity({ purchase_quantity: 1, purchase_unit: 'kg' });
  assert.equal(base, 1000);
  const avg = E.weightedAvgIngredientCost([{ line_total: 20000, purchase_quantity: 1, purchase_unit: 'kg' }]);
  assert.equal(Math.round(avg.cost), 20);
});

test('example 2: cost 40,000, sold 100,000 with 10% discount -> net 90,000, gross profit 50,000', () => {
  const costs = new Map([['i1', { cost: 40000, hasPrice: true }]]);
  const r = E.recipeCostFromMap([{ ingredient_id: 'i1', quantity: 1, ingredient_name_snapshot: 'X', unit: 'piece' }], costs);
  const perPiece = E.costPerPiece(r.batchCost, 1, 'piece', 20);
  assert.equal(Math.round(perPiece), 40000, 'cost per piece = 40,000');
  // sale: line_total already discount-adjusted = 90,000 (100,000 - 10,000)
  const sales = [{ id: 's1', status: 'completed' }];
  const items = [{ id: 'it1', sale_id: 's1', product_id: 'p1', product_name_snapshot: 'Tort', quantity: 1, line_total: 90000 }];
  const costById = new Map([['it1', { unitCost: perPiece, isEstimate: false, unknown: false }]]);
  const report = E.aggregateReport(sales, items, costById);
  assert.equal(report.summary.net_revenue, 90000, 'net revenue');
  assert.equal(report.summary.cost_of_goods, 40000, 'cost of goods');
  assert.equal(report.summary.gross_profit, 50000, 'gross profit');
  assert.equal(report.summary.margin, 55.56, 'margin %');
  assert.equal(report.products[0].quantity, 1);
});

test('example 2b: 100% discount -> zero revenue, cost remains -> negative gross profit', () => {
  const sales = [{ id: 's1', status: 'completed' }];
  const items = [{ id: 'it1', sale_id: 's1', product_id: 'p1', product_name_snapshot: 'Tort', quantity: 1, line_total: 0 }];
  const costById = new Map([['it1', { unitCost: 40000, isEstimate: false, unknown: false }]]);
  const report = E.aggregateReport(sales, items, costById);
  assert.equal(report.summary.net_revenue, 0);
  assert.equal(report.summary.cost_of_goods, 40000);
  assert.equal(report.summary.gross_profit, -40000, 'negative gross profit');
});

test('example 3: full refund reverses both revenue and cost (refunded sale excluded)', () => {
  const sales = [
    { id: 's1', status: 'refunded' },
    { id: 's2', status: 'completed' },
  ];
  const items = [
    { id: 'a1', sale_id: 's1', product_id: 'p1', product_name_snapshot: 'A', quantity: 2, line_total: 50000 },
    { id: 'a2', sale_id: 's2', product_id: 'p1', product_name_snapshot: 'A', quantity: 1, line_total: 25000 },
  ];
  const costById = new Map([
    ['a1', { unitCost: 10000, isEstimate: false, unknown: false }],
    ['a2', { unitCost: 10000, isEstimate: false, unknown: false }],
  ]);
  const report = E.aggregateReport(sales, items, costById);
  assert.equal(report.summary.net_revenue, 25000, 'refunded revenue excluded');
  assert.equal(report.summary.cost_of_goods, 10000, 'refunded cost excluded');
  assert.equal(report.summary.gross_profit, 15000);
  assert.equal(report.products[0].quantity, 1);
});

test('missing ingredient price is never treated as zero (flagged, not 0)', () => {
  const costs = new Map([['i1', { cost: 0, hasPrice: false }]]);
  const r = E.recipeCostFromMap([{ ingredient_id: 'i1', quantity: 100, ingredient_name_snapshot: 'Un', unit: 'g' }], costs);
  assert.equal(r.batchCost, 0, 'cost stays 0');
  assert.equal(r.hasAllPrices, false, 'flagged as missing price');
  assert.deepEqual(r.missing, ['Un']);
});

test('weighted average across two purchases at different prices', () => {
  // 2 kg @ 30,000 = 60,000 ; 1 kg @ 15,000 = 15,000  => total 75,000 for 3000 g => 25/g
  const lines = [
    { line_total: 60000, base_quantity: 2000 },
    { line_total: 15000, base_quantity: 1000 },
  ];
  const avg = E.weightedAvgIngredientCost(lines);
  assert.equal(Math.round(avg.cost), 25, 'weighted avg = 25 UZS/g');
});