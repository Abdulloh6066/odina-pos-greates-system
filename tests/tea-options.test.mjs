// In-memory integration tests only: no live sales, stock, payments or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { buildPendingSale } from '../src/lib/offline-sales.js';
import * as tea from '../src/lib/tea-options.js';
import * as burger from '../src/lib/burger-fries.js';
import { saleLineKey } from '../src/lib/sale-options.js';

const shopId = burger.BURGER_FRIES_SHOP_ID;
const teaId = '6ab66ca8ae6223ce0f93e60d';
const now = '2026-10-31T13:30:00.000Z';
const saleFile = 'base44/functions/complete-sale/entry.ts';
const cup = { product_id: teaId, quantity: 1, tea_option: 'cup' };
const pot = { product_id: teaId, quantity: 1, tea_option: 'pot' };

function fixture(location = shopId) {
  return memoryBackend({
    User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Mock owner', shop_id: location }],
    Shop: [{ id: location, name: 'Mock Branch', active: true, location_type: 'shop', allows_pos: true,
      restaurant_table_count: 5, restaurant_table_orders: [], restaurant_table_orders_version: 0 }],
    Shift: [{ id: 'shift', user_id: 'owner', shop_id: location, shop_name: 'Mock Branch', status: 'open',
      opened_at: '2026-10-31T12:00:00Z', expected_cash: 0, total_sales: 0, order_count: 0, sale_request_keys: [] }],
    Product: [{ id: teaId, name: 'Yagodniy choy', price: 30000, shop_prices: { [location]: 28000 },
      active: true, source_type: 'shop_prepared', sale_unit: 'piece', track_stock: true }],
    Recipe: [{ id: 'recipe', product_id: teaId, active: true, version: 1, output_quantity: 1, output_unit: 'piece' }],
    RecipeItem: [
      { id: 'ri1', recipe_id: 'recipe', ingredient_id: 'berries', ingredient_name_snapshot: 'Rezavor', quantity: 50, unit: 'g' },
      { id: 'ri2', recipe_id: 'recipe', ingredient_id: 'water', ingredient_name_snapshot: 'Suv', quantity: 600, unit: 'ml' },
      { id: 'ri3', recipe_id: 'recipe', ingredient_id: 'cup', ingredient_name_snapshot: 'Stakan', quantity: 1, unit: 'piece', takeaway_only: true },
    ],
    IngredientStock: ['berries','water','cup'].map((id, i) => ({ id: 'stock-' + id,
      ingredient_id: id, location_id: location, quantity: 10000, unit: ['g','ml','piece'][i] })),
    SupplierReceipt: [{ id: 'receipt', status: 'completed' }],
    SupplierReceiptItem: ['berries','water','cup'].map(id => ({ id: 'purchase-' + id,
      ingredient_id: id, receipt_id: 'receipt', base_quantity: 100, line_total: 1000 })),
    Settings: [{ id: 'settings', allow_negative_stock: false }],
    Sale: [], SaleItem: [], Payment: [], ProductStock: [], StockMovement: [], ActionHistory: [], Refund: [],
  }, { now });
}
const stock = (f, id) => f.db.IngredientStock.find(row => row.ingredient_id === id).quantity;
const request = (items, amount, key = 'pos-tea-test-00001') => ({
  action: 'complete_sale', shift_id: 'shift', recorded_at: now, idempotency_key: key,
  items, payments: [{ method: 'cash', amount }],
});
async function tables(f, body) {
  let handler;
  f.load('base44/functions/restaurant-tables/entry.ts', { Deno: { serve: cb => { handler = cb; } } });
  // Each fixture's module registers its handler only on first load.
  f.tableHandler ||= handler;
  const response = await f.tableHandler({ json: async () => body });
  return { status: response.status, data: await response.json() };
}

