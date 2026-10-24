// All entity data stays in memory. No SDK network, real sales or live writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';

const file = 'base44/functions/checkout-timing/entry.ts';
const requestKey = 'pos-checkout-request-123456';
const eventId = 'timing-event-123456789';
const now = '2026-10-16T06:00:00.000Z';
const body = (patch = {}) => ({ action: 'record', event_id: eventId, shift_id: 'shift', request_key: requestKey,
  sale_id: 'sale', total_ms: 2400, api_round_trip_ms: 1500.5, outcome: 'confirmed', client_completed_at: '2026-10-16T05:59:59.000Z', ...patch });
const make = () => memoryBackend({
  User: [{ id: 'cashier', role: 'cashier', active: true, full_name: 'Stored cashier', email: 'cashier@example.test', shop_id: 'branch' }],
  Shop: [{ id: 'branch', active: true, allows_pos: true, location_type: 'shop', name: 'Stored branch' }],
  Shift: [{ id: 'shift', user_id: 'cashier', shop_id: 'branch', shop_name: 'Old shift name', status: 'open', expected_cash: 15000,
    sale_request_keys: [requestKey, `sale-completed:${requestKey}`] }],
  Sale: [{ id: 'sale', idempotency_key: requestKey, shift_id: 'shift', user_id: 'cashier', shop_id: 'branch', status: 'completed', financial_records_version: 3,
    sale_number: 'OD-20261016-123456', total: 15000, items: [{ product_id: 'cake', quantity: 1, price: 15000 }], payments: [{ method: 'cash', amount: 15000 }] }],
  SaleItem: [{ id: 'item', sale_id: 'sale', line_total: 15000 }], Payment: [{ id: 'payment', sale_id: 'sale', amount: 15000 }],
  ProductStock: [{ id: 'stock', quantity: 2 }], StockMovement: [{ id: 'movement', quantity_change: -1 }],
  BudgetBalance: [{ id: 'budget', balance: 50000 }], BudgetTransaction: [{ id: 'budget-transaction', amount: 50000 }],
  CustomerOrder: [{ id: 'order', total: 10000 }], SupplierPayment: [{ id: 'supplier-payment', amount: 1000 }],
  Settings: [{ id: 'settings' }], ActionHistory: [{ id: 'action', action: 'sale_completed' }], CheckoutTiming: [],
}, { now });
const invoke = (f, patch) => f.invoke(file, body(patch));
const admin = f => { f.db.User[0].role = 'admin'; return f; };
const savedRow = (patch = {}) => ({ id: 'timing', event_id: eventId, actor_id: 'cashier', actor_name: 'Stored cashier', shop_id: 'branch', shop_name: 'Stored branch', shift_id: 'shift',
  sale_id: 'sale', sale_number: 'OD-20261016-123456', request_key: requestKey, total_ms: 2400, api_round_trip_ms: 1500.5,
  outcome: 'confirmed', client_completed_at: '2026-10-16T05:59:59.000Z', received_at: now, source: 'browser', ...patch });
const snapshot = f => structuredClone(Object.fromEntries(Object.entries(f.db).filter(([name]) => name !== 'CheckoutTiming')));

test('entity grants only admin create/read for service-role compatibility; all worker operations and all updates/deletes are denied', () => {
  const schema = JSON.parse(readFileSync('base44/entities/CheckoutTiming.jsonc', 'utf8'));
  const allows = (rule, role) => rule === true || Boolean(rule && rule.user_condition?.role === role);
  for (const role of ['admin', 'manager', 'cashier', 'accountant', 'production', 'warehouse', 'user', undefined]) {
    for (const action of ['create', 'read', 'update', 'delete']) {
      assert.equal(allows(schema.rls[action], role), role === 'admin' && ['create', 'read'].includes(action), `${role}:${action}`);
    }
  }
  assert.equal(schema.properties.total_ms.maximum, 86400000);
  assert.equal(schema.properties.source.enum[0], 'browser');
});

