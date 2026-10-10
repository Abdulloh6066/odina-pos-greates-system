// Integration regressions with an in-memory SDK. No real sales, stock or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { buildPendingSale } from '../src/lib/offline-sales.js';
import * as fries from '../base44/shared/burger-fries.js';

const shopId = fries.BURGER_FRIES_SHOP_ID;
const [classicId, miniId] = fries.BURGER_PRODUCT_IDS;
const manifest = [
  {
    "product_id": "6ab747c5c1c33517e6eea448",
    "product_name_snapshot": "Burger classic",
    "rows": [
      {
        "ingredient_id": "6aca1510023619f83a97a1ce",
        "ingredient_name_snapshot": "Chizburger bulochkasi",
        "quantity": 1,
        "unit": "piece"
      },
      {
        "ingredient_id": "6aca1510023619f83a97a1c8",
        "ingredient_name_snapshot": "Aysberg",
        "quantity": 20,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca42bb8a3025f47521338b",
        "ingredient_name_snapshot": "Farsh",
        "quantity": 120,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca1510023619f83a97a1c7",
        "ingredient_name_snapshot": "Pomidor",
        "quantity": 30,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca42bb8a3025f47521338c",
        "ingredient_name_snapshot": "Marinadlangan bodring",
        "quantity": 30,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca39ef9b16b72eb1b19508",
        "ingredient_name_snapshot": "Firmenniy sous (P/F)",
        "quantity": 40,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca42f7fc0f4fa176bc7bd7",
        "ingredient_name_snapshot": "Qizil piyoz",
        "quantity": 10,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca1510023619f83a97a1ba",
        "ingredient_name_snapshot": "Ketchup — Heunz",
        "quantity": 50,
        "unit": "g"
      }
    ]
  },
  {
    "product_id": "6ab747c5c1c33517e6eea449",
    "product_name_snapshot": "Burger mini (3 ta)",
    "rows": [
      {
        "ingredient_id": "6aca1510023619f83a97a1cf",
        "ingredient_name_snapshot": "Mini bulochka",
        "quantity": 3,
        "unit": "piece"
      },
      {
        "ingredient_id": "6aca42bb8a3025f47521338c",
        "ingredient_name_snapshot": "Marinadlangan bodring",
        "quantity": 45,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca42bb8a3025f47521338b",
        "ingredient_name_snapshot": "Farsh",
        "quantity": 120,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca1510023619f83a97a1bc",
        "ingredient_name_snapshot": "Sir — Chedler",
        "quantity": 1,
        "unit": "piece"
      },
      {
        "ingredient_id": "6aca39ef9b16b72eb1b19508",
        "ingredient_name_snapshot": "Firmenniy sous (P/F)",
        "quantity": 30,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca42bb8a3025f47521338d",
        "ingredient_name_snapshot": "Gribnoy sous (P/F)",
        "quantity": 45,
        "unit": "g"
      },
      {
        "ingredient_id": "6aca1510023619f83a97a1ba",
        "ingredient_name_snapshot": "Ketchup — Heunz",
        "quantity": 50,
        "unit": "g"
      }
    ]
  }
];
const saleFile = 'base44/functions/complete-sale/entry.ts';
const now = '2026-10-10T14:00:00.000Z';
function fixture() {
  const recipeItems = manifest.flatMap((m, index) => m.rows.map((row, position) => ({
    ...row, id: 'ri-' + index + '-' + position, product_id: m.product_id, recipe_id: 'recipe-' + index, position,
  })));
  const ingredientIds = [...new Set([...recipeItems.map(r => r.ingredient_id), fries.FRIES_INGREDIENT_ID])];
  const f = memoryBackend({
    User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Mock owner', shop_id: shopId }],
    Shift: [{ id: 'shift', user_id: 'owner', shop_id: shopId, shop_name: 'Mock Branch', status: 'open',
      opened_at: '2026-10-10T13:00:00Z', expected_cash: 0, total_sales: 0, order_count: 0, sale_request_keys: [] }],
    Shop: [{ id: shopId, name: 'Mock Branch', location_type: 'shop', active: true, allows_pos: true,
      restaurant_table_count: 5, restaurant_table_orders: [], restaurant_table_orders_version: 0 }],
    Product: [
      { id: classicId, name: 'Burger classic', price: 42000, shop_prices: { [shopId]: 37000 },
        source_type: 'shop_prepared', active: true, track_stock: true, sale_unit: 'piece' },
      { id: miniId, name: 'Burger mini (3 ta)', price: 55000, shop_prices: { [shopId]: 45000 },
        source_type: 'shop_prepared', active: true, track_stock: true, sale_unit: 'piece' },
    ],
    Recipe: manifest.map((m, index) => ({ id: 'recipe-' + index, product_id: m.product_id,
      version: 1, active: true, output_quantity: 1, output_unit: 'piece' })),
    RecipeItem: recipeItems,
    IngredientStock: ingredientIds.map(id => ({ id: 'stock-' + id, ingredient_id: id,
      location_id: shopId, quantity: 10000, unit: recipeItems.find(r => r.ingredient_id === id)?.unit || 'g' })),
    SupplierReceipt: [{ id: 'receipt', status: 'completed' }],
    SupplierReceiptItem: ingredientIds.map(id => ({ id: 'purchase-' + id, ingredient_id: id,
      receipt_id: 'receipt', base_quantity: 100, line_total: 1000 })),
    Settings: [{ id: 'settings', allow_negative_stock: false }],
    Sale: [], SaleItem: [], Payment: [], ProductStock: [], StockMovement: [], Refund: [], ActionHistory: [],
  }, { now });
  return f;
}
function saleRequest(items, amount, key = 'pos-burger-test-00001') {
  return { action: 'complete_sale', shift_id: 'shift', recorded_at: now, idempotency_key: key,
    items, payments: [{ method: 'cash', amount }] };
}
const stock = (f, id) => f.db.IngredientStock.find(r => r.ingredient_id === id).quantity;
const ingredient = name => manifest.flatMap(m => m.rows).find(r => r.ingredient_name_snapshot === name).ingredient_id;

