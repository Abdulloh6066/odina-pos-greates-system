// Offline only: this harness never imports the Base44 SDK or uses network/live data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { makeWasteRow, submitWasteRows, validateWasteRows, wasteRequest, wasteDateTime } from '../src/lib/waste.js';

const NOW = Date.parse('2026-09-11T08:00:00.000Z');
const HOUR = 3600000;
const stamp = (hours) => new Date(NOW - hours * HOUR).toISOString();
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}

function fixture() {
  const db = {
    User: [{ id: 'cashier', role: 'cashier', shop_id: 'shop', full_name: 'Test cashier', email: 'cashier@example.test', active: true }],
    Shop: [
      { id: 'shop', name: 'Test shop', active: true },
      { id: 'other', name: 'Other shop', active: true },
      { id: 'central', name: 'Production', active: true, location_type: 'production', allows_pos: false },
    ],
    Product: [
      { id: 'cake', name: 'Cake', price: 45000, active: true, track_stock: true },
      { id: 'bread', name: 'Bread', price: 10000, active: true, track_stock: true },
    ],
    ProductStock: [
      { id: 'cake-stock', location_id: 'shop', product_id: 'cake', product_name: 'Cake', quantity: 10, unit: 'piece', updated_at: stamp(1), updated_date: stamp(1) },
      { id: 'bread-stock', location_id: 'shop', product_id: 'bread', product_name: 'Bread', quantity: 5, unit: 'piece', updated_at: stamp(1), updated_date: stamp(1) },
      { id: 'other-stock', location_id: 'other', product_id: 'cake', quantity: 20, unit: 'piece' },
    ],
    StockTransfer: [
      { id: 'old', status: 'received', destination_location_id: 'shop', product_id: 'cake', received_quantity: 4, received_at: stamp(80) },
      { id: 'soon', status: 'received', destination_location_id: 'shop', product_id: 'cake', received_quantity: 4, received_at: stamp(60) },
      { id: 'fresh', status: 'received', destination_location_id: 'shop', product_id: 'cake', received_quantity: 2, received_at: stamp(24) },
      { id: 'other-old', status: 'received', destination_location_id: 'other', product_id: 'cake', received_quantity: 20, received_at: stamp(90) },
    ],
    WasteRecord: [], StockMovement: [], ActionHistory: [],
  };
  const runtime = memoryBackend(db, { now: new Date(NOW).toISOString(), copySeed: false });
  // Export the private pure helper only inside the test module; application source stays intact.
  const source = readFileSync('base44/functions/waste-ledger/entry.ts', 'utf8');
  const helperEnd = source.indexOf('const getRetailShops =');
  assert.ok(helperEnd > source.indexOf('const ageSummary ='));
  const helperSource = source.slice(0, helperEnd).replace(/^import .+;$/gm, '') + '\nglobalThis.testAgeSummary = ageSummary;';
  const context = vm.createContext({ Date: FixedDate });
  vm.runInContext(ts.transpileModule(helperSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
  return { db, entities: runtime.entities,
    call: (body) => runtime.invoke('base44/functions/waste-ledger/entry.ts', body), age: context.testAgeSummary };
}
const bodyFor = (f, productId = 'cake', quantity = 2) => {
  const stock = f.db.ProductStock.find((row) => row.location_id === 'shop' && row.product_id === productId);
  return {
    action: 'create_waste', location_id: 'shop', product_id: productId, quantity, reason_code: 'damaged',
    request_id: webcrypto.randomUUID(), expected_quantity: stock.quantity,
    expected_stock_version: stock.updated_date || stock.updated_at || '',
  };
};

test('expiry and next-24-hour quantities use remaining FIFO stock without mixing shops', async () => {
  const f = fixture();
  const response = await f.call({ action: 'get_context' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.shops.map((shop) => shop.id), ['shop']);
  assert.equal(response.data.expired_items[0].expired_quantity, 4);
  assert.equal(response.data.near_expiry_items[0].near_expiry_quantity, 4);
  assert.equal(response.data.near_expiry_items[0].next_expires_at, new Date(NOW + 12 * HOUR).toISOString());
  assert.ok(response.data.stock_items.every((item) => item.location_id === 'shop'));
  const remaining = f.age({ ...f.db.ProductStock[0], quantity: 7 }, f.db.StockTransfer, NOW);
  assert.equal(remaining.expired_quantity, 1);
  assert.equal(remaining.near_expiry_quantity, 4);
});

test('exact 72h and 48h boundaries are classified once; untracked stock is not labelled fresh', () => {
  const f = fixture();
  const transfers = [72, 48, 47].map((hours, index) => ({
    status: 'received', destination_location_id: 'shop', product_id: 'cake',
    received_quantity: 1, received_at: stamp(hours), id: String(index),
  }));
  const age = f.age({ location_id: 'shop', product_id: 'cake', quantity: 5 }, transfers, NOW);
  assert.equal(age.expired_quantity, 1);
  assert.equal(age.near_expiry_quantity, 1);
  assert.equal(age.untracked_quantity, 2);
});

test('new request deducts exactly once and saves the trusted shop, employee, reason and movement', async () => {
  const f = fixture();
  const body = { ...bodyFor(f), recorded_by_id: 'forged', location_id: 'other' };
  const response = await f.call(body);
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(f.db.ProductStock[0].quantity, 8);
  assert.equal(f.db.ProductStock[2].quantity, 20);
  assert.equal(response.data.waste.location_id, 'shop');
  assert.equal(response.data.waste.recorded_by_id, 'cashier');
  assert.equal(response.data.waste.reason_label, 'Shikastlangan');
  assert.equal(response.data.waste.request_id, body.request_id);
  assert.equal(f.db.StockMovement[0].quantity_change, -2);
});

test('retrying an already committed request replays the original record', async () => {
  const f = fixture();
  const body = bodyFor(f);
  const first = await f.call(body);
  const retry = await f.call(body);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.waste.id, first.data.waste.id);
  assert.equal(f.db.ProductStock[0].quantity, 8);
  assert.equal(f.db.WasteRecord.length, 1);
  assert.equal(f.db.StockMovement.length, 1);
});

test('concurrent identical submissions cannot double-deduct', async () => {
  const f = fixture();
  const body = bodyFor(f);
  const responses = await Promise.all([f.call(body), f.call(body)]);
  assert.ok(responses.some((response) => response.status === 200));
  assert.ok(responses.every((response) => [200, 409].includes(response.status)));
  assert.equal(f.db.WasteRecord.length, 1);
  assert.equal(f.db.ProductStock[0].quantity, 8);
});

test('request identifiers cannot be reused with a different quantity', async () => {
  const f = fixture();
  const body = bodyFor(f);
  await f.call(body);
  assert.equal((await f.call({ ...body, quantity: 3 })).status, 409);
  assert.equal(f.db.ProductStock[0].quantity, 8);
});

test('stale stock version is rejected even if the quantity has returned to its old value', async () => {
  const f = fixture();
  const body = bodyFor(f);
  f.db.ProductStock[0].updated_date = stamp(0);
  assert.equal((await f.call(body)).status, 409);
  assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal(f.db.WasteRecord.length, 0);
});

test('too much expired stock and fractional quantities are rejected without mutation', async () => {
  const f = fixture();
  assert.equal((await f.call({ ...bodyFor(f, 'cake', 5), reason_code: 'expired' })).status, 409);
  assert.equal((await f.call({ ...bodyFor(f), quantity: 1.0001 })).status, 400);
  assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal(f.db.WasteRecord.length, 0);
});

test('expired stock is deducted first by the existing age calculation', async () => {
  const f = fixture();
  assert.equal((await f.call({ ...bodyFor(f, 'cake', 4), reason_code: 'expired' })).status, 200);
  const response = await f.call({ action: 'get_context' });
  assert.equal(response.data.expired_items.length, 0);
  assert.equal(response.data.near_expiry_items[0].near_expiry_quantity, 4);
});

test('cashiers cannot cancel; an admin cancellation restores stock once and retains the request history', async () => {
  const f = fixture();
  const body = bodyFor(f);
  const created = await f.call(body);
  const cancel = { action: 'cancel_waste', waste_id: created.data.waste.id };
  assert.equal((await f.call(cancel)).status, 403);
  f.db.User[0].role = 'admin';
  assert.equal((await f.call(cancel)).status, 200);
  assert.equal((await f.call(cancel)).status, 409);
  assert.equal((await f.call(body)).data.replayed, true);
  assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal(f.db.WasteRecord[0].status, 'cancelled');
});

test('unauthorized roles and inactive users cannot access or change waste', async () => {
  const f = fixture();
  const body = bodyFor(f);
  f.db.User[0].role = 'production';
  assert.equal((await f.call({ action: 'get_context' })).status, 403);
  assert.equal((await f.call(body)).status, 403);
  f.db.User[0].role = 'cashier';
  f.db.User[0].active = false;
  assert.equal((await f.call(body)).status, 403);
  assert.equal(f.db.WasteRecord.length, 0);
});

test('record creation failure restores the stock without creating or deleting any records', async () => {
  const f = fixture();
  f.entities.WasteRecord.create = async () => { throw new Error('Simulated write failure'); };
  assert.equal((await f.call(bodyFor(f))).status, 500);
  assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal(f.db.WasteRecord.length, 0);
  assert.equal(f.db.StockMovement.length, 0);
});

test('batch retries only remaining rows and recovers a lost successful response without duplication', async () => {
  const f = fixture();
  const first = { product_id: 'cake', attempt: bodyFor(f) };
  const second = { product_id: 'bread', attempt: bodyFor(f, 'bread') };
  let loseResponse = true;
  const invoke = async (body) => {
    const response = await f.call(body);
    if (response.status >= 400) throw { response: { data: response.data } };
    if (body.product_id === 'bread' && loseResponse) {
      loseResponse = false;
      throw new Error('Simulated lost response');
    }
    return { data: response.data };
  };
  const selected = new Map([[first.product_id, first], [second.product_id, second]]);
  const update = (result) => { if (result.ok) selected.delete(result.product_id); };
  const results = await submitWasteRows([...selected.values()], invoke, update);
  assert.deepEqual(results.map((result) => result.ok), [true, false]);
  assert.deepEqual([...selected.keys()], ['bread']);
  const retried = await submitWasteRows([...selected.values()], invoke, update);
  assert.equal(retried[0].ok, true);
  assert.equal(selected.size, 0);
  assert.equal(f.db.WasteRecord.length, 2);
  assert.equal(f.db.ProductStock[0].quantity, 8);
  assert.equal(f.db.ProductStock[1].quantity, 3);
});

test('draft validation keeps per-item reasons and freezes the original retry payload', () => {
  const item = { product_id: 'cake', product_name: 'Cake', quantity: 10, expired_quantity: 4, stock_version: 'v1' };
  const row = makeWasteRow(item, { quantity: 4, reason_code: 'expired' });
  assert.equal(validateWasteRows([row]), '');
  assert.ok(validateWasteRows([{ ...row, quantity: 5 }]));
  assert.ok(validateWasteRows([{ ...row, quantity: '1.5' }]));
  assert.ok(validateWasteRows([row, row]));
  const original = wasteRequest(row, 'shop', 'Original note', '');
  assert.deepEqual(wasteRequest({ ...row, attempt: original }, 'other', 'Edited', 'https://example.test/image'), original);
});

test('business dates are displayed in Tashkent time', () => {
  const text = wasteDateTime('2026-09-10T21:30:00.000Z');
  assert.match(text, /11/);
  assert.match(text, /02:30/);
  assert.equal(wasteDateTime('invalid'), '—');
});
