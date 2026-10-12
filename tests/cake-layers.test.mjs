// All handlers run against in-memory entities. No network or production records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cakeLayerStockRows, calculateProductionCapacity } from '../src/lib/cake-layer-inventory.js';

function fixture() {
  const db = {
    User: [{ id: 'owner', role: 'admin', active: true },
      { id: 'worker', role: 'production', active: true, shop_id: 'central' },
      { id: 'wrong-worker', role: 'production', active: true, shop_id: 'other' },
      { id: 'cashier', role: 'cashier', active: true, shop_id: 'branch' }],
    Shop: [{ id: 'central', name: 'Central', active: true, location_type: 'production' },
      { id: 'branch', name: 'Branch', active: true, location_type: 'shop' }],
    Ingredient: [{ id: 'layer', name: 'Biskvit list', is_cake_layer: true, active: true,
      category: 'food', base_unit: 'piece', purchase_unit: 'piece', conversion_to_base: 1 },
      { id: 'cream', name: 'Krem', active: true, category: 'food', base_unit: 'g', purchase_unit: 'kg', conversion_to_base: 1000 }],
    IngredientStock: [{ id: 'layer-stock', ingredient_id: 'layer', location_id: 'central', quantity: 25, unit: 'piece' },
      { id: 'cream-stock', ingredient_id: 'cream', location_id: 'central', quantity: 600, unit: 'g' },
      { id: 'other-layer-stock', ingredient_id: 'layer', location_id: 'branch', quantity: 999, unit: 'piece' }],
    Product: [{ id: 'cake', name: 'Tort', active: true, archived: false, track_stock: true,
      source_type: 'central_produced', production_unit: 'piece' }],
    ProductStock: [{ id: 'finished-stock', product_id: 'cake', location_id: 'central', quantity: 0, unit: 'piece' }],
    Recipe: [{ id: 'recipe', product_id: 'cake', output_quantity: 1, output_unit: 'piece', active: true, version: 1 }],
    RecipeItem: [{ id: 'rl', recipe_id: 'recipe', ingredient_id: 'layer', ingredient_name_snapshot: 'Biskvit list', quantity: 5, unit: 'piece' },
      { id: 'rc', recipe_id: 'recipe', ingredient_id: 'cream', ingredient_name_snapshot: 'Krem', quantity: 200, unit: 'g' }],
    CashRecipient: [{ id: 'supplier', name: 'Supplier', active: true, recipient_type: 'supplier' }],
    SupplierReceipt: [], SupplierReceiptItem: [], StockTransfer: [], StockMovement: [],
    ActionHistory: [], ProductionBatch: [], ProductionBatchItem: [],
  };
  let seq = 0, actor = 'owner', failMovement = false;
  const clone = (value) => value == null ? value : structuredClone(value);
  const matches = (row, query) => Object.entries(query).every(([key, value]) => row[key] === value);
  const entities = Object.fromEntries(Object.keys(db).map((name) => {
    const entity = {
      get: async (id) => clone(db[name].find((row) => row.id === id) || null),
      list: async () => clone(db[name]),
      filter: async (query) => clone(db[name].filter((row) => matches(row, query))),
      create: async (data) => {
        if (name === 'StockMovement' && failMovement) { failMovement = false; throw new Error('Simulated ledger failure'); }
        const row = { ...clone(data), id: name + '-' + ++seq };
        db[name].push(row); return clone(row);
      },
      update: async (id, data) => {
        const row = db[name].find((item) => item.id === id);
        if (!row) throw new Error('Missing record');
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
      delete: async (id) => { db[name] = db[name].filter((row) => row.id !== id); },
    };
    entity.bulkCreate = async (rows) => Promise.all(rows.map(entity.create));
    return [name, entity];
  }));
  return {
    db, actor: (id) => { actor = id; }, failMovement: () => { failMovement = true; },
    client: { asServiceRole: { entities }, auth: { me: async () => clone(db.User.find((row) => row.id === actor)) } },
  };
}

function handler(name, client) {
  let helpers = 'const resolveAppUser = async (_service, auth) => auth;\nconst assertManagerRequestScope = async () => {};\n';
  if (name === 'production-run') {
    helpers += readFileSync('base44/shared/cost-engine.ts', 'utf8').replace(/export /g, '') + '\n';
    helpers += readFileSync('base44/shared/production-forecast-logic.ts', 'utf8').replace(/export /g, '') + '\n';
  }
  if (name === 'stock-transfer') {
    helpers += 'const userLabel = user => user.full_name || user.id;\nconst userRole = user => user.role;\nconst userShopId = user => user.shop_id || "";\nconst userShopName = user => user.shop_name || "";\n';
  }
  const source = readFileSync('base44/functions/' + name + '/entry.ts', 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('export default async function(req)', 'async function handler(req)');
  const context = vm.createContext({ client, Response, crypto: webcrypto, TextEncoder,
    console: { warn() {} }, structuredClone, exports: {} });
  const code = ts.transpileModule(helpers + '\nconst createClientFromRequest = () => client;\n' + source
    + '\nglobalThis.handler = handler;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInContext(code, context);
  return async (body) => {
    const response = await context.handler({ json: async () => body });
    return { status: response.status, data: await response.json() };
  };
}

const capacity = (f) => calculateProductionCapacity({ product: f.db.Product[0], recipe: f.db.Recipe[0],
  lines: f.db.RecipeItem, ingredients: f.db.Ingredient, stocks: f.db.IngredientStock, locationId: 'central' });
const produce = { action: 'complete_production', location_id: 'central', product_id: 'cake', produced_quantity: 2 };

test('25 layers allow 5 cakes, but cream allows only 3; branch stock is ignored', () => {
  const f = fixture(), result = capacity(f);
  assert.equal(result.layerPossible, 5); assert.equal(result.possible, 3);
  assert.equal(result.layers[0].available, 25); assert.equal(result.layers[0].perOutput, 5);
});

test('missing cream or layer stock gives zero production capacity', () => {
  const f = fixture(); f.db.IngredientStock = f.db.IngredientStock.filter((row) => row.ingredient_id !== 'cream');
  assert.equal(capacity(f).possible, 0); assert.equal(capacity(f).layerPossible, 5);
  f.db.IngredientStock = []; assert.equal(capacity(f).possible, 0);
});

test('batch recipe divides layers by output quantity and floors to whole cakes', () => {
  const f = fixture(); f.db.Recipe[0].output_quantity = 2;
  f.db.RecipeItem[0].quantity = 10; f.db.RecipeItem[1].quantity = 400;
  assert.equal(capacity(f).possible, 3); assert.equal(capacity(f).layers[0].perOutput, 5);
});

test('invalid layer fraction, stock unit, duplicates, inactive ingredient are blocked', () => {
  for (const scenario of ['fraction', 'unit', 'duplicate', 'inactive', 'stock-fraction']) {
    const f = fixture();
    if (scenario === 'fraction') f.db.RecipeItem[0].quantity = 2.5;
    if (scenario === 'unit') f.db.IngredientStock[0].unit = 'g';
    if (scenario === 'duplicate') f.db.IngredientStock.push({ ...f.db.IngredientStock[0], id: 'duplicate' });
    if (scenario === 'inactive') f.db.Ingredient[0].active = false;
    if (scenario === 'stock-fraction') f.db.IngredientStock[0].quantity = 2.5;
    const result = capacity(f); assert.equal(result.possible, 0); assert.ok(result.issue, scenario);
  }
});

test('no recipe is never presented as possible production', () => {
  const f = fixture(); f.db.Recipe = [];
  assert.equal(capacity(f).possible, 0); assert.match(capacity(f).issue, /retsept/i);
});

test('layer inventory excludes raw ingredients and exposes invalid stock', () => {
  const f = fixture();
  assert.equal(cakeLayerStockRows(f.db.Ingredient, f.db.IngredientStock, 'central').length, 1);
  f.db.IngredientStock[0].quantity = 1.5;
  assert.equal(cakeLayerStockRows(f.db.Ingredient, f.db.IngredientStock, 'central')[0].valid, false);
});

test('recipe saves whole layers and retains previous recipe history', async () => {
  const f = fixture(), call = handler('production-run', f.client);
  const result = await call({ action: 'save_recipe', product_id: 'cake', output_quantity: 2,
    items: [{ ingredient_id: 'layer', quantity: 10 }, { ingredient_id: 'cream', quantity: 400 }] });
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.recipe.version, 2);
  assert.equal(f.db.Recipe.find((row) => row.id === 'recipe').active, false);
  assert.equal(f.db.RecipeItem.find((row) => row.id === 'rl').quantity, 5);
});

test('fractional or shop-prepared layer recipes are rejected before mutation', async () => {
  for (const scenario of ['fraction', 'rounded-fraction', 'shop-prepared', 'unit']) {
    const f = fixture(), call = handler('production-run', f.client);
    if (scenario === 'shop-prepared') f.db.Product[0].source_type = 'shop_prepared';
    if (scenario === 'unit') f.db.Ingredient[0].base_unit = 'g';
    const quantity = scenario === 'fraction' ? 2.5 : scenario === 'rounded-fraction' ? 5.0001 : 5;
    const before = structuredClone(f.db.Recipe);
    const result = await call({ action: 'save_recipe', product_id: 'cake', output_quantity: 1, items: [{ ingredient_id: 'layer', quantity }] });
    assert.equal(result.status, 400, scenario); assert.deepEqual(f.db.Recipe, before);
  }
});

test('central layer adjustment is integer and audited; branch adjustment is blocked', async () => {
  const f = fixture(), call = handler('warehouse-stock', f.client);
  const body = { action: 'adjust_stock', location_id: 'central', item_kind: 'ingredient', item_id: 'layer',
    quantity_change: 2, reason: 'Offline physical count', movement_type: 'opening' };
  const result = await call(body); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.IngredientStock[0].quantity, 27); assert.equal(f.db.StockMovement[0].unit, 'piece');
  for (const change of [0.5, 1.0001]) assert.equal((await call({ ...body, quantity_change: change })).status, 400);
  assert.equal((await call({ ...body, location_id: 'branch' })).status, 400);
  assert.equal(f.db.IngredientStock[0].quantity, 27);
});

test('assembling 2 cakes consumes 10 layers and 400g cream once, records output', async () => {
  const f = fixture(), result = await handler('production-run', f.client)(produce);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.IngredientStock[0].quantity, 15); assert.equal(f.db.IngredientStock[1].quantity, 200);
  assert.equal(f.db.ProductStock[0].quantity, 2);
  assert.equal(f.db.StockMovement.filter((row) => row.movement_type === 'production_use').length, 2);
  assert.equal(f.db.ProductionBatchItem.find((row) => row.ingredient_id === 'layer').quantity_used, 10);
});

