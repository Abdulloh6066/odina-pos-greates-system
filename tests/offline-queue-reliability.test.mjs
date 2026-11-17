// Queue storage is an in-memory fake. No IndexedDB, real sales, or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncPendingSales, pendingSaleRetryDelay } from '../src/lib/offline-sales.js';

const timestamp = Date.parse('2026-09-27T07:00:00.000Z');
const queue = (seed = ['bad', 'good']) => {
  let rows = seed.map((id, i) => ({ id, user_id: 'cashier', status: 'pending', attempts: 0,
    created_at: new Date(timestamp + i).toISOString(), request: { idempotency_key: id, value: i } }));
  const storage = {
    list: async userId => structuredClone(rows.filter(row => row.user_id === userId)),
    update: async (id, patch) => { Object.assign(rows.find(row => row.id === id), structuredClone(patch)); },
    remove: async id => { rows = rows.filter(row => row.id !== id); },
  };
  const run = (send, extra = {}) => syncPendingSales({ userId: 'cashier', send, storage,
    now: () => timestamp, lock: work => work(), ...extra });
  return { storage, run, rows: () => rows };
};
const failure = status => Object.assign(new Error('Mock request failure'), { status });
const processing = () => ({ response: { status: 503,
  data: { code: 'SALE_PROCESSING', error: 'Still processing', retry_after_ms: 15000 } } });

test('a processing sale backs off independently while later sales send, then confirms with its original key', async () => {
  const q = queue(), requests = [];
  const original = structuredClone(q.rows()[0].request);
  await q.run(async req => {
    requests.push(structuredClone(req));
    if (req.idempotency_key === 'bad') throw processing();
    return { sale: { id: 'saved-good' } };
  });
  assert.deepEqual(requests.map(req => req.idempotency_key), ['bad', 'good']);
  assert.equal(q.rows().length, 1);
  assert.equal(q.rows()[0].retry_scope, 'sale');
  assert.equal(pendingSaleRetryDelay(q.rows(), timestamp), 15250);
  await q.run(async () => { throw new Error('must wait'); });
  assert.equal(q.rows()[0].attempts, 1);
  const result = await q.run(async req => {
    assert.deepEqual(req, original); return { sale: { id: 'saved-bad' } };
  }, { now: () => timestamp + 15250 });
  assert.equal(result.synced, 1); assert.equal(result.remaining, 0);
});

test('persistently processing entries stop automatic retries after six checks and remain recoverable', async () => {
  const q = queue(['stuck']), original = structuredClone(q.rows()[0].request);
  let current = timestamp, calls = 0;
  for (let i = 0; i < 6; i++) {
    await q.run(async () => { calls++; throw processing(); }, { now: () => current });
    current += 61000;
  }
  assert.equal(calls, 6); assert.equal(q.rows()[0].status, 'failed');
  assert.deepEqual(q.rows()[0].request, original);
  assert.equal(pendingSaleRetryDelay(q.rows(), current), null);
  await q.run(async () => { calls++; }, { now: () => current });
  assert.equal(calls, 6);
  const result = await q.run(async req => {
    assert.deepEqual(req, original); return { sale: { id: 'completed-later' } };
  }, { retryFailed: true, now: () => current });
  assert.equal(result.remaining, 0);
});

test('a rate limit behind a processing entry pauses every retry including explicit retries and survives reload', async () => {
  const q = queue(['stuck', 'limited', 'later']), sent = [];
  await q.run(async req => {
    sent.push(req.idempotency_key);
    if (req.idempotency_key === 'stuck') throw processing();
    throw { response: { status: 429, data: { retry_after_ms: 45000 } } };
  });
  assert.deepEqual(sent, ['stuck', 'limited']);
  // Scheduler derives cooldown only from durable rows, no page-local state.
  assert.equal(pendingSaleRetryDelay(structuredClone(q.rows()), timestamp), 45250);
  for (const retryFailed of [false, true]) await q.run(async () => {
    assert.fail('cooldown must not be bypassed');
  }, { retryFailed, recordId: 'later' });
  const result = await q.run(async () => ({ sale: { id: 'saved' } }), { now: () => timestamp + 45250 });
  assert.equal(result.synced, 3); assert.equal(result.remaining, 0);
});