test('mixed tea servings use server shop prices and keep full recipe amounts for each serving', async () => {
  const f = fixture();
  const originalRecipe = structuredClone(f.db.RecipeItem);
  const result = await f.invoke(saleFile, request([{ ...cup, price: 1 }, { ...pot, price: 1 }], 42000));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.db.Sale[0].total, 42000);
  assert.equal(f.db.SaleItem.length, 2);
  const cupLine = f.db.SaleItem.find(row => row.tea_option === 'cup');
  const potLine = f.db.SaleItem.find(row => row.tea_option === 'pot');
  assert.equal(cupLine.unit_price, 14000);
  assert.equal(potLine.unit_price, 28000);
  assert.match(cupLine.product_name_snapshot, /Stakan/);
  assert.match(potLine.product_name_snapshot, /Choynik/);
  assert.equal(stock(f, 'berries'), 9900);
  assert.equal(stock(f, 'water'), 8800);
  assert.equal(stock(f, 'cup'), 10000);
  assert.equal(cupLine.unit_cost_at_sale, potLine.unit_cost_at_sale);
  assert.equal(cupLine.cost_is_estimate, false);
  assert.deepEqual(f.db.RecipeItem, originalRecipe);
  assert.equal(f.db.ProductStock.length, 0);
});

test('tea retries cannot switch cup to pot, and legacy full-price requests retain their fingerprint', async () => {
  const f = fixture();
  const req = request([cup], 14000);
  assert.equal((await f.invoke(saleFile, req)).status, 200);
  const retry = await f.invoke(saleFile, req);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.already_processed, true);
  assert.equal((await f.invoke(saleFile, { ...req, items: [pot] })).status, 409);
  assert.equal(f.db.Sale.length, 1);
  assert.equal(stock(f, 'water'), 9400);
  const old = fixture();
  const legacy = request([{ product_id: teaId, quantity: 1 }], 28000);
  assert.equal((await old.invoke(saleFile, legacy)).status, 200);
  assert.equal(old.db.Sale[0].items[0].product_name, 'Yagodniy choy');
  assert.equal(Object.hasOwn(old.db.SaleItem[0], 'tea_option'), false);
  const explicitPot = await old.invoke(saleFile, { ...legacy, items: [pot] });
  assert.equal(explicitPot.status, 200);
  assert.equal(explicitPot.data.already_processed, true);
  assert.equal(old.db.Payment.length, 1);
});

test('non-tea and malformed serving options are rejected before payment or stock writes', async () => {
  for (const item of [{ ...cup, tea_option: 'invalid' }, { ...cup, product_id: 'cake' }]) {
    const f = fixture();
    const result = await f.invoke(saleFile, request([item], 14000));
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.equal(f.db.Sale.length, 0);
    assert.equal(f.db.Payment.length, 0);
    assert.equal(f.db.StockMovement.length, 0);
  }
  assert.equal(tea.canChooseTeaServing('6ad3599745b7d8066e5d871f'), false);
  assert.equal(tea.canChooseTeaServing('6ad3599745b7d8066e5d871d'), false);
});

test('offline receipts preserve both serving options, names and amounts through synchronization', async () => {
  const f = fixture();
  const pending = buildPendingSale({
    idempotencyKey: 'pos-tea-offline-00001', recordedAt: now, shift: f.db.Shift[0], user: f.db.User[0],
    cart: [
      { ...cup, product_name: 'Yagodniy choy — Stakan', price: 14000 },
      { ...pot, product_name: 'Yagodniy choy — Choynik', price: 28000 },
    ], payments: [{ method: 'cash', amount: 42000 }],
  });
  assert.deepEqual(pending.request.items, [cup, pot]);
  assert.equal(pending.local_sale.total, 42000);
  assert.match(pending.local_sale.items[0].product_name, /Stakan/);
  assert.match(pending.local_sale.items[1].product_name, /Choynik/);
  const synced = await f.invoke(saleFile, pending.request);
  assert.equal(synced.status, 200, JSON.stringify(synced));
  assert.equal(f.db.Sale[0].total, pending.local_sale.total);
  assert.equal(f.db.SaleItem.length, 2);
});

