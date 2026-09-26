import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const order = ['SaleItem', 'Payment', 'Refund', 'CashMovement', 'StockMovement',
  'ShiftProductSnapshot', 'Sale', 'Shift', 'DailyShopReport', 'BudgetTransaction'];

async function hash(rows) {
  const ids = rows.map((row) => row.id).sort().join('\n');
  const bytes = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(ids));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fixture({ extraSale = false } = {}) {
  const db = {
    SaleItem: [{ id: 'item', sale_id: 'sale' }],
    Payment: [{ id: 'pay', sale_id: 'sale' }],
    Refund: [], CashMovement: [],
    StockMovement: [{ id: 'movement', reference_id: 'sale', reference_type: 'sale' }],
    ShiftProductSnapshot: [{ id: 'snapshot', shift_id: 'shift' }],
    Sale: [{ id: 'sale', shift_id: 'shift' }],
    Shift: [{ id: 'shift' }],
    DailyShopReport: [{ id: 'report' }],
    BudgetTransaction: [
      { id: 'cash-tx', account: 'cash', type: 'shift_deposit', shift_id: 'shift', direction: 'in', amount: 325097, balance_before: 500000, balance_after: 825097 },
      { id: 'uzcard-tx', account: 'uzcard', type: 'shift_deposit', shift_id: 'shift', direction: 'in', amount: 282000, balance_before: 27000, balance_after: 309000 },
      { id: 'online-tx', account: 'online', type: 'shift_deposit', shift_id: 'shift', direction: 'in', amount: 111000, balance_before: 0, balance_after: 111000 },
    ],
    BudgetBalance: [
      { id: 'cash-balance', account: 'cash', balance: 825097 },
      { id: 'uzcard-balance', account: 'uzcard', balance: 309000 },
      { id: 'online-balance', account: 'online', balance: 111000 },
      { id: 'humo-balance', account: 'humo', balance: 0 },
      { id: 'bank-balance', account: 'bank', balance: 0 },
    ],
    Product: [{ id: 'product' }],
    ProductStock: [{ id: 'stock', quantity: 7 }],
    Category: [{ id: 'category' }],
    ActionHistory: [],
  };
  const expected = {};
  for (const name of order) expected[name] = [db[name].length, await hash(db[name])];
  if (extraSale) db.Sale.push({ id: 'new-sale', shift_id: 'shift' });
  const deleted = [];
  const entities = Object.fromEntries(Object.keys(db).map((name) => [name, {
    list: async () => structuredClone(db[name]),
    delete: async (id) => {
      deleted.push([name, id]);
      db[name] = db[name].filter((row) => row.id !== id);
    },
    update: async (id, patch) => {
      const row = db[name].find((x) => x.id === id);
      Object.assign(row, patch);
      return structuredClone(row);
    },
    create: async (record) => db[name].push(record),
  }]));
  const client = {
    auth: { me: async () => ({ id: 'admin' }) },
    asServiceRole: { entities },
  };
  let handler;
  let source = readFileSync('base44/functions/clear-prelaunch-sales/entry.ts', 'utf8')
    .replace(/import \{ createClientFromRequest \} from "npm:@base44\/sdk";/, 'const createClientFromRequest = () => client;')
    .replace(/import \{ resolveStoredAppUser, userRole \} from "\.\.\/\.\.\/shared\/user-helpers\.ts";/,
      'const resolveStoredAppUser = async () => ({ id: "admin", role: "admin", active: true }); const userRole = () => "admin";')
    .replace(/const EXPECTED: Record<string, \[number, string\]> = \{[\s\S]*?\};/,
      'const EXPECTED = ' + JSON.stringify(expected) + ';');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(code, {
    client, Deno: { serve: (fn) => { handler = fn; } }, Response, crypto: webcrypto,
    TextEncoder, Date, Set, Number, String, Object, Array,
  });
  const invoke = async () => {
    const response = await handler({ method: 'POST', json: async () => ({
      scope: 'prelaunch_sales_shifts', confirm: 'SOTUVNI_TOZALASH',
    }) });
    return { status: response.status, data: await response.json() };
  };
  return { db, deleted, invoke };
}

test('prelaunch reset deletes only archived sales and shifts; restores pre-deposit balances', async () => {
  const { db, deleted, invoke } = await fixture();
  const { data } = await invoke();
  assert.equal(data.ok, true);
  for (const name of order) assert.equal(db[name].length, 0, name);
  assert.deepEqual(db.Product, [{ id: 'product' }]);
  assert.deepEqual(db.ProductStock, [{ id: 'stock', quantity: 7 }]);
  assert.deepEqual(db.Category, [{ id: 'category' }]);
  assert.deepEqual(Object.fromEntries(db.BudgetBalance.map((r) => [r.account, r.balance])),
    { cash: 500000, uzcard: 27000, online: 0, humo: 0, bank: 0 });
  assert.ok(deleted.every(([name]) => order.includes(name)));
  assert.equal(db.ActionHistory.length, 1);
});

test('a new sale stops reset before any deletion or budget update', async () => {
  const { db, deleted, invoke } = await fixture({ extraSale: true });
  const { status, data } = await invoke();
  assert.equal(status, 409);
  assert.match(data.error, /Sale/);
  assert.equal(deleted.length, 0);
  assert.equal(db.BudgetBalance.find((r) => r.account === 'cash').balance, 825097);
});
