// Offline regression tests for automatic ingredient deduction when a customer order is marked ready.
// No live Base44 records are read or changed; all entities are in-memory mocks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { matches } from './helpers/memory-backend.mjs';

let clock = '2026-09-13T07:00:00.000Z';

function makeClock() {
  const RealDate = globalThis.Date;
  return class MockDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return RealDate.parse(clock);
    }
  };
}

function fixture(role = 'admin', assignedLocation = '') {
  const db = {
    User: [{
      id: 'u1',
      email: 'owner@example.test',
      full_name: role === 'production' ? 'Ishlab chiqaruvchi' : 'Odina Egasi',
      role,
      shop_id: assignedLocation,
      active: true,
    }],
    Shop: [
      { id: 'shop-a', name: 'Filial A', active: true, location_type: 'shop', allows_pos: true },
      { id: 'prod-main', name: 'Markaziy ombor', active: true, location_type: 'production', is_main: true },
    ],
    Product: [
      {
        id: 'cake-sheet',
        name: 'Tort list',
        source_type: 'central_produced',
        production_unit: 'sheet',
        pieces_per_sheet: 20,
        track_stock: true,
        active: true,
        archived: false,
      },
      {
        id: 'cake-piece',
        name: 'Kapykeyk',
        source_type: 'central_produced',
        production_unit: 'piece',
        track_stock: true,
        active: true,
        archived: false,
      },
      {
        id: 'resale',
        name: 'Sharbat',
        source_type: 'resale',
        production_unit: 'piece',
        track_stock: true,
        active: true,
        archived: false,
      },
    ],
    Recipe: [
      {
        id: 'recipe-sheet',
        product_id: 'cake-sheet',
        version: 2,
        output_quantity: 2,
        output_unit: 'sheet',
        active: true,
      },
      {
        id: 'recipe-piece',
        product_id: 'cake-piece',
        version: 3,
        output_quantity: 10,
        output_unit: 'piece',
        active: true,
      },
    ],
    RecipeItem: [
      {
        id: 'ri-sheet-flour',
        recipe_id: 'recipe-sheet',
        product_id: 'cake-sheet',
        ingredient_id: 'flour',
        ingredient_name_snapshot: 'Un',
        quantity: 1000,
        unit: 'g',
      },
      {
        id: 'ri-sheet-sugar',
        recipe_id: 'recipe-sheet',
        product_id: 'cake-sheet',
        ingredient_id: 'sugar',
        ingredient_name_snapshot: 'Shakar',
        quantity: 500,
        unit: 'g',
      },
      {
        id: 'ri-piece-flour',
        recipe_id: 'recipe-piece',
        product_id: 'cake-piece',
        ingredient_id: 'flour',
        ingredient_name_snapshot: 'Un',
        quantity: 500,
        unit: 'g',
      },
      {
        id: 'ri-piece-box',
        recipe_id: 'recipe-piece',
        product_id: 'cake-piece',
        ingredient_id: 'box',
        ingredient_name_snapshot: 'Quti',
        quantity: 10,
        unit: 'piece',
      },
    ],
    IngredientStock: [
      {
        id: 'is-flour',
        location_id: 'prod-main',
        location_name: 'Markaziy ombor',
        ingredient_id: 'flour',
        ingredient_name: 'Un',
        unit: 'g',
        quantity: 10000,
      },
      {
        id: 'is-sugar',
        location_id: 'prod-main',
        location_name: 'Markaziy ombor',
        ingredient_id: 'sugar',
        ingredient_name: 'Shakar',
        unit: 'g',
        quantity: 5000,
      },
      {
        id: 'is-box',
        location_id: 'prod-main',
        location_name: 'Markaziy ombor',
        ingredient_id: 'box',
        ingredient_name: 'Quti',
        unit: 'piece',
        quantity: 100,
      },
    ],
    ProductStock: [
      {
        id: 'ps-sheet',
        location_id: 'shop-a',
        product_id: 'cake-sheet',
        product_name: 'Tort list',
        unit: 'piece',
        quantity: 100,
      },
      {
        id: 'ps-piece',
        location_id: 'shop-a',
        product_id: 'cake-piece',
        product_name: 'Kapykeyk',
        unit: 'piece',
        quantity: 50,
      },
      {
        id: 'ps-resale',
        location_id: 'shop-a',
        product_id: 'resale',
        product_name: 'Sharbat',
        unit: 'piece',
        quantity: 20,
      },
    ],
    Customer: [],
    CustomerOrder: [{
      id: 'order-1',
      order_number: 'BO-TEST-001',
      order_type: 'toy_va_bazmlar',
      shop_id: 'shop-a',
      shop_name_snapshot: 'Filial A',
      total: 950000,
      paid_amount: 950000,
      remaining_balance: 0,
      payment_status: 'paid',
      order_status: 'qabul_qilindi',
      ready_inventory_state: 'pending',
    }],
    CustomerOrderItem: [
      {
        id: 'oi-sheet',
        order_id: 'order-1',
        product_id: 'cake-sheet',
        product_name_snapshot: 'Tort list',
        unit_snapshot: 'sheet',
        quantity: 2,
        event_pieces_per_sheet_snapshot: 40,
      },
      {
        id: 'oi-piece',
        order_id: 'order-1',
        product_id: 'cake-piece',
        product_name_snapshot: 'Kapykeyk',
        unit_snapshot: 'piece',
        quantity: 10,
      },
    ],
    ProductionBatch: [],
    ProductionBatchItem: [],
    StockMovement: [],
    SupplierReceipt: [],
    SupplierReceiptItem: [],
    Settings: [{ id: 'settings-1', allow_negative_stock: true }],
    Shift: [],
    OrderPayment: [],
    ActionHistory: [],
  };
  return { db };
}

