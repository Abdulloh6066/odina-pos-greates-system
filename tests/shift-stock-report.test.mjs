// Offline regression tests for shift-close stock reports. No live records are read or changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

function fixture() {
  const db = {
    User: [{
      id: 'cashier',
      email: 'cashier@example.test',
      full_name: 'Test cashier',
      role: 'cashier',
      shop_id: 'shop',
      active: true,
    }],
    Shift: [{
      id: 'shift',
      user_id: 'cashier',
      user_name: 'Test cashier',
      shop_id: 'shop',
      shop_name: 'Test shop',
      status: 'open',
      opened_at: '2026-09-01T08:00:00.000Z',
      starting_cash: 0,
      expected_cash: 0,
      cash_sales: 0,
      uzcard_sales: 0,
      humo_sales: 0,
      online_sales: 0,
      bank_transfer_sales: 0,
      total_sales: 0,
      order_count: 0,
      cash_removed: 0,
      refunds_total: 0,
    }],
    Product: [
      { id: 'cake', name: 'Cake', image_url: 'cake.png', active: true, track_stock: true },
      { id: 'cookie', name: 'Cookie', active: true, track_stock: true },
      { id: 'service', name: 'Delivery', active: true, track_stock: false },
    ],
    ProductStock: [
      { id: 'cake-stock', location_id: 'shop', product_id: 'cake', product_name: 'Cake', unit: 'piece', quantity: 7 },
      { id: 'cookie-stock', location_id: 'shop', product_id: 'cookie', product_name: 'Cookie', unit: 'piece', quantity: 0 },
      { id: 'service-stock', location_id: 'shop', product_id: 'service', product_name: 'Delivery', unit: 'piece', quantity: 99 },
    ],
    StockMovement: [
      { id: 'old', location_id: 'shop', item_kind: 'product', item_id: 'cake', item_name: 'Cake', unit: 'piece',
        movement_type: 'opening', quantity_change: 10, balance_before: 0, balance_after: 10, created_at: '2026-08-31T08:00:00.000Z' },
      { id: 'receive', location_id: 'shop', item_kind: 'product', item_id: 'cake', item_name: 'Cake', unit: 'piece',
        movement_type: 'transfer_in', quantity_change: 5, balance_before: 10, balance_after: 15, created_at: '2026-09-08T09:00:00.000Z' },
      { id: 'sale', location_id: 'shop', item_kind: 'product', item_id: 'cake', item_name: 'Cake', unit: 'piece',
        movement_type: 'sale', quantity_change: -6, balance_before: 15, balance_after: 9, created_at: '2026-09-08T10:00:00.000Z' },
      { id: 'waste', location_id: 'shop', item_kind: 'product', item_id: 'cake', item_name: 'Cake', unit: 'piece',
        movement_type: 'waste', quantity_change: -2, balance_before: 9, balance_after: 7, created_at: '2026-09-08T11:00:00.000Z' },
      { id: 'refund', location_id: 'shop', item_kind: 'product', item_id: 'cake', item_name: 'Cake', unit: 'piece',
        movement_type: 'refund', quantity_change: 1, balance_before: 7, balance_after: 8, created_at: '2026-09-08T11:30:00.000Z' },
      { id: 'adjustment', location_id: 'shop', item_kind: 'product', item_id: 'cake', item_name: 'Cake', unit: 'piece',
        movement_type: 'adjustment', quantity_change: -1, balance_before: 8, balance_after: 7, created_at: '2026-09-08T12:00:00.000Z' },
    ],
    ShiftProductSnapshot: [],
    BudgetBalance: [],
    BudgetTransaction: [],
    ActionHistory: [],
  };

  let sequence = 0;
  const clone = (value) => value == null ? value : structuredClone(value);
  const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$gte' in expected && !(actual >= expected.$gte)) return false;
      if ('$lte' in expected && !(actual <= expected.$lte)) return false;
      return true;
    }
    return actual === expected;
  };
  const matches = (row, query) => Object.entries(query || {}).every(
    ([key, value]) => matchesValue(row[key], value),
  );

  const entities = Object.fromEntries(Object.keys(db).map((name) => {
    const entity = {
      get: async (id) => clone(db[name].find((row) => row.id === id) || null),
      list: async () => clone(db[name]),
      filter: async (query) => clone(db[name].filter((row) => matches(row, query))),
      create: async (data) => {
        const row = { ...clone(data), id: name + '-' + ++sequence };
        db[name].push(row);
        return clone(row);
      },
      update: async (id, data) => {
        const row = db[name].find((item) => item.id === id);
        if (!row) throw new Error('Missing row ' + id);
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

  const client = {
    asServiceRole: { entities },
    auth: { me: async () => clone(db.User[0]) },
  };
  return { db, client };
}

function loadHandler(client) {
  let source = readFileSync('base44/functions/complete-sale/entry.ts', 'utf8')
    .replace(/import \{ createClientFromRequest \} from "npm:@base44\/sdk";/, 'const createClientFromRequest = () => client;')
    .replace('export default async function(req)', 'async function handler(req)');
  source += '\nglobalThis.testHandler = handler;';
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = vm.createContext({ client, Response, crypto: webcrypto, console, structuredClone });
  vm.runInContext(code, context);
  return async (body) => {
    const response = await context.testHandler({ json: async () => body });
    return { status: response.status, data: await response.json() };
  };
}

const closeBody = (stockCounts) => ({
  action: 'close_shift',
  shift_id: 'shift',
  actual_cash: 0,
  budget_cash_submitted: 0,
  cash_left_for_next_shift: 0,
  stock_counts: stockCounts,
});

test('preview separates opening, received, sold, waste, refund and other changes', async () => {
  const f = fixture();
  const call = loadHandler(f.client);
  const response = await call({ action: 'get_shift_stock_report', shift_id: 'shift' });

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.stock_report.rows.length, 2);
  const cake = response.data.stock_report.rows.find((row) => row.product_id === 'cake');
  assert.deepEqual(
    {
      opening: cake.opening_quantity,
      received: cake.received_quantity,
      sold: cake.sold_quantity,
      waste: cake.waste_quantity,
      returned: cake.returned_quantity,
      other: cake.other_change_quantity,
      expected: cake.expected_quantity,
    },
    { opening: 10, received: 5, sold: 6, waste: 2, returned: 1, other: -1, expected: 7 },
  );
  assert.equal(response.data.stock_report.rows.some((row) => row.product_id === 'service'), false);
});

test('every displayed product must have a counted whole-number quantity', async () => {
  for (const counts of [
    [{ product_id: 'cake', counted_quantity: 7 }],
    [{ product_id: 'cake', counted_quantity: '' }, { product_id: 'cookie', counted_quantity: 0 }],
    [{ product_id: 'cake', counted_quantity: 6.5 }, { product_id: 'cookie', counted_quantity: 0 }],
  ]) {
    const f = fixture();
    const response = await loadHandler(f.client)(closeBody(counts));
    assert.ok(response.status >= 400, JSON.stringify(response));
    assert.equal(f.db.Shift[0].status, 'open');
    assert.equal(f.db.ShiftProductSnapshot.length, 0);
    assert.equal(f.db.BudgetTransaction.length, 0);
  }
});

test('close stores immutable product snapshots and discrepancy summary', async () => {
  const f = fixture();
  const call = loadHandler(f.client);
  const response = await call(closeBody([
    { product_id: 'cake', counted_quantity: 6 },
    { product_id: 'cookie', counted_quantity: 0 },
  ]));

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(f.db.Shift[0].status, 'closed');
  assert.equal(f.db.Shift[0].stock_count_completed, true);
  assert.equal(f.db.Shift[0].stock_snapshot_count, 2);
  assert.equal(f.db.Shift[0].stock_difference_product_count, 1);
  assert.equal(f.db.Shift[0].stock_difference_quantity, 1);

  const cakeSnapshot = f.db.ShiftProductSnapshot.find((row) => row.product_id === 'cake');
  assert.equal(cakeSnapshot.expected_quantity, 7);
  assert.equal(cakeSnapshot.counted_quantity, 6);
  assert.equal(cakeSnapshot.difference, -1);
  f.db.ProductStock.find((row) => row.product_id === 'cake').quantity = 999;
  assert.equal(cakeSnapshot.expected_quantity, 7);
});

console.log('3 shift stock report regression tests passed. No live data was used.');
