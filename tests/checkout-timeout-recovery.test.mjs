// In-memory SDK and deferred reads only. No live data, credentials, or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { checkoutFixture } from './checkout-read-latency.test.mjs';
import { openPosShift, fetchCurrentPosShift } from '../src/lib/current-pos-shift.js';
const entry = 'base44/functions/complete-sale/entry.ts';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('ordinary checkout overlaps shop contacts, verified products, and stock policy before writes', { timeout: 5000 }, async () => {
  const f = checkoutFixture(1), gate = deferred(), allStarted = deferred();
  let started = 0;
  for (const [entity, method] of [['Shop', 'get'], ['Product', 'get'], ['Settings', 'list']]) {
    const original = f.entities[entity][method];
    f.entities[entity][method] = async (...args) => {
      if (++started === 3) allStarted.resolve();
      await gate.promise; return original(...args);
    };
  }
  const pending = f.invoke(entry, f.request);
  try { await allStarted.promise; assert.equal(f.calls.length, 0); }
  finally { gate.resolve(); }
  const r = await pending;
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment[0].amount, 1000);
  assert.equal(f.db.Shift[0].expected_cash, 1000);
});

test('manager checkout reuses request-local ownership reads and rereads in the next request', async () => {
  const f = checkoutFixture(1); f.db.User[0].role = 'manager';
  let shopReads = 0, shiftReads = 0;
  const shopGet = f.entities.Shop.get, shiftGet = f.entities.Shift.get;
  f.entities.Shop.get = async (...a) => { shopReads++; return shopGet(...a); };
  f.entities.Shift.get = async (...a) => { shiftReads++; return shiftGet(...a); };
  assert.equal((await f.invoke(entry, f.request)).status, 200);
  assert.equal(shopReads, 1); assert.equal(shiftReads, 1);
  f.db.User[0].active = false;
  assert.equal((await f.invoke(entry, { ...f.request, idempotency_key: 'another-checkout-key' })).status, 403);
  assert.equal(f.db.Sale.length, 1);
});

test('a transient stock read retries once and a persistent timeout returns 503 without writing', async () => {
  const f = checkoutFixture(1); const original = f.entities.ProductStock.filter; let reads = 0;
  f.entities.ProductStock.filter = async (...a) => {
    if (++reads === 1) throw new Error('MongoDB connection timed out');
    return original(...a);
  };
  const r = await f.invoke(entry, f.request);
  assert.equal(r.status, 200); assert.equal(reads, 2);
  assert.equal(r.data.backend_timing.read_retries, 1);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.ProductStock[0].quantity, 9);
  const broken = checkoutFixture(1); let attempts = 0;
  broken.entities.ProductStock.filter = async () => { attempts++; throw new Error('MongoDB connection timed out'); };
  const error = await broken.invoke(entry, broken.request);
  assert.equal(error.status, 503); assert.equal(attempts, 2); assert.equal(broken.calls.length, 0);
  assert.doesNotMatch(error.data.error, /mongodb|:1063|timeoutMS/i);
});

test('read cache clears before an uncertain write, and mutations are never automatically replayed', async () => {
  const f = checkoutFixture(1);
  const { createCheckoutReadTracker } = f.load('base44/shared/checkout-reads.ts');
  const tracker = createCheckoutReadTracker(f.service); let reads = 0, writes = 0;
  const get = f.entities.Shop.get;
  f.entities.Shop.get = async (...a) => { reads++; return get(...a); };
  const current = await tracker.service.entities.Shop.get('shop');
  await tracker.service.entities.Shop.get('shop'); assert.equal(reads, 1);
  f.entities.Shop.update = async (_id, values) => {
    writes++; Object.assign(f.db.Shop[0], values); throw new Error('response timed out after write');
  };
  await assert.rejects(tracker.service.entities.Shop.update('shop', { name: 'Changed' }), /timed out/);
  assert.equal(writes, 1);
  assert.equal((await tracker.service.entities.Shop.get('shop')).name, 'Changed');
  assert.equal(reads, 2); assert.equal(current.name, 'Mock shop');
  let denied = 0;
  f.entities.Product.get = async () => { denied++; throw Object.assign(new Error('Forbidden'), { status: 403 }); };
  await assert.rejects(tracker.service.entities.Product.get('cake-0'), /Forbidden/);
  assert.equal(denied, 1);
});

test('first ticket is claimed with one atomic write, competing cashiers receive unique consecutive numbers', async () => {
  const f = checkoutFixture(1), helper = f.load('base44/shared/shift-close-helpers.ts');
  const initial = structuredClone(f.db.Shop[0]);
  const values = await Promise.all([
    helper.allocateServiceTicketNumber(f.service, 'shop', initial),
    helper.allocateServiceTicketNumber(f.service, 'shop', initial),
  ]);
  assert.deepEqual([...values].sort(), [1, 2]);
  assert.equal(f.db.Shop[0].service_ticket_counter, 2);
  const single = checkoutFixture(1); assert.equal((await single.invoke(entry, single.request)).status, 200);
  assert.equal(single.calls.filter(([entity, method]) => entity === 'Shop' && method === 'updateMany').length, 1);
  assert.equal(single.db.Sale[0].service_ticket_number, 1);
});