test('confirmed telemetry derives identity and names, returns only matching ACK and leaves all business snapshots unchanged', async () => {
  const f = make(); const before = snapshot(f);
  const result = await invoke(f, { actor_id: 'forged', actor_name: 'Forged actor', shop_id: 'other', shop_name: 'Forged shop', source: 'server',
    sale_number: 'Forged sale', total: 1, payments: [{ amount: 1 }], owner_pin: 'never-store', token: 'never-store', error_stack: 'never-store' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { saved: true, event_id: eventId, already_recorded: false });
  assert.equal(f.db.CheckoutTiming.length, 1);
  const row = f.db.CheckoutTiming[0];
  assert.equal(row.actor_id, 'cashier'); assert.equal(row.actor_name, 'Stored cashier');
  assert.equal(row.shop_id, 'branch'); assert.equal(row.shop_name, 'Stored branch');
  assert.equal(row.sale_id, 'sale'); assert.equal(row.sale_number, 'OD-20261016-123456');
  assert.equal(row.received_at, now); assert.equal(row.source, 'browser');
  assert.doesNotMatch(JSON.stringify(row), /never-store|Forged|payments|owner_pin|error_stack/);
  assert.deepEqual(snapshot(f), before);
  assert.ok(f.calls.every(([entity, action]) => entity === 'CheckoutTiming' && action === 'create'));
});

test('confirmed lookup may omit sale_id; each new actual attempt has its own event even for a reused checkout key', async () => {
  const f = make();
  assert.equal((await invoke(f, { sale_id: undefined })).status, 200);
  assert.equal((await invoke(f, { event_id: 'timing-second-event-12345', outcome: 'rechecked', total_ms: 500, sale_id: undefined })).status, 200);
  assert.equal(f.db.CheckoutTiming.length, 2);
  assert.ok(f.db.CheckoutTiming.every(row => row.sale_id === 'sale' && row.request_key === requestKey));
});

test('serial retries and lost diagnostic-save replies acknowledge the saved event once', async () => {
  const f = make(); const create = f.entities.CheckoutTiming.create;
  f.entities.CheckoutTiming.create = async data => { await create(data); throw new Error('Mock lost reply'); };
  assert.equal((await invoke(f)).data.already_recorded, true);
  assert.equal((await invoke(f)).data.already_recorded, true);
  assert.equal(f.db.CheckoutTiming.length, 1);
  // A later refund does not invalidate the acknowledgment for a verified event
  // already received before that refund; the saved diagnostic stays immutable.
  f.db.Sale[0].status = 'refunded';
  assert.equal((await invoke(f)).data.already_recorded, true);
  assert.equal(f.db.CheckoutTiming.length, 1);
});

test('an event key cannot be reused for a changed immutable diagnostic payload', async () => {
  const f = make(); await invoke(f);
  for (const change of [{ total_ms: 2401 }, { api_round_trip_ms: 1501 }, { outcome: 'rechecked' },
    { client_completed_at: '2026-10-16T06:00:01.000Z' }, { request_key: 'different-request-key-1234' }, { sale_id: 'different-sale' }]) {
    assert.equal((await invoke(f, change)).status, 409, JSON.stringify(change));
  }
  assert.equal(f.db.CheckoutTiming.length, 1);
});

test('all record roles require a stored active user, independent of forged token role claims', async () => {
  const missing = make(); missing.client.auth.me = async () => null;
  assert.equal((await invoke(missing)).status, 401);
  for (const change of [{ active: false }, { data: { active: false } }]) {
    const f = make(); Object.assign(f.db.User[0], change);
    assert.equal((await invoke(f)).status, 403); assert.equal(f.db.CheckoutTiming.length, 0);
  }
  for (const role of ['accountant', 'production', 'warehouse']) {
    const f = make(); f.db.User[0].role = role;
    assert.equal((await invoke(f)).status, 403); assert.equal(f.db.CheckoutTiming.length, 0);
  }
  const f = make(); f.client.auth.me = async () => ({ id: 'cashier', role: 'admin', active: true, full_name: 'Forged name' });
  assert.equal((await invoke(f)).status, 200); assert.equal(f.db.CheckoutTiming[0].actor_name, 'Stored cashier');
  assert.equal((await f.invoke(file, { action: 'list' })).status, 403);
});

test('admin, manager and cashier can record their own valid shift without mutating a closed shift', async () => {
  for (const role of ['admin', 'manager', 'cashier']) {
    const f = make(); f.db.User[0].role = role; f.db.Shift[0].status = 'closed';
    const before = snapshot(f);
    assert.equal((await invoke(f)).status, 200, role);
    assert.deepEqual(snapshot(f), before);
  }
});

test('foreign shifts, reassigned worker shops, and inactive or non-POS shops reject before creating telemetry', async () => {
  for (const configure of [
    f => { f.db.Shift[0].user_id = 'other-worker'; },
    f => { f.db.User[0].shop_id = 'other-shop'; },
    f => { f.db.Shop[0].active = false; },
    f => { f.db.Shop[0].allows_pos = false; },
    f => { f.db.Shop[0].location_type = 'production'; },
    f => { f.db.Shift = []; },
  ]) {
    const f = make(); configure(f); const before = snapshot(f);
    assert.equal((await invoke(f)).status, 403);
    assert.equal(f.db.CheckoutTiming.length, 0); assert.deepEqual(snapshot(f), before);
  }
});

test('success outcomes require matching real Sale ownership, request and final financial marker', async () => {
  for (const configure of [
    f => { f.db.Sale = []; }, f => { f.db.Sale[0].user_id = 'other-worker'; },
    f => { f.db.Sale[0].shop_id = 'other-shop'; }, f => { f.db.Sale[0].shift_id = 'other-shift'; },
    f => { f.db.Sale[0].idempotency_key = 'other-request-key-123456'; },
    f => { f.db.Sale[0].status = 'invalid'; }, f => { f.db.Shift[0].sale_request_keys = [requestKey]; },
  ]) {
    const f = make(); configure(f); const before = snapshot(f);
    assert.equal((await invoke(f)).status, 409);
    assert.equal(f.db.CheckoutTiming.length, 0); assert.deepEqual(snapshot(f), before);
  }
  const legacy = make(); legacy.db.Sale[0].financial_records_version = 2; legacy.db.Shift[0].sale_request_keys = [];
  assert.equal((await invoke(legacy)).status, 200);
  const ambiguous = make(); ambiguous.db.Sale.push({ ...structuredClone(ambiguous.db.Sale[0]), id: 'duplicate-sale' });
  assert.equal((await invoke(ambiguous, { sale_id: undefined })).status, 409);
});

test('a delayed first timing upload after refund verifies original v3 completion without changing refund history', async () => {
  for (const outcome of ['confirmed', 'rechecked']) {
    const f = make(); Object.assign(f.db.Sale[0], { status: 'refunded', refunded_at: '2026-10-16T05:59:59.500Z', refund_id: 'refund' });
    f.db.Shift[0].status = 'closed'; const before = snapshot(f);
    assert.equal((await invoke(f, { outcome })).status, 200);
    assert.equal(f.db.CheckoutTiming[0].outcome, outcome);
    assert.deepEqual(snapshot(f), before);
  }
  const unverified = make(); unverified.db.Sale[0].status = 'refunded'; unverified.db.Shift[0].sale_request_keys = [];
  assert.equal((await invoke(unverified)).status, 409);
  const legacy = make(); legacy.db.Sale[0].status = 'refunded'; legacy.db.Sale[0].financial_records_version = 2;
  assert.equal((await invoke(legacy)).status, 409, 'a legacy refunded sale lacks the required final-completion proof');
});

test('independent fresh admin device reads all workers from shared server rows; worker list never reaches timing queries', async () => {
  const firstDevice = make(); const store = firstDevice.db;
  store.User.push({ id: 'worker-two', role: 'cashier', active: true, full_name: 'Second cashier', shop_id: 'other-branch' },
    { id: 'owner', role: 'admin', active: true, full_name: 'Owner' });
  store.Shop.push({ id: 'other-branch', active: true, allows_pos: true, location_type: 'shop', name: 'Other branch' });
  store.Shift.push({ id: 'shift-two', user_id: 'worker-two', shop_id: 'other-branch', status: 'closed', sale_request_keys: [`sale-completed:${requestKey}`] });
  store.Sale.push({ ...structuredClone(store.Sale[0]), id: 'sale-two', user_id: 'worker-two', shop_id: 'other-branch', shift_id: 'shift-two', sale_number: 'OD-2' });
  assert.equal((await invoke(firstDevice)).status, 200);
  firstDevice.client.auth.me = async () => ({ id: 'worker-two', role: 'cashier' });
  assert.equal((await invoke(firstDevice, { event_id: 'worker-two-event-123456', sale_id: 'sale-two', shift_id: 'shift-two' })).status, 200);
  const ownerDevice = memoryBackend(store, { now, copySeed: false });
  ownerDevice.client.auth.me = async () => ({ id: 'owner', role: 'admin' });
  const shared = await ownerDevice.invoke(file, { action: 'list' });
  assert.equal(shared.status, 200); assert.equal(shared.data.records.length, 2);
  assert.deepEqual(new Set(shared.data.records.map(row => row.actor_id)), new Set(['cashier', 'worker-two']));
  assert.deepEqual(new Set(shared.data.records.map(row => row.shop_id)), new Set(['branch', 'other-branch']));
  const workerDevice = memoryBackend(store, { now, copySeed: false }); let queried = false;
  workerDevice.entities.CheckoutTiming.filter = async () => { queried = true; throw new Error('Must not read diagnostics'); };
  assert.equal((await workerDevice.invoke(file, { action: 'list' })).status, 403);
  assert.equal(queried, false);
});

test('raw concurrent uploads may append equivalent diagnostics but owner queries present one event', async () => {
  const f = make();
  const results = await Promise.all([invoke(f), invoke(f)]);
  assert.ok(results.every(result => result.status === 200));
  assert.ok(f.db.CheckoutTiming.length >= 1);
  admin(f);
  const listed = await f.invoke(file, { action: 'list' });
  assert.equal(listed.data.records.length, 1); assert.equal(listed.data.records[0].event_id, eventId);
  assert.equal(listed.data.has_more, false);
});

test('queued/unconfirmed attempts never become financial confirmations or link an invented sale', async () => {
  for (const outcome of ['queued', 'unconfirmed']) {
    const f = make(); f.db.Sale = [];
    assert.equal((await invoke(f, { outcome, sale_id: undefined, api_round_trip_ms: null })).status, 200);
    assert.equal(f.db.CheckoutTiming[0].outcome, outcome);
    assert.equal(f.db.CheckoutTiming[0].sale_id, ''); assert.equal(f.db.CheckoutTiming[0].sale_number, '');
    assert.equal(f.db.CheckoutTiming[0].api_round_trip_ms, undefined);
    const other = make();
    assert.equal((await invoke(other, { outcome })).status, 400);
    assert.equal(other.db.CheckoutTiming.length, 0);
  }
});

test('invalid durations, identifiers, timestamps and outcomes are rejected without a write', async () => {
  for (const change of [
    { total_ms: -1 }, { total_ms: 0.5 }, { total_ms: 86400001 }, { total_ms: Infinity }, { total_ms: NaN }, { total_ms: '2400' },
    { api_round_trip_ms: -1 }, { api_round_trip_ms: Infinity }, { api_round_trip_ms: 86400001 }, { api_round_trip_ms: '5' },
    { event_id: 'short' }, { event_id: 'x'.repeat(129) }, { event_id: 'bad:event\n1234567890' }, { request_key: '' }, { request_key: { $ne: '' } },
    { shift_id: { $ne: '' } }, { sale_id: { $gt: '' } }, { outcome: 'paid' }, { client_completed_at: '2026-10-16' },
    { client_completed_at: '2026-02-30T00:00:00.000Z' }, { client_completed_at: 'bad' },
  ]) {
    const f = make(); const result = await invoke(f, change);
    assert.equal(result.status, 400, JSON.stringify(change)); assert.equal(f.db.CheckoutTiming.length, 0);
  }
  for (const total_ms of [0, 86400000]) assert.equal((await invoke(make(), { total_ms })).status, 200);
});

test('blocked storage service returns a sanitized retryable error and never touches financial data', async () => {
  const f = make(); const before = snapshot(f);
  f.entities.CheckoutTiming.create = async () => { throw new Error('private-token never-return-this-stack'); };
  const result = await invoke(f);
  assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.data), /private-token|never-return|stack/);
  assert.deepEqual(snapshot(f), before);
  f.entities.Shift.get = async () => { throw Object.assign(new Error('private-token'), { status: 403 }); };
  const privateFailure = await invoke(f);
  assert.equal(privateFailure.status, 503); assert.doesNotMatch(JSON.stringify(privateFailure.data), /private-token/);
});

