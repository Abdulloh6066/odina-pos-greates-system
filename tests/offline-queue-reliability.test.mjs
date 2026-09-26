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
