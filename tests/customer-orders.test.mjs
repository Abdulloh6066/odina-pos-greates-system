// Offline regression tests for the Buyurtmalar (customer-orders) module.
// No live data is read or changed — everything runs in an in-memory mock harness.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

let clock = '2026-09-09T10:00:00.000Z';
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
        pieces_per_sheet: 20, sheet_price: 400000, price: 20000, active: true, archived: false },
      { id: 'cake-piece', name: 'Kapykeyk', category_name: 'Pishiriqlar', production_unit: 'piece',
        price: 15000, active: true, archived: false },
      { id: 'inactive', name: 'Khm', category_name: 'X', production_unit: 'piece',
        price: 5000, active: false, archived: false },
    ],
    Shift: [{
      id: 'shift-a', user_id: 'u1', user_name: 'Test Cashier', shop_id: 'shop-a', shop_name: 'Filial A',
      status: 'open', opened_at: '2026-09-09T08:00:00.000Z', starting_cash: 0, expected_cash: 0,
      cash_sales: 0, uzcard_sales: 0, humo_sales: 0, online_sales: 0, bank_transfer_sales: 0,
      total_sales: 0, order_count: 0,
    }],
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
  const matchesValue = (a, e) => {
    if (e && typeof e === 'object' && !Array.isArray(e)) {
      if ('$gte' in e && !(a >= e.$gte)) return false;
      if ('$lte' in e && !(a <= e.$lte)) return false;
      return true;
    }
    return a === e;
  };
  const matches = (row, q) => Object.entries(q || {}).every(([k, v]) => matchesValue(row[k], v));
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
        }
        return { success: true, updated: rows.length };
      },
      delete: async (id) => { db[name] = db[name].filter((r) => r.id !== id); },
    };
    entity.bulkCreate = async (rows) => Promise.all(rows.map((r) => entity.create(r)));
    return [name, entity];
  }));
  const client = {
    asServiceRole: { entities },
    auth: { me: async () => clone(db.User[0]) },
  };
  return client;
}

function loadHandler(client) {
  const sharedSrc = readFileSync('base44/shared/shift-close-helpers.ts', 'utf8').replace(/export /g, '');
  const sharedCode = ts.transpileModule(sharedSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  let source = readFileSync('base44/functions/customer-orders/entry.ts', 'utf8')
    .replace(/import \{ createClientFromRequest \} from "npm:@base44\/sdk";/, 'const createClientFromRequest = () => client;')
    .replace(/import \{[\s\S]*?\} from "\.\.\/\.\.\/shared\/shift-close-helpers\.ts";/, '')
    .replace(/export default async function\(req[^{]*\{/, 'async function handler(req) {');
  source = sharedCode + '\n' + source;
  source += '\nglobalThis.testHandler = handler;';
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = vm.createContext({
    client, Response, crypto: webcrypto, console, structuredClone,
    Date: makeClock(), __setClock: (v) => { clock = v; },
  });
  vm.runInContext(code, context);
  return async (body) => {
    const res = await context.testHandler({ json: async () => body });
    return { status: res.status, data: await res.json() };
  };
}

const baseOrder = (overrides = {}) => ({
  action: 'create_order',
  idempotency_key: 'key-' + Math.random().toString(36).slice(2),
  order_type: 'toy_va_bazmlar',
  customer_name: 'Vali',
  customer_phone: '+998901234567',
  required_date: '2026-09-12',
  required_time: '18:00',
  fulfilment_type: 'pickup',
  shop_id: 'shop-a',
  items: [
    { product_id: 'cake-sheet', quantity: 2, customization_note: 'erka bolasi uchun' },
    { product_id: 'cake-piece', quantity: 10 },
  ],
  ...overrides,
});

test('multiple products in one order', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder());
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.data.items.length, 2);
  assert.equal(f.db.CustomerOrderItem.length, 2);
});

test('wedding sheet conversion is 40 pieces per sheet', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder());
  assert.equal(res.status, 200, JSON.stringify(res));
  const sheetItem = f.db.CustomerOrderItem.find((i) => i.product_id === 'cake-sheet');
  assert.equal(sheetItem.unit_snapshot, 'sheet');
  assert.equal(sheetItem.event_pieces_per_sheet_snapshot, 40);
  assert.equal(sheetItem.unit_price_snapshot, 400000);
  assert.equal(sheetItem.line_total, 800000);
});

