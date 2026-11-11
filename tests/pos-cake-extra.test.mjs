// Offline integration through the real POS backend and browser order serializer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { buildPendingSale } from '../src/lib/offline-sales.js';
import * as options from '../src/lib/sale-options.js';
import * as burgers from '../src/lib/burger-fries.js';
import * as tea from '../src/lib/tea-options.js';

const cake = 'offline-cake';
const category = '6ab57e00ab3a0a5019ea99db';
const shop = 'offline-shop';
const now = '2026-11-11T08:00:00.000Z';
const endpoint = 'base44/functions/complete-sale/entry.ts';
function fixture() {
  return memoryBackend({
    User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Offline owner', shop_id: shop }],
    Shift: [{ id: 'shift', user_id: 'owner', shop_id: shop, shop_name: 'Offline shop', status: 'open',
      opened_at: '2026-11-11T07:00:00Z', expected_cash: 0, total_sales: 0, order_count: 0, sale_request_keys: [] }],
    Shop: [{ id: shop, name: 'Offline shop', location_type: 'shop', active: true, allows_pos: true,
      restaurant_table_count: 5, restaurant_table_orders: [], restaurant_table_orders_version: 0 }],
    Product: [{ id: cake, name: 'Offline Tort', category_id: category, sale_unit: 'piece',
      price: 120000, active: true, source_type: 'central_produced', track_stock: true }],
    ProductStock: [{ id: 'cake-stock', location_id: shop, product_id: cake, product_name: 'Offline Tort', quantity: 10 }],
    Recipe: [{ id: 'recipe', product_id: cake, active: true, version: 1, output_quantity: 1, output_unit: 'piece' }],
    RecipeItem: [{ id: 'ingredient-row', recipe_id: 'recipe', product_id: cake, ingredient_id: 'ingredient', quantity: 1, unit: 'piece' }],
    SupplierReceipt: [{ id: 'receipt', status: 'completed' }],
    SupplierReceiptItem: [{ id: 'purchase', receipt_id: 'receipt', ingredient_id: 'ingredient', base_quantity: 100, line_total: 5000000 }],
    Settings: [{ id: 'settings', allow_negative_stock: false }],
    Sale: [], SaleItem: [], Payment: [], StockMovement: [], ActionHistory: [],
  }, { now });
}
const line = (extra, quantity = 1) => ({ product_id: cake, quantity, ...(extra ? { cake_extra: true } : {}) });
const request = (items, amount, key = 'offline-cake-order-one') => ({ action: 'complete_sale', shift_id: 'shift',
  idempotency_key: key, recorded_at: now, items, payments: [{ method: 'cash', amount }] });

test('the POS prompts before adding a cake and charges 125000 on the cake row itself', () => {
  const source = readFileSync(new URL('../src/pages/POS.jsx', import.meta.url), 'utf8');
  const callbacks = source.slice(source.indexOf('  const addToCart = useStableEvent((product) => {'),
    source.indexOf('  useEffect(() => { setTeaProduct(null);'));
  const ctx = { ...burgers, ...tea, ...options, catalogShopId: shop,
    cart: [], cakeExtraProduct: null, burgerProduct: null, teaProduct: null, tableLocked: false, paying: false, payOpen: false, stockChecking: false,
    useStableEvent: callback => callback, setKeyboardProductId() {},
    setCakeExtraProduct: value => { ctx.cakeExtraProduct = value; },
    setCart: change => { ctx.cart = change(ctx.cart); },
  };
  vm.runInNewContext(callbacks + '\nglobalThis.api = { addToCart, saveCakeExtraChoice: typeof saveCakeExtraChoice === "function" ? saveCakeExtraChoice : null };', ctx);
  const product = fixture().db.Product[0];
  ctx.api.addToCart(product);
  assert.equal(ctx.cart.length, 0);
  assert.equal(ctx.cakeExtraProduct?.id, cake);
  ctx.api.saveCakeExtraChoice(true);
  assert.equal(ctx.cart.length, 1); assert.equal(ctx.cart[0].price, 125000);
  assert.equal(ctx.cart[0].subtotal, 125000); assert.equal(ctx.cart[0].product_id, cake);
  assert.equal(product.price, 120000);
  ctx.api.addToCart(product); ctx.api.saveCakeExtraChoice(false);
  ctx.api.addToCart(product); ctx.api.saveCakeExtraChoice(true);
  assert.equal(ctx.cart.length, 2);
  assert.equal(ctx.cart.find(row => row.cake_extra).quantity, 2);
  assert.equal(ctx.cart.find(row => !row.cake_extra).price, 120000);
  ctx.api.addToCart(product); ctx.setCakeExtraProduct(null); ctx.api.saveCakeExtraChoice(true);
  assert.equal(ctx.cart.find(row => row.cake_extra).quantity, 2);
});

