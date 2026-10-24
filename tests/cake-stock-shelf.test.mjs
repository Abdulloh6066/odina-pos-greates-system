// Offline only: real stock handler with in-memory records. No production calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { cakeProducts, cakeStockInfo, loadAllCakeBalances, mergeCakeStockEvent, stockChange, stockShops } from '../src/lib/cake-stock-shelf.js';
import { matches } from './helpers/memory-backend.mjs';

function fixture({ quantity = 10, existing = true, role = 'cashier', assigned = 'branch', baseUnit = 'ml' } = {}) {
  const db = {
    Shop: [{ id: 'branch', name: 'Branch', active: true, location_type: 'shop' }, { id: 'other', name: 'Other', active: true, location_type: 'shop' }],
    Product: [{ id: 'cake', name: 'Cake', active: true, production_unit: 'piece' }],
    ProductStock: existing ? [{ id: 'stock', product_id: 'cake', location_id: 'branch', unit: 'piece', quantity }] : [],
    Ingredient: [{ id: 'ingredient', name: 'Ingredient', active: true, base_unit: baseUnit }],
    IngredientStock: existing ? [{ id: 'ingredient-stock', ingredient_id: 'ingredient', location_id: 'branch', unit: baseUnit, quantity }] : [],
    StockMovement: [], ActionHistory: [],
  };
  let sequence = 0;
  const entities = Object.fromEntries(Object.keys(db).map((name) => [name, {
    get: async (id) => structuredClone(db[name].find((row) => row.id === id) || null),
    filter: async (query) => structuredClone(db[name].filter((row) => matches(row, query))),
    create: async (data) => { const row = { ...structuredClone(data), id: name + ++sequence }; db[name].push(row); return structuredClone(row); },
    update: async (id, data) => { const row = db[name].find((item) => item.id === id); Object.assign(row, structuredClone(data)); return structuredClone(row); },
    updateMany: async (query, operation) => { const rows = db[name].filter((row) => matches(row, query)); for (const row of rows) Object.assign(row, structuredClone(operation.$set || {})); return { success: true, updated: rows.length }; },
    delete: async (id) => { const index = db[name].findIndex((row) => row.id === id); if (index >= 0) db[name].splice(index, 1); },
  }]));
  const actor = { id: 'worker', full_name: 'Offline test worker', role, shop_id: assigned, active: true };
  const client = { auth: { me: async () => actor }, asServiceRole: { entities } };
  let source = readFileSync('base44/functions/warehouse-stock/entry.ts', 'utf8')
    .replace(/import \{ createClientFromRequest \} from "npm:@base44\/sdk";/, 'const createClientFromRequest = () => client;')
    .replace(/import \{ resolveAppUser \} from "[^"]+";/, 'const resolveAppUser = async (_service, auth) => auth;')
    .replace('export default async function(req)', 'async function handler(req)');
  source += '\nglobalThis.handler = handler;';
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const context = vm.createContext({ client, Response, crypto: webcrypto, console, exports: {} });
  vm.runInContext(code, context);
  return { db, call: async (body) => { const response = await context.handler({ json: async () => body }); return { status: response.status, data: await response.json() }; } };
}
const request = (fields = {}) => ({ action: 'adjust_stock', location_id: 'branch', item_kind: 'product', item_id: 'cake', movement_type: 'adjustment', reason: 'Offline test count', ...fields });
let checks = 0;
async function test(name, action) { await action(); checks++; console.log('PASS ' + name); }