test('manager timing history is always forced to his own shop', async () => {
  const f = make(); f.db.User[0].role = 'manager';
  const queries = []; const filter = f.entities.CheckoutTiming.filter;
  f.entities.CheckoutTiming.filter = async (...args) => { queries.push(structuredClone(args)); return filter(...args); };
  const result = await f.invoke(file, { action: 'list', shop_id: 'other-shop' });
  assert.equal(result.status, 200);
  assert.ok(queries.length > 0);
  for (const [query] of queries) assert.equal(query.shop_id, 'branch');
});

test('workers, unknown users and deactivated admins cannot query timing rows even with malformed filters', async () => {
  for (const role of ['cashier', 'accountant', 'production', 'warehouse']) {
    const f = make(); f.db.User[0].role = role;
    f.entities.CheckoutTiming.filter = async () => { throw new Error('Forbidden timing query reached'); };
    const result = await f.invoke(file, { action: 'list', limit: 'all', shop_id: { $ne: '' }, role: 'admin' });
    assert.equal(result.status, 403, role);
  }
  const f = admin(make()); f.db.User[0].active = false;
  assert.equal((await f.invoke(file, { action: 'list' })).status, 403);
  const unknown = make(); unknown.client.auth.me = async () => ({ id: 'not-stored', role: 'admin' });
  assert.equal((await unknown.invoke(file, { action: 'list' })).status, 403);
});