test('server charges the shop catalogue price plus 5000 per chosen cake and keeps original cost and stock', async () => {
  const f = fixture();
  const body = request([line(false), { ...line(true, 2), price: 1 }], 370000);
  const result = await f.invoke(endpoint, body);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(f.db.Sale[0].total, 370000);
  assert.equal(f.db.SaleItem.length, 2);
  assert.equal(f.db.SaleItem.find(row => !row.cake_extra).unit_price, 120000);
  const chosen = f.db.SaleItem.find(row => row.cake_extra);
  assert.equal(chosen.unit_price, 125000); assert.equal(chosen.quantity, 2);
  assert.equal(chosen.unit_cost_at_sale, 50000);
  assert.equal(f.db.ProductStock[0].quantity, 7);
  assert.equal(f.db.Product[0].price, 120000);
  assert.equal((await f.invoke(endpoint, body)).status, 200);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.ProductStock[0].quantity, 7);
  const changed = await f.invoke(endpoint, { ...body, items: [line(false, 3)] });
  assert.equal(changed.status, 409); assert.equal(f.db.Sale.length, 1);
});

test('arbitrary surcharge values, non-cakes and weight products cannot use the option', async () => {
  for (const mode of ['amount', 'not-cake', 'by-weight']) {
    for (const tender of [120000, 125000]) {
      const f = fixture(); const item = line(true, mode === 'by-weight' ? 1000 : 1);
      if (mode === 'amount') item.cake_extra = 5000;
      if (mode === 'not-cake') f.db.Product[0].category_id = 'other-category';
      if (mode === 'by-weight') f.db.Product[0].sale_unit = 'gram';
      const result = await f.invoke(endpoint, request([item], tender));
      assert.equal(result.status, 400, `${mode}, ${tender}: ${JSON.stringify(result.data)}`);
      assert.equal(f.db.Sale.length, 0); assert.equal(f.db.ProductStock[0].quantity, 10);
    }
  }
});

test('offline queue preserves the cake option and synchronizes the same single 125000 item', async () => {
  const f = fixture();
  const pending = buildPendingSale({ idempotencyKey: 'offline-cake-sync-one', recordedAt: now, shift: f.db.Shift[0], user: f.db.User[0],
    cart: [{ ...line(true), product_name: 'Offline Tort', price: 125000 }], payments: [{ method: 'cash', amount: 125000 }] });
  assert.deepEqual(pending.request.items, [line(true)]);
  assert.equal(pending.local_sale.items.length, 1); assert.equal(pending.local_sale.items[0].price, 125000);
  const result = await f.invoke(endpoint, pending.request);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(f.db.SaleItem[0].unit_price, 125000); assert.equal(f.db.ProductStock[0].quantity, 9);
});

test('saved table cake keeps its 125000 price even if the catalogue price later changes', async () => {
  const f = fixture(); let handler;
  const schema = JSON.parse(readFileSync(new URL('../base44/entities/Shop.jsonc', import.meta.url), 'utf8'));
  const itemSchema = schema.properties.restaurant_table_orders.items.properties.items.items.properties;
  const update = f.entities.Shop.updateMany;
  f.entities.Shop.updateMany = async (query, ops) => {
    for (const order of ops.$set?.restaurant_table_orders || []) {
      for (const item of order.items || []) {
        if (item.cake_extra !== undefined && itemSchema.cake_extra?.type !== 'boolean') {
          throw Object.assign(new Error('Offline Shop schema does not store cake_extra'), { status: 400 });
        }
      }
    }
    return update(query, ops);
  };
  f.load('base44/functions/restaurant-tables/entry.ts', { Deno: { serve: cb => { handler = cb; } } });
  const items = [line(true)];
  const response = await handler({ json: async () => ({ action: 'save_table_order', shop_id: shop, shift_id: 'shift',
    table_number: 1, expected_revision: 0, items }) });
  const saved = await response.json();
  assert.equal(response.status, 200, JSON.stringify(saved));
  assert.equal(saved.order.items.length, 1); assert.equal(saved.order.items[0].price, 125000);
  assert.equal(saved.order.items[0].cake_extra, true); assert.equal(f.db.Sale.length, 0);
  f.db.Product[0].price = 130000;
  const result = await f.invoke(endpoint, { ...request(items, 125000), table_shop_id: shop, table_number: 1,
    table_order_id: saved.order.id, table_order_revision: saved.order.revision });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(f.db.SaleItem[0].unit_price, 125000); assert.equal(f.db.ProductStock[0].quantity, 9);
});