test('ready cakes transfer from central to Branch only on receipt, no second ingredient use', async () => {
  const f = fixture();
  assert.equal((await handler('production-run', f.client)(produce)).status, 200);
  const before = structuredClone(f.db.IngredientStock), call = handler('stock-transfer', f.client);
  const sent = await call({ action: 'create_transfer', source_location_id: 'central', destination_location_id: 'branch',
    items: [{ product_id: 'cake', quantity: 2 }] });
  assert.equal(sent.status, 200, JSON.stringify(sent)); assert.equal(f.db.ProductStock[0].quantity, 0);
  assert.equal(f.db.ProductStock.find((row) => row.location_id === 'branch'), undefined);
  f.actor('cashier');
  const received = await call({ action: 'receive_transfer_batch', batch_id: sent.data.batch_id });
  assert.equal(received.status, 200, JSON.stringify(received));
  assert.equal(f.db.ProductStock.find((row) => row.location_id === 'branch').quantity, 2);
  assert.deepEqual(f.db.IngredientStock, before);
  assert.equal((await call({ action: 'receive_transfer_batch', batch_id: sent.data.batch_id })).status, 409);
});

test('insufficient cream blocks assembly with every stock unchanged', async () => {
  const f = fixture(); f.db.IngredientStock[1].quantity = 399;
  const before = structuredClone(f.db);
  const result = await handler('production-run', f.client)(produce);
  assert.equal(result.status, 409); assert.deepEqual(f.db, before);
});

