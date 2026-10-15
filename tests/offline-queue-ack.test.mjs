// Run the actual queue hook with React and memory-only persistence/transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as offline from '../src/lib/offline-sales.js';
import * as network from '../src/lib/pos-network.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let fixtureId = 0;
function fixture({ connected = false, onSynced = () => {}, onConfirmed = () => {}, seed = [] } = {}) {
  const user = `queue-user-${++fixtureId}`, rows = new Map(seed.map(row => [row.id, row]));
  const subscribers = new Set(), events = new Map(), timers = new Map(), saves = [], reads = [];
  let saveGate = null, listGate = null, next = 0, writes = 0, value, renderer;
  const nav = { onLine: connected };
  const win = {
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    setTimeout: (fn, delay) => { timers.set(++next, { fn, delay }); return next; }, clearTimeout: id => timers.delete(id),
  };
  const storage = {
    list: async userId => {
      const snapshot = [...rows.values()].filter(row => row.user_id === userId).map(row => structuredClone(row));
      reads.push(snapshot); if (listGate) await listGate.promise; return snapshot;
    },
    update: async (id, patch) => Object.assign(rows.get(id), patch), remove: async id => rows.delete(id),
  };
  const transport = async (_name, request) => {
    if (request.action === 'get_current_shift') return { data: { ok: true, shift: { id: 'shift', status: 'open' } } };
    writes++; return { data: { sale: { id: request.idempotency_key }, shift: { id: 'shift', order_count: writes }, stock_updates: [] } };
  };
  const data = { ...offline,
    listPendingSales: storage.list,
    savePendingSale: async row => { saves.push(row); if (saveGate) await saveGate.promise; rows.set(row.id, structuredClone(row)); for (const fn of subscribers) fn(); },
    subscribePendingSales: fn => { subscribers.add(fn); return () => subscribers.delete(fn); },
    syncPendingSales: options => offline.syncPendingSales({ ...options, storage, lock: work => work() }),
  };
  const dependencies = { react: React, '@/api/base44Client': { base44: { functions: { invoke: transport } } },
    '@/lib/offline-sales': data, '@/lib/pos-network': network };
  const module = { exports: {} };
  const code = transformSync(readFileSync('src/hooks/useOfflineSaleQueue.js', 'utf8'), { loader: 'js', format: 'cjs' }).code;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { navigator: nav, window: win })(name => {
    assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name];
  }, module, module.exports);
  function Probe({ userId = user }) { value = module.exports.default(userId, onSynced, undefined, onConfirmed); return null; }
  const record = suffix => offline.buildPendingSale({ idempotencyKey: `pos-${user}-${suffix}`, recordedAt: '2026-10-16T08:00:00.000Z',
    shift: { id: 'shift', shop_id: 'shop' }, user: { id: user },
    cart: [{ product_id: 'cake', price: 1000, quantity: 1 }], payments: [{ method: 'cash', amount: 1000 }] });
  return { userId: user, rows, reads, saves, nav, events, timers, record, value: () => value,
    writes: () => writes,
    blockSave: () => (saveGate = deferred()), blockList: () => (listGate = deferred()),
    clearList: () => { listGate = null; },
    async mount() { await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); await tick(); }); },
    async user(userId) { await act(async () => { renderer.update(React.createElement(Probe, { userId })); await tick(); }); },
    unmount() { act(() => renderer.unmount()); },
  };
}

test('enqueue acknowledges the durable commit without waiting for a slow list read, and stale lists cannot erase it', async () => {
  const f = fixture(); await f.mount();
  try {
    const saved = f.blockSave(), stale = f.blockList();
    let settled = false;
    const before = f.value().refresh();
    const row = f.record('one');
    const pending = f.value().enqueue(row).then(() => { settled = true; });
    await act(async () => { await tick(); });
    assert.equal(settled, false); assert.equal(f.value().records.length, 0);
    await act(async () => { saved.resolve(); await pending; });
    assert.equal(settled, true); assert.equal(f.value().records[0].id, row.id);
    assert.equal(f.rows.size, 1);
    await act(async () => { stale.resolve(); await before; await tick(); });
    assert.equal(f.value().records[0].id, row.id, 'old empty list must not overwrite committed local row');
  } finally { f.unmount(); }
});

test('failed durable storage reports an error without claiming a queued receipt', async () => {
  const f = fixture(); await f.mount();
  try {
    const saved = f.blockSave(), row = f.record('quota');
    const pending = f.value().enqueue(row);
    const rejected = assert.rejects(pending, /Quota/);
    await act(async () => { saved.reject(new Error('Quota')); await rejected; });
    assert.equal(f.rows.size, 0); assert.equal(f.value().records.length, 0);
    assert.match(f.value().storageError, /Quota/); assert.equal(f.writes(), 0);
  } finally { f.unmount(); }
});

