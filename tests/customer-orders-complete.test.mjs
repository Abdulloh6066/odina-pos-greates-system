// Offline regression tests for Phase 2B: Buyurtmalar complete_order action.
// No live data is read or changed — everything runs in an in-memory mock harness.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { matches } from './helpers/memory-backend.mjs';

let clock = '2026-09-10T10:00:00.000Z';
function makeClock() {
  const RealDate = globalThis.Date;
  class MockDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return RealDate.parse(clock); }
  }
  return MockDate;
}

function fixture(role = 'cashier', shopId = 'shop-a') {
  const db = {
    User: [{
      id: 'u1', email: 'cashier@example.test', full_name: 'Test Cashier',
      role: role, shop_id: role === 'admin' ? '' : shopId, active: true,
    }],
    Shop: [
      { id: 'shop-a', name: 'Filial A', active: true, allows_pos: true, location_type: 'shop' },
      { id: 'shop-b', name: 'Filial B', active: true, allows_pos: true, location_type: 'shop' },
    ],
    Product: [
      { id: 'cake-sheet', name: 'Tort varaq', category_name: 'Tortlar', production_unit: 'sheet',
        pieces_per_sheet: 20, sheet_price: 400000, price: 20000, active: true, archived: false, track_stock: true },
      { id: 'cake-piece', name: 'Kapykeyk', category_name: 'Pishiriqlar', production_unit: 'piece',
        price: 15000, active: true, archived: false, track_stock: true },
      { id: 'untracked', name: 'Bezatish', category_name: 'X', production_unit: 'piece',
        price: 5000, active: true, archived: false, track_stock: false },
    ],
    Shift: [{
      id: 'shift-a', user_id: 'u1', user_name: 'Test Cashier', shop_id: 'shop-a', shop_name: 'Filial A',
      status: 'open', opened_at: '2026-09-10T08:00:00.000Z', starting_cash: 0, expected_cash: 0,
      cash_sales: 0, uzcard_sales: 0, humo_sales: 0, online_sales: 0, bank_transfer_sales: 0,
      total_sales: 0, order_count: 0,
    }],
    ProductStock: [
      { id: 'ps-sheet', location_id: 'shop-a', product_id: 'cake-sheet', product_name: 'Tort varaq', unit: 'piece', quantity: 100 },
      { id: 'ps-piece', location_id: 'shop-a', product_id: 'cake-piece', product_name: 'Kapykeyk', unit: 'piece', quantity: 50 },
    ],
    StockMovement: [],
    ProductionBatch: [],
    Settings: [{ id: 's1', shop_name: 'Odina', customer_order_last_number: 0, allow_negative_stock: true }],
    Customer: [],
    CustomerOrder: [],
    CustomerOrderItem: [],
    OrderPayment: [],
    ActionHistory: [],
  };
  return { db };
}

function harness(db) {
  let sequence = 0;
  const clone = (v) => v == null ? v : structuredClone(v);
  const entities = Object.fromEntries(Object.keys(db).map((name) => {
    const entity = {
      get: async (id) => clone(db[name].find((r) => r.id === id) || null),
      list: async () => clone(db[name]),
      filter: async (q) => clone(db[name].filter((r) => matches(r, q))),
      create: async (data) => {
        const row = { ...clone(data), id: name + '-' + ++sequence };
        db[name].push(row);
        return clone(row);
      },
      update: async (id, data) => {
        const row = db[name].find((r) => r.id === id);
        if (!row) throw new Error('Missing ' + id);
        Object.assign(row, clone(data));
        return clone(row);
      },
      updateMany: async (q, op) => {
        const rows = db[name].filter((r) => matches(r, q));
        for (const row of rows) {
          Object.assign(row, clone(op.$set || {}));
          for (const [k, v] of Object.entries(op.$inc || {})) row[k] = Number(row[k] || 0) + Number(v);
          for (const [k, v] of Object.entries(op.$push || {})) (row[k] ??= []).push(clone(v));
        }
        return { success: true, updated: rows.length };
      },
      delete: async (id) => { db[name] = db[name].filter((r) => r.id !== id); },
    };
    entity.bulkCreate = async (rows) => Promise.all(rows.map((r) => entity.create(r)));
    return [name, entity];
  }));
  return {
    asServiceRole: { entities },
    auth: { me: async () => clone(db.User[0]) },
  };
}