test('saved table servings retain price snapshots and checkout as two distinct lines', async () => {
  const f = fixture();
  const body = { action: 'save_table_order', shop_id: shopId, shift_id: 'shift', table_number: 1,
    expected_revision: 0, items: [cup, pot] };
  const saved = await tables(f, body);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(saved.data.order.total, 42000);
  assert.equal(saved.data.order.items.length, 2);
  assert.equal(f.db.Sale.length, 0);
  assert.equal(stock(f, 'water'), 10000);
  f.db.Product[0].shop_prices[shopId] = 40000;
  const edited = await tables(f, { ...body, expected_revision: saved.data.order.revision });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.order.total, 42000);
  const paid = await f.invoke(saleFile, { ...request([cup, pot], 42000),
    table_shop_id: shopId, table_number: 1, table_order_id: edited.data.order.id,
    table_order_revision: edited.data.order.revision });
  assert.equal(paid.status, 200, JSON.stringify(paid));
  assert.equal(f.db.SaleItem.find(row => row.tea_option === 'cup').unit_price, 14000);
  assert.equal(f.db.Shop[0].restaurant_table_orders.length, 0);
  assert.equal(stock(f, 'water'), 8800);
});

test('takeaway servings survive save, reload and payment with one whole package per serving', async () => {
  const f = fixture();
  const body = { action: 'save_takeaway_order', shop_id: shopId, shift_id: 'shift',
    order_id: 'takeaway-tea-test-0001', expected_revision: 0, items: [cup, pot] };
  const saved = await tables(f, body);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const retry = await tables(f, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.order.revision, saved.data.order.revision);
  const loaded = await tables(f, { action: 'get_takeaway_order', shop_id: shopId, order_id: body.order_id });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.data.order.items.length, 2);
  assert.equal(loaded.data.order.items[0].tea_option, 'cup');
  const paid = await f.invoke(saleFile, { ...request([cup,pot], 42000),
    takeaway_order_id: body.order_id, takeaway_order_revision: saved.data.order.revision });
  assert.equal(paid.status, 200, JSON.stringify(paid));
  assert.equal(stock(f, 'water'), 8800);
  assert.equal(stock(f, 'cup'), 9998);
});

test('finished-product stock combines cup and pot into a single balance update outside Branch', async () => {
  for (const existing of [true, false]) {
    const f = fixture('other-shop');
    if (existing) f.db.ProductStock.push({ id: 'finished', location_id: 'other-shop',
      product_id: teaId, quantity: 10, unit: 'piece' });
    else f.db.Settings[0].allow_negative_stock = true;
    const result = await f.invoke(saleFile, request([cup, { ...pot, quantity: 2 }], 70000));
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(f.db.ProductStock.length, 1);
    assert.equal(f.db.ProductStock[0].quantity, existing ? 7 : -3);
    const movements = f.db.StockMovement.filter(row => row.item_kind === 'product');
    assert.equal(movements.length, 1);
    assert.equal(movements[0].quantity_change, -3);
    assert.deepEqual(f.db.Sale[0].items.map(row => row.stock_quantity_change), [-1,-2]);
    assert.ok(f.db.Sale[0].items.every(row => row.stock_location_id === 'other-shop'));
  }
});

test('tea refund restores exactly the original ingredients once and preserves both serving snapshots', async () => {
  const f = fixture();
  const pin = '0101'; const salt = 'test-only-salt';
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256',
    salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  await f.entities.SecuritySettings.create({ key: 'owner_approval_pin', pin_salt: salt,
    pin_hash: Buffer.from(bits).toString('hex'), pin_algorithm: 'PBKDF2-SHA256', pin_iterations: 100000 });
  assert.equal((await f.invoke(saleFile, request([cup,pot],42000))).status, 200);
  const original = structuredClone(f.db.SaleItem);
  const refund = { action: 'refund_sale', sale_id: f.db.Sale[0].id, owner_pin: pin, reason: 'Mock tea refund' };
  const returned = await f.invoke(saleFile, refund);
  assert.equal(returned.status, 200, JSON.stringify(returned));
  assert.equal(stock(f, 'water'), 10000);
  assert.equal(stock(f, 'berries'), 10000);
  assert.deepEqual(f.db.SaleItem, original);
  assert.equal((await f.invoke(saleFile, refund)).status, 409);
  assert.equal(stock(f, 'water'), 10000);
});

