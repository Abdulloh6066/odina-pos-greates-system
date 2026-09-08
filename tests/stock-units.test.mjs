// Offline regression tests: real handlers, in-memory entities, no network or live records.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

function fixture() {
  const db = {
    User: [{ id: 'admin', role: 'admin', active: true, full_name: 'Test admin' },
      { id: 'cashier', role: 'cashier', shop_id: 'shop', active: true },
      { id: 'other', role: 'cashier', shop_id: 'other-shop', active: true }],
    Shop: [{ id: 'central', name: 'Central', active: true, location_type: 'production' },
      { id: 'shop', name: 'Shop', active: true, location_type: 'shop' }],
    Product: [{ id: 'cake', name: 'Cake', production_unit: 'sheet', pieces_per_sheet: 20, active: true, source_type: 'central_produced' },
      { id: 'croissant', name: 'Croissant', production_unit: 'piece', active: true, source_type: 'central_produced' }],
    ProductStock: [{ id: 'cake-stock', location_id: 'central', product_id: 'cake', quantity: 5, unit: 'sheet' },
      { id: 'croissant-stock', location_id: 'central', product_id: 'croissant', quantity: 30, unit: 'piece' }],
    Ingredient: [{ id: 'flour', name: 'Flour', base_unit: 'g', active: true }, { id: 'sugar', name: 'Sugar', base_unit: 'g', active: true }],
    IngredientStock: [{ id: 'flour-stock', location_id: 'central', ingredient_id: 'flour', quantity: 10000, unit: 'g' },
      { id: 'sugar-stock', location_id: 'central', ingredient_id: 'sugar', quantity: 10000, unit: 'g' }],
    Recipe: [{ id: 'cake-recipe', product_id: 'cake', output_quantity: 1, output_unit: 'sheet', version: 1, active: true },
      { id: 'croissant-recipe', product_id: 'croissant', output_quantity: 20, output_unit: 'piece', version: 1, active: true }],
    RecipeItem: [
      { id: 'cf', recipe_id: 'cake-recipe', ingredient_id: 'flour', ingredient_name_snapshot: 'Flour', quantity: 1000, unit: 'g' },
      { id: 'cs', recipe_id: 'cake-recipe', ingredient_id: 'sugar', ingredient_name_snapshot: 'Sugar', quantity: 500, unit: 'g' },
      { id: 'rf', recipe_id: 'croissant-recipe', ingredient_id: 'flour', ingredient_name_snapshot: 'Flour', quantity: 1000, unit: 'g' },
      { id: 'rs', recipe_id: 'croissant-recipe', ingredient_id: 'sugar', ingredient_name_snapshot: 'Sugar', quantity: 1000, unit: 'g' },
    ],
    StockTransfer: [], StockMovement: [], ActionHistory: [], ProductionBatch: [], ProductionBatchItem: [],
  };
  let sequence = 0;
  let actor = 'admin';
  const clone = (v) => v == null ? v : structuredClone(v);
  const matches = (row, query) => Object.entries(query).every(([key, value]) => row[key] === value);
  const entities = Object.fromEntries(Object.keys(db).map((name) => {
    const entity = {
      get: async (id) => clone(db[name].find((row) => row.id === id) || null),
      list: async () => clone(db[name]),
      filter: async (query) => clone(db[name].filter((row) => matches(row, query))),
      create: async (data) => {
        const row = { ...clone(data), id: name + '-' + ++sequence };
        db[name].push(row); return clone(row);
      },
      update: async (id, data) => {
        const row = db[name].find((r) => r.id === id);
        if (!row) throw new Error('Missing row ' + id);
        Object.assign(row, clone(data)); return clone(row);
      },
      updateMany: async (query, operation) => {
        const rows = db[name].filter((row) => matches(row, query));
        for (const row of rows) {
          Object.assign(row, clone(operation.$set || {}));
          for (const [key, value] of Object.entries(operation.$inc || {})) row[key] = Number(row[key] || 0) + value;
        }
        return { success: true, updated: rows.length };
      },
      delete: async (id) => { db[name] = db[name].filter((r) => r.id !== id); },
    };
    entity.bulkCreate = async (rows) => Promise.all(rows.map(entity.create));
    return [name, entity];
  }));
  const client = { asServiceRole: { entities }, auth: { me: async () => clone(db.User.find((u) => u.id === actor)) } };
  return { db, client, actor: (id) => { actor = id; } };
}

