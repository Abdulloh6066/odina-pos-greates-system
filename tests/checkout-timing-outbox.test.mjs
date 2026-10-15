// Actual outbox with a transactional in-memory IndexedDB. No SDK, sales or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const clone = value => value === undefined ? undefined : structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const event = (index = 0, actor = 'cashier') => ({
  event_id: `ct-test-event-${String(index).padStart(8, '0')}`, actor_id: actor, shift_id: 'shift',
  request_key: `pos-test-request-${String(index).padStart(8, '0')}`, sale_id: `sale-${index}`,
  total_ms: 2400, api_round_trip_ms: 2100, outcome: 'confirmed', client_completed_at: '2026-10-16T06:00:00.000Z',
});
const ack = body => ({ data: { saved: true, event_id: body.event_id, already_recorded: false } });

function indexedDb() {
  const databases = new Map(); const opened = []; const removed = [];
  const control = { failOpen: false, failPut: false, failRead: false, failRemove: false };
  function connection(state) {
    return { close() {}, createObjectStore() { return { createIndex() {} }; },
      transaction(_store, mode) {
        const tx = {}; const operations = []; let active = false; let finished = false;
        let staged; let release;
        const prior = state.tail; state.tail = new Promise(resolve => { release = resolve; });
        const finish = error => {
          if (finished) return; finished = true;
          if (!error && mode === 'readwrite') state.rows = staged;
          if (error) { tx.error = error; tx.onabort?.(); } else tx.oncomplete?.();
          release();
        };
        const pump = () => {
          if (finished || !active) return;
          const next = operations.shift(); if (!next) { finish(); return; }
          try {
            next.request.result = next.operation(staged);
            next.request.onsuccess?.();
          } catch (error) { next.request.error = error; next.request.onerror?.(); finish(error); return; }
          queueMicrotask(pump);
        };
        const request = operation => {
          const result = {}; operations.push({ request: result, operation }); return result;
        };
        const read = operation => request(rows => {
          if (control.failRead) { control.failRead = false; throw new Error('Mock read failure'); }
          return operation(rows);
        });
        const store = {
          get: id => read(rows => clone(rows.get(id))),
          put: row => request(rows => {
            if (control.failPut) { control.failPut = false; throw new Error('Mock quota failure'); }
            rows.set(row.id, clone(row)); return row.id;
          }),
          delete: id => request(rows => {
            if (control.failRemove) { control.failRemove = false; throw new Error('Mock remove failure'); }
            removed.push(id); rows.delete(id);
          }),
          index: () => ({ getAll: actor => read(rows => [...rows.values()].filter(row => row.actor_id === actor).map(clone)) }),
        };
        tx.objectStore = () => store;
        prior.then(() => { staged = new Map([...state.rows].map(([key, row]) => [key, clone(row)])); active = true; queueMicrotask(pump); });
        return tx;
      },
    };
  }
  const api = { open(name) {
    opened.push(name); const request = {};
    queueMicrotask(() => {
      if (control.failOpen) { request.onerror?.(); return; }
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, { rows: new Map(), tail: Promise.resolve() });
      request.result = connection(databases.get(name));
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  } };
  return { api, control, opened, removed, rows: () => [...databases.values()].flatMap(db => [...db.rows.values()]) };
}

function loadOutbox(idb, globals = {}) {
  const module = { exports: {} };
  const code = transformSync(readFileSync('src/lib/checkout-timing-outbox.js', 'utf8'), { loader: 'js', format: 'cjs' }).code;
  const context = { indexedDB: idb.api, navigator: { onLine: true },
    fetch: () => { throw new Error('No network allowed'); },
    setTimeout: () => { throw new Error('No retry timers allowed'); }, setInterval: () => { throw new Error('No retry intervals allowed'); },
    ...globals,
  };
  vm.runInNewContext(`(function(module,exports){${code}\n})`, context)(module, module.exports);
  return { ...module.exports, context };
}

test('real IndexedDB outbox survives module reload and sends only whitelisted diagnostics after persistence', async () => {
  const db = indexedDb(); const first = loadOutbox(db);
  const original = { ...event(), payments: [{ amount: 1000 }], token: 'secret', shop_id: 'untrusted' };
  const pending = first.enqueueCheckoutTiming(original);
  original.total_ms = 9999;
  assert.equal((await pending).persisted, true);
  assert.equal(db.rows().length, 1); assert.deepEqual(plain(db.rows()[0].event), event());
  const reopened = loadOutbox(db); const sent = [];
  const result = await reopened.flushCheckoutTimings({ userId: 'cashier', send: async body => { sent.push(plain(body)); return ack(body); } });
  assert.equal(result.sent, 1); assert.equal(result.remaining, 0);
  const { actor_id: _actor, ...expected } = event();
  assert.deepEqual(sent, [{ action: 'record', ...expected }]);
  assert.ok(db.opened.every(name => name === 'odina-checkout-timing-outbox'));
  assert.equal(db.removed.length, 1); assert.equal(db.rows().length, 0);
});

test('atomic concurrent enqueues retain the original event and reject conflicting reuse of its identity', async () => {
  const db = indexedDb(); const a = loadOutbox(db); const b = loadOutbox(db);
  const results = await Promise.all([a.enqueueCheckoutTiming(event()), b.enqueueCheckoutTiming(event()),
    a.enqueueCheckoutTiming({ ...event(), total_ms: 9999 })]);
  assert.equal(results.filter(result => result.persisted).length, 2);
  assert.equal(results[2].error, 'event_conflict'); assert.equal(db.rows().length, 1);
  assert.equal(db.rows()[0].event.total_ms, 2400);
});

test('lost reply and missing or mismatched acknowledgment retry the identical event without any sale call', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db); await outbox.enqueueCheckoutTiming(event()); const sent = [];
  for (const reply of [null, { saved: false, event_id: event().event_id }, { saved: true, event_id: 'different-event' }]) {
    const result = await outbox.flushCheckoutTimings({ userId: 'cashier', send: async body => {
      sent.push(plain(body)); if (reply === null) throw new Error('Reply lost after saved telemetry'); return reply;
    } });
    assert.equal(result.sent, 0); assert.equal(result.remaining, 1); assert.equal(result.hasMore, false);
    assert.equal(db.removed.length, 0);
  }
  const result = await outbox.flushCheckoutTimings({ userId: 'cashier', send: async body => {
    sent.push(plain(body)); return { saved: true, event_id: body.event_id, already_recorded: true };
  } });
  assert.equal(result.sent, 1); assert.equal(result.remaining, 0);
  assert.ok(sent.every(body => JSON.stringify(body) === JSON.stringify(sent[0])));
  assert.ok(sent.every(body => body.action === 'record' && !Object.hasOwn(body, 'actor_id')));
});