// Load the current production modules without contacting the SDK or live data.
function loadHandler(client) {
  const cache = new Map();
  const context = vm.createContext({
    URL, Response, crypto: webcrypto, TextEncoder, console, structuredClone, Date: makeClock(),
  });
  function load(path) {
    path = resolve(path);
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} }; cache.set(path, module);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, allowJs: true },
    }).outputText;
    const require = name => {
      if (name === 'npm:@base44/sdk') return { createClientFromRequest: () => client };
      if (name === 'node:crypto') return { webcrypto, randomUUID: () => webcrypto.randomUUID() };
      if (!name.startsWith('.')) throw new Error('Unexpected offline dependency ' + name);
      return load(resolve(dirname(path), name));
    };
    vm.runInContext('(function(require,module,exports){\n' + code + '\n})', context)(require,module,module.exports);
    return module.exports;
  }
  const handler = load('base44/functions/customer-orders/entry.ts').default;
  return async (body) => {
    const res = await handler({ json: async () => body });
    return { status: res.status, data: await res.json() };
  };
}

// Create a wedding order, then mark it ready/dispatched for completion tests.
async function setupReadyOrder(call, db, overrides = {}) {
  clock = '2026-09-10T10:00:00.000Z';
  const createRes = await call({
    action: 'create_order',
    idempotency_key: 'key-' + Math.random().toString(36).slice(2),
    order_type: 'toy_va_bazmlar',
    customer_name: 'Vali',
    customer_phone: '+998901234567',
    required_date: '2026-09-15',
    required_time: '18:00',
    fulfilment_type: 'pickup',
    shop_id: 'shop-a',
    items: [
      { product_id: 'cake-sheet', quantity: 2 },
      { product_id: 'cake-piece', quantity: 10 },
    ],
    ...overrides,
  });
  assert.equal(createRes.status, 200, JSON.stringify(createRes));
  const order = db.CustomerOrder[db.CustomerOrder.length - 1];
  order.order_status = overrides.order_status || 'tayyor';
  return order;
}

test('fully-paid order completes with stock deduction and no new payment', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'uzcard', amount: 950000 } });
  assert.equal(f.db.OrderPayment.length, 1); // advance only
  const res = await call({
    action: 'complete_order', order_id: order.id,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.data.order.order_status, 'yakunlandi');
  assert.equal(f.db.OrderPayment.length, 1); // no new payment
  // Stock: 2 sheets * 40 = 80 pieces deducted from 100 → 20; 10 pieces from 50 → 40
  assert.equal(f.db.ProductStock.find((s) => s.product_id === 'cake-sheet').quantity, 20);
  assert.equal(f.db.ProductStock.find((s) => s.product_id === 'cake-piece').quantity, 40);
  assert.equal(f.db.StockMovement.length, 2);
  assert.equal(f.db.StockMovement.every((m) => m.movement_type === 'sale'), true);
  assert.equal(f.db.StockMovement.every((m) => m.reference_type === 'customer_order'), true);
});

test('balance payment is recorded on actual payment day and hits the correct shift exactly once', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'cash', amount: 300000 } });
  // Advance counted on shift-a on day 1
  assert.equal(f.db.Shift[0].cash_sales, 300000);
  // Move to a later day with a new open shift
  clock = '2026-09-12T15:00:00.000Z';
  f.db.Shift[0].status = 'closed';
  f.db.Shift.push({
    id: 'shift-b', user_id: 'u1', user_name: 'Test Cashier', shop_id: 'shop-a', shop_name: 'Filial A',
    status: 'open', opened_at: '2026-09-12T09:00:00.000Z', starting_cash: 0, expected_cash: 0,
    cash_sales: 0, uzcard_sales: 0, humo_sales: 0, online_sales: 0, bank_transfer_sales: 0,
    total_sales: 0, order_count: 0,
  });
  const remaining = 950000 - 300000;
  const res = await call({
    action: 'complete_order', order_id: order.id, method: 'cash', amount: remaining,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.data.payment.payment_kind, 'balance');
  assert.equal(res.data.payment.paid_at, '2026-09-12T15:00:00.000Z');
  assert.equal(res.data.payment.shift_id, 'shift-b');
  // Shift-a keeps only the advance; shift-b gets only the balance
  assert.equal(f.db.Shift.find((s) => s.id === 'shift-a').cash_sales, 300000);
  assert.equal(f.db.Shift.find((s) => s.id === 'shift-b').cash_sales, remaining);
  assert.equal(f.db.Shift.find((s) => s.id === 'shift-b').total_sales, remaining);
  // Order fully paid
  assert.equal(res.data.order.paid_amount, 950000);
  assert.equal(res.data.order.remaining_balance, 0);
  assert.equal(res.data.order.payment_status, 'paid');
  assert.equal(res.data.order.order_status, 'yakunlandi');
});

