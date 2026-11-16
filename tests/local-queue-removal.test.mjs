import test from 'node:test';
import assert from 'node:assert/strict';

// Transactional memory double: real queue functions, no network or production data.
async function fixture() {
  const rows = new Map();
  let failWrite = false, sequence = 0;
  const database = { transaction(_store, mode) {
    const snapshot = new Map([...rows].map(([id, row]) => [id, structuredClone(row)]));
    const tx = { aborted: false, abort() { this.aborted = true; queueMicrotask(() => this.onabort?.()); } };
    const read = fn => { const r = {}; queueMicrotask(() => { if (!tx.aborted) { r.result = structuredClone(fn()); r.onsuccess?.(); } }); return r; };
    tx.objectStore = () => ({
      get: id => read(() => snapshot.get(id)), getAll: () => read(() => [...snapshot.values()]),
      put: row => { if (failWrite) { tx.abort(); return; } snapshot.set(row.id, structuredClone(row)); },
      delete: id => snapshot.delete(id),
    });
    setTimeout(() => {
      if (tx.aborted) return;
      if (mode === 'readwrite') { rows.clear(); for (const [id, row] of snapshot) rows.set(id, row); }
      tx.oncomplete?.();
    }, 0);
    return tx;
  } };
  const savedIDB = globalThis.indexedDB, savedChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = undefined;
  globalThis.indexedDB = { open() { const r = {}; queueMicrotask(() => { r.result = database; r.onsuccess?.(); }); return r; } };
  const queue = await import('../src/lib/offline-sales.js?local-removal=' + Math.random());
  const add = async (owner = 'staff') => {
    const id = 'pos-local-test-' + String(++sequence).padStart(8, '0');
    const record = { id, user_id: owner, shop_id: 'shop', shift_id: 'shift', status: 'pending',
      created_at: new Date().toISOString(), request: { idempotency_key: id, items: [{ product_id: 'cake', quantity: 1 }] },
      local_sale: { total: 80000 } };
    await queue.savePendingSale(record); return record;
  };
  const approval = ids => ({ authorized: true, action: 'local_queue_removal', approval_id: 'approval-test',
    user_id: 'staff', shop_id: 'shop', ids, reason: 'Stuck sale', approved_at: new Date().toISOString() });
  return { queue, rows, add, approval, failWrites: value => { failWrite = value; },
    close() { globalThis.indexedDB = savedIDB; globalThis.BroadcastChannel = savedChannel; } };
}
test('50 selected sales use one approval and retain recovery copies after reload', async () => {
  const f = await fixture();
  try {
    const selected = [];
    for (let i = 0; i < 50; i++) selected.push(await f.add());
    const untouched = await f.add(), other = await f.add('other');
    let calls = 0;
    const result = await f.queue.removeLocalPendingSales({ userId: 'staff', ids: selected.map(row => row.id),
      authorize: async ids => { calls++; return f.approval(ids); } });
    assert.equal(calls, 1);
    assert.equal(result.results.length, 50);
    assert.equal((await f.queue.listPendingSales('staff')).length, 1);
    for (const row of selected) {
      assert.equal(f.rows.get(row.id).status, 'removed');
      assert.deepEqual(f.rows.get(row.id).request, row.request);
      assert.deepEqual(f.rows.get(row.id).local_sale, row.local_sale);
      assert.equal(f.rows.get(row.id).resolution.local_only, true);
    }
    assert.equal(f.rows.get(untouched.id).status, 'pending');
    assert.equal(f.rows.get(other.id).status, 'pending');
    const reloaded = await import('../src/lib/offline-sales.js?local-reload=' + Math.random());
    assert.equal((await reloaded.listPendingSales('staff')).length, 1);
    await f.queue.savePendingSale(selected[0]); // delayed enqueue cannot revive archive
    assert.equal(f.rows.get(selected[0].id).status, 'removed');
  } finally { f.close(); }
});
test('failed PIN, changed user, wrong scope, and failed transaction keep queued sales', async () => {
  const f = await fixture();
  try {
    const first = await f.add(), second = await f.add();
    const options = { userId: 'staff', ids: [first.id, second.id] };
    await assert.rejects(f.queue.removeLocalPendingSales({ ...options, authorize: async () => { throw new Error('503'); } }));
    await assert.rejects(f.queue.removeLocalPendingSales({ ...options, authorize: async ids => ({ ...f.approval(ids), shop_id: 'other' }) }));
    await assert.rejects(f.queue.removeLocalPendingSales({ ...options, isCurrent: () => false, authorize: async ids => f.approval(ids) }));
    await assert.rejects(f.queue.removeLocalPendingSales({ ...options, authorizationTimeoutMs: 5,
      authorize: async () => new Promise(() => {}) }), /PIN tekshiruvi/);
    f.failWrites(true);
    await assert.rejects(f.queue.removeLocalPendingSales({ ...options, authorize: async ids => f.approval(ids) }));
    f.failWrites(false);
    assert.equal((await f.queue.listPendingSales('staff')).length, 2);
    assert.equal(f.rows.get(first.id).status, 'pending');
    assert.equal(f.rows.get(second.id).status, 'pending');
  } finally { f.close(); }
});
for (const succeeds of [true, false]) test('late ' + (succeeds ? 'success' : 'failure') + ' preserves archive and does not send later removed entries', async () => {
  const f = await fixture();
  let release;
  try {
    const first = await f.add(), second = await f.add();
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const sent = [];
    const sender = f.queue.syncPendingSales({ userId: 'staff', lock: work => work(),
      send: async req => {
        sent.push(req.idempotency_key); entered(); await gate;
        if (!succeeds) throw Object.assign(new Error('503'), { status: 503 });
        return { sale: { id: 'server-sale' } };
      } });
    await started;
    await f.queue.removeLocalPendingSales({ userId: 'staff', ids: [first.id, second.id],
      authorize: async ids => f.approval(ids) });
    release(); await sender;
    assert.deepEqual(sent, [first.id]);
    assert.equal(f.rows.get(first.id).status, 'removed');
    assert.equal(f.rows.get(second.id).status, 'removed');
    assert.equal((await f.queue.listPendingSales('staff')).length, 0);
  } finally { release?.(); f.close(); }
});
test('pausing review stops a queue drain before sending', async () => {
  const f = await fixture();
  try {
    await f.add();
    const result = await f.queue.syncPendingSales({ userId: 'staff', shouldStop: () => true,
      lock: work => work(), send: async () => { throw new Error('Must not send while review is paused'); } });
    assert.equal(result.synced, 0);
    assert.equal(result.remaining, 1);
    assert.equal([...f.rows.values()][0].attempts, undefined);
  } finally { f.close(); }
});