test('confirmed queue acknowledgment does not await stock reconciliation or noncritical onSynced refetch', async () => {
  const reconciliation = deferred(), background = deferred(), confirmed = [], recovered = [];
  const f = fixture({ onConfirmed: (...args) => { confirmed.push(args); return reconciliation.promise; },
    onSynced: result => { recovered.push(result); return background.promise; } });
  await f.mount();
  try {
    const row = { ...f.record('confirmed'), last_error_status: 401, last_error: 'Prior session expired' };
    await act(async () => { await f.value().enqueue(row); });
    assert.equal(f.value().authorizationBlocked, true);
    f.nav.onLine = true;
    let settled = false, result;
    await act(async () => { result = await f.value().syncNow().then(value => { settled = true; return value; }); await tick(); });
    assert.equal(settled, true); assert.equal(result.synced, 1); assert.equal(f.value().syncing, false);
    assert.equal(f.rows.size, 0); assert.equal(f.writes(), 1); assert.equal(recovered.length, 1);
    assert.equal(f.value().authorizationBlocked, false, 'confirmed auth success must clear a held row’s prior401');
    assert.equal(confirmed.length, 1); assert.equal(confirmed[0][1], row.id);
    assert.equal(confirmed[0][2].request.idempotency_key, row.id);
    assert.equal(f.value().records[0].status, 'confirmed', 'retain stock reservation until reconciliation is confirmed');
    await act(async () => { await f.value().refresh(); });
    assert.equal(f.value().records.length, 1, 'durable queue read cannot erase the pending stock reconciliation');
    await act(async () => { reconciliation.resolve(); await tick(); });
    assert.equal(f.value().records.length, 0); assert.equal(f.writes(), 1);
    background.resolve();
  } finally { f.unmount(); }
});

test('stock reconciliation failure retries only the callback, never the acknowledged payment', async () => {
  let confirms = 0;
  const f = fixture({ onConfirmed: async () => { if (++confirms === 1) throw new Error('Stock read failed'); } });
  await f.mount();
  try {
    await act(async () => { await f.value().enqueue(f.record('retry')); });
    f.nav.onLine = true;
    await act(async () => { await f.value().syncNow(); await tick(); });
    assert.equal(f.rows.size, 0); assert.equal(f.value().records[0].status, 'confirmed');
    assert.equal(f.writes(), 1); assert.equal(confirms, 1);
    await act(async () => { await f.value().syncNow(); await tick(); });
    assert.equal(confirms, 2); assert.equal(f.writes(), 1); assert.equal(f.value().records.length, 0);
  } finally { f.unmount(); }
});

test('late reconciliation after user change cannot remove or publish another user’s records', async () => {
  const gate = deferred();
  const f = fixture({ onConfirmed: () => gate.promise }); await f.mount();
  try {
    await act(async () => { await f.value().enqueue(f.record('old-user')); });
    f.nav.onLine = true;
    await act(async () => { await f.value().syncNow(); await tick(); });
    assert.equal(f.value().records[0].status, 'confirmed');
    f.nav.onLine = false;
    await f.user('new-cashier');
    assert.equal(f.value().records.length, 0);
    await act(async () => { gate.resolve(); await tick(); });
    assert.equal(f.value().records.length, 0); assert.equal(f.writes(), 1);
  } finally { f.unmount(); }
});

test('old user durable-save continuation cannot invalidate the new user’s pending queue read', async () => {
  const nextUserRow = offline.buildPendingSale({ idempotencyKey: 'pos-next-cashier-pending', recordedAt: '2026-10-16T08:00:00.000Z',
    shift: { id: 'new-shift', shop_id: 'shop' }, user: { id: 'new-cashier' },
    cart: [{ product_id: 'cake', price: 1000, quantity: 2 }], payments: [{ method: 'cash', amount: 2000 }] });
  const f = fixture({ seed: [nextUserRow] }); await f.mount();
  try {
    const save = f.blockSave();
    const oldEnqueue = f.value().enqueue(f.record('old-slow-save'));
    const lists = f.blockList();
    await f.user('new-cashier');
    assert.equal(f.value().records.length, 0, 'new user list is still pending');
    await act(async () => { save.resolve(); await oldEnqueue; await tick(); });
    await act(async () => { lists.resolve(); await tick(); });
    assert.deepEqual(Array.from(f.value().records, row => row.id), [nextUserRow.id]);
    assert.equal(f.value().records[0].request.items[0].quantity, 2, 'preserve the next user’s pending stock reservation');
  } finally { f.unmount(); }
});