test('exact remaining balance is required — partial amount rejected', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'cash', amount: 300000 } });
  const res = await call({
    action: 'complete_order', order_id: order.id, method: 'cash', amount: 100000,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 400);
  assert.equal(f.db.CustomerOrder[0].order_status, 'tayyor');
});

test('cash balance without open shift is rejected before any write', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db);
  f.db.Shift[0].status = 'closed';
  const remaining = 950000;
  const res = await call({
    action: 'complete_order', order_id: order.id, method: 'cash', amount: remaining,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 409);
  assert.equal(f.db.OrderPayment.length, 0);
  assert.equal(f.db.StockMovement.length, 0);
  assert.equal(f.db.CustomerOrder[0].order_status, 'tayyor');
});

test('insufficient stock with negative-stock disabled is rejected before any write', async () => {
  const f = fixture();
  f.db.Settings[0].allow_negative_stock = false;
  f.db.ProductStock.find((s) => s.product_id === 'cake-sheet').quantity = 10; // need 80
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db);
  const remaining = 950000;
  const res = await call({
    action: 'complete_order', order_id: order.id, method: 'uzcard', amount: remaining,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 409);
  assert.ok(res.data.shortages.length >= 1);
  assert.equal(f.db.StockMovement.length, 0);
  assert.equal(f.db.ProductStock.find((s) => s.product_id === 'cake-sheet').quantity, 10);
  assert.equal(f.db.CustomerOrder[0].order_status, 'tayyor');
});

test('insufficient stock with negative-stock allowed completes with negative balance', async () => {
  const f = fixture();
  f.db.ProductStock.find((s) => s.product_id === 'cake-sheet').quantity = 10;
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'cash', amount: 950000 } });
  const res = await call({
    action: 'complete_order', order_id: order.id,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(f.db.ProductStock.find((s) => s.product_id === 'cake-sheet').quantity, -70);
});

test('duplicate complete request does not duplicate payment, stock, or completion', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'uzcard', amount: 950000 } });
  const idem = 'dup-' + Math.random().toString(36).slice(2);
  const first = await call({ action: 'complete_order', order_id: order.id, idempotency_key: idem });
  assert.equal(first.status, 200);
  const second = await call({ action: 'complete_order', order_id: order.id, idempotency_key: idem });
  assert.equal(second.status, 200);
  assert.equal(second.data.already_completed, true);
  assert.equal(f.db.OrderPayment.length, 1);
  assert.equal(f.db.StockMovement.length, 2);
  assert.equal(f.db.CustomerOrder.length, 1);
});

test('cashier cannot complete another shop order', async () => {
  const f = fixture('admin');
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { shop_id: 'shop-b', advance_payment: { method: 'uzcard', amount: 950000 } });
  // Switch to cashier assigned to a different shop
  f.db.User[0] = { id: 'u2', email: 'cashier@example.test', full_name: 'Test Cashier', role: 'cashier', shop_id: 'shop-a', active: true };
  const res = await call({
    action: 'complete_order', order_id: order.id,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 403);
  assert.equal(f.db.CustomerOrder.find((o) => o.id === order.id).order_status, 'tayyor');
});

test('admin can complete any shop order', async () => {
  const f = fixture('admin');
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { shop_id: 'shop-b', advance_payment: { method: 'uzcard', amount: 950000 } });
  const res = await call({
    action: 'complete_order', order_id: order.id,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.data.order.order_status, 'yakunlandi');
});