// Exercise the actual POS click handlers without a live POS session.
const source = readFileSync('src/pages/POS.jsx', 'utf8');
const callbacks = source.slice(source.indexOf('  const addToCart = useStableEvent((product) => {'),
  source.indexOf('  useEffect(() => { setTeaProduct(null);'));
function pos() {
  const ctx = { ...burger, ...tea, catalogShopId: shopId, cart: [], teaProduct: null,
    burgerProduct: null, tableLocked: false, paying: false, payOpen: false, stockChecking: false,
    useStableEvent: cb => cb,
    setCart: update => { ctx.cart = update(ctx.cart); },
    setTeaProduct: value => { ctx.teaProduct = value; },
    setBurgerProduct: value => { ctx.burgerProduct = value; },
    setKeyboardProductId: value => { ctx.selectedKey = value; },
    openWeight: () => { throw new Error('Unexpected weight dialog'); },
  };
  vm.runInNewContext(callbacks + '\nglobalThis.api = { addToCart, saveTeaChoice };', ctx);
  return ctx;
}
test('tea click waits for a choice, merges matching servings and keeps cup separate from pot', () => {
  const ctx = pos();
  const product = { id: teaId, name: 'Yagodniy choy', price: 28000 };
  ctx.api.addToCart(product);
  assert.equal(ctx.cart.length, 0);
  assert.equal(ctx.teaProduct.id, teaId);
  ctx.api.saveTeaChoice('cup');
  ctx.api.addToCart(product); ctx.api.saveTeaChoice('pot');
  ctx.api.addToCart(product); ctx.api.saveTeaChoice('cup');
  assert.equal(ctx.cart.length, 2);
  assert.equal(ctx.cart[0].quantity, 2);
  assert.equal(ctx.cart[0].price, 14000);
  assert.equal(ctx.cart[0].subtotal, 28000);
  assert.equal(ctx.cart[1].price, 28000);
  assert.notEqual(saleLineKey(ctx.cart[0]), saleLineKey(ctx.cart[1]));
  assert.equal(ctx.selectedKey, saleLineKey(ctx.cart[0]));
  assert.equal(ctx.teaProduct, null);
});

test('cancelled, locked and stale-shop tea choices cannot add a cart line', () => {
  const product = { id: teaId, name: 'Yagodniy choy', price: 28000 };
  const ctx = pos();
  ctx.api.addToCart(product); ctx.setTeaProduct(null); ctx.api.saveTeaChoice('cup');
  assert.equal(ctx.cart.length, 0);
  ctx.tableLocked = true; ctx.api.addToCart(product);
  assert.equal(ctx.teaProduct, null);
  ctx.tableLocked = false; ctx.api.addToCart(product); ctx.catalogShopId = 'another-shop';
  ctx.api.saveTeaChoice('cup');
  assert.equal(ctx.cart.length, 0);
});

test('tea previews reprice cup and pot from shop prices without altering old rows', () => {
  const original = [{ ...cup, price: 15000, subtotal: 15000 }, { ...pot, price: 30000, subtotal: 30000 }];
  const products = [{ id: teaId, price: 30000, shop_prices: { [shopId]: 28000 } }];
  const adjusted = tea.repriceTeaCartForShop(original, products, shopId);
  assert.equal(adjusted[0].price, 14000);
  assert.equal(adjusted[1].price, 28000);
  assert.equal(original[0].price, 15000);
  assert.equal(tea.repriceTeaCartForShop(adjusted, products, shopId), adjusted);
});