test('admin list applies allowlisted server filters and Tashkent boundaries to received_at, not client time', async () => {
  const f = admin(make());
  f.db.CheckoutTiming = [
    savedRow({ id: 'before', event_id: 'timing-before-123456', received_at: '2026-10-15T18:59:59.999Z' }),
    savedRow({ id: 'start', event_id: 'timing-start-1234567', received_at: '2026-10-15T19:00:00.000Z', client_completed_at: '2020-01-01T00:00:00.000Z' }),
    savedRow({ id: 'end', event_id: 'timing-ending-123456', received_at: '2026-10-16T18:59:59.999Z' }),
    savedRow({ id: 'after', event_id: 'timing-after-1234567', received_at: '2026-10-16T19:00:00.000Z' }),
    savedRow({ id: 'other-shop', event_id: 'timing-other-1234567', shop_id: 'other', received_at: '2026-10-16T10:00:00.000Z' }),
    savedRow({ id: 'other-user', event_id: 'timing-user-12345678', actor_id: 'other', received_at: '2026-10-16T10:00:00.000Z' }),
    savedRow({ id: 'queued', event_id: 'timing-queued-123456', outcome: 'queued', received_at: '2026-10-16T10:00:00.000Z' }),
  ];
  const filter = f.entities.CheckoutTiming.filter; const queries = [];
  f.entities.CheckoutTiming.filter = async (...args) => { queries.push(structuredClone(args)); return filter(...args); };
  const result = await f.invoke(file, { action: 'list', shop_id: 'branch', user_id: 'cashier', from_date: '2026-10-16', to_date: '2026-10-16', outcome: 'confirmed' });
  assert.equal(result.status, 200); assert.deepEqual(result.data.records.map(row => row.id), ['end', 'start']);
  assert.equal(result.data.has_more, false); assert.equal(result.data.next_skip, null);
  assert.deepEqual(queries[0][0], { source: 'browser', shop_id: 'branch', actor_id: 'cashier', outcome: 'confirmed',
    received_at: { $gte: '2026-10-15T19:00:00.000Z', $lt: '2026-10-16T19:00:00.000Z' } });
  assert.equal(queries[0][1], '-received_at');
});