test('production role cannot complete orders', async () => {
  const f = fixture('admin');
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'uzcard', amount: 950000 } });
  // Switch to production role
  f.db.User[0] = { id: 'u3', email: 'prod@example.test', full_name: 'Prod User', role: 'production', shop_id: 'shop-a', active: true };
  const res = await call({
    action: 'complete_order', order_id: order.id,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 403);
  assert.equal(f.db.CustomerOrder.find((o) => o.id === order.id).order_status, 'tayyor');
});

test('non-eligible status (qabul qilindi) is rejected', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { order_status: 'qabul_qilindi', advance_payment: { method: 'uzcard', amount: 950000 } });
  const res = await call({
    action: 'complete_order', order_id: order.id,
    idempotency_key: 'cmp-' + Math.random().toString(36).slice(2),
  });
  assert.equal(res.status, 409);
});

test('wedding order uses 40 pieces per sheet for stock deduction', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'uzcard', amount: 950000 } });
  await call({ action: 'complete_order', order_id: order.id, idempotency_key: 'cmp-w' });
  // 2 sheets * 40 = 80 pieces → 100 - 80 = 20
  assert.equal(f.db.ProductStock.find((s) => s.product_id === 'cake-sheet').quantity, 20);
});

test('non-wedding order uses 20 pieces per sheet for stock deduction', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, {
    order_type: 'tugilgan_kun_va_boshqa', advance_payment: { method: 'uzcard', amount: 950000 },
  });
  await call({ action: 'complete_order', order_id: order.id, idempotency_key: 'cmp-nw' });
  // 2 sheets * 20 = 40 pieces → 100 - 40 = 60
  assert.equal(f.db.ProductStock.find((s) => s.product_id === 'cake-sheet').quantity, 60);
  // 10 pieces → 50 - 10 = 40
  assert.equal(f.db.ProductStock.find((s) => s.product_id === 'cake-piece').quantity, 40);
});

test('untracked products are not deducted from stock', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  // Create order with untracked product only
  const createRes = await call({
    action: 'create_order',
    idempotency_key: 'key-' + Math.random().toString(36).slice(2),
    order_type: 'toy_va_bazmlar',
    customer_name: 'Vali', customer_phone: '+998901234567',
    required_date: '2026-09-15', required_time: '18:00',
    fulfilment_type: 'pickup', shop_id: 'shop-a',
    items: [{ product_id: 'untracked', quantity: 5 }],
    advance_payment: { method: 'uzcard', amount: 25000 },
  });
  assert.equal(createRes.status, 200, JSON.stringify(createRes));
  const order = f.db.CustomerOrder[f.db.CustomerOrder.length - 1];
  order.order_status = 'tayyor';
  const res = await call({ action: 'complete_order', order_id: order.id, idempotency_key: 'cmp-u' });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(f.db.StockMovement.length, 0); // no deduction for untracked
  assert.equal(res.data.order.order_status, 'yakunlandi');
});

test('already-completed order returns early without new writes', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'uzcard', amount: 950000 } });
  await call({ action: 'complete_order', order_id: order.id, idempotency_key: 'cmp-1' });
  const movementsBefore = f.db.StockMovement.length;
  const paymentsBefore = f.db.OrderPayment.length;
  const res = await call({ action: 'complete_order', order_id: order.id, idempotency_key: 'cmp-2' });
  assert.equal(res.status, 200);
  assert.equal(res.data.already_completed, true);
  assert.equal(f.db.StockMovement.length, movementsBefore);
  assert.equal(f.db.OrderPayment.length, paymentsBefore);
});

test('ActionHistory records completion with employee, shop, and timestamp', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const order = await setupReadyOrder(call, f.db, { advance_payment: { method: 'uzcard', amount: 950000 } });
  await call({ action: 'complete_order', order_id: order.id, idempotency_key: 'cmp-h' });
  const log = f.db.ActionHistory.find((a) => a.action === 'order_completed');
  assert.ok(log);
  assert.ok(log.details.includes(order.order_number));
  assert.ok(log.details.includes('Filial A'));
  assert.ok(log.details.includes('Test Cashier'));
  assert.ok(log.details.includes('2026-09-10'));
});

console.log('Customer orders Phase 2B (complete_order) regression tests ready.');