test('mixed burger options charge per portion, deduct 150 g only with fries, and keep immutable line costs', async () => {
  const f = fixture();
  const result = await f.invoke(saleFile, saleRequest([
    { product_id: classicId, fries_option: 'without', quantity: 1, price: 1 },
    { product_id: classicId, fries_option: 'with', quantity: 2, price: 1 },
    { product_id: miniId, fries_option: 'with', quantity: 1 },
  ], 171000));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.Sale[0].total, 171000);
  assert.equal(f.db.SaleItem.length, 3);
  assert.equal(stock(f, fries.FRIES_INGREDIENT_ID), 9550);
  assert.equal(stock(f, ingredient('Farsh')), 9520);
  assert.equal(stock(f, ingredient('Mini bulochka')), 9997);
  assert.equal(stock(f, ingredient('Sir — Chedler')), 9999);
  const base = f.db.SaleItem.find(r => r.product_id === classicId && r.fries_option === 'without');
  const withFries = f.db.SaleItem.find(r => r.product_id === classicId && r.fries_option === 'with');
  assert.equal(base.unit_price, 37000);
  assert.equal(withFries.unit_price, 42000);
  assert.equal(withFries.unit_cost_at_sale - base.unit_cost_at_sale, 1500);
  assert.equal(withFries.cost_is_estimate, false);
  assert.match(withFries.product_name_snapshot, /Fri bilan/);
  assert.match(base.product_name_snapshot, /Frisiz/);
  assert.equal(f.db.ProductStock.length, 0, 'no finished-burger double deduction');
  const friMovements = f.db.StockMovement.filter(r => r.item_id === fries.FRIES_INGREDIENT_ID && r.movement_type === 'sale');
  assert.equal(friMovements.length, 1);
  assert.equal(friMovements[0].quantity_change, -450);
});

test('replaying a sale does not charge or deduct again; changing the fries choice under its key is rejected', async () => {
  const f = fixture();
  const request = saleRequest([{ product_id: miniId, quantity: 1, fries_option: 'with' }], 50000);
  const first = await f.invoke(saleFile, request);
  assert.equal(first.status, 200, JSON.stringify(first));
  const repeated = await f.invoke(saleFile, request);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.already_processed, true);
  assert.equal(f.db.Sale.length, 1);
  assert.equal(stock(f, fries.FRIES_INGREDIENT_ID), 9850);
  const changed = await f.invoke(saleFile, { ...request, items: [{ product_id: miniId, quantity: 1, fries_option: 'without' }] });
  assert.equal(changed.status, 409);
  assert.equal(stock(f, fries.FRIES_INGREDIENT_ID), 9850);
});

test('legacy burger requests retain base price and never consume fries', async () => {
  const f = fixture();
  const result = await f.invoke(saleFile, saleRequest([{ product_id: classicId, quantity: 1 }], 37000));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(stock(f, fries.FRIES_INGREDIENT_ID), 10000);
  assert.equal(f.db.SaleItem[0].product_name_snapshot, 'Burger classic');
  assert.equal(Object.hasOwn(f.db.SaleItem[0], 'fries_option'), false);
});