await test('cake scope excludes milk, drinks, archived cakes and other shops', () => {
  const products = [
    { id: 'cake', source_type: 'central_produced' },
    { id: 'croissant', source_type: 'central_produced', category_id: 'pastry' },
    { id: 'milk', source_type: 'resale' }, { id: 'coffee', source_type: 'shop_prepared' },
    { id: 'salad', source_type: 'central_produced', sale_unit: 'gram' },
    { id: 'archived', source_type: 'central_produced', archived: true },
    { id: 'central-only', source_type: 'central_produced', available_shop_ids: ['central'] },
    { id: 'hidden', source_type: 'central_produced', category_id: 'hidden-category' },
  ];
  assert.deepEqual(cakeProducts(products, [{ id: 'hidden-category', hidden_shop_ids: ['branch'] }], 'branch').map((p) => p.id), ['cake', 'croissant']);
  const shops = [{ id: 'branch' }, { id: 'other' }, { id: 'production', location_type: 'production' }];
  assert.deepEqual(stockShops(shops, { role: 'manager', data: { shop_id: 'branch' } }).map((s) => s.id), ['branch']);
  // A hidden (unlisted) own shop falls back to the account's assigned shop, never another shop.
  assert.deepEqual(stockShops([], { role: 'manager', shop_id: 'branch', shop_name: 'Odina Branch' }), [{ id: 'branch', name: 'Odina Branch', active: true, location_type: 'shop' }]);
  assert.deepEqual(stockShops([], { role: 'cashier', shop_id: '' }), []);
  assert.deepEqual(stockShops([], { role: 'admin', shop_id: 'branch' }), []);
  assert.deepEqual(stockShops([], { role: 'production', shop_id: 'center' }), []);
});
await test('missing, zero, negative, duplicate and invalid units stay distinct', () => {
  assert.equal(cakeStockInfo([], 'cake').status, 'missing');
  assert.equal(cakeStockInfo([], 'cake', false).status, 'loading');
  assert.equal(cakeStockInfo([{ product_id: 'cake', quantity: 0, unit: 'piece' }], 'cake').status, 'zero');
  assert.equal(cakeStockInfo([{ product_id: 'cake', quantity: -761, unit: 'piece' }], 'cake').quantity, -761);
  assert.equal(cakeStockInfo([{ product_id: 'cake', quantity: 2, unit: 'sheet' }], 'cake').status, 'invalid');
  assert.equal(cakeStockInfo([{ product_id: 'cake', quantity: 1 }, { product_id: 'cake', quantity: 2 }], 'cake').status, 'invalid');
  assert.ok(stockChange('out', 11, 10).error);
  assert.ok(stockChange('in', 1.5, 10).error);
  assert.deepEqual(stockChange('count', 0, -3), { quantity: 0, before: -3, after: 0, delta: 3 });
});
await test('paginated stock loading keeps records beyond the first 500 and excludes another location', async () => {
  let calls = 0;
  const result = await loadAllCakeBalances({ filter: async (query, sort, limit, skip) => {
    calls++; assert.equal(query.location_id, 'branch'); assert.equal(limit, 500);
    if (!skip) return Array.from({ length: 500 }, (_, id) => ({ id: String(id), location_id: 'branch' }));
    return [{ id: 'last', location_id: 'branch' }, { id: 'other', location_id: 'other' }];
  } }, 'branch');
  assert.equal(calls, 2); assert.equal(result.length, 501); assert.equal(result.at(-1).id, 'last');
});
await test('realtime updates cannot replace a newer quantity or mix shops', () => {
  const rows = [{ id: 's', product_id: 'cake', location_id: 'branch', quantity: 7, updated_at: '2026-10-16T08:00:00Z' }];
  assert.equal(mergeCakeStockEvent(rows, { type: 'update', data: { id: 's', quantity: 2, updated_at: '2026-10-16T07:59:00Z' } }, 'branch')[0].quantity, 7);
  assert.equal(mergeCakeStockEvent(rows, { type: 'update', data: { id: 's', quantity: 6, updated_at: '2026-10-16T08:01:00Z' } }, 'branch')[0].quantity, 6);
  assert.equal(mergeCakeStockEvent(rows, { type: 'create', data: { id: 'x', location_id: 'other', quantity: 99 } }, 'branch').length, 1);
});
await test('physical count repairs a negative balance and keeps one ledger movement', async () => {
  const f = fixture({ quantity: -761 });
  const r = await f.call(request({ counted_quantity: 8, expected_quantity: -761 }));
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(f.db.ProductStock[0].quantity, 8);
  assert.equal(f.db.StockMovement[0].quantity_change, 769);
  assert.equal(f.db.StockMovement[0].balance_before, -761);
  assert.equal(f.db.StockMovement[0].balance_after, 8);
});
await test('a real zero can initialize an absent balance; repeat does not duplicate the ledger', async () => {
  const f = fixture({ existing: false });
  const body = request({ counted_quantity: 0, expected_quantity: 0 });
  assert.equal((await f.call(body)).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 0);
  assert.equal((await f.call(body)).data.unchanged, true);
  assert.equal(f.db.ProductStock.length, 1); assert.equal(f.db.StockMovement.length, 1);
});
await test('stale counts and repeated incoming requests do not overwrite or double-add', async () => {
  const f = fixture();
  const body = request({ quantity_change: 3, expected_quantity: 10 });
  assert.equal((await f.call(body)).status, 200);
  assert.equal((await f.call(body)).status, 409);
  assert.equal((await f.call(request({ counted_quantity: 7, expected_quantity: 10 }))).status, 409);
  assert.equal(f.db.ProductStock[0].quantity, 13); assert.equal(f.db.StockMovement.length, 1);
});
await test('permission, whole-unit and non-negative validations remain on the backend', async () => {
  const other = fixture({ assigned: 'other' });
  assert.equal((await other.call(request({ counted_quantity: 9, expected_quantity: 10 }))).status, 403);
  assert.equal(other.db.StockMovement.length, 0);
  const f = fixture();
  assert.equal((await f.call(request({ counted_quantity: 1.5, expected_quantity: 10 }))).status, 400);
  assert.equal((await f.call(request({ quantity_change: -11, expected_quantity: 10 }))).status, 409);
  assert.equal((await f.call(request({ counted_quantity: 5, expected_quantity: NaN }))).status, 400);
  assert.equal(f.db.ProductStock[0].quantity, 10); assert.equal(f.db.StockMovement.length, 0);
});
await test('legacy warehouse calls still work without the new optional count fields', async () => {
  const f = fixture();
  assert.equal((await f.call(request({ quantity_change: 2 }))).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 12);
});

