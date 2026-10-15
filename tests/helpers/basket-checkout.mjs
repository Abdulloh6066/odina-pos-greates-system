// Isolated checkout fixture: real handler/modules, in-memory records, no SDK/network.
import { memoryBackend } from './memory-backend.mjs';
import { performance } from 'node:perf_hooks';
export const checkoutEntry = 'base44/functions/complete-sale/entry.ts';
export const branchId = '6a96f0a4ecc85c2fc57f3174';
export const quiet = { log() {}, info() {}, warn() {}, error() {} };
export function basketCheckoutFixture(store = 'Branch', ingredientCount = 2, unrelatedCount = 900) {
  const shopId = store === 'Branch' ? branchId : 'mock-central';
  const ingredients = [
    ['milk', 100, 'ml', 1], ['coffee', 18, 'g', 10], ['sugar', 5, 'g', 1],
    ['vanilla', 2, 'ml', 2], ['water', 50, 'ml', 1], ['cup', 1, 'piece', 100],
  ].slice(0, ingredientCount);
  const receipts = ingredients.map(([id]) => ({ id: id + '-receipt', status: 'confirmed', received_at: '2026-09-26' }));
  const prices = ingredients.map(([id, , , price]) => ({ id: id + '-price', ingredient_id: id,
    receipt_id: id + '-receipt', base_quantity: 1000, line_total: price * 1000, created_date: '2026-09-26' }));
  for (let index = 0; index < unrelatedCount; index++) {
    const id = 'unrelated-' + index;
    prices.push({ id, ingredient_id: 'not-in-basket-' + index, receipt_id: 'unrelated-receipt',
      base_quantity: 1, line_total: 99999, created_date: '2026-09-25' });
  }
  receipts.push({ id: 'unrelated-receipt', status: 'confirmed', received_at: '2026-09-25' });
  const f = memoryBackend({
    User: [{ id: 'mock-cashier', role: 'cashier', shop_id: shopId, active: true }],
    Shop: [{ id: shopId, name: 'Mock ' + store, active: true, location_type: 'shop', allows_pos: true,
      service_ticket_cycle_active: true, service_ticket_counter: 0, service_ticket_version: 0 }],
    Shift: [{ id: 'mock-shift', user_id: 'mock-cashier', shop_id: shopId, shop_name: 'Mock ' + store,
      status: 'open', opened_at: '2026-09-27T06:00:00Z', total_sales: 0, expected_cash: 0,
      order_count: 0, sale_request_keys: [] }],
    Product: [{ id: 'cappuccino', name: 'Mock Cappuccino', price: 20000, source_type: ingredientCount ? 'shop_prepared' : 'resale',
      sale_unit: 'piece', active: true, track_stock: true }],
    ProductStock: [{ id: 'cappuccino-stock', product_id: 'cappuccino', location_id: shopId, quantity: 100 }],
    Recipe: ingredientCount ? [{ id: 'cappuccino-recipe', product_id: 'cappuccino', active: true, version: 1, output_quantity: 1, output_unit: 'piece' }] : [],
    RecipeItem: ingredients.map(([id, quantity, unit], position) => ({ id: id + '-recipe-item', recipe_id: 'cappuccino-recipe',
      ingredient_id: id, ingredient_name_snapshot: 'Mock ' + id, quantity, unit, position })),
    IngredientStock: ingredients.map(([id, , unit]) => ({ id: id + '-stock', ingredient_id: id,
      ingredient_name: 'Mock ' + id, location_id: shopId, quantity: 100000, unit })),
    SupplierReceipt: receipts, SupplierReceiptItem: prices,
    Settings: [{ id: 'mock-settings', allow_negative_stock: false }],
    Sale: [], SaleItem: [], Payment: [], StockMovement: [], ActionHistory: [],
  });
  f.shopId = shopId; f.ingredients = ingredients; f.reads = [];
  for (const entityName of ['SupplierReceipt', 'SupplierReceiptItem']) {
    for (const method of ['list', 'filter']) {
      const original = f.entities[entityName][method];
      f.entities[entityName][method] = async (...args) => {
        const rows = await original(...args);
        f.reads.push({ entityName, method, args: structuredClone(args), rows: rows.length });
        return rows;
      };
    }
  }
  f.request = { action: 'complete_sale', shift_id: 'mock-shift', idempotency_key: 'mock-basket-checkout-001',
    recorded_at: '2026-09-27T07:00:00Z', items: [{ product_id: 'cappuccino', quantity: 1 }],
    payments: [{ method: 'cash', amount: 20000 }] };
  f.modules = f.load(checkoutEntry, { performance, console: quiet });
  f.call = (body = f.request) => f.invoke(checkoutEntry, body, { performance, console: quiet });
  return f;
}