test('flushes are sequential under the module fallback and only the current matching worker is uploaded', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db); const gate = deferred(); const sent = []; let active = 0; let maximum = 0;
  for (const item of [event(0), event(1), event(2, 'other-worker')]) await outbox.enqueueCheckoutTiming(item);
  const send = async body => { active++; maximum = Math.max(maximum, active); sent.push(body.event_id); if (sent.length === 1) await gate.promise; active--; return ack(body); };
  const first = outbox.flushCheckoutTimings({ userId: 'cashier', send });
  const second = outbox.flushCheckoutTimings({ userId: 'cashier', send });
  await tick(); assert.equal(sent.length, 1); gate.resolve(); await Promise.all([first, second]);
  assert.equal(maximum, 1); assert.equal(sent.length, 2);
  assert.equal(db.rows().length, 1); assert.equal(db.rows()[0].actor_id, 'other-worker');
  const blocked = await outbox.flushCheckoutTimings({ userId: 'other-worker', send, isCurrentUser: () => false });
  assert.equal(blocked.skipped, true); assert.equal(sent.length, 2);
});

test('browser cross-tab lock skips the second instance without concurrent requests', async () => {
  const db = indexedDb(); let held = false;
  const locks = { request: async (_name, options, work) => {
    assert.equal(options.mode, 'exclusive'); assert.equal(options.ifAvailable, true);
    if (held) return work(null); held = true;
    try { return await work({ name: 'timing-lock' }); } finally { held = false; }
  } };
  const a = loadOutbox(db, { navigator: { locks, onLine: true } }); const b = loadOutbox(db, { navigator: { locks, onLine: true } });
  await a.enqueueCheckoutTiming(event()); const gate = deferred(); let calls = 0;
  const send = async body => { calls++; await gate.promise; return ack(body); };
  const pending = a.flushCheckoutTimings({ userId: 'cashier', send }); await tick();
  const skipped = await b.flushCheckoutTimings({ userId: 'cashier', send });
  assert.equal(skipped.skipped, true); assert.equal(calls, 1); gate.resolve(); await pending;
});

test('user changes during an upload stop before the next event and retain that worker backlog', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db); await outbox.enqueueCheckoutTiming(event(0)); await outbox.enqueueCheckoutTiming(event(1));
  const gate = deferred(); let current = 'cashier'; const sent = [];
  const pending = outbox.flushCheckoutTimings({ userId: 'cashier', isCurrentUser: actor => actor === current,
    send: async body => { sent.push(body); await gate.promise; return ack(body); } });
  await tick(); current = 'another-login'; gate.resolve(); const result = await pending;
  assert.equal(sent.length, 1); assert.equal(result.sent, 1); assert.equal(result.remaining, 1); assert.equal(result.hasMore, false);
  assert.equal(db.rows()[0].actor_id, 'cashier');
});