test('missing fries stock or missing burger recipe blocks before any financial mutation', async () => {
  for (const failure of ['stock', 'recipe']) {
    const f = fixture();
    if (failure === 'stock') f.db.IngredientStock.find(r => r.ingredient_id === fries.FRIES_INGREDIENT_ID).quantity = 149;
    else f.db.Recipe = [];
    const result = await f.invoke(saleFile, saleRequest([{ product_id: classicId, quantity: 1, fries_option: 'with' }], 42000));
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.equal(f.db.Sale.length, 0);
    assert.equal(f.db.Payment.length, 0);
    assert.equal(f.db.StockMovement.length, 0);
  }
});

test('unsupported product, shop or option cannot acquire a fries surcharge', () => {
  for (const [row, shop] of [
    [{ product_id: 'cake', fries_option: 'with' }, shopId],
    [{ product_id: classicId, fries_option: 'with' }, 'other-shop'],
    [{ product_id: classicId, fries_option: 'invalid' }, shopId],
  ]) assert.throws(() => fries.validateFriesOption(row, shop), error => error.status === 400);
});

test('offline receipts and synchronization preserve mixed fries choices and portion quantities', () => {
  const f = fixture();
  const record = buildPendingSale({ idempotencyKey: 'pos-burger-offline', recordedAt: now,
    shift: f.db.Shift[0], user: f.db.User[0],
    cart: [{ product_id: miniId, product_name: 'Burger mini (3 ta) — Frisiz', quantity: 1, price: 45000, fries_option: 'without' },
      { product_id: miniId, product_name: 'Burger mini (3 ta) — Fri bilan', quantity: 2, price: 50000, fries_option: 'with' }],
    payments: [{ method: 'cash', amount: 145000 }] });
  assert.deepEqual(record.request.items, [
    { product_id: miniId, quantity: 1, fries_option: 'without' },
    { product_id: miniId, quantity: 2, fries_option: 'with' },
  ]);
  assert.equal(record.local_sale.total, 145000);
  assert.match(record.local_sale.items[1].product_name, /Fri bilan/);
});

test('missing fries purchase price marks the whole with-fries cost as an estimate', async () => {
  const f = fixture();
  f.db.SupplierReceiptItem = f.db.SupplierReceiptItem.filter(r => r.ingredient_id !== fries.FRIES_INGREDIENT_ID);
  const result = await f.invoke(saleFile, saleRequest([{ product_id: miniId, quantity: 1, fries_option: 'with' }], 50000));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.SaleItem[0].cost_is_estimate, true);
});

test('saving and reloading a mixed table order preserves both choices and creates no sale until checkout', async () => {
  const f = fixture(); let handler;
  f.load('base44/functions/restaurant-tables/entry.ts', { Deno: { serve: cb => { handler = cb; } } });
  const body = { action: 'save_table_order', shop_id: shopId, shift_id: 'shift', table_number: 1, expected_revision: 0,
    items: [{ product_id: miniId, quantity: 1, fries_option: 'without' }, { product_id: miniId, quantity: 1, fries_option: 'with' }] };
  const response = await handler({ json: async () => body });
  const saved = await response.json();
  assert.equal(response.status, 200, JSON.stringify(saved));
  assert.equal(saved.order.items.length, 2);
  assert.equal(saved.order.total, 95000);
  assert.equal(f.db.Sale.length, 0);
  assert.equal(stock(f, fries.FRIES_INGREDIENT_ID), 10000);
  const paid = await f.invoke(saleFile, { ...saleRequest(body.items, 95000), table_shop_id: shopId,
    table_number: 1, table_order_id: saved.order.id, table_order_revision: saved.order.revision });
  assert.equal(paid.status, 200, JSON.stringify(paid));
  assert.equal(stock(f, fries.FRIES_INGREDIENT_ID), 9850);
  assert.equal(f.db.Shop[0].restaurant_table_orders.length, 0);
});

test('a failed fries movement rolls back ingredient deductions and financial records', async () => {
  const f = fixture();
  const original = f.entities.StockMovement.create;
  f.entities.StockMovement.create = data => {
    if (data.item_id === fries.FRIES_INGREDIENT_ID && data.movement_type === 'sale') throw new Error('Mock fries movement failure');
    return original(data);
  };
  const result = await f.invoke(saleFile, saleRequest([{ product_id: miniId, quantity: 1, fries_option: 'with' }], 50000));
  assert.equal(result.status, 500);
  assert.equal(stock(f, fries.FRIES_INGREDIENT_ID), 10000);
  assert.equal(stock(f, ingredient('Farsh')), 10000);
  assert.equal(f.db.Sale.length, 0);
  assert.equal(f.db.SaleItem.length, 0);
  assert.equal(f.db.Payment.length, 0);
  assert.equal(f.db.Shift[0].total_sales, 0);
});
