// Memory-only regression tests: no live SDK, sales, shifts or inventory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { memoryBackend } from './helpers/memory-backend.mjs';
import * as queue from '../src/lib/offline-sales.js';

const endpoint = 'base44/functions/complete-sale/entry.ts';
const request = () => ({ action: 'complete_sale', shift_id: 'shift',
  items: [{ product_id: 'cake', quantity: 1 }], payments: [{ method: 'cash', amount: 65000 }],
  idempotency_key: 'pos-central-pending-000001', recorded_at: '2026-09-27T06:30:00Z' });
const pinKey = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('1234'), 'PBKDF2', false, ['deriveBits']);
const pinHash = Buffer.from(await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256',
  salt: new TextEncoder().encode('test-salt'), iterations: 100000 }, pinKey, 256)).toString('hex');
function fixture(status = 'open') {
  const f = memoryBackend({
    User: [{ id: 'staff', email: 'staff@example.test', role: 'cashier', active: true, shop_id: 'shop' }],
    Shop: [{ id: 'shop', name: 'Central', active: true, location_type: 'shop' }],
    Shift: [{ id: 'shift', user_id: 'staff', shop_id: 'shop', status, opened_at: '2026-09-27T06:00:00Z',
      ...(status === 'closed' ? { closed_at: '2026-09-27T06:55:00Z' } : {}), sale_request_keys: [],
      total_sales: 0, cash_sales: 0, expected_cash: 0, order_count: 0 }],
    Product: [{ id: 'cake', name: 'Cake', price: 75000, active: true, source_type: 'central_produced', track_stock: true }],
    ProductStock: [{ id: 'stock', location_id: 'shop', product_id: 'cake', quantity: 10, unit: 'piece' }],
    Settings: [{ allow_negative_stock: true }],
    SecuritySettings: [{ key: 'owner_approval_pin', pin_hash: pinHash, pin_salt: 'test-salt',
      pin_algorithm: 'PBKDF2-SHA256', pin_iterations: 100000 }],
  });
  const call = body => f.invoke(endpoint, body);
  const inspect = extra => call({ action: 'inspect_pending_sale', original_request: request(), ...extra });
  const resolve = (operation, extra = {}) => call({ action: 'resolve_pending_sale', operation,
    original_request: request(), owner_pin: '1234', reason: 'Central order review', ...extra });
  return { ...f, call, inspect, resolve };
}
test('staff can inspect the full price mismatch without a PIN or financial writes', async () => {
  const f = fixture(); const result = await f.inspect();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.state, 'pending');
  assert.equal(result.data.subtotal, 75000);
  assert.equal(result.data.paid_total, 65000);
  assert.equal(f.calls.length, 0);
});
test('editing and cancellation both require the server-verified owner PIN', async () => {
  for (const operation of ['edit', 'cancel']) {
    const f = fixture();
    const result = await f.resolve(operation, { owner_pin: '9999', final_total: 65000 });
    assert.equal(result.status, 403);
    assert.equal(f.db.Shift[0].sale_request_keys.length, 0);
    assert.equal(f.db.Sale?.length || 0, 0);
  }
});
test('bulk cancellation requires one owner PIN and preserves closed-shift finances', async () => {
  const f = fixture('closed');
  const originals = [request(), { ...request(), idempotency_key: 'pos-central-pending-000002' }];
  const body = { action: 'cancel_pending_sales', original_requests: originals, reason: 'Clear retained queue', owner_pin: '9999' };
  assert.equal((await f.call(body)).status, 403);
  assert.equal(f.db.Shift[0].pos_queue_resolutions_json, undefined);
  const result = await f.call({ ...body, owner_pin: '1234' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.results.length, 2);
  assert.ok(result.data.results.every(row => row.state === 'cancelled'));
  assert.equal(f.db.Shift[0].status, 'closed');
  assert.equal(f.db.Shift[0].total_sales, 0);
  assert.equal(f.db.ProductStock[0].quantity, 10);
  for (const original of originals) assert.equal((await f.call(original)).status, 410);
  const replay = await f.call({ ...body, owner_pin: '1234' });
  assert.equal(replay.data.results.length, 2);
  assert.equal(Object.keys(JSON.parse(f.db.Shift[0].pos_queue_resolutions_json)).length, 2);
});
test('bulk cancellation retains processing sales and acknowledges completed sales without deleting them', async () => {
  const f = fixture();
  const original = request(), processing = { ...request(), idempotency_key: 'pos-central-processing-000002' };
  f.db.Shift[0].sale_request_keys.push(processing.idempotency_key);
  f.db.Sale = [{ id: 'saved', idempotency_key: original.idempotency_key,
    user_id: 'staff', shift_id: 'shift', shop_id: 'shop', total: 65000 }];
  const result = await f.call({ action: 'cancel_pending_sales', original_requests: [original, processing],
    reason: 'Clear queue', owner_pin: '1234' });
  assert.equal(result.status, 200);
  assert.equal(result.data.results[0].state, 'confirmed');
  assert.equal(result.data.errors.length, 1);
  assert.equal(f.db.Sale.length, 1);
  assert.equal(f.db.Shift[0].pos_queue_resolutions_json, undefined);
});
test('bulk local management touches only the explicitly selected snapshot after server approval', async () => {
  assert.equal(typeof queue.managePendingSales, 'function');
  const one = { id: 'pos-selected-snapshot-00001', user_id: 'staff', shift_id: 'shift', request: request() };
  const later = { ...one, id: 'pos-later-arrival-00002' }, applied = [];
  const storage = { list: async () => [one, later], resolve: async record => applied.push(record.id) };
  const result = await queue.managePendingSales({ userId: 'staff', ids: [one.id], storage,
    lock: work => work(), authorize: async records => ({ results: records.map(record => ({
      state: 'cancelled', original_key: record.id })), errors: [] }) });
  assert.deepEqual(applied, [one.id]);
  assert.equal(result.results.length, 1);
});
test('a later bulk request failure returns earlier acknowledgements for reconciliation', async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: 'pos-batch-pending-' + String(i).padStart(6, '0'),
    user_id: 'staff', shift_id: 'shift', request: request() }));
  let calls = 0, archived = 0, result;
  await assert.doesNotReject(async () => {
    result = await queue.managePendingSales({ userId: 'staff', ids: rows.map(row => row.id),
      lock: work => work(), storage: { list: async () => rows, resolve: async () => { archived++; } },
      authorize: async batch => {
        if (++calls > 1) throw new Error('second batch timeout');
        return { results: batch.map(row => ({ state: 'confirmed', original_key: row.id,
          sale: { id: 'saved-' + row.id, idempotency_key: row.id, user_id: 'staff', shift_id: 'shift' } })), errors: [] };
      } });
  });
  assert.equal(archived, 50);
  assert.equal(result.results.length, 50);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].original_key, rows[50].id);
});
test('a closed-shift pending sale can be cancelled without altering closed financial totals', async () => {
  const f = fixture('closed'); const before = structuredClone(f.db.Shift[0]);
  const result = await f.resolve('cancel');
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.state, 'cancelled');
  assert.equal(f.db.Shift[0].total_sales, before.total_sales);
  assert.equal(f.db.Shift[0].status, 'closed');
  assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal((await f.call(request())).status, 410);
  assert.equal((await f.inspect()).data.state, 'cancelled');
  assert.equal((await f.resolve('cancel')).data.state, 'cancelled');
});
test('PIN-approved edit keeps 65000, records a 10000 discount and sends exactly one repaired sale', async () => {
  const f = fixture(); const result = await f.resolve('edit', { final_total: 65000 });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const replacement = result.data.request;
  assert.notEqual(replacement.idempotency_key, request().idempotency_key);
  assert.equal(replacement.manual_discount_amount, 10000);
  assert.equal(replacement.payments[0].amount, 65000);
  assert.equal(f.db.Product[0].price, 75000);
  assert.equal((await f.call(request())).status, 410);
  assert.equal((await f.resolve('edit', { final_total: 65000 })).data.request.idempotency_key, replacement.idempotency_key);
  const saved = await f.call(replacement);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.sale.total, 65000);
  assert.equal((await f.call(replacement)).status, 200);
  assert.equal(f.db.Sale.length, 1);
  assert.equal(f.db.Shift[0].total_sales, 65000);
  assert.equal(f.db.ProductStock[0].quantity, 9);
});
test('a closed shift cannot be silently reopened or edited into a new shift', async () => {
  const f = fixture('closed'); const result = await f.resolve('edit', { final_total: 65000 });
  assert.equal(result.status, 409);
  assert.equal(f.db.Shift[0].status, 'closed');
  assert.equal(f.db.Shift[0].sale_request_keys.length, 0);
});
test('in-flight and already recorded sales cannot be cancelled or changed', async () => {
  for (const recorded of [false, true]) {
    const f = fixture();
    f.db.Shift[0].sale_request_keys.push(request().idempotency_key);
    if (recorded) f.db.Sale = [{ id: 'saved', user_id: 'staff', shift_id: 'shift', shop_id: 'shop',
      idempotency_key: request().idempotency_key, total: 65000 }];
    const result = await f.resolve('cancel');
    assert.equal(result.status, 409);
    assert.equal(f.db.Shift[0].pos_queue_resolutions_json, undefined);
    assert.equal(f.db.Sale?.length || 0, recorded ? 1 : 0);
  }
});
test('inspection and PIN approvals cannot cross staff/shop boundaries', async () => {
  const f = fixture(); f.db.Shift[0].user_id = 'another-staff';
  assert.equal((await f.inspect()).status, 403);
  assert.equal((await f.resolve('cancel')).status, 403);
});
test('editing cannot reuse a prior approval for a different final amount', async () => {
  const f = fixture(); await f.resolve('edit', { final_total: 65000 });
  assert.equal((await f.resolve('edit', { final_total: 60000 })).status, 409);
});
test('PIN edit preserves every legacy payment method accepted by checkout', async () => {
  for (const method of ['click', 'payme', 'other']) {
    const f = fixture(); const original = request(); original.payments[0].method = method;
    const result = await f.resolve('edit', { original_request: original, final_total: 65000 });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.request.payments[0].method, method);
  }
});
test('lost approval reply is recovered from the atomic journal without another edit', async () => {
  const f = fixture(); const update = f.entities.Shift.updateMany;
  let lost = false;
  f.entities.Shift.updateMany = async (query, ops) => {
    const result = await update(query, ops);
    if (!lost && ops.$set?.pos_queue_resolutions_json) { lost = true; throw new Error('reply lost'); }
    return result;
  };
  assert.equal((await f.resolve('edit', { final_total: 65000 })).status, 500);
  const inspection = await f.inspect();
  assert.equal(inspection.data.state, 'edited');
  const retry = await f.resolve('edit', { final_total: 65000 });
  assert.equal(retry.data.request.idempotency_key, inspection.data.request.idempotency_key);
  assert.equal(f.db.Shift[0].sale_request_keys.length, 1);
});
test('a checkout winning the race prevents the admin resolution from being saved', async () => {
  const f = fixture(); const update = f.entities.Shift.updateMany;
  f.entities.Shift.updateMany = async (query, ops) => {
    if (ops.$set?.pos_queue_resolutions_json) f.db.Shift[0].sale_request_keys.push(request().idempotency_key);
    return update(query, ops);
  };
  const result = await f.resolve('cancel');
  assert.equal(result.status, 409);
  assert.equal(f.db.Shift[0].pos_queue_resolutions_json, undefined);
});
test('local replacement preserves the original record and uses the approved final price', () => {
  const original = { id: request().idempotency_key, user_id: 'staff', shift_id: 'shift',
    created_at: request().recorded_at, request: request(), local_sale: { total: 65000 } };
  const replacement = { ...request(), idempotency_key: 'pos-replacement-000001', manual_discount_amount: 10000 };
  const [archive, edited] = queue.resolvedPendingRecords(original, { state: 'edited', original_key: original.id,
    final_total: 65000, subtotal: 75000, request: replacement, items: [{ product_name: 'Cake', quantity: 1, subtotal: 75000 }] });
  assert.equal(archive.status, 'superseded');
  assert.equal(archive.request.idempotency_key, original.id);
  assert.equal(edited.local_sale.total, 65000);
  assert.equal(edited.local_sale.discount_amount, 10000);
  assert.equal(edited.status, 'pending');
});
test('individual retry sends only the selected record', async () => {
  const rows = ['one', 'two'].map(id => ({ id, user_id: 'staff', status: 'failed', request: { idempotency_key: id } }));
  const sent = [];
  await queue.syncPendingSales({ userId: 'staff', recordId: 'two', retryFailed: true,
    send: async req => { sent.push(req.idempotency_key); return { sale: { id: 'saved' } }; },
    lock: work => work(), storage: { list: async () => rows, update: async () => {}, remove: async () => {} } });
  assert.deepEqual(sent, ['two']);
});
test('local queue management waits for server approval and atomically applies its response', async () => {
  assert.equal(typeof queue.managePendingSale, 'function');
  const record = { id: request().idempotency_key, user_id: 'staff', request: request(), local_sale: { total: 65000 } };
  let applied = 0;
  const storage = { list: async () => [record], resolve: async (row, result) => {
    assert.equal(row.id, record.id); assert.equal(result.state, 'cancelled'); applied++;
  } };
  await assert.rejects(queue.managePendingSale({ userId: 'staff', id: record.id, storage,
    lock: work => work(), authorize: async () => { throw new Error('wrong PIN'); } }));
  assert.equal(applied, 0);
  await queue.managePendingSale({ userId: 'staff', id: record.id, storage, lock: work => work(),
    authorize: async () => ({ state: 'cancelled', original_key: record.id }) });
  assert.equal(applied, 1);
});
test('a late sender cannot resurrect a PIN-cancelled record when Web Locks are unavailable', async () => {
  const rows = new Map();
  // Minimal asynchronous IndexedDB double with transaction completion ordering.
  const database = { transaction() {
    const tx = { objectStore: () => ({
      get: id => read(() => rows.get(id)), getAll: () => read(() => [...rows.values()]),
      put: row => rows.set(row.id, structuredClone(row)), delete: id => rows.delete(id),
    }), abort: () => { tx.aborted = true; queueMicrotask(() => tx.onabort?.()); } };
    setTimeout(() => { if (!tx.aborted) tx.oncomplete?.(); }, 0);
    return tx;
  } };
  const read = fn => { const result = {}; queueMicrotask(() => { result.result = structuredClone(fn()); result.onsuccess?.(); }); return result; };
  const previousIDB = globalThis.indexedDB, previousChannel = globalThis.BroadcastChannel;
  globalThis.indexedDB = { open: () => read(() => database) };
  // The database object includes methods, so open's result cannot be cloned.
  globalThis.indexedDB.open = () => { const result = {}; queueMicrotask(() => { result.result = database; result.onsuccess?.(); }); return result; };
  globalThis.BroadcastChannel = undefined;
  const id = 'pos-overlap-cancel-000001';
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  try {
    await queue.savePendingSale({ id, user_id: 'staff', shift_id: 'shift', status: 'pending',
      created_at: '2026-09-27T06:30:00Z', request: { ...request(), idempotency_key: id } });
    const sender = queue.syncPendingSales({ userId: 'staff', lock: work => work(), send: async () => {
      started(); await gate; throw Object.assign(new Error('cancelled'), { status: 410 });
    } });
    await entered;
    await queue.managePendingSale({ userId: 'staff', id, lock: work => work(),
      authorize: async () => ({ state: 'cancelled', original_key: id }) });
    release(); await sender;
    assert.equal(rows.get(id).status, 'cancelled');
    assert.equal((await queue.listPendingSales('staff')).length, 0);
  } finally { release(); globalThis.indexedDB = previousIDB; globalThis.BroadcastChannel = previousChannel; }
});