test('permanent rejection is retained for diagnosis without retry loops or blocking later good events', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db); await outbox.enqueueCheckoutTiming(event(0)); await outbox.enqueueCheckoutTiming(event(1));
  const sent = [];
  const result = await outbox.flushCheckoutTimings({ userId: 'cashier', send: async body => {
    sent.push(body.event_id); if (body.event_id === event(0).event_id) throw Object.assign(new Error('Rejected'), { status: 400 }); return ack(body);
  } });
  assert.equal(result.sent, 1); assert.equal(result.remaining, 1); assert.equal(result.hasMore, false);
  assert.equal(db.rows()[0].status, 'rejected'); assert.equal(db.rows()[0].last_error_status, 400);
  await outbox.flushCheckoutTimings({ userId: 'cashier', send: async () => { throw new Error('Rejected event must not retry automatically'); } });
  assert.equal(sent.length, 2); assert.equal(db.rows().length, 1);
});

test('session, rollout, throttling and transient failures retain identical pending events and stop the batch', async () => {
  for (const status of [0, 401, 404, 408, 429, 503]) {
    const db = indexedDb(); const outbox = loadOutbox(db); await outbox.enqueueCheckoutTiming(event(0)); await outbox.enqueueCheckoutTiming(event(1));
    let sent = 0;
    const result = await outbox.flushCheckoutTimings({ userId: 'cashier', send: async () => { sent++; throw Object.assign(new Error('Unavailable'), { status }); } });
    assert.equal(sent, 1); assert.equal(result.remaining, 2); assert.equal(result.hasMore, false);
    assert.ok(db.rows().every(row => row.status === 'pending')); assert.equal(db.removed.length, 0);
  }
});

test('each flush is bounded at50; reporting drains additional sequential batches without timers or silent dropping', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db); const sent = [];
  for (let index = 0; index < 121; index++) await outbox.enqueueCheckoutTiming(event(index));
  const send = async body => { sent.push(body.event_id); return ack(body); };
  const first = await outbox.flushCheckoutTimings({ userId: 'cashier', send });
  assert.equal(first.sent, 50); assert.equal(first.remaining, 71); assert.equal(first.hasMore, true);
  const final = await outbox.reportCheckoutTiming(event(121), { send });
  assert.equal(final.remaining, 0); assert.equal(final.hasMore, false);
  assert.equal(sent.length, 122); assert.equal(new Set(sent).size, 122); assert.equal(db.rows().length, 0);
});

test('storage open, read, quota and acknowledged-removal failures never throw and do not lose pending metrics', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db); db.control.failOpen = true;
  assert.equal((await outbox.reportCheckoutTiming(event(), { send: ack })).persisted, false);
  db.control.failOpen = false; db.control.failPut = true;
  assert.equal((await outbox.enqueueCheckoutTiming(event())).persisted, false); assert.equal(db.rows().length, 0);
  assert.equal((await outbox.enqueueCheckoutTiming(event())).persisted, true);
  db.control.failRead = true;
  assert.equal((await outbox.flushCheckoutTimings({ userId: 'cashier', send: ack })).failed.reason, 'storage_unavailable');
  assert.equal(db.rows().length, 1);
  db.control.failRemove = true;
  const failed = await outbox.flushCheckoutTimings({ userId: 'cashier', send: ack });
  assert.equal(failed.sent, 0); assert.equal(failed.remaining, 1);
  assert.equal((await outbox.flushCheckoutTimings({ userId: 'cashier', send: ack })).sent, 1);
});

test('blocked storage falls back to a validated direct timing report, with an honest persistence warning', async () => {
  const db = indexedDb(); db.control.failOpen = true; const outbox = loadOutbox(db); const sent = [];
  const value = { ...event(), token: 'never-send', payments: [1000] };
  const pending = outbox.reportCheckoutTiming(value, { send: async body => { sent.push(plain(body)); return ack(body); } });
  value.actor_id = 'other-worker'; value.total_ms = 9999;
  const result = await pending;
  assert.equal(result.sent, 1); assert.equal(result.persisted, false); assert.equal(result.error, 'storage_unavailable');
  assert.equal(sent.length, 1); assert.equal(sent[0].total_ms, 2400); assert.equal(sent[0].event_id, event().event_id);
  assert.doesNotMatch(JSON.stringify(sent), /never-send|payments|actor_id|other-worker|complete-sale/);
  assert.equal(db.rows().length, 0);
  const failed = await outbox.reportCheckoutTiming(event(1), { send: () => { throw new Error('Network down too'); } });
  assert.equal(failed.sent, 0); assert.equal(failed.failed.reason, 'direct_report_failed');
  let attempts = 0;
  await outbox.reportCheckoutTiming(event(2), { send: () => { attempts++; }, isCurrentUser: () => false });
  assert.equal(attempts, 0);
  outbox.context.navigator.onLine = false;
  await outbox.reportCheckoutTiming(event(3), { send: () => { attempts++; } });
  assert.equal(attempts, 0);
});