test('ledger failure restores layers, cream and finished stock', async () => {
  const f = fixture(), before = structuredClone(f.db);
  f.failMovement();
  const result = await handler('production-run', f.client)(produce);
  assert.equal(result.status, 500);
  assert.equal(f.db.IngredientStock[0].quantity, before.IngredientStock[0].quantity);
  assert.equal(f.db.IngredientStock[1].quantity, before.IngredientStock[1].quantity);
  assert.equal(f.db.ProductStock[0].quantity, 0);
  assert.equal(f.db.ProductionBatch.length, 0); assert.equal(f.db.StockMovement.length, 0);
});

test('cashier or worker assigned elsewhere cannot assemble central cakes', async () => {
  for (const actor of ['cashier', 'wrong-worker']) {
    const f = fixture(); f.actor(actor); const before = structuredClone(f.db);
    assert.equal((await handler('production-run', f.client)(produce)).status, 403);
    assert.deepEqual(f.db, before);
  }
});

test('supplier cannot receive fractional layers or receive them into Branch', async () => {
  const f = fixture(), call = handler('supplier-ledger', f.client), before = structuredClone(f.db);
  for (const [location_id, purchase_quantity] of [['central', 1.5], ['branch', 2]]) {
    const result = await call({ action: 'create_receipt', location_id, supplier_id: 'supplier',
      items: [{ ingredient_id: 'layer', purchase_quantity, unit_price: 100 }] });
    assert.equal(result.status, 400, JSON.stringify(result)); assert.deepEqual(f.db, before);
  }
});