function loadHandler(name, client) {
  const path = 'base44/functions/' + name + '/entry.ts';
  let source = readFileSync(path, 'utf8')
    .replace(/import \{ createClientFromRequest \} from "npm:@base44\/sdk";/, 'const createClientFromRequest = () => client;')
    .replace('export default async function(req)', 'async function handler(req)');
  source += '\nglobalThis.testHandler = handler;';
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const context = vm.createContext({ client, Response, crypto: webcrypto, console, structuredClone });
  vm.runInContext(code, context);
  return async (body) => {
    const response = await context.testHandler({ json: async () => body });
    return { status: response.status, data: await response.json() };
  };
}
const stock = (db, product, location) => db.ProductStock.find((s) => s.product_id === product && s.location_id === location);
let checks = 0;
async function test(label, fn) { await fn(); checks++; console.log('PASS ' + label); }

await test('mixed transfer: central -2 sheets/-20 units; destination +40/+20 only on receipt', async () => {
  const f = fixture(), call = loadHandler('stock-transfer', f.client);
  const beforeIngredients = structuredClone(f.db.IngredientStock);
  const sent = await call({ action: 'create_transfer', source_location_id: 'central', destination_location_id: 'shop',
    items: [{ product_id: 'cake', quantity: 2 }, { product_id: 'croissant', quantity: 20 }] });
  assert.equal(sent.status, 200, JSON.stringify(sent));
  assert.equal(stock(f.db, 'cake', 'central').quantity, 3);
  assert.equal(stock(f.db, 'croissant', 'central').quantity, 10);
  assert.equal(stock(f.db, 'cake', 'shop'), undefined);
  assert.equal(sent.data.transfers[0].received_quantity, 40);
  assert.equal(sent.data.transfers[0].unit, 'sheet');
  f.actor('other');
  assert.equal((await call({ action: 'receive_transfer_batch', batch_id: sent.data.batch_id })).status, 403);
  f.actor('cashier');
  f.db.Product[0].pieces_per_sheet = 99; // historical transfer must retain its original conversion
  const received = await call({ action: 'receive_transfer_batch', batch_id: sent.data.batch_id });
  assert.equal(received.status, 200, JSON.stringify(received));
  assert.equal(stock(f.db, 'cake', 'shop').quantity, 40);
  assert.equal(stock(f.db, 'croissant', 'shop').quantity, 20);
  assert.deepEqual(f.db.IngredientStock, beforeIngredients);
  const out = f.db.StockMovement.find((m) => m.item_id === 'cake' && m.movement_type === 'transfer_out');
  const incoming = f.db.StockMovement.find((m) => m.item_id === 'cake' && m.movement_type === 'transfer_in');
  assert.equal(out.unit, 'sheet'); assert.equal(out.quantity_change, -2);
  assert.equal(incoming.unit, 'piece'); assert.equal(incoming.quantity_change, 40);
  assert.equal((await call({ action: 'receive_transfer_batch', batch_id: sent.data.batch_id })).status, 409);
  assert.equal(stock(f.db, 'cake', 'shop').quantity, 40);
});

await test('shortage in mixed batch leaves every stock unchanged', async () => {
  const f = fixture(), call = loadHandler('stock-transfer', f.client), before = structuredClone(f.db.ProductStock);
  const r = await call({ action: 'create_transfer', source_location_id: 'central', destination_location_id: 'shop',
    items: [{ product_id: 'cake', quantity: 2 }, { product_id: 'croissant', quantity: 31 }] });
  assert.equal(r.status, 409); assert.deepEqual(f.db.ProductStock, before); assert.equal(f.db.StockTransfer.length, 0);
});