test('a rejected old-shift 403 remains diagnostic and cannot block another valid timing', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db); await outbox.enqueueCheckoutTiming(event(0)); await outbox.enqueueCheckoutTiming(event(1));
  let sent = 0;
  const result = await outbox.flushCheckoutTimings({ userId: 'cashier', send: async body => {
    sent++; if (sent === 1) throw Object.assign(new Error('Old shift access denied'), { status: 403 }); return ack(body);
  } });
  assert.equal(sent, 2); assert.equal(result.sent, 1); assert.equal(result.hasMore, false);
  assert.equal(db.rows().length, 1); assert.equal(db.rows()[0].status, 'rejected'); assert.equal(db.rows()[0].last_error_status, 403);
});

test('damaged persisted entries are quarantined without sending them or blocking later healthy reports', async () => {
  for (const corrupt of [
    row => Reflect.deleteProperty(row, 'event'),
    row => { row.event.actor_id = 'another-worker'; },
    row => { row.event.total_ms = 9999; },
    row => { row.event_json = null; },
    row => { row.event.client_completed_at = 'invalid'; },
  ]) {
    const db = indexedDb(); const outbox = loadOutbox(db);
    await outbox.enqueueCheckoutTiming(event(0)); await outbox.enqueueCheckoutTiming(event(1));
    corrupt(db.rows().find(row => row.event.event_id === event(0).event_id));
    const sent = [];
    const result = await outbox.flushCheckoutTimings({ userId: 'cashier', send: async body => { sent.push(body.event_id); return ack(body); } });
    assert.deepEqual(sent, [event(1).event_id]);
    assert.equal(result.sent, 1); assert.equal(result.remaining, 1); assert.equal(result.hasMore, false);
    assert.equal(result.failed.reason, 'corrupt_event');
    assert.equal(db.rows()[0].status, 'rejected'); assert.equal(db.rows()[0].last_error, 'corrupt_event');
    const again = await outbox.flushCheckoutTimings({ userId: 'cashier', send: async () => { throw new Error('Quarantined entry was retried'); } });
    assert.equal(again.sent, 0); assert.equal(again.hasMore, false); assert.equal(db.removed.length, 1);
  }
});

test('all outcomes remain distinct, input is frozen, and malformed events or hostile getters cannot reach send', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db); const sent = [];
  for (const [index, outcome] of ['confirmed', 'rechecked', 'queued', 'unconfirmed'].entries()) {
    const value = { ...event(index), outcome }; if (outcome === 'queued' || outcome === 'unconfirmed') Reflect.deleteProperty(value, 'sale_id');
    await outbox.reportCheckoutTiming(value, { send: async body => { sent.push(plain(body)); return ack(body); } });
  }
  assert.deepEqual(sent.map(row => row.outcome), ['confirmed', 'rechecked', 'queued', 'unconfirmed']);
  for (const patch of [{ total_ms: -1 }, { total_ms: Infinity }, { total_ms: 86400001 }, { total_ms: 1.5 },
    { event_id: 'short' }, { event_id: 1234567890123456 }, { request_key: 'short' }, { actor_id: '' }, { shift_id: '' },
    { client_completed_at: '2026-10-16' }, { client_completed_at: 'invalid' }, { outcome: 'paid' },
    { outcome: 'queued' }, { api_round_trip_ms: -1 }]) {
    const result = await outbox.reportCheckoutTiming({ ...event(), ...patch }, { send: () => { throw new Error('Invalid event sent'); } });
    assert.equal(result.queued, false);
  }
  const hostile = Object.defineProperty({}, 'event_id', { get() { throw new Error('Blocked getter'); } });
  assert.equal((await outbox.reportCheckoutTiming(hostile)).queued, false);
  assert.equal((await outbox.reportCheckoutTiming(null)).queued, false);
  assert.equal(sent.length, 4); assert.equal(db.rows().length, 0);
});

test('event identifiers stay unique with blocked crypto and an offline browser never uploads', async () => {
  const db = indexedDb(); const outbox = loadOutbox(db, { navigator: { onLine: false }, crypto: { randomUUID() { throw new Error('Crypto blocked'); } } });
  const ids = Array.from({ length: 100 }, () => outbox.createCheckoutTimingEventId());
  assert.equal(new Set(ids).size, 100); assert.ok(ids.every(id => /^[A-Za-z0-9:_-]{16,128}$/.test(id)));
  const result = await outbox.reportCheckoutTiming(event(), { send: () => { throw new Error('Offline request attempted'); } });
  assert.equal(result.remaining, 1); assert.equal(result.hasMore, false); assert.equal(db.rows().length, 1);
});
