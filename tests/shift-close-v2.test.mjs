// Offline regression tests for the dedicated shift-close-v2 backend.
// Proves a zero-sale shift with one tracked ProductStock (qty 6) saves exactly
// one immutable ShiftProductSnapshot with closing quantity 6. No live records used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

function zeroSaleFixture() {
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
      shop_name: 'Odina Branch',
      status: 'open',
      opened_at: '2026-09-08T19:00:00.000Z',
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
      { id: 'meselka123', name: 'MESELKA123', image_url: 'meselka.png', active: true, track_stock: true },
    ],
    ProductStock: [
      { id: 'meselka-stock', location_id: 'shop', product_id: 'meselka123', product_name: 'MESELKA123', unit: 'piece', quantity: 6 },
    ],
    StockMovement: [],
    ShiftProductSnapshot: [],
    BudgetBalance: [],
    BudgetTransaction: [],
    ActionHistory: [],
  };
  return { db };
}

function sharedDbHarness(db) {
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
  return client;
}

function loadHandler(client, options = {}) {
  const sharedSrc = readFileSync('base44/shared/shift-close-helpers.ts', 'utf8').replace(/export /g, '');
  const sharedCode = ts.transpileModule(sharedSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;

  let source = readFileSync('base44/functions/shift-close-v2/entry.ts', 'utf8')
    .replace(/import \{ createClientFromRequest \} from "npm:@base44\/sdk";/, 'const createClientFromRequest = () => client;')
    .replace(/import \{[\s\S]*?\} from "\.\.\/\.\.\/shared\/shift-close-helpers\.ts";/, '')
    .replace('export default async function(req)', 'async function handler(req)');
  source = sharedCode + '\n' + source;
  source += '\nglobalThis.testHandler = handler;';
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = vm.createContext({
    client,
    Response,
    crypto: webcrypto,
    console,
    structuredClone,
    AbortSignal,
    Deno: { env: { get: (key) => key === 'TELEGRAM_BOT_TOKEN' ? (options.telegramToken || '') : '' } },
    fetch: options.fetchImpl || (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
  });
  vm.runInContext(code, context);
  return async (body) => {
    const response = await context.testHandler({ json: async () => body });
    return { status: response.status, data: await response.json() };
  };
}

const closeBody = () => ({
  action: 'close_shift',
  shift_id: 'shift',
  actual_cash: 0,
  budget_cash_submitted: 0,
  cash_left_for_next_shift: 0,
});

test('zero-sale shift saves exactly one snapshot with closing quantity 6', async () => {
  const f = zeroSaleFixture();
  const client = sharedDbHarness(f.db);
  const call = loadHandler(client);
  const response = await call(closeBody());

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.runtime_version, 'shift-close-v2-2026-09-15-telegram');
  assert.equal(f.db.Shift[0].status, 'closed');
  assert.equal(f.db.Shift[0].stock_count_completed, true);
  assert.equal(f.db.Shift[0].stock_snapshot_count, 1);
  assert.equal(f.db.ShiftProductSnapshot.length, 1);

  const snapshot = f.db.ShiftProductSnapshot[0];
  assert.equal(snapshot.product_id, 'meselka123');
  assert.equal(snapshot.product_name_snapshot, 'MESELKA123');
  assert.equal(snapshot.unit, 'piece');
  assert.equal(snapshot.expected_quantity, 6);
  assert.equal(snapshot.counted_quantity, 6);
  assert.equal(snapshot.opening_quantity, 6);
  assert.equal(snapshot.received_quantity, 0);
  assert.equal(snapshot.sold_quantity, 0);
  assert.equal(snapshot.waste_quantity, 0);
  assert.equal(snapshot.returned_quantity, 0);
  assert.equal(snapshot.other_change_quantity, 0);
  assert.equal(snapshot.difference, 0);
  assert.equal(snapshot.counted_by_id, '');
  assert.ok(snapshot.closed_at);
});

test('runtime_status reports the new backend version', async () => {
  const f = zeroSaleFixture();
  const client = sharedDbHarness(f.db);
  const call = loadHandler(client);
  const response = await call({ action: 'runtime_status' });

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.runtime_version, 'shift-close-v2-2026-09-15-telegram');
});

test('snapshot is immutable — later stock change does not alter the saved row', async () => {
  const f = zeroSaleFixture();
  const client = sharedDbHarness(f.db);
  const call = loadHandler(client);
  const response = await call(closeBody());

  assert.equal(response.status, 200, JSON.stringify(response));
  f.db.ProductStock[0].quantity = 999;
  assert.equal(f.db.ShiftProductSnapshot[0].expected_quantity, 6);
});

test('shift_closed ActionHistory records the new backend marker', async () => {
  const f = zeroSaleFixture();
  const client = sharedDbHarness(f.db);
  const call = loadHandler(client);
  const response = await call(closeBody());

  assert.equal(response.status, 200, JSON.stringify(response));
  const closed = f.db.ActionHistory.find((row) => row.action === 'shift_closed');
  assert.ok(closed, 'shift_closed audit row was created');
  assert.ok(closed.details.includes('backend shift-close-v2-2026-09-15-telegram'), closed.details);
});

test('successful shift close sends a TEST-labelled Telegram summary', async () => {
  const f = zeroSaleFixture();
  const client = sharedDbHarness(f.db);
  const sent = [];
  const call = loadHandler(client, {
    telegramToken: 'offline-test-token',
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const response = await call({ ...closeBody(), test_mode: true });

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.telegram_notification.sent, true);
  assert.equal(response.data.telegram_notification.message_id, 777);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, '-5570444945');
  assert.match(sent[0].body.text, /🧪 TEST · Smena yopildi/);
  assert.match(sent[0].body.text, /Odina Branch/);
  assert.match(sent[0].body.text, /Test cashier/);
  assert.ok(f.db.ActionHistory.some((row) => row.action === 'shift_telegram_sent'));
});

test('Telegram failure never rolls back an otherwise successful shift close', async () => {
  const f = zeroSaleFixture();
  const client = sharedDbHarness(f.db);
  const call = loadHandler(client, {
    telegramToken: 'offline-test-token',
    fetchImpl: async () => { throw new Error('offline network failure'); },
  });
  const response = await call({ ...closeBody(), test_mode: true });

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(f.db.Shift[0].status, 'closed');
  assert.equal(response.data.telegram_notification.sent, false);
  assert.equal(response.data.telegram_notification.reason, 'network_error');
  assert.ok(f.db.ActionHistory.some((row) => row.action === 'shift_telegram_failed'));
});

console.log('6 shift-close-v2 regression tests passed. No live data was used.');