function harness(db, options = {}) {
  let sequence = 0;
  const createCounts = {};
  const clone = (value) => value == null ? value : structuredClone(value);

  const entities = Object.fromEntries(Object.keys(db).map((name) => {
    const entity = {
      get: async (id) => clone(db[name].find((row) => row.id === id) || null),
      list: async () => clone(db[name]),
      filter: async (query) => clone(db[name].filter((row) => matches(row, query))),
      create: async (data) => {
        createCounts[name] = Number(createCounts[name] || 0) + 1;
        if (
          options.failCreateEntity === name
          && createCounts[name] === Number(options.failCreateAt || 1)
        ) {
          throw new Error(`${name} yaratish sinov xatosi`);
        }
        const row = { ...clone(data), id: `${name}-${++sequence}` };
        db[name].push(row);
        return clone(row);
      },
      update: async (id, data) => {
        const row = db[name].find((candidate) => candidate.id === id);
        if (!row) throw new Error(`Missing ${id}`);
        Object.assign(row, clone(data));
        return clone(row);
      },
      updateMany: async (query, operation) => {
        const rows = db[name].filter((row) => matches(row, query));
        for (const row of rows) {
          Object.assign(row, clone(operation.$set || {}));
          for (const [key, value] of Object.entries(operation.$inc || {})) {
            row[key] = Number(row[key] || 0) + Number(value);
          }
          for (const [key, value] of Object.entries(operation.$push || {})) (row[key] ??= []).push(clone(value));
          for (const key of Object.keys(operation.$unset || {})) {
            delete row[key];
          }
        }
        return { success: true, updated: rows.length };
      },
      delete: async (id) => {
        db[name] = db[name].filter((row) => row.id !== id);
      },
    };
    entity.bulkCreate = async (rows) => Promise.all(rows.map((row) => entity.create(row)));
    return [name, entity];
  }));

  return {
    asServiceRole: { entities },
    auth: { me: async () => clone(db.User[0]) },
  };
}

function loadHandler(client, { enableRecipeAccounting = true } = {}) {
  const cache = new Map();
  const context = vm.createContext({
    Response, crypto: webcrypto, TextEncoder, console, structuredClone, Date: makeClock(),
  });
  function loadModule(path) {
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    let source = readFileSync(path, 'utf8');
    if (path.replaceAll('\\', '/').endsWith('/customer-orders/entry.ts') && enableRecipeAccounting) {
      // Exercise the preserved recipe path separately from the production policy.
      source = source.replace('const ORDER_RECIPE_ACCOUNTING_ENABLED = false;',
        'const ORDER_RECIPE_ACCOUNTING_ENABLED = true;');
    }
    const code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const require = (specifier) => {
      if (specifier === 'npm:@base44/sdk') return { createClientFromRequest: () => client };
      if (!specifier.startsWith('.')) throw new Error('Unexpected offline dependency: ' + specifier);
      return loadModule(resolve(dirname(path), specifier));
    };
    vm.runInContext('(function(require, module, exports) {\n' + code + '\n})', context)(
      require, module, module.exports,
    );
    return module.exports;
  }
  const handler = loadModule(resolve('base44/functions/customer-orders/entry.ts')).default;
  return async (body) => {
    const response = await handler({ json: async () => body });
    return { status: response.status, data: await response.json() };
  };
}