const shiftFixture = () => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true }],
  Shop: [{ id: 'shop', name: 'Mock shop', active: true, allows_pos: true, location_type: 'shop' }],
  Shift: [], ActionHistory: [],
});
const shiftClient = f => ({ functions: { invoke: async (name, body) => {
  assert.equal(name, 'complete-sale'); const r = await f.invoke(entry, body);
  if (r.status >= 400) throw Object.assign(new Error(r.data.error), { response: { status: r.status, data: r.data } });
  return { data: r.data };
} } });

test('history failure cannot report failure after the shift has been created', async () => {
  const f = shiftFixture();
  f.entities.ActionHistory.create = async () => { throw new Error('MongoDB connection timed out'); };
  const r = await f.invoke(entry, { action: 'open_shift', shop_id: 'shop', starting_cash: 0 });
  assert.equal(r.status, 200); assert.equal(r.data.audit_logged, false);
  assert.equal(r.data.shift.id, f.db.Shift[0].id); assert.equal(f.db.Shift.length, 1);
  assert.equal((await openPosShift(shiftClient(f), { shopId: 'shop', startingCash: 0 })).id, f.db.Shift[0].id);
  assert.equal(f.db.Shift.length, 1);
});

test('a committed shift with a lost create response is recovered without a second create', async () => {
  const f = shiftFixture(), create = f.entities.Shift.create; let creates = 0;
  f.entities.Shift.create = async data => {
    creates++; await create(data); throw new Error('MongoDB connection timed out after create');
  };
  const recovered = await openPosShift(shiftClient(f), { shopId: 'shop', startingCash: 500 });
  assert.equal(creates, 1); assert.equal(f.db.Shift.length, 1);
  assert.equal(recovered.starting_cash, 500); assert.equal(recovered.id, f.db.Shift[0].id);
});

test('shift recovery does not adopt another shop, hide denied access, or retry a failed create', async () => {
  for (const kind of ['not created', 'another shop', 'forbidden']) {
    let calls = 0; const failure = { response: { status: kind === 'forbidden' ? 403 : 503 } };
    const client = { functions: { invoke: async (_name, body) => {
      calls++;
      if (body.action === 'open_shift') throw failure;
      return { data: { ok: true, shift: kind === 'another shop'
        ? { id: 'wrong', shop_id: 'other', status: 'open' } : null } };
    } } };
    await assert.rejects(openPosShift(client, { shopId: 'shop', startingCash: 0 }), e => e === failure);
    assert.equal(calls, kind === 'forbidden' ? 1 : 2);
  }
});

test('purchase prices and recipe items load together while immutable sale costs stay exact', { timeout: 5000 }, async () => {
  const f = checkoutFixture(1), gate = deferred(), reached = deferred(); let started = 0;
  for (const [entity, method] of [['RecipeItem', 'filter'], ['SupplierReceiptItem', 'list']]) {
    const original = f.entities[entity][method];
    f.entities[entity][method] = async (...args) => {
      if (++started === 2) reached.resolve();
      await gate.promise; return original(...args);
    };
  }
  const pending = f.invoke(entry, f.request);
  try { await reached.promise; assert.equal(f.calls.length, 0); }
  finally { gate.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal(f.db.SaleItem[0].unit_cost_at_sale, 500);
  assert.equal(f.db.SaleItem[0].cost_is_estimate, false);
});

test('current shift retries a lost gateway response once and preserves a confirmed existing shift', async () => {
  let reads = 0;
  const current = { id: 'saved', status: 'open', shop_id: 'shop' };
  const client = { functions: { invoke: async (_name, body) => {
    assert.deepEqual(body, { action: 'get_current_shift' });
    if (++reads === 1) throw { response: { status: 503 } };
    return { data: { ok: true, shift: current } };
  } } };
  assert.deepEqual(await fetchCurrentPosShift(client), current);
  assert.equal(reads, 2);
});

test('current shift does not multiply exhausted server retries or retry invalid and denied responses', async () => {
  for (const mode of ['server exhausted', 'forbidden', 'malformed', 'gateway persists']) {
    let calls = 0; const client = { functions: { invoke: async () => {
      calls++;
      if (mode === 'malformed') return { data: { ok: false } };
      throw { response: { status: mode === 'forbidden' ? 403 : 503,
        data: { server_recovery_attempted: mode === 'server exhausted' } } };
    } } };
    await assert.rejects(fetchCurrentPosShift(client));
    assert.equal(calls, mode === 'gateway persists' ? 2 : 1, mode);
  }
});