test('non-wedding keeps the existing 20 pieces per sheet', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({ order_type: 'tugilgan_kun_va_boshqa' }));
  assert.equal(res.status, 200, JSON.stringify(res));
  const sheetItem = f.db.CustomerOrderItem.find((i) => i.product_id === 'cake-sheet');
  assert.equal(sheetItem.event_pieces_per_sheet_snapshot, 20);
});

test('product prices are reloaded from the database, not trusted from client', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({
    items: [{ product_id: 'cake-piece', quantity: 3, unit_price_snapshot: 1 }],
  }));
  assert.equal(res.status, 200, JSON.stringify(res));
  const pieceItem = f.db.CustomerOrderItem.find((i) => i.product_id === 'cake-piece');
  assert.equal(pieceItem.unit_price_snapshot, 15000);
  assert.equal(pieceItem.line_total, 45000);
});

test('inactive products are rejected', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({ items: [{ product_id: 'inactive', quantity: 1 }] }));
  assert.equal(res.status, 409);
  assert.ok(res.data.error);
});

test('price snapshots are immutable to later product edits', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder());
  assert.equal(res.status, 200, JSON.stringify(res));
  f.db.Product.find((p) => p.id === 'cake-piece').price = 999999;
  const pieceItem = f.db.CustomerOrderItem.find((i) => i.product_id === 'cake-piece');
  assert.equal(pieceItem.unit_price_snapshot, 15000);
  assert.equal(pieceItem.line_total, 150000);
});

test('cashier cannot submit another shop id — forced to assigned shop', async () => {
  const f = fixture('cashier', 'shop-a');
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({ shop_id: 'shop-b' }));
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(f.db.CustomerOrder[0].shop_id, 'shop-a');
});

test('admin can create orders for any shop', async () => {
  const f = fixture('admin');
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({ shop_id: 'shop-b' }));
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(f.db.CustomerOrder[0].shop_id, 'shop-b');
  assert.equal(f.db.CustomerOrder[0].creator_role, 'admin');
});

test('wedding delivery is free', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({ fulfilment_type: 'delivery', delivery_fee: 50000 }));
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(f.db.CustomerOrder[0].delivery_fee, 0);
});

test('advance cash payment is recorded on its actual payment date and hits the shift once', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({
    advance_payment: { method: 'cash', amount: 300000 },
  }));
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(f.db.CustomerOrder[0].paid_amount, 300000);
  assert.equal(f.db.CustomerOrder[0].payment_status, 'partial');
  assert.equal(f.db.OrderPayment.length, 1);
  const payment = f.db.OrderPayment[0];
  assert.equal(payment.payment_kind, 'advance');
  assert.equal(payment.payment_method, 'cash');
  assert.equal(payment.paid_at, '2026-09-09T10:00:00.000Z');
  assert.equal(payment.shift_id, 'shift-a');
  assert.equal(f.db.Shift[0].cash_sales, 300000);
  assert.equal(f.db.Shift[0].total_sales, 300000);
  assert.equal(f.db.Shift[0].expected_cash, 300000);
  assert.equal(f.db.Shift[0].order_count, 1);
});