const readyRequest = {
  action: 'update_production_status',
  order_id: 'order-1',
  step: 'ready',
};

test('Tayyor bo‘ldi deducts recipe ingredients and records order-reserved production', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const result = await call(readyRequest);

  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.order.order_status, 'tayyor');
  assert.equal(result.data.order.ready_inventory_state, 'completed');
  assert.equal(result.data.production_applied, true);
  assert.equal(result.data.production_batches.length, 2);

  assert.equal(f.db.IngredientStock.find((row) => row.ingredient_id === 'flour').quantity, 8500);
  assert.equal(f.db.IngredientStock.find((row) => row.ingredient_id === 'sugar').quantity, 4500);
  assert.equal(f.db.IngredientStock.find((row) => row.ingredient_id === 'box').quantity, 90);

  assert.equal(f.db.ProductionBatch.length, 2);
  assert.equal(f.db.ProductionBatch.every((row) => row.status === 'completed'), true);
  assert.equal(f.db.ProductionBatch.every((row) => row.order_id === 'order-1'), true);
  assert.equal(f.db.ProductionBatch.every((row) => row.output_disposition === 'customer_order'), true);
  assert.equal(f.db.ProductionBatch.find((row) => row.product_id === 'cake-sheet').reserved_pieces, 80);
  assert.equal(f.db.ProductionBatch.find((row) => row.product_id === 'cake-piece').reserved_pieces, 10);

  assert.equal(f.db.ProductionBatchItem.length, 4);
  assert.equal(f.db.StockMovement.length, 4);
  assert.equal(f.db.StockMovement.every((row) => row.movement_type === 'production_use'), true);
  assert.equal(f.db.StockMovement.every((row) => row.order_id === 'order-1'), true);
  assert.equal(f.db.ProductStock.find((row) => row.product_id === 'cake-sheet').quantity, 100);
  assert.ok(f.db.ActionHistory.some((row) => row.action === 'order_ready_production'));
});

test('repeating Tayyor bo‘ldi does not deduct ingredients twice', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));

  const first = await call(readyRequest);
  assert.equal(first.status, 200);
  const snapshot = f.db.IngredientStock.map((row) => row.quantity);
  const batchCount = f.db.ProductionBatch.length;
  const movementCount = f.db.StockMovement.length;

  const second = await call(readyRequest);
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.equal(second.data.already_ready, true);
  assert.deepEqual(f.db.IngredientStock.map((row) => row.quantity), snapshot);
  assert.equal(f.db.ProductionBatch.length, batchCount);
  assert.equal(f.db.StockMovement.length, movementCount);
});

test('insufficient ingredients block Ready before any write', async () => {
  const f = fixture();
  f.db.IngredientStock.find((row) => row.ingredient_id === 'flour').quantity = 1000;
  const call = loadHandler(harness(f.db));

  const result = await call(readyRequest);
  assert.equal(result.status, 409);
  assert.ok(result.data.error.includes('Masalliqlar yetarli emas'));
  assert.ok(Array.isArray(result.data.shortages));
  assert.equal(f.db.CustomerOrder[0].order_status, 'qabul_qilindi');
  assert.equal(f.db.CustomerOrder[0].ready_inventory_state, 'pending');
  assert.equal(f.db.IngredientStock.find((row) => row.ingredient_id === 'flour').quantity, 1000);
  assert.equal(f.db.ProductionBatch.length, 0);
  assert.equal(f.db.StockMovement.length, 0);
});

test('missing active recipe blocks Ready without changing stock', async () => {
  const f = fixture();
  f.db.Recipe = f.db.Recipe.filter((row) => row.product_id !== 'cake-piece');
  const before = f.db.IngredientStock.map((row) => row.quantity);
  const call = loadHandler(harness(f.db));

  const result = await call(readyRequest);
  assert.equal(result.status, 409);
  assert.ok(result.data.error.includes('faol tex-karta'));
  assert.deepEqual(f.db.IngredientStock.map((row) => row.quantity), before);
  assert.equal(f.db.CustomerOrder[0].order_status, 'qabul_qilindi');
  assert.equal(f.db.ProductionBatch.length, 0);
});