test('a new eligible sale schedules promptly behind a processing-only cooldown', async () => {
  const q = queue();
  await q.storage.update('bad', { retry_scope: 'sale', next_retry_at: new Date(timestamp + 60000).toISOString() });
  assert.equal(pendingSaleRetryDelay(q.rows(), timestamp), 1000);
  const sent = [];
  await q.run(async req => { sent.push(req.idempotency_key); return { sale: { id: 'saved' } }; });
  assert.deepEqual(sent, ['good']); assert.equal(q.rows()[0].id, 'bad');
});


test('permanently invalid sale is retained while a valid sale behind it synchronizes', async () => {
  const q = queue(); const sent = [];
  const result = await q.run(async request => {
    sent.push(request.idempotency_key);
    if (request.idempotency_key === 'bad') throw failure(400);
    return { sale: { id: 'saved-good' } };
  });
  assert.deepEqual(sent, ['bad', 'good']); assert.equal(result.synced, 1);
  assert.equal(result.remaining, 1); assert.equal(q.rows()[0].status, 'failed');
  assert.deepEqual(q.rows()[0].request, { idempotency_key: 'bad', value: 0 });
});
test('automatic synchronization skips already failed records, manual retry can resolve them', async () => {
  const q = queue(['bad']); await q.storage.update('bad', { status: 'failed', last_error: 'Review required' });
  let sent = 0;
  const send = async () => { sent++; return { data: { sale: { id: 'saved' } } }; };
  const automatic = await q.run(send); assert.equal(sent, 0); assert.ok(automatic.failed);
  const manual = await q.run(send, { retryFailed: true }); assert.equal(sent, 1); assert.equal(manual.remaining, 0);
});
test('temporary server outage stops and backs off instead of hammering later queued sales', async () => {
  const q = queue(); const sent = [];
  await q.run(async req => { sent.push(req.idempotency_key); throw failure(503); });
  assert.deepEqual(sent, ['bad']); assert.equal(q.rows()[0].status, 'pending');
  assert.equal(pendingSaleRetryDelay(q.rows(), timestamp), 5000);
  let retry = 0; await q.run(async () => { retry++; return { sale: {} }; }); assert.equal(retry, 0);
  const result = await q.run(async () => ({ sale: { id: 'saved' } }), { now: () => timestamp + 5000 });
  assert.equal(result.synced, 2); assert.equal(result.remaining, 0);
});
test('session errors pause the entire queue without marking valid sales permanently failed', async () => {
  for (const status of [401, 403]) {
    const q = queue(); let sent = 0;
    await q.run(async () => { sent++; throw failure(status); });
    assert.equal(sent, 1); assert.equal(q.rows()[0].status, 'pending');
    assert.equal(pendingSaleRetryDelay(q.rows(), timestamp), 60000);
  }
});
test('a response without a confirmed sale never removes the queued receipt', async () => {
  const q = queue(['one']);
  const result = await q.run(async () => ({ data: { error: 'not confirmed' } }));
  assert.equal(result.synced, 0); assert.equal(q.rows().length, 1); assert.equal(q.rows()[0].status, 'pending');
});
test('no retry timer is requested for an empty queue or only permanently failed rows', () => {
  assert.equal(pendingSaleRetryDelay([], timestamp), null);
  assert.equal(pendingSaleRetryDelay([{ status: 'failed' }], timestamp), null);
});
test('cross-tab lock miss skips synchronization without sending a request', async () => {
  const q = queue(['one']); let sent = 0;
  const result = await q.run(async () => { sent++; return { sale: {} }; }, { lock: async () => ({ skipped: true }) });
  assert.equal(sent, 0); assert.equal(result.skipped, true); assert.equal(result.remaining, 1);
});
