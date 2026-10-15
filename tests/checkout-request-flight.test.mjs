// Mocked sends, injected timers, and memory storage only. No network or IndexedDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POS_CHECKOUT_RESPONSE_BUDGET_MS,
  POS_QUEUE_RESPONSE_BUDGET_MS,
  buildPendingSale,
  releaseSaleRequest,
  startSaleRequest,
  syncPendingSales,
  waitForSaleResponse,
} from '../src/lib/offline-sales.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const fakeTimers = () => {
  let nextId = 0;
  const jobs = new Map(), scheduled = [], cleared = [], listeners = [];
  const timers = {
    setTimeout(callback, milliseconds) {
      const id = ++nextId;
      jobs.set(id, callback);
      scheduled.push({ id, milliseconds });
      for (const notify of listeners.splice(0)) notify(id);
      return id;
    },
    clearTimeout(id) { cleared.push(id); jobs.delete(id); },
  };
  return {
    timers, scheduled, cleared,
    active: () => jobs.size,
    nextScheduled: () => jobs.size
      ? Promise.resolve(jobs.keys().next().value)
      : new Promise(resolve => listeners.push(resolve)),
    fire(id) {
      const callback = jobs.get(id);
      assert.equal(typeof callback, 'function', `missing injected timer ${id}`);
      jobs.delete(id);
      callback();
    },
  };
};

let sequence = 0;
const scope = t => {
  const userId = `request-flight-user-${++sequence}`;
  const flights = [];
  t.after(() => { for (const flight of flights) releaseSaleRequest(flight.request.idempotency_key, flight); });
  return {
    userId,
    start(request, send, options = {}) {
      const flight = startSaleRequest(request, send, { userId, ...options });
      flights.push(flight);
      return flight;
    },
  };
};

const requestFor = key => ({
  action: 'complete_sale', idempotency_key: key, shift_id: 'shift-1',
  items: [{ product_id: 'cake', quantity: 2 }],
  payments: [{ method: 'cash', amount: 1000, reference: '' }],
  recorded_at: '2026-10-16T08:00:00.000Z', is_delivery: false,
});

const queueFor = (userId, key) => {
  const record = buildPendingSale({
    idempotencyKey: key, recordedAt: '2026-10-16T08:00:00.000Z',
    user: { id: userId, full_name: 'Mock cashier' },
    shift: { id: 'shift-1', shop_id: 'shop-1' },
    cart: [{ product_id: 'cake', product_name: 'Cake', price: 500, quantity: 2 }],
    payments: [{ method: 'cash', amount: 1000 }],
  });
  let rows = [structuredClone(record)];
  const updates = [], removals = [];
  return {
    record, updates, removals,
    rows: () => structuredClone(rows),
    add: row => { rows.push(structuredClone(row)); },
    storage: {
      list: async id => structuredClone(rows.filter(row => row.user_id === id)),
      update: async (id, patch) => {
        updates.push([id, structuredClone(patch)]);
        Object.assign(rows.find(row => row.id === id), structuredClone(patch));
      },
      remove: async id => { removals.push(id); rows = rows.filter(row => row.id !== id); },
    },
  };
};

