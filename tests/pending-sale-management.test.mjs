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
test('one PIN approval for 50 local entries does not read stuck sales or shifts', async () => {
  const f = fixture();
  let pinReads = 0;
  const readPin = f.entities.SecuritySettings.filter;
  f.entities.SecuritySettings.filter = async (...args) => { pinReads++; return readPin(...args); };
  for (const name of ['Sale', 'Shift', 'ProductStock', 'Payment', 'Product']) {
    f.entities[name].get = f.entities[name].filter = f.entities[name].updateMany = async () => { throw new Error('No financial access allowed: ' + name); };
  }
  const ids = Array.from({ length: 50 }, (_, i) => 'pos-local-removal-' + String(i).padStart(6, '0'));
  const result = await f.call({ action: 'authorize_local_queue_removal', ids, reason: 'Stuck queue', owner_pin: '1234' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.authorized, true);
  assert.equal(result.data.user_id, 'staff');
  assert.equal(result.data.shop_id, 'shop');
  assert.deepEqual(result.data.ids, ids);
  assert.equal(pinReads, 1);
  assert.equal(JSON.stringify(result.data).includes('1234'), false);
});
test('local queue approval rejects incorrect PIN and invalid selection', async () => {
  const f = fixture();
  const base = { action: 'authorize_local_queue_removal', ids: [request().idempotency_key], reason: 'Stuck queue', owner_pin: '1234' };
  assert.equal((await f.call({ ...base, owner_pin: '9999' })).status, 403);
  assert.equal((await f.call({ ...base, reason: '' })).status, 400);
  assert.equal((await f.call({ ...base, ids: [base.ids[0], base.ids[0]] })).status, 400);
  f.db.User[0].active = false;
  assert.equal((await f.call(base)).status, 403);
});

test('PIN removal archives stuck requests without changing server financial records', async () => {
  for (const partial of [false, true]) {
    const f = fixture('closed');
    f.db.Shift[0].sale_request_keys.push(request().idempotency_key);
    if (partial) {
      f.db.Sale = [{ id: 'partial', user_id: 'staff', shift_id: 'shift', shop_id: 'shop',
        idempotency_key: request().idempotency_key, financial_records_version: 3, total: 65000 }];
      f.db.Payment = [{ id: 'payment', sale_id: 'partial', amount: 65000 }];
    }
    f.db.Sale ??= []; f.db.Payment ??= [];
    const before = structuredClone({ sales: f.db.Sale, payments: f.db.Payment, stocks: f.db.ProductStock });
    const result = await f.resolve('remove');
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.state, 'removed');
    assert.equal(result.data.financial_records_unchanged, true);
    assert.deepEqual({ sales: f.db.Sale, payments: f.db.Payment, stocks: f.db.ProductStock }, before);
    assert.equal(f.db.Shift[0].total_sales, 0);
    assert.equal(f.db.Shift[0].sale_request_keys.length, 1);
    assert.equal((await f.resolve('remove')).data.state, 'removed');
    assert.equal((await f.inspect()).data.state, 'removed');
    const journal = JSON.parse(f.db.Shift[0].pos_queue_resolutions_json)[request().idempotency_key];
    assert.equal(journal.original_request_json, result.data.original_request_json);
    assert.equal(journal.reason, 'Central order review');
    assert.equal((await f.call(request())).status, 410, 'original cannot be retried as a new sale');
  }
});
test('queue removal still rejects wrong PIN, missing reason and foreign ownership', async () => {
  for (const kind of ['pin', 'reason', 'staff', 'shop']) {
    const f = fixture();
    f.db.Shift[0].sale_request_keys.push(request().idempotency_key);
    if (kind === 'staff') f.db.Shift[0].user_id = 'other';
    if (kind === 'shop') f.db.Shift[0].shop_id = 'other-shop';
    const result = await f.resolve('remove', kind === 'pin' ? { owner_pin: '0000' } : kind === 'reason' ? { reason: '' } : {});
    assert.ok([400, 403].includes(result.status), JSON.stringify(result.data));
    assert.equal(f.db.Shift[0].pos_queue_resolutions_json, undefined);
  }
});
test('completed sales are reconciled and unclaimed sales use the existing cancellation fence', async () => {
  const complete = fixture();
  complete.db.Sale = [{ id: 'complete', user_id: 'staff', shift_id: 'shift', shop_id: 'shop',
    idempotency_key: request().idempotency_key, financial_records_version: 3, total: 65000 }];
  complete.db.Shift[0].sale_request_keys.push(request().idempotency_key, 'sale-completed:' + request().idempotency_key);
  assert.equal((await complete.resolve('remove')).data.state, 'confirmed');
  assert.equal(complete.db.Shift[0].pos_queue_resolutions_json, undefined);
  const pending = fixture();
  assert.equal((await pending.resolve('remove')).data.state, 'cancelled');
  assert.equal((await pending.call(request())).status, 410);
});
test('stuck removal does not overwrite another concurrently saved journal decision', async () => {
  const f = fixture();
  f.db.Shift[0].sale_request_keys.push(request().idempotency_key);
  const update = f.entities.Shift.updateMany;
  f.entities.Shift.updateMany = async (query, ops) => {
    if (ops.$set?.pos_queue_resolutions_json) f.db.Shift[0].pos_queue_resolutions_json = '{"other":{"state":"cancelled"}}';
    return update(query, ops);
  };
  assert.equal((await f.resolve('remove')).status, 409);
  assert.deepEqual(JSON.parse(f.db.Shift[0].pos_queue_resolutions_json), { other: { state: 'cancelled' } });
});
test('bulk queue removal supports processing entries after one PIN approval', async () => {
  const f = fixture();
  const second = { ...request(), idempotency_key: 'pos-central-pending-000002' };
  f.db.Shift[0].sale_request_keys.push(request().idempotency_key, second.idempotency_key);
  const result = await f.call({ action: 'cancel_pending_sales', operation: 'remove',
    original_requests: [request(), second], owner_pin: '1234', reason: 'Stuck queue' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.errors.length, 0);
  assert.deepEqual(result.data.results.map(row => row.state), ['removed', 'removed']);
});
test('client archives removed entries with original payload and does not resolve without approval', async () => {
  const record = { id: request().idempotency_key, user_id: 'staff', shift_id: 'shift',
    status: 'failed', request: request() };
  const decision = { state: 'removed', original_key: record.id, reason: 'Stuck queue' };
  const [archive] = queue.resolvedPendingRecords(record, decision);
  assert.equal(archive.status, 'removed');
  assert.deepEqual(archive.request, record.request);
  assert.equal(archive.resolution.reason, 'Stuck queue');
  let applied = 0;
  const storage = { list: async () => [record], resolve: async () => { applied++; } };
  await assert.rejects(queue.managePendingSale({ userId: 'staff', id: record.id, storage,
    lock: work => work(), authorize: async () => { throw new Error('PIN rejected'); } }));
  assert.equal(applied, 0);
  await queue.managePendingSale({ userId: 'staff', id: record.id, storage,
    lock: work => work(), authorize: async () => decision });
  assert.equal(applied, 1);
  const result = await queue.managePendingSales({ userId: 'staff', ids: [record.id], storage,
    lock: work => work(), authorize: async () => ({ results: [decision], errors: [] }) });
  assert.equal(result.results[0].state, 'removed');
  assert.equal(applied, 2);
});

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
