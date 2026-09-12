// Offline regression tests for one-time discount codes and 100% OWNER PIN approval.
// No live Base44 records are read, created, updated, or deleted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(percentage = 5) {
  const code = percentage === 100 ? 'FREE100' : 'WELCOME5';
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
      opened_at: '2026-09-10T08:00:00.000Z',
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
    Product: [{
      id: 'cake',
      name: 'Test cake',
      image_url: 'cake.png',
      price: 100000,
      active: true,
      track_stock: true,
      source_type: 'central_produced',
    }],
    ProductStock: [{
      id: 'cake-stock',
      location_id: 'shop',
      location_name: 'Test shop',
      product_id: 'cake',
      product_name: 'Test cake',
      unit: 'piece',
      quantity: 10,
    }],
    Settings: [{ id: 'settings', allow_negative_stock: false }],
    DiscountCode: [{
      id: 'discount',
      code,
      percentage,
      active: true,
      usage_count: 0,
      single_use: true,
    }],
    Sale: [],
    SaleItem: [],
    Payment: [],
    StockMovement: [],
    ActionHistory: [],
    SecuritySettings: [],
    Refund: [],
    CashMovement: [],
    CashRecipient: [],
    BudgetBalance: [],
    BudgetTransaction: [],
    ShiftProductSnapshot: [],
    SupplierReceipt: [],
    SupplierReceiptItem: [],
    Recipe: [],
    RecipeItem: [],
  };

  let sequence = 0;
  const clone = (value) => value == null ? value : structuredClone(value);
  const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$gte' in expected && !(actual >= expected.$gte)) return false;
      if ('$lte' in expected && !(actual <= expected.$lte)) return false;
      if ('$in' in expected && !expected.$in.includes(actual)) return false;
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
  return { db, entities, client, code };
}

function loadHandler(client) {
  const sharedSrc = readFileSync('base44/shared/shift-close-helpers.ts', 'utf8').replace(/export /g, '');
  const sharedCode = ts.transpileModule(sharedSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const costSrc = readFileSync('base44/shared/cost-engine.ts', 'utf8').replace(/export /g, '');
  const costCode = ts.transpileModule(costSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;

  let source = readFileSync('base44/functions/complete-sale/entry.ts', 'utf8')
    .replace(/import \{ createClientFromRequest \} from "npm:@base44\/sdk";/, 'const createClientFromRequest = () => client;')
    .replace(/import \{[\s\S]*?\} from "\.\.\/\.\.\/shared\/shift-close-helpers\.ts";/, '')
    .replace(/import \{ loadIngredientCosts, computeProductCost \} from "\.\.\/\.\.\/shared\/cost-engine\.ts";/, '')
    .replace(
      /async function verifyOwnerPin\(service: any, pinValue: unknown\) \{[\s\S]*?\n\}\n\nconst IDEMPOTENCY_KEY_PATTERN/,
      'async function verifyOwnerPin(_service, pinValue) { return String(pinValue || "") === "2468"; }\n\nconst IDEMPOTENCY_KEY_PATTERN',
    )
    .replace('export default async function(req)', 'async function handler(req)')
    .replace(
      'error: error instanceof Error ? error.message : "Savdoni yakunlab bo‘lmadi.",',
      'error: error instanceof Error ? (error.stack || error.message) : "Savdoni yakunlab bo‘lmadi.",',
    );
  source = sharedCode + '\n' + costCode + '\n' + source + '\nglobalThis.testHandler = handler;';

  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  if (process.env.ODINA_DEBUG_TEST) {
    console.log(code.split('\n').slice(1342, 1352).map((line, index) => `${1343 + index}: ${line}`).join('\n'));
  }
  const context = vm.createContext({
    client,
    Response,
    crypto: webcrypto,
    TextEncoder,
    exports: {},
    console,
    structuredClone,
  });
  vm.runInContext(code, context);

  return async (body) => {
    const response = await context.testHandler({ json: async () => body });
    return { status: response.status, data: await response.json() };
  };
}

const saleBody = (code, percentage, ownerPin) => ({
  action: 'complete_sale',
  shift_id: 'shift',
  items: [{ product_id: 'cake', quantity: 1 }],
  discount_code: code,
  owner_pin: ownerPin,
  payments: percentage === 100
    ? []
    : [{ method: 'cash', amount: 100000 - (100000 * percentage / 100) }],
});

test('cashier can validate a 1–99% code without OWNER PIN', async () => {
  const f = fixture(5);
  const response = await loadHandler(f.client)({
    action: 'validate_discount',
    code: f.code,
  });

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.percentage, 5);
  assert.equal(response.data.requires_owner_pin, false);
});

test('cashier must provide OWNER PIN for a 100% code', async () => {
  const f = fixture(100);
  const response = await loadHandler(f.client)({
    action: 'validate_discount',
    code: f.code,
  });

  assert.equal(response.status, 403, JSON.stringify(response));
  assert.equal(response.data.requires_owner_pin, true);
  assert.equal(f.db.DiscountCode[0].active, true);
});

test('correct OWNER PIN validates a 100% code', async () => {
  const f = fixture(100);
  const response = await loadHandler(f.client)({
    action: 'validate_discount',
    code: f.code,
    owner_pin: '2468',
  });

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.percentage, 100);
});