const ingredientRequest = fields => request({ item_kind: 'ingredient', item_id: 'ingredient', ...fields });
await test('ingredient counts support fractional base units, negative repair and stale-write protection', async () => {
  const f = fixture({ quantity: -350.5 });
  const body = ingredientRequest({ counted_quantity: 3250.25, expected_quantity: -350.5 });
  assert.equal((await f.call(body)).status, 200);
  assert.equal(f.db.IngredientStock[0].quantity, 3250.25);
  assert.equal(f.db.StockMovement[0].item_kind, 'ingredient');
  assert.equal(f.db.StockMovement[0].unit, 'ml');
  assert.equal(f.db.StockMovement[0].quantity_change, 3600.75);
  assert.equal((await f.call(body)).status, 409);
  assert.equal(f.db.StockMovement.length, 1);
  assert.equal(f.db.ProductStock[0].quantity, -350.5);
});
await test('ingredient receipt and count validation preserve units, whole pieces and assigned-shop access', async () => {
  const f = fixture({ quantity: 5800, baseUnit: 'g' });
  assert.equal((await f.call(ingredientRequest({ quantity_change: 125, expected_quantity: 5800 }))).status, 200);
  assert.equal(f.db.IngredientStock[0].quantity, 5925);
  assert.equal(f.db.StockMovement[0].unit, 'g');
  assert.equal((await f.call(ingredientRequest({ counted_quantity: '6000', expected_quantity: 5925 }))).status, 400);
  assert.equal((await f.call(ingredientRequest({ counted_quantity: 1.2345, expected_quantity: 5925 }))).status, 400);
  f.db.IngredientStock[0].unit = 'ml';
  assert.equal((await f.call(ingredientRequest({ quantity_change: 100, expected_quantity: 5925 }))).status, 409);
  assert.equal(f.db.IngredientStock[0].quantity, 5925);
  const pieces = fixture({ baseUnit: 'piece' });
  assert.equal((await pieces.call(ingredientRequest({ counted_quantity: 1.5, expected_quantity: 10 }))).status, 400);
  assert.equal((await pieces.call(ingredientRequest({ quantity_change: 1.5, expected_quantity: 10 }))).status, 400);
  const other = fixture({ assigned: 'other' });
  assert.equal((await other.call(ingredientRequest({ counted_quantity: 5, expected_quantity: 10 }))).status, 403);
  assert.equal(other.db.StockMovement.length, 0);
  const missing = fixture({ existing: false });
  const zero = ingredientRequest({ counted_quantity: 0, expected_quantity: 0 });
  assert.equal((await missing.call(zero)).status, 200);
  assert.equal((await missing.call(zero)).data.unchanged, true);
  assert.equal(missing.db.StockMovement.length, 1);
});
console.log(checks + ' stock checks passed.');
