import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
const file = 'base44/functions/complete-sale/entry.ts';
const shop = '6a96f0a4ecc85c2fc57f3173';
const make = () => memoryBackend({
 User: [{ id: 'cashier', role: 'cashier', shop_id: shop, active: true }],
 Shop: [{ id: shop, name: 'Central', active: true, allows_pos: true, location_type: 'shop' }],
 Shift: [{ id: 'shift', user_id: 'cashier', shop_id: shop, shop_name: 'Central', status: 'open', opened_at: '2026-09-27T06:00:00Z', sale_request_keys: [], expected_cash: 0, total_sales: 0, order_count: 0 }],
 Product: [{ id: 'cake', name: 'Cake', price: 100000, source_type: 'central_produced', active: true, track_stock: true }],
 ProductStock: [{ id: 'stock', product_id: 'cake', location_id: shop, unit: 'piece', quantity: 10 }],
 Settings: [{ id: 'settings', allow_negative_stock: false }],
 Sale: [], SaleItem: [], Payment: [], StockMovement: [], ActionHistory: [], Recipe: [],
});
const body = (suffix, recorded = '2026-09-27T06:30:00Z') => ({
 action: 'complete_sale', shift_id: 'shift', idempotency_key: 'pos-backlog-pacing-' + suffix, recorded_at: recorded,
 items: [{ product_id: 'cake', quantity: 1 }], payments: [{ method: 'cash', amount: 100000 }],
});
test('older Central receipts reserve a slot; a waiting receipt has no payment claim or inventory write', async () => {
 const f = make();
 assert.equal((await f.invoke(file, body('first'))).status, 200);
 const before = f.db.ProductStock[0].quantity;
 const r = await f.invoke(file, body('second'));
 assert.equal(r.status, 429); assert.ok(r.data.retry_after_ms > 0);
 assert.equal(f.db.ProductStock[0].quantity, before);
 assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
 assert.equal(f.db.Shift[0].sale_request_keys.includes(body('second').idempotency_key), false);
 f.db.Shift[0].checkout_queue_resume_ms = 0;
 assert.equal((await f.invoke(file, body('second'))).status, 200);
 assert.equal(f.db.ProductStock[0].quantity, 8);
 assert.equal(f.db.Shift[0].order_count, 2);
});
test('confirmed replay bypasses backlog pacing without another deduction', async () => {
 const f = make();
 await f.invoke(file, body('replay'));
 const r = await f.invoke(file, body('replay'));
 assert.equal(r.status, 200); assert.equal(r.data.already_processed, true);
 assert.equal(f.db.ProductStock[0].quantity, 9);
 assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
});
test('a fresh Central checkout remains available during older backlog pacing', async () => {
 const f = make();
 await f.invoke(file, body('old'));
 const r = await f.invoke(file, body('fresh', '2026-09-27T07:00:00Z'));
 assert.equal(r.status, 200, JSON.stringify(r.data));
 assert.equal(f.db.Sale.length, 2); assert.equal(f.db.ProductStock[0].quantity, 8);
});
test('two concurrent older requests cannot both reserve the same slot', async () => {
 const f = make();
 const results = await Promise.all([f.invoke(file, body('concurrent-a')), f.invoke(file, body('concurrent-b'))]);
 assert.deepEqual(results.map(r => r.status).sort(), [200, 429]);
 assert.equal(f.db.ProductStock[0].quantity, 9);
 assert.equal(f.db.Shift[0].order_count, 1);
});