test('the current shop price is authoritative for a cake with the fixed extra', async () => {
  const f = fixture();
  f.db.Product[0].shop_prices = { [shop]: 130000 };
  const cart = [{ ...line(true, 2), price: 125000, subtotal: 250000 }];
  const repriced = options.repriceCakeCartForShop(cart, f.db.Product, shop);
  assert.equal(repriced[0].price, 135000); assert.equal(repriced[0].subtotal, 270000);
  assert.equal(cart[0].price, 125000);
  const result = await f.invoke(endpoint, request([{ ...line(true), price: 125000 }], 135000));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(f.db.SaleItem[0].unit_price, 135000);
  assert.equal(f.db.Product[0].price, 120000); assert.equal(f.db.Product[0].shop_prices[shop], 130000);
});

test('cake sale and refund keep canonical product labels and restore exactly one unit', async () => {
  const f = fixture(); const pin = '2468'; const salt = 'offline-only';
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  f.db.SecuritySettings = [{ id: 'pin', key: 'owner_approval_pin', pin_salt: salt,
    pin_hash: Buffer.from(bits).toString('hex'), pin_algorithm: 'PBKDF2-SHA256', pin_iterations: 100000 }];
  const completed = await f.invoke(endpoint, request([line(true)], 125000));
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  assert.equal(f.db.ProductStock[0].product_name, 'Offline Tort');
  assert.equal(f.db.ProductStock[0].quantity, 9);
  const snapshot = structuredClone(f.db.SaleItem[0]);
  assert.equal(snapshot.product_name_snapshot, 'Offline Tort');
  assert.equal(snapshot.unit_price, 125000); assert.equal(snapshot.cake_extra, true);
  const refund = await f.invoke(endpoint, { action: 'refund_sale', sale_id: f.db.Sale[0].id, owner_pin: pin, reason: 'Offline return' });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  assert.equal(f.db.ProductStock[0].product_name, 'Offline Tort'); assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal(f.db.Shift[0].expected_cash, 0);
  assert.deepEqual(f.db.SaleItem[0], snapshot);
  assert.deepEqual(f.db.StockMovement.filter(row => row.item_id === cake).map(row => row.item_name), ['Offline Tort', 'Offline Tort']);
});

test('offline checkout compares plain and extra cake quantities with one stock balance', async () => {
  const source = readFileSync(new URL('../src/pages/POS.jsx', import.meta.url), 'utf8');
  const warning = source.slice(source.indexOf('  const confirmStockWarnings = async'), source.indexOf('  const openPayment = (offline)'));
  const checkout = source.slice(source.indexOf('  const openOfflinePayment = async'), source.indexOf('  const openCheckout = async'));
  const alerts = [], opened = [];
  const ctx = { selectedTable: null, takeawayOrder: null, takeawayRequestIdRef: { current: '' }, discountCode: '', roundingTarget: null,
    cart: [{ ...line(false), product_name: 'Offline Tort' }, { ...line(true), product_name: 'Offline Tort' }],
    productsById: { [cake]: { name: 'Offline Tort', track_stock: true } }, stockByProduct: { [cake]: 1 },
    settings: { allow_negative_stock: false }, SHOW_NEGATIVE_STOCK_CONFIRMATION: false,
    odinaAlert: async (_message, options) => { alerts.push(options); }, openPayment: value => opened.push(value),
  };
  vm.runInNewContext(warning + checkout + '\nglobalThis.checkout = openOfflinePayment;', ctx);
  assert.equal(await ctx.checkout(), false); assert.deepEqual(opened, []);
  assert.match(alerts[0].details, /2 ta kerak, 1 ta mavjud/);
  ctx.stockByProduct[cake] = 2;
  assert.equal(await ctx.checkout(), true); assert.deepEqual(opened, [true]);
  ctx.stockByProduct[cake] = 1; ctx.settings.allow_negative_stock = true;
  assert.equal(await ctx.checkout(), true); assert.deepEqual(opened, [true, true]);
});
