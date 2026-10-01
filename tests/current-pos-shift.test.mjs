import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { fetchCurrentPosShift } from '../src/lib/current-pos-shift.js';

const path = 'base44/functions/complete-sale/entry.ts';
const manager = { id: 'stored-manager', email: 'manager@example.test', role: 'manager', active: true, shop_id: 'central' };
const openShift = { id: 'original-shift', user_id: manager.id, shop_id: 'central', status: 'open', total_sales: 15000, expected_cash: 15000 };
const seed = () => ({
  User: [{ ...manager }],
  Shop: [{ id: 'central', active: true }, { id: 'branch', active: true }],
  Shift: [{ ...openShift }, { id: 'other-staff', user_id: 'cashier', shop_id: 'central', status: 'open' }],
});
const call = (f, body = {}) => f.invoke(path, { action: 'get_current_shift', ...body });

test('current shift restores original shift through the same stored identity as open/close', async () => {
  const f = memoryBackend(seed());
  f.client.auth.me = async () => ({ id: 'different-auth-id', email: manager.email, role: 'user' });
  const before = structuredClone(f.db);
  const client = { functions: { invoke: async (name, body) => {
    assert.equal(name, 'complete-sale');
    assert.deepEqual(body, { action: 'get_current_shift' });
    const result = await f.invoke(path, body);
    assert.equal(result.status, 200);
    return { data: result.data };
  } }, entities: { Shift: { list: () => { throw Error('Browser entity reads must not be used'); } } } };
  assert.deepEqual(await fetchCurrentPosShift(client), openShift);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.db, before);
});

test('closed history pagination cannot hide an open shift', async () => {
  const data = seed();
  data.Shift.unshift(...Array.from({ length: 100 }, (_, i) => ({
    id: 'closed-' + i, user_id: manager.id, shop_id: 'central', status: 'closed',
  })));
  const f = memoryBackend(data);
  const result = await call(f);
  assert.equal(result.status, 200);
  assert.equal(result.data.shift.id, openShift.id);
  assert.deepEqual(f.calls, []);
});

test('client-supplied employee and shift IDs cannot select another employee shift', async () => {
  const f = memoryBackend(seed());
  const result = await call(f, { user_id: 'cashier', shift_id: 'other-staff' });
  assert.equal(result.status, 200);
  assert.equal(result.data.shift.id, openShift.id);
  assert.deepEqual(f.calls, []);
});

test('no current shift is explicitly confirmed, never inferred from another employee shift', async () => {
  const data = seed(); data.Shift = data.Shift.slice(1);
  const f = memoryBackend(data);
  assert.deepEqual((await call(f)).data, { ok: true, shift: null });
  assert.deepEqual(f.calls, []);
});

test('manager cannot recover a shift from a different assigned location', async () => {
  const data = seed(); data.Shift[0].shop_id = 'branch';
  const f = memoryBackend(data);
  const result = await call(f);
  assert.equal(result.status, 403);
  assert.equal(result.data.shift, undefined);
  assert.deepEqual(f.calls, []);
});

test('forged location is rejected before any shift is disclosed', async () => {
  const f = memoryBackend(seed());
  const result = await call(f, { shop_id: 'branch' });
  assert.equal(result.status, 403);
  assert.equal(result.data.shift, undefined);
});

test('disabled, unassigned, inactive-shop, and non-POS accounts cannot read current shifts', async () => {
  for (const variant of ['disabled', 'unassigned', 'inactive-shop', 'accountant']) {
    const data = seed();
    if (variant === 'disabled') data.User[0].active = false;
    if (variant === 'unassigned') data.User[0].shop_id = '';
    if (variant === 'inactive-shop') data.Shop[0].active = false;
    if (variant === 'accountant') data.User[0].role = 'accountant';
    const f = memoryBackend(data);
    const result = await call(f);
    assert.equal(result.status, 403, variant);
    assert.equal(result.data.shift, undefined, variant);
    assert.deepEqual(f.calls, []);
  }
});

test('unauthenticated caller receives no shift', async () => {
  const f = memoryBackend(seed()); f.client.auth.me = async () => null;
  assert.equal((await call(f)).status, 401);
});

test('owner and cashier lookup still return only their own open shift', async () => {
  for (const role of ['admin', 'cashier']) {
    const data = seed(); data.User[0].role = role;
    const f = memoryBackend(data);
    const result = await call(f);
    assert.equal(result.status, 200);
    assert.equal(result.data.shift.id, openShift.id);
    assert.deepEqual(f.calls, []);
  }
});

test('duplicate open shifts require attention without mutating balances', async () => {
  const data = seed(); data.Shift.push({ ...openShift, id: 'duplicate' });
  const f = memoryBackend(data);
  const result = await call(f);
  assert.equal(result.status, 409);
  assert.equal(result.data.shift, undefined);
  assert.deepEqual(f.calls, []);
  assert.equal(f.db.Shift[0].total_sales, 15000);
});

test('frontend preserves a failed request as an error rather than no active shift', async () => {
  const client = { functions: { invoke: async () => { throw Error('Network unavailable'); } } };
  await assert.rejects(fetchCurrentPosShift(client), /Network unavailable/);
  for (const payload of [{}, { ok: true }, { ok: true, shift: {} }, { ok: true, shift: { id: 'closed', status: 'closed' } }]) {
    await assert.rejects(fetchCurrentPosShift({ functions: { invoke: async () => ({ data: payload }) } }));
  }
  assert.equal(await fetchCurrentPosShift({ functions: { invoke: async () => ({ data: { ok: true, shift: null } }) } }), null);
});