const useGlobalFakeTimers = (t, clock) => {
  t.mock.method(globalThis, 'setTimeout', clock.timers.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', clock.timers.clearTimeout);
};

test('same user and exact sale reuse one pending request and its confirmed response', async t => {
  const s = scope(t), gate = deferred(), request = requestFor('same-key');
  let sends = 0, sentRequest;
  const flight = s.start(request, snapshot => { sends++; sentRequest = snapshot; return gate.promise; });
  assert.equal(sends, 1, 'send starts synchronously');
  assert.equal(s.start(structuredClone(request), () => assert.fail('duplicate send')), flight);
  assert.equal(flight.status, 'pending');
  assert.notEqual(sentRequest, request);
  assert.notEqual(sentRequest.items, request.items);
  request.items[0].quantity = 99;
  assert.equal(sentRequest.items[0].quantity, 2, 'caller mutation cannot change the submitted snapshot');
  const response = { data: { sale: { id: 'confirmed' } } };
  gate.resolve(response);
  assert.equal(await flight.promise, response);
  assert.equal(flight.status, 'fulfilled');
  assert.equal(flight.response, response);
  assert.equal(s.start(structuredClone(sentRequest), () => assert.fail('confirmed request resent')), flight);
  assert.equal(sends, 1);
});

test('a retained key rejects changed items, payments, shift, and delivery without sending', async t => {
  const s = scope(t), gate = deferred(), request = requestFor('payload-guard');
  const flight = s.start(request, () => gate.promise);
  for (const change of [
    value => { value.items[0].quantity++; },
    value => { value.payments[0].amount++; },
    value => { value.shift_id = 'another-shift'; },
    value => { value.is_delivery = true; },
  ]) {
    const different = structuredClone(request);
    change(different);
    assert.throws(() => s.start(different, () => assert.fail('changed sale sent')), /Avvalgi to‘lov/);
    assert.equal(s.start(request, () => assert.fail('original request resent')), flight);
  }
  gate.resolve({ sale: { id: 'original' } });
  await flight.promise;
});

test('missing idempotency key fails before send', t => {
  const s = scope(t);
  for (const key of [undefined, '']) {
    assert.throws(() => s.start({ idempotency_key: key }, () => assert.fail('invalid send')),
      error => error.status === 400);
  }
});

test('the same sale key in different users has isolated flights and responses', async t => {
  const s = scope(t), request = requestFor('shared-key'), left = deferred(), right = deferred();
  let sends = 0;
  const a = s.start(request, () => { sends++; return left.promise; });
  const b = s.start(request, () => { sends++; return right.promise; }, { userId: `${s.userId}-other` });
  assert.notEqual(a, b);
  assert.notEqual(a.cacheKey, b.cacheKey);
  left.resolve({ sale: { id: 'sale-a' } }); right.resolve({ sale: { id: 'sale-b' } });
  assert.equal((await a.promise).sale.id, 'sale-a');
  assert.equal((await b.promise).sale.id, 'sale-b');
  releaseSaleRequest(request.idempotency_key, a);
  assert.equal(s.start(request, () => assert.fail('other user resent'), { userId: `${s.userId}-other` }), b);
  assert.equal(sends, 2);
});

test('presentation deadline never aborts the send and a late result remains reusable', async t => {
  const s = scope(t), gate = deferred(), clock = fakeTimers(), request = requestFor('late-result');
  let sends = 0, aborts = 0;
  gate.promise.abort = () => { aborts++; };
  const flight = s.start(request, (...args) => {
    sends++;
    assert.equal(args.length, 1, 'no abort signal is attached to the authoritative write');
    return gate.promise;
  });
  const waiting = waitForSaleResponse(flight, { timers: clock.timers });
  assert.equal(clock.scheduled[0].milliseconds, POS_CHECKOUT_RESPONSE_BUDGET_MS);
  clock.fire(clock.scheduled[0].id);
  assert.deepEqual(await waiting, { pending: true });
  assert.equal(flight.status, 'pending');
  assert.equal(aborts, 0);
  assert.equal(clock.active(), 0);
  assert.equal(s.start(request, () => assert.fail('deadline triggered another send')), flight);
  const response = { data: { sale: { id: 'late-confirmed' } } };
  gate.resolve(response);
  await flight.promise;
  const outcome = await waitForSaleResponse(flight, { timers: clock.timers });
  assert.deepEqual(outcome, { pending: false, response });
  assert.equal(clock.active(), 0);
  assert.deepEqual(clock.cleared, clock.scheduled.map(({ id }) => id));
  assert.equal(s.start(request, () => assert.fail('late confirmed request resent')), flight);
  assert.equal(sends, 1);
  assert.equal(aborts, 0);
});

test('independent response waits keep independent deadlines for one shared flight', async t => {
  const s = scope(t), gate = deferred(), short = fakeTimers(), long = fakeTimers();
  const flight = s.start(requestFor('two-waits'), () => gate.promise);
  const first = waitForSaleResponse(flight, { timeoutMs: 5, timers: short.timers });
  const second = waitForSaleResponse(flight, { timeoutMs: 50, timers: long.timers });
  short.fire(short.scheduled[0].id);
  assert.deepEqual(await first, { pending: true });
  assert.equal(long.active(), 1);
  const response = { sale: { id: 'shared-confirmed' } };
  gate.resolve(response);
  assert.deepEqual(await second, { pending: false, response });
  assert.equal(short.active(), 0); assert.equal(long.active(), 0);
});

test('rejected transport clears its deadline and allows the same exact key to retry', async t => {
  const s = scope(t), gate = deferred(), clock = fakeTimers(), request = requestFor('retry-rejected');
  const failure = Object.assign(new Error('Mock gateway failure'), { status: 503 });
  const first = s.start(request, () => gate.promise);
  const waiting = waitForSaleResponse(first, { timers: clock.timers });
  const rejected = assert.rejects(waiting, error => error === failure);
  gate.reject(failure);
  await rejected;
  assert.equal(first.status, 'rejected'); assert.equal(first.error, failure);
  assert.equal(clock.active(), 0);
  let retries = 0;
  const retry = s.start(request, snapshot => {
    retries++; assert.deepEqual(snapshot, request); return { sale: { id: 'retry-confirmed' } };
  });
  assert.notEqual(retry, first);
  assert.equal((await retry.promise).sale.id, 'retry-confirmed');
  assert.equal(retries, 1);
});

test('a synchronous send failure also releases the key for a retry', async t => {
  const s = scope(t), request = requestFor('sync-throw'), failure = new Error('Mock synchronous failure');
  const first = s.start(request, () => { throw failure; });
  await assert.rejects(first.promise, error => error === failure);
  const retry = s.start(request, () => ({ sale: { id: 'retry' } }));
  assert.notEqual(first, retry);
  assert.equal((await retry.promise).sale.id, 'retry');
});

test('wrong-key and stale release cannot delete a newer flight', async t => {
  const s = scope(t), request = requestFor('release-generation'), old = deferred(), current = deferred();
  const first = s.start(request, () => old.promise);
  releaseSaleRequest('different-key', first);
  assert.equal(s.start(request, () => assert.fail('wrong-key release removed flight')), first);
  releaseSaleRequest(request.idempotency_key, first);
  const replacement = s.start(request, () => current.promise);
  assert.notEqual(replacement, first);
  old.resolve({ sale: { id: 'old-response' } });
  await first.promise;
  releaseSaleRequest(request.idempotency_key, first);
  assert.equal(s.start(request, () => assert.fail('stale release removed replacement')), replacement);
  current.resolve({ sale: { id: 'new-response' } });
  assert.equal((await replacement.promise).sale.id, 'new-response');
});

test('late rejection of a released flight cannot evict its replacement', async t => {
  const s = scope(t), request = requestFor('rejected-generation'), old = deferred();
  const first = s.start(request, () => old.promise);
  releaseSaleRequest(request.idempotency_key, first);
  const replacement = s.start(request, () => ({ sale: { id: 'newer' } }));
  const rejected = assert.rejects(first.promise, /Mock old rejection/);
  old.reject(new Error('Mock old rejection'));
  await rejected;
  assert.equal(s.start(request, () => assert.fail('old rejection removed newer flight')), replacement);
  assert.equal((await replacement.promise).sale.id, 'newer');
});

test('bounded registry evicts only request reuse and leaves saved receipt data intact', async t => {
  const s = scope(t), q = queueFor(s.userId, 'oldest-cached-sale');
  const saved = q.rows(), gate = deferred();
  let sends = 0;
  const send = () => { sends++; return gate.promise; };
  const oldest = s.start(q.record.request, send);
  const others = Array.from({ length: 127 }, (_, i) => {
    const request = requestFor(`bounded-${i}`);
    return { request, flight: s.start(request, send) };
  });
  assert.equal(s.start(q.record.request, () => assert.fail('registry evicted before its bound')), oldest);
  const newestRequest = requestFor('bounded-newest');
  const newest = s.start(newestRequest, send);
  assert.equal(s.start(others[0].request, () => assert.fail('more than oldest was evicted')), others[0].flight);
  const replay = s.start(q.record.request, send);
  assert.notEqual(replay, oldest);
  assert.equal(sends, 130, '128 cached sends, one overflow, and one exact-key replay');
  assert.equal(s.start(newestRequest, () => assert.fail('newest entry was evicted')), newest);
  releaseSaleRequest(q.record.id, oldest);
  assert.equal(s.start(q.record.request, () => assert.fail('evicted generation removed replay')), replay);
  assert.deepEqual(q.rows(), saved);
  assert.deepEqual(q.removals, []);
  gate.resolve({ sale: { id: 'server-idempotent-result' } });
  await Promise.all([oldest, replay, newest, ...others.map(({ flight }) => flight)].map(flight => flight.promise));
  assert.deepEqual(q.rows(), saved, 'response caching cannot confirm or delete a durable queued sale');
});

test('queue drain reuses the timed-out presentation flight and removes only its confirmed receipt', async t => {
  const s = scope(t), q = queueFor(s.userId, 'queued-shared-flight'), gate = deferred();
  const other = queueFor(`${s.userId}-other`, 'other-user-receipt').record;
  q.add(other);
  const savedRequest = structuredClone(q.record.request), presentation = fakeTimers(), queueClock = fakeTimers();
  let sends = 0;
  const flight = s.start(q.record.request, () => { sends++; return gate.promise; });
  const waiting = waitForSaleResponse(flight, { timers: presentation.timers });
  presentation.fire(presentation.scheduled[0].id);
  assert.deepEqual(await waiting, { pending: true });
  assert.equal(q.rows().length, 2);
  useGlobalFakeTimers(t, queueClock);
  const confirmed = [];
  const syncing = syncPendingSales({
    userId: s.userId, storage: q.storage, lock: work => work(),
    send: () => assert.fail('queue must reuse the active exact-key request'),
    onConfirmed: details => { confirmed.push(details); },
  });
  await queueClock.nextScheduled();
  assert.equal(queueClock.scheduled[0].milliseconds, POS_QUEUE_RESPONSE_BUDGET_MS);
  assert.equal(q.rows().find(row => row.id === q.record.id).status, 'syncing');
  assert.deepEqual(q.removals, [], 'a presentation deadline cannot confirm the queue record');
  const response = { data: { sale: { id: 'saved-shared-sale' }, stock_updates: [] } };
  gate.resolve(response);
  assert.deepEqual(await syncing, { synced: 1, remaining: 0, failed: null });
  assert.equal(sends, 1);
  assert.deepEqual(q.removals, [q.record.id]);
  assert.deepEqual(q.rows(), [other]);
  assert.equal(confirmed.length, 1);
  assert.deepEqual(confirmed[0].request, savedRequest);
  assert.equal(confirmed[0].payload.sale.id, 'saved-shared-sale');
  assert.equal(queueClock.active(), 0);
});

test('queue drain cannot adopt a cached response from another user with the same key', async t => {
  const s = scope(t), q = queueFor(s.userId, 'cross-user-queue-key'), clock = fakeTimers();
  const otherFlight = s.start(q.record.request, () => ({ sale: { id: 'another-users-sale' } }),
    { userId: `${s.userId}-other` });
  await otherFlight.promise;
  useGlobalFakeTimers(t, clock);
  let sends = 0, confirmed;
  const result = await syncPendingSales({
    userId: s.userId, storage: q.storage, lock: work => work(),
    send: request => { sends++; assert.deepEqual(request, q.record.request); return { sale: { id: 'own-sale' } }; },
    onConfirmed: details => { confirmed = details; },
  });
  assert.equal(sends, 1);
  assert.equal(result.synced, 1);
  assert.equal(confirmed.payload.sale.id, 'own-sale');
  assert.equal(clock.active(), 0);
  assert.equal(s.start(q.record.request, () => assert.fail('other user cache was deleted'),
    { userId: `${s.userId}-other` }), otherFlight);
});

test('queue deadline retains the exact durable sale and a late response alone cannot delete it', async t => {
  const s = scope(t), q = queueFor(s.userId, 'queue-deadline'), clock = fakeTimers(), gate = deferred();
  const saved = structuredClone(q.record), now = Date.parse('2026-10-16T08:01:00.000Z');
  useGlobalFakeTimers(t, clock);
  let sends = 0;
  const syncing = syncPendingSales({
    userId: s.userId, storage: q.storage, lock: work => work(), now: () => now,
    send: request => { sends++; assert.deepEqual(request, saved.request); return gate.promise; },
  });
  const timerId = await clock.nextScheduled();
  clock.fire(timerId);
  const result = await syncing;
  assert.equal(result.synced, 0); assert.equal(result.remaining, 1);
  assert.equal(result.failed.retryable, true);
  assert.equal(sends, 1);
  const retained = q.rows()[0];
  assert.equal(retained.status, 'pending');
  assert.equal(retained.attempts, 1);
  assert.equal(retained.next_retry_at, new Date(now + 5000).toISOString());
  assert.deepEqual(retained.request, saved.request);
  assert.deepEqual(retained.local_sale, saved.local_sale);
  assert.deepEqual(q.removals, []);
  gate.resolve({ sale: { id: 'eventually-saved' } });
  await gate.promise;
  await Promise.resolve();
  assert.deepEqual(q.rows(), [retained]);
  assert.deepEqual(q.removals, []);
  assert.equal(clock.active(), 0);
});