test('actual layer creation UI creates only a definition, with no fake stock', async () => {
  const source = readFileSync('src/pages/Warehouse.jsx', 'utf8');
  const start = source.indexOf('function IngredientDialog(');
  const code = source.slice(start).split('const save = async () => {')[1].split('\n  return (')[0];
  const created = [];
  const context = vm.createContext({ name: 'Oq biskvit', asLayer: true, existingIngredients: [],
    baseUnit: 'piece', purchaseUnit: 'piece', category: 'food', setSaving() {}, onSaved() {},
    odinaAlert() {}, base44: { entities: { Ingredient: { create: async (row) => created.push(row) } } } });
  vm.runInContext('globalThis.save = async () => {' + code, context);
  await context.save();
  assert.equal(created.length, 1); assert.equal(created[0].is_cake_layer, true);
  assert.equal(created[0].base_unit, 'piece'); assert.equal(created[0].purchase_unit, 'piece');
  assert.equal(created[0].conversion_to_base, 1); assert.equal(created[0].quantity, undefined);
});

test('actual panel renders capacities, ready stock and shared-stock caution', () => {
  const source = readFileSync('src/components/warehouse/CakeLayersPanel.jsx', 'utf8').replace(/^import .*;$/gm, '')
    .replace('export default function CakeLayersPanel', 'function CakeLayersPanel');
  const Icon = () => React.createElement('svg');
  const context = vm.createContext({ React, Button: ({ children, ...props }) => React.createElement('button', props, children),
    AlertTriangle: Icon, ArrowRightLeft: Icon, BookOpen: Icon, CakeSlice: Icon, Layers3: Icon, PackagePlus: Icon, Plus: Icon,
    formatNum: (value) => String(value) });
  const code = ts.transpileModule(source + '\nglobalThis.Panel = CakeLayersPanel;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  vm.runInContext(code, context);
  const f = fixture();
  const html = renderToStaticMarkup(React.createElement(context.Panel, {
    layerRows: cakeLayerStockRows(f.db.Ingredient, f.db.IngredientStock, 'central'),
    capacityRows: [{ product: f.db.Product[0], capacity: capacity(f), prepared: 2 }],
    canManage: true, canAdjust: true, canProduce: true,
  }));
  assert.match(html, /Qavatlar va listlar/); assert.match(html, /Biskvit list/);
  assert.match(html, /Faqat qavatlardan/); assert.match(html, /Barcha masalliqlar bilan/);
  assert.match(html, /qo‘shib bo‘lmaydi/); assert.match(html, /Tayyor ombor qoldig‘i/);
});