test('remaining balance is recorded on a later day on a later shift, counted exactly once', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const created = await call(baseOrder({
    advance_payment: { method: 'cash', amount: 300000 },
  }));
  assert.equal(created.status, 200, JSON.stringify(created));
  const orderId = created.data.order.id;
  // later day + new open shift
  clock = '2026-09-11T15:00:00.000Z';
  f.db.Shift[0].status = 'closed';
  f.db.Shift.push({
    id: 'shift-b', user_id: 'u1', user_name: 'Test Cashier', shop_id: 'shop-a', shop_name: 'Filial A',
    status: 'open', opened_at: '2026-09-11T09:00:00.000Z', starting_cash: 0, expected_cash: 0,
    cash_sales: 0, uzcard_sales: 0, humo_sales: 0, online_sales: 0, bank_transfer_sales: 0,
    total_sales: 0, order_count: 0,
  });
  const balance = await call({
    action: 'record_payment', order_id: orderId, method: 'cash', amount: 650000,
    payment_kind: 'balance', idempotency_key: 'bal-' + Math.random().toString(36).slice(2),
  });
  assert.equal(balance.status, 200, JSON.stringify(balance));
  assert.equal(f.db.OrderPayment.length, 2);
  const balancePayment = f.db.OrderPayment[1];
  assert.equal(balancePayment.paid_at, '2026-09-11T15:00:00.000Z');
  assert.equal(balancePayment.shift_id, 'shift-b');
  assert.equal(f.db.Shift.find((s) => s.id === 'shift-b').cash_sales, 650000);
  assert.equal(f.db.Shift.find((s) => s.id === 'shift-a').cash_sales, 300000);
  assert.equal(f.db.CustomerOrder[0].paid_amount, 950000);
  assert.equal(f.db.CustomerOrder[0].remaining_balance, 0);
  assert.equal(f.db.CustomerOrder[0].payment_status, 'paid');
});

test('duplicate payment request is not posted twice (idempotency)', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const idem = 'dup-' + Math.random().toString(36).slice(2);
  const first = await call(baseOrder({ advance_payment: { method: 'cash', amount: 100000, idempotency_key: idem + '-adv' }, idempotency_key: idem }));
  assert.equal(first.status, 200);
  const second = await call(baseOrder({ advance_payment: { method: 'cash', amount: 100000, idempotency_key: idem + '-adv' }, idempotency_key: idem }));
  assert.equal(second.status, 200);
  assert.equal(second.data.already_exists, true);
  assert.equal(f.db.OrderPayment.length, 1);
  assert.equal(f.db.CustomerOrder.length, 1);
  assert.equal(f.db.Shift[0].cash_sales, 100000);
});

test('cash advance without an open shift is rejected', async () => {
  const f = fixture();
  f.db.Shift[0].status = 'closed';
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({ advance_payment: { method: 'cash', amount: 100000 } }));
  assert.equal(res.status, 409);
  assert.equal(f.db.CustomerOrder.length, 0);
  assert.equal(f.db.OrderPayment.length, 0);
});

test('payment above remaining balance is rejected', async () => {
  const f = fixture();
  const call = loadHandler(harness(f.db));
  const created = await call(baseOrder());
  assert.equal(created.status, 200);
  const res = await call({
    action: 'record_payment', order_id: created.data.order.id, method: 'uzcard',
    amount: 9999999, payment_kind: 'balance', idempotency_key: 'x' + Math.random(),
  });
  assert.equal(res.status, 400);
});

test('adjustment is admin-only and requires a reason', async () => {
  const f = fixture('cashier');
  const call = loadHandler(harness(f.db));
  const res = await call(baseOrder({ adjustment_amount: -50000, adjustment_reason: 'do‘stga chegirma' }));
  assert.equal(res.status, 403);
  const admin = fixture('admin');
  const adminCall = loadHandler(harness(admin.db));
  const okRes = await adminCall(baseOrder({ shop_id: 'shop-b', adjustment_amount: -50000, adjustment_reason: 'do‘stga chegirma' }));
  assert.equal(okRes.status, 200, JSON.stringify(okRes));
  assert.equal(admin.db.CustomerOrder[0].original_calculated_total, admin.db.CustomerOrder[0].subtotal);
  assert.equal(admin.db.CustomerOrder[0].adjustment_amount, -50000);
  assert.equal(admin.db.CustomerOrder[0].adjustment_reason, 'do‘stga chegirma');
});

console.log('Customer orders regression tests ready.');