test('write failure rolls ingredient stock and history back, leaving a safe retry', async () => {
  const f = fixture();
  const before = f.db.IngredientStock.map((row) => row.quantity);
  const call = loadHandler(harness(f.db, {
    failCreateEntity: 'StockMovement',
    failCreateAt: 2,
  }));

  const result = await call(readyRequest);
  assert.equal(result.status, 500);
  assert.deepEqual(f.db.IngredientStock.map((row) => row.quantity), before);
  assert.equal(f.db.CustomerOrder[0].order_status, 'qabul_qilindi');
  assert.equal(f.db.CustomerOrder[0].ready_inventory_state, 'pending');
  assert.equal(f.db.ProductionBatch.length, 0);
  assert.equal(f.db.ProductionBatchItem.length, 0);
  assert.equal(f.db.StockMovement.length, 0);
});

test('production employee must be assigned to the active production warehouse', async () => {
  const f = fixture('production', 'shop-a');
  const before = f.db.IngredientStock.map((row) => row.quantity);
  const call = loadHandler(harness(f.db));

  const result = await call(readyRequest);
  assert.equal(result.status, 403);
  assert.deepEqual(f.db.IngredientStock.map((row) => row.quantity), before);
  assert.equal(f.db.CustomerOrder[0].order_status, 'qabul_qilindi');
});

test('completing a ready order does not deduct its reserved products a second time', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const ready = await call(readyRequest);
  assert.equal(ready.status, 200, JSON.stringify(ready));

  f.db.User[0] = {
    id: 'cashier-1',
    email: 'cashier@example.test',
    full_name: 'Kassir',
    role: 'cashier',
    shop_id: 'shop-a',
    active: true,
  };
  const beforeProductStock = f.db.ProductStock.map((row) => row.quantity);
  const completed = await call({
    action: 'complete_order',
    order_id: 'order-1',
    idempotency_key: 'complete-1',
  });

  assert.equal(completed.status, 200, JSON.stringify(completed));
  assert.equal(completed.data.order.order_status, 'yakunlandi');
  assert.deepEqual(f.db.ProductStock.map((row) => row.quantity), beforeProductStock);
  assert.equal(f.db.StockMovement.some((row) => row.movement_type === 'sale'), false);
});

test('resale items remain regular shop stock while central products stay reserved', async () => {
  const f = fixture();
  f.db.CustomerOrderItem.push({
    id: 'oi-resale',
    order_id: 'order-1',
    product_id: 'resale',
    product_name_snapshot: 'Sharbat',
    unit_snapshot: 'piece',
    quantity: 3,
  });
  const call = loadHandler(harness(f.db));
  const ready = await call(readyRequest);
  assert.equal(ready.status, 200, JSON.stringify(ready));
  assert.equal(f.db.ProductionBatch.length, 2);

  f.db.User[0] = {
    id: 'cashier-1',
    email: 'cashier@example.test',
    full_name: 'Kassir',
    role: 'cashier',
    shop_id: 'shop-a',
    active: true,
  };
  const completed = await call({
    action: 'complete_order',
    order_id: 'order-1',
    idempotency_key: 'complete-mixed',
  });

  assert.equal(completed.status, 200, JSON.stringify(completed));
  assert.equal(f.db.ProductStock.find((row) => row.product_id === 'cake-sheet').quantity, 100);
  assert.equal(f.db.ProductStock.find((row) => row.product_id === 'cake-piece').quantity, 50);
  assert.equal(f.db.ProductStock.find((row) => row.product_id === 'resale').quantity, 17);
  const saleMovements = f.db.StockMovement.filter((row) => row.movement_type === 'sale');
  assert.equal(saleMovements.length, 1);
  assert.equal(saleMovements[0].item_id, 'resale');
});

test('legacy active orders without the new inventory state remain compatible', async () => {
  const f = fixture();
  delete f.db.CustomerOrder[0].ready_inventory_state;
  const call = loadHandler(harness(f.db));

  const result = await call(readyRequest);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.CustomerOrder[0].order_status, 'tayyor');
  assert.equal(f.db.CustomerOrder[0].ready_inventory_state, 'completed');
  assert.equal(f.db.IngredientStock.find((row) => row.ingredient_id === 'flour').quantity, 8500);
});

test('simultaneous Ready requests cannot double-deduct stock', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));

  const results = await Promise.all([call(readyRequest), call(readyRequest)]);
  assert.equal(results.some((result) => result.status === 200), true);
  assert.equal(f.db.IngredientStock.find((row) => row.ingredient_id === 'flour').quantity, 8500);
  assert.equal(f.db.IngredientStock.find((row) => row.ingredient_id === 'sugar').quantity, 4500);
  assert.equal(f.db.IngredientStock.find((row) => row.ingredient_id === 'box').quantity, 90);
  assert.equal(f.db.ProductionBatch.length, 2);
  assert.equal(f.db.StockMovement.length, 4);
});