test('owner list deduplicates overlapping uploads before logical pagination, including raw-page boundaries', async () => {
  const f = admin(make());
  f.db.CheckoutTiming = [
    savedRow({ id: 'duplicate-new', received_at: '2026-10-16T06:00:03.000Z', private_token: 'never-return' }),
    savedRow({ id: 'duplicate-old', received_at: '2026-10-16T06:00:02.000Z' }),
    savedRow({ id: 'event-two', event_id: 'event-second-123456789', received_at: '2026-10-16T06:00:01.000Z' }),
    savedRow({ id: 'event-three', event_id: 'event-third-1234567890', received_at: '2026-10-16T06:00:00.000Z' }),
  ];
  const first = await f.invoke(file, { action: 'list', limit: 1, skip: 0 });
  assert.deepEqual(first.data.records.map(row => row.id), ['duplicate-new']);
  assert.equal(first.data.has_more, true); assert.equal(first.data.next_skip, 1);
  assert.doesNotMatch(JSON.stringify(first.data), /private_token|never-return/);
  const second = await f.invoke(file, { action: 'list', limit: 1, skip: first.data.next_skip });
  assert.deepEqual(second.data.records.map(row => row.id), ['event-two']);
  const third = await f.invoke(file, { action: 'list', limit: 1, skip: second.data.next_skip });
  assert.deepEqual(third.data.records.map(row => row.id), ['event-three']);
  assert.equal(third.data.has_more, false);
});

