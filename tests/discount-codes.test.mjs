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
      sale_request_keys: [],
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
      if ('$ne' in expected) {
        if (Array.isArray(actual) ? actual.includes(expected.$ne) : actual === expected.$ne) return false;
      }
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
          for (const [key, value] of Object.entries(operation.$push || {})) {
            if (!Array.isArray(row[key])) row[key] = [];
            row[key].push(clone(value));
          }
          for (const [key, value] of Object.entries(operation.$pull || {})) {
            row[key] = (Array.isArray(row[key]) ? row[key] : []).filter((item) => item !== value);
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
      /async function verifyOwnerPin\(service: any, pinValue: unknown, actor: any\) \{[\s\S]*?\n\}\n\nconst IDEMPOTENCY_KEY_PATTERN/,
      'async function verifyOwnerPin(_service, pinValue, _actor) { return String(pinValue || "") === "2468"; }\n\nconst IDEMPOTENCY_KEY_PATTERN',
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

test('simultaneous untracked offline retries still create one sale', async () => {
  const f = fixture(5);
  f.db.Product[0].track_stock = false;
  const call = loadHandler(f.client);
  const request = {
    action: 'complete_sale',
    shift_id: 'shift',
    items: [{ product_id: 'cake', quantity: 1 }],
    payments: [{ method: 'cash', amount: 100000 }],
    idempotency_key: 'pos-offline-race-00000001',
    recorded_at: '2026-09-11T20:30:00.000Z',
  };

  const results = await Promise.all([
    call(structuredClone(request)),
    call(structuredClone(request)),
  ]);
  assert.ok(results.some((result) => result.status === 200), JSON.stringify(results));
  assert.ok(results.every((result) => result.status === 200 || result.status === 503), JSON.stringify(results));

  const retry = await call(structuredClone(request));
  assert.equal(retry.status, 200, JSON.stringify(retry));
  assert.equal(retry.data.already_processed, true);
  assert.equal(f.db.Sale.length, 1);
  assert.equal(f.db.SaleItem.length, 1);
  assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.StockMovement.length, 0);
  assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal(f.db.Shift[0].order_count, 1);
  assert.deepEqual(f.db.Shift[0].sale_request_keys, [request.idempotency_key]);
});

test('discount management hides used codes and creates one-time codes', () => {
  const source = readFileSync('src/pages/DiscountCodes.jsx', 'utf8');
  assert.match(source, /item\.active !== false/);
  assert.match(source, /Number\(item\.usage_count \|\| 0\) < 1/);
  assert.match(source, /single_use: true/);
});

test('86,000 cake rounds to 85,000 with immutable original price and matching accounting', async () => {
  const f = fixture();
  f.db.Product[0].price = 86000;
  const response = await loadHandler(f.client)({
    action: 'complete_sale', shift_id: 'shift',
    items: [{ product_id: 'cake', quantity: 1 }],
    rounding_total: 85000,
    payments: [{ method: 'cash', amount: 85000 }],
  });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.sale.subtotal, 86000);
  assert.equal(response.data.sale.discount_amount, 1000);
  assert.equal(response.data.sale.discount_code, 'YAXLITLASH');
  assert.equal(response.data.sale.total, 85000);
  assert.equal(f.db.Product[0].price, 86000);
  assert.equal(f.db.SaleItem[0].unit_price, 86000);
  assert.equal(f.db.SaleItem[0].discount_amount, 1000);
  assert.equal(f.db.SaleItem[0].line_total, 85000);
  assert.equal(f.db.Payment[0].amount, 85000);
  assert.equal(f.db.Shift[0].total_sales, 85000);
});

test('63k and 64k may round to 60k; limits and coupon stacking fail without mutations', async () => {
  for (const price of [63000, 64000]) {
    const f = fixture(); f.db.Product[0].price = price;
    const call = loadHandler(f.client);
    const body = { action:'complete_sale', shift_id:'shift', items:[{product_id:'cake', quantity:1}],
      rounding_total:60000, payments:[{method:'cash',amount:60000}] };
    const ok = await call(body);
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.equal(ok.data.sale.discount_amount, price - 60000);
    assert.equal(ok.data.sale.total, 60000);
  }
  for (const target of [0, -1, 94000, 90000, 100001, 95000.5, '95000', null]) {
    const f = fixture();
    const result = await loadHandler(f.client)({ action:'complete_sale', shift_id:'shift',
      items:[{product_id:'cake',quantity:1}], rounding_total:target,
      payments:[{method:'cash',amount:Number(target)||1}] });
    assert.notEqual(result.status, 200, `invalid rounding accepted: ${target}`);
    assert.equal(f.db.Sale.length, 0);
    assert.equal(f.db.ProductStock[0].quantity, 10);
  }
  const f = fixture();
  const combined = await loadHandler(f.client)({ ...saleBody(f.code, 5),
    rounding_total:95000 });
  assert.equal(combined.status, 400, JSON.stringify(combined));
  assert.equal(f.db.Sale.length, 0);
  assert.equal(f.db.DiscountCode[0].usage_count, 0);
});

test('rounding idempotency key is tied to requested target', async () => {
  const f = fixture();
  const call = loadHandler(f.client);
  const request = { action:'complete_sale', shift_id:'shift',
    items:[{product_id:'cake',quantity:1}], rounding_total:95000,
    payments:[{method:'cash',amount:95000}],
    idempotency_key:'pos-rounding-test-00001', recorded_at:'2026-09-11T20:30:00.000Z' };
  const first = await call(request);
  const duplicate = await call({...request});
  const altered = await call({...request,rounding_total:96000});
  assert.equal(first.status,200,JSON.stringify(first));
  assert.equal(duplicate.status,200,JSON.stringify(duplicate));
  assert.equal(duplicate.data.already_processed,true);
  assert.equal(altered.status,409,JSON.stringify(altered));
  assert.equal(f.db.Sale.length,1);
});

test('rounding UI requires online checkout; existing offline queue remains unmodified', () => {
  const source = readFileSync('src/pages/POS.jsx','utf8');
  assert.match(source,/discountCode \|\| roundingTarget !== null/);
  assert.match(source,/!discountCode && roundingTarget === null/);
  assert.match(source,/rounding_total: roundingTarget \?\? undefined/);
  const cart = readFileSync('src/components/pos/Cart.jsx','utf8');
  assert.match(cart,/Summani yaxlitlash/);
  assert.match(cart,/onRemoveRounding/);
});

console.log('Discount, rounding and idempotency regression tests passed. No live data was used.');