await test('invalid quantity, factor and source-unit mismatch are rejected before mutation', async () => {
  for (const scenario of ['fraction', 'factor', 'unit']) {
    const f = fixture(), call = loadHandler('stock-transfer', f.client);
    if (scenario === 'factor') f.db.Product[0].pieces_per_sheet = 0;
    if (scenario === 'unit') f.db.ProductStock[0].unit = 'piece';
    const before = structuredClone(f.db.ProductStock);
    const r = await call({ action: 'create_transfer', source_location_id: 'central', destination_location_id: 'shop',
      items: [{ product_id: 'cake', quantity: scenario === 'fraction' ? 1.5 : 2 }] });
    assert.ok(r.status >= 400); assert.deepEqual(f.db.ProductStock, before);
  }
});

await test('legacy piece-only transfer still receives unchanged quantity', async () => {
  const f = fixture(), call = loadHandler('stock-transfer', f.client);
  f.db.StockTransfer.push({ id: 'legacy', product_id: 'croissant', quantity: 3, unit: 'piece', status: 'pending',
    source_location_id: 'central', destination_location_id: 'shop' });
  const r = await call({ action: 'receive_transfer', transfer_id: 'legacy' });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(stock(f.db, 'croissant', 'shop').quantity, 3);
});

await test('20-unit recipe producing 10 uses 500g flour + 500g sugar', async () => {
  const f = fixture(), call = loadHandler('production-run', f.client);
  const r = await call({ action: 'complete_production', location_id: 'central', product_id: 'croissant', produced_quantity: 10 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(f.db.IngredientStock[0].quantity, 9500); assert.equal(f.db.IngredientStock[1].quantity, 9500);
  assert.equal(stock(f.db, 'croissant', 'central').quantity, 40);
  assert.equal(r.data.batch.unit, 'piece');
});

await test('sheet recipe produces sheets and consumes ingredients once', async () => {
  const f = fixture(), call = loadHandler('production-run', f.client);
  const r = await call({ action: 'complete_production', location_id: 'central', product_id: 'cake', produced_quantity: 2 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(f.db.IngredientStock[0].quantity, 8000); assert.equal(f.db.IngredientStock[1].quantity, 9000);
  assert.equal(stock(f.db, 'cake', 'central').quantity, 7);
  assert.equal(stock(f.db, 'cake', 'central').unit, 'sheet');
  assert.equal(r.data.batch.unit, 'sheet');
});

await test('recipe/product unit mismatch blocks production without ingredient changes', async () => {
  const f = fixture(), call = loadHandler('production-run', f.client);
  f.db.Recipe[0].output_unit = 'piece';
  const before = structuredClone(f.db.IngredientStock);
  const r = await call({ action: 'complete_production', location_id: 'central', product_id: 'cake', produced_quantity: 2 });
  assert.equal(r.status, 409); assert.deepEqual(f.db.IngredientStock, before);
});

await test('saving sheet recipe records output unit from product, not caller', async () => {
  const f = fixture(), call = loadHandler('production-run', f.client);
  const r = await call({ action: 'save_recipe', product_id: 'cake', output_quantity: 1, output_unit: 'piece',
    items: [{ ingredient_id: 'flour', quantity: 1000 }] });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.data.recipe.output_unit, 'sheet');
});

await test('manual adjustment is sheets centrally, pieces in shop; no ingredient consumption', async () => {
  const f = fixture(), call = loadHandler('warehouse-stock', f.client), before = structuredClone(f.db.IngredientStock);
  for (const [location, quantity, unit] of [['central', 2, 'sheet'], ['shop', 40, 'piece']]) {
    const r = await call({ action: 'adjust_stock', location_id: location, item_kind: 'product', item_id: 'cake',
      quantity_change: quantity, reason: 'offline test', movement_type: 'opening' });
    assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.data.stock.unit, unit);
  }
  assert.deepEqual(f.db.IngredientStock, before);
});

console.log(checks + ' offline regression tests passed. No live data was used.');