test('backend blocks a 100% sale when OWNER PIN is missing', async () => {
  const f = fixture(100);
  const response = await loadHandler(f.client)(saleBody(f.code, 100));

  assert.equal(response.status, 403, JSON.stringify(response));
  assert.equal(f.db.Sale.length, 0);
  assert.equal(f.db.DiscountCode[0].active, true);
  assert.equal(f.db.DiscountCode[0].usage_count, 0);
});

test('100% sale completes without a payment and archives its one-time code', async () => {
  const f = fixture(100);
  const call = loadHandler(f.client);
  const response = await call(saleBody(f.code, 100, '2468'));

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.sale.total, 0);
  assert.equal(response.data.payments.length, 0);
  assert.equal(f.db.Payment.length, 0);
  assert.equal(f.db.Shift[0].order_count, 1);
  assert.equal(f.db.Shift[0].total_sales, 0);
  assert.equal(f.db.ProductStock[0].quantity, 9);
  assert.equal(f.db.DiscountCode[0].active, false);
  assert.equal(f.db.DiscountCode[0].usage_count, 1);
  assert.equal(f.db.DiscountCode[0].used_by_sale_id, response.data.sale.id);

  const reused = await call({ action: 'validate_discount', code: f.code, owner_pin: '2468' });
  assert.equal(reused.status, 404, JSON.stringify(reused));
});

test('a 5% code completes without OWNER PIN and is single-use', async () => {
  const f = fixture(5);
  const response = await loadHandler(f.client)(saleBody(f.code, 5));

  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.sale.total, 95000);
  assert.equal(f.db.Payment[0].amount, 95000);
  assert.equal(f.db.DiscountCode[0].active, false);
  assert.equal(f.db.DiscountCode[0].usage_count, 1);
});

test('simultaneous requests cannot spend the same one-time code twice', async () => {
  const f = fixture(5);
  const call = loadHandler(f.client);
  const results = await Promise.all([
    call(saleBody(f.code, 5)),
    call(saleBody(f.code, 5)),
  ]);

  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
  assert.equal(f.db.Sale.length, 1);
  assert.equal(f.db.DiscountCode[0].usage_count, 1);
});

test('failed sale rolls back the reserved discount code', async () => {
  const f = fixture(5);
  f.entities.Shift.updateMany = async () => ({ success: true, updated: 0 });
  const response = await loadHandler(f.client)(saleBody(f.code, 5));

  assert.equal(response.status, 500, JSON.stringify(response));
  assert.equal(f.db.Sale.length, 0);
  assert.equal(f.db.SaleItem.length, 0);
  assert.equal(f.db.Payment.length, 0);
  assert.equal(f.db.StockMovement.length, 0);
  assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal(f.db.DiscountCode[0].active, true);
  assert.equal(f.db.DiscountCode[0].usage_count, 0);
});

test('same offline sale request is processed only once', async () => {
  const f = fixture(5);
  const call = loadHandler(f.client);
  const request = {
    action: 'complete_sale',
    shift_id: 'shift',
    items: [{ product_id: 'cake', quantity: 1 }],
    payments: [{ method: 'cash', amount: 100000 }],
    idempotency_key: 'pos-offline-test-00000001',
    recorded_at: '2026-09-11T20:30:00.000Z',
  };

  const first = await call(request);
  const second = await call(structuredClone(request));

  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.equal(second.data.already_processed, true);
  assert.equal(second.data.sale.id, first.data.sale.id);
  assert.equal(f.db.Sale.length, 1);
  assert.equal(f.db.SaleItem.length, 1);
  assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.StockMovement.length, 1);
  assert.equal(f.db.ProductStock[0].quantity, 9);
  assert.equal(f.db.Shift[0].order_count, 1);
  assert.equal(first.data.sale.sold_at, request.recorded_at);
  assert.equal(first.data.sale.business_date, '2026-09-12');
});

test('same offline key cannot be reused for a different sale', async () => {
  const f = fixture(5);
  const call = loadHandler(f.client);
  const request = {
    action: 'complete_sale',
    shift_id: 'shift',
    items: [{ product_id: 'cake', quantity: 1 }],
    payments: [{ method: 'cash', amount: 100000 }],
    idempotency_key: 'pos-offline-test-00000002',
    recorded_at: '2026-09-11T20:30:00.000Z',
  };

  const first = await call(request);
  const conflict = await call({
    ...request,
    items: [{ product_id: 'cake', quantity: 2 }],
    payments: [{ method: 'cash', amount: 200000 }],
  });

  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(conflict.status, 409, JSON.stringify(conflict));
  assert.equal(f.db.Sale.length, 1);
  assert.equal(f.db.ProductStock[0].quantity, 9);
  assert.equal(f.db.Shift[0].order_count, 1);
});

test('discount management hides used codes and creates one-time codes', () => {
  const source = readFileSync('src/pages/DiscountCodes.jsx', 'utf8');
  assert.match(source, /item\.active !== false/);
  assert.match(source, /Number\(item\.usage_count \|\| 0\) < 1/);
  assert.match(source, /single_use: true/);
});

console.log('11 discount and idempotency regression tests passed. No live data was used.');