test('correctly assigned production worker can mark ready and shipped but cannot accept payments', async () => {
  const f = fixture('production', 'prod-main');
  const call = loadHandler(harness(f.db));
  const ready = await call(readyRequest);
  assert.equal(ready.status, 200, JSON.stringify(ready));
  assert.equal(ready.data.order.order_status, 'tayyor');
  assert.equal(ready.data.production_applied, true);
  const shipped = await call({ ...readyRequest, step: 'shipped' });
  assert.equal(shipped.status, 200, JSON.stringify(shipped));
  assert.equal(shipped.data.order.order_status, 'yuborildi_olib_ketildi');
  for (const action of ['create_order', 'record_payment', 'complete_order']) {
    assert.equal((await call({ action, order_id: 'order-1', amount: 1, method: 'cash' })).status, 403);
  }
  assert.equal(f.db.OrderPayment.length, 0);
});

test('disabled production worker is rejected before any order status change', async () => {
  const f = fixture('production', 'prod-main'); f.db.User[0].active = false;
  const result = await loadHandler(harness(f.db))(readyRequest);
  assert.equal(result.status, 403);
  assert.equal(f.db.CustomerOrder[0].order_status, 'qabul_qilindi');
});


test('paused recipes allow Ready with no recipe or ingredient stock and keep all stock unchanged', async () => {
  const f = fixture();
  f.db.Recipe = []; f.db.RecipeItem = []; f.db.IngredientStock = [];
  const before = structuredClone(f.db.ProductStock);
  const call = loadHandler(harness(f.db), { enableRecipeAccounting: false });
  const runtime = await call({ action: 'runtime_status' });
  assert.equal(runtime.data.order_recipe_accounting_enabled, false);
  // A caller cannot opt back into recipe accounting.
  const result = await call({ ...readyRequest, applyIngredients: true });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.order.order_status, 'tayyor');
  assert.equal(result.data.production_applied, false);
  assert.equal(f.db.CustomerOrder[0].ready_inventory_state, 'pending');
  assert.match(f.db.CustomerOrder[0].ready_at, /\+05:00$/);
  assert.deepEqual(f.db.ProductStock, before);
  assert.equal(f.db.ProductionBatch.length, 0);
  assert.equal(f.db.ProductionBatchItem.length, 0);
  assert.equal(f.db.StockMovement.length, 0);
  const stamp = f.db.CustomerOrder[0].ready_at;
  assert.equal((await call(readyRequest)).data.already_ready, true);
  assert.equal(f.db.CustomerOrder[0].ready_at, stamp);
  assert.equal(f.db.ActionHistory.length, 1);
  assert.equal((await call({ ...readyRequest, step: 'shipped' })).status, 200);
});

test('paused recipes do not consume ingredients even when a recipe exists', async () => {
  const f = fixture(); const before = structuredClone(f.db.IngredientStock);
  const result = await loadHandler(harness(f.db), { enableRecipeAccounting: false })(readyRequest);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.deepEqual(f.db.IngredientStock, before);
  assert.equal(result.data.production_applied, false);
  assert.equal(f.db.StockMovement.length, 0);
});

test('paused recipe mode supports legacy drafts and prevents simultaneous status writes', async () => {
  const f = fixture(); delete f.db.CustomerOrder[0].ready_inventory_state;
  const call = loadHandler(harness(f.db), { enableRecipeAccounting: false });
  const results = await Promise.all([call(readyRequest), call(readyRequest)]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 1);
  assert.equal(f.db.CustomerOrder[0].order_status, 'tayyor');
  assert.equal(f.db.ActionHistory.length, 1);
  assert.equal(f.db.StockMovement.length, 0);
});

test('paused recipes preserve production permissions and reject cancelled or processing orders', async () => {
  for (const [role, shop, expected] of [
    ['production', 'prod-main', 200], ['production', 'shop-a', 403], ['cashier', 'shop-a', 403],
  ]) {
    const f = fixture(role, shop); f.db.Recipe = [];
    const call = loadHandler(harness(f.db), { enableRecipeAccounting: false });
    assert.equal((await call(readyRequest)).status, expected);
    if (role === 'production') {
      assert.equal((await call({ action: 'record_payment', order_id: 'order-1', amount: 1 })).status, 403);
    }
  }
  for (const blocked of [
    { order_status: 'bekor_qilindi' }, { ready_inventory_state: 'processing' },
    { ready_inventory_state: 'completed' },
  ]) {
    const f = fixture(); Object.assign(f.db.CustomerOrder[0], blocked);
    const before = structuredClone(f.db);
    const result = await loadHandler(harness(f.db), { enableRecipeAccounting: false })(readyRequest);
    assert.equal(result.status, 409);
    assert.deepEqual(f.db, before);
  }
});

test('normal completion still deducts finished goods while paused recipes leave ingredients alone', async () => {
  const f = fixture(); const before = structuredClone(f.db.IngredientStock);
  const call = loadHandler(harness(f.db), { enableRecipeAccounting: false });
  assert.equal((await call(readyRequest)).status, 200);
  const result = await call({ action: 'complete_order', order_id: 'order-1', idempotency_key: 'paused-complete' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.order.order_status, 'yakunlandi');
  assert.deepEqual(f.db.IngredientStock, before);
  assert.equal(f.db.ProductStock.find(r => r.product_id === 'cake-sheet').quantity, 20);
  assert.equal(f.db.ProductStock.find(r => r.product_id === 'cake-piece').quantity, 40);
  assert.equal(f.db.StockMovement.filter(r => r.movement_type === 'sale').length, 2);
});

console.log('Customer order ready-production offline regression tests ready.');

test('warehouse preparing-ready-shipped changes one order and preserves both shops payment ownership', async () => {
  for (const shopId of ['shop-a','shop-central']) {
    const f = fixture('production', 'prod-main');
    f.db.CustomerOrder[0].shop_id = shopId;
    f.db.CustomerOrder[0].shop_name_snapshot = shopId;
    f.db.OrderPayment.push({id:'original-payment',order_id:'order-1',shop_id:shopId,amount:950000});
    const before = structuredClone(f.db);
    const call = loadHandler(harness(f.db), {enableRecipeAccounting:false});
    const first = await call({...readyRequest, step:'preparing'});
    assert.equal(first.status,200,JSON.stringify(first));
    assert.equal(first.data.order.order_status,'tayyorlanmoqda');
    assert.equal((await call({...readyRequest,step:'preparing'})).data.already_started,true);
    assert.equal((await call(readyRequest)).status,200);
    assert.equal((await call({...readyRequest,step:'shipped'})).status,200);
    assert.equal(f.db.CustomerOrder.length,1);
    const final = f.db.CustomerOrder[0];
    for (const key of ['id','shop_id','shop_name_snapshot','total','paid_amount','remaining_balance','payment_status']) {
      assert.equal(final[key],before.CustomerOrder[0][key],key);
    }
    for (const entity of ['CustomerOrderItem','OrderPayment','ProductStock','IngredientStock','StockMovement','ProductionBatch']) {
      assert.deepEqual(f.db[entity],before[entity],entity);
    }
  }
});

test('starting warehouse preparation enforces assignment, original shop scope and status', async () => {
  for (const [role, assigned, expected] of [
    ['production','prod-main',200], ['production','shop-a',403],
    ['cashier','shop-a',403], ['manager','shop-other',403],
  ]) {
    const f=fixture(role,assigned);
    f.db.Shop.push({id:'shop-other',active:true,location_type:'shop'});
    const result=await loadHandler(harness(f.db),{enableRecipeAccounting:false})({...readyRequest,step:'preparing'});
    assert.equal(result.status,expected,JSON.stringify({role,result}));
    if(expected!==200) assert.equal(f.db.CustomerOrder[0].order_status,'qabul_qilindi');
  }
  for (const status of ['tayyor','yuborildi_olib_ketildi','yakunlandi','bekor_qilindi']) {
    const f=fixture('production','prod-main'); f.db.CustomerOrder[0].order_status=status;
    const result=await loadHandler(harness(f.db),{enableRecipeAccounting:false})({...readyRequest,step:'preparing'});
    assert.equal(result.status,409);
    assert.equal(f.db.CustomerOrder[0].order_status,status);
  }
});

test('concurrent start requests create one preparation transition', async () => {
  const f=fixture('production','prod-main');
  const call=loadHandler(harness(f.db),{enableRecipeAccounting:false});
  const results=await Promise.all([call({...readyRequest,step:'preparing'}),call({...readyRequest,step:'preparing'})]);
  assert.ok(results.some(r=>r.status===200));
  assert.ok(results.every(r=>[200,409].includes(r.status)));
  assert.equal(f.db.ActionHistory.filter(row=>row.action==='production_status_change').length,1);
});