test('owner list keeps different actors separate and enforces default/max page sizes and offsets', async () => {
  const f = admin(make());
  f.db.CheckoutTiming = Array.from({ length: 120 }, (_, index) => savedRow({ id: `timing-${index}`, event_id: `unique-event-${index}`,
    received_at: new Date(Date.parse(now) - index * 1000).toISOString() }));
  f.db.CheckoutTiming.push(savedRow({ id: 'other-actor-same-event', actor_id: 'another-actor', event_id: f.db.CheckoutTiming[0].event_id, received_at: '2026-10-16T06:00:01.000Z' }));
  const first = await f.invoke(file, { action: 'list' });
  assert.equal(first.data.records.length, 50); assert.equal(first.data.has_more, true); assert.equal(first.data.next_skip, 50);
  const max = await f.invoke(file, { action: 'list', limit: 100, skip: 0 });
  assert.equal(max.data.records.length, 100);
  const last = await f.invoke(file, { action: 'list', limit: 100, skip: 100 });
  assert.equal(last.data.records.length, 21); assert.equal(last.data.has_more, false);
  const empty = await f.invoke(file, { action: 'list', skip: 100000 });
  assert.deepEqual(empty.data.records, []);
  for (const change of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '50' }, { skip: -1 }, { skip: 100001 }, { skip: Infinity }, { skip: '0' },
    { shop_id: { $ne: '' } }, { user_id: [] }, { outcome: 'all' }, { from_date: '2026-02-30' }, { to_date: 'bad' }, { from_date: '2026-10-17', to_date: '2026-10-16' }]) {
    assert.equal((await f.invoke(file, { action: 'list', ...change })).status, 400, JSON.stringify(change));
  }
});

test('unknown actions and non-object requests do not create diagnostics or change any business record', async () => {
  const f = admin(make()); const before = snapshot(f);
  for (const input of [null, [], 'record', { action: 'delete' }, { action: 'update', total_ms: 1 }]) {
    assert.equal((await f.invoke(file, input)).status, 400);
  }
  assert.equal(f.db.CheckoutTiming.length, 0); assert.deepEqual(snapshot(f), before);
  assert.equal(f.calls.length, 0);
});
