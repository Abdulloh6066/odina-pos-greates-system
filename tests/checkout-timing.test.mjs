// Actual local timing helper and hook; memory storage only, no SDK or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as timing from '../src/lib/checkout-timing.js';

const scope = timing.checkoutTimingScope('cashier', 'branch', 'shift');
const measurement = { totalMs: 2400, outcome: 'confirmed' };
function memoryStorage() {
  const values = new Map(); const writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); values.set(key, value); } };
}
function useStorage(t, value, getter) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...(getter ? { get: getter } : { value, writable: true }) });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'localStorage', before); else Reflect.deleteProperty(globalThis, 'localStorage'); });
}
function loadHook() {
  const code = transformSync(readFileSync('src/hooks/useCheckoutTiming.js', 'utf8'), { loader: 'js', format: 'cjs' }).code;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {
    fetch: () => { throw new Error('Timing must not use a network'); },
    setTimeout: () => { throw new Error('Timing must not schedule a timer'); },
    setInterval: () => { throw new Error('Timing must not schedule an interval'); },
  })(name => {
    if (name === 'react') return React;
    if (name === '@/lib/checkout-timing') return timing;
    throw new Error(`Unexpected timing hook dependency: ${name}`);
  }, module, module.exports);
  return module.exports.default;
}
function mountHook(useHook = loadHook(), initial = scope) {
  let current; let tree; const renders = [];
  function Probe({ selected }) {
    current = useHook(selected?.userId, selected?.shopId, selected?.shiftId);
    renders.push(current.timing);
    return null;
  }
  act(() => { tree = TestRenderer.create(React.createElement(Probe, { selected: initial })); });
  return { value: () => current, renders,
    record(value) { let result; act(() => { result = current.recordTiming(value); }); return result; },
    change(selected) { act(() => { tree.update(React.createElement(Probe, { selected })); }); },
    unmount() { act(() => { tree.unmount(); }); },
  };
}

test('storage retains only a scoped validated metric with an actual ISO completion timestamp', () => {
  const storage = memoryStorage(); const before = Date.now();
  const saved = timing.saveCheckoutTiming(scope, { ...measurement, sale: { id: 'never-store' }, payments: [1000], token: 'never-store' }, storage);
  assert.equal(saved.version, 1); assert.equal(saved.persisted, true);
  assert.equal(saved.userId, scope.userId); assert.equal(saved.shopId, scope.shopId); assert.equal(saved.shiftId, scope.shiftId);
  assert.equal(new Date(saved.completedAt).toISOString(), saved.completedAt);
  assert.ok(Date.parse(saved.completedAt) >= before && Date.parse(saved.completedAt) <= Date.now());
  assert.deepEqual(timing.readCheckoutTiming(scope, storage), saved);
  assert.equal(storage.values.size, 1);
  const stored = JSON.parse([...storage.values.values()][0]);
  assert.deepEqual(Object.keys(stored).sort(), ['version', 'userId', 'shopId', 'shiftId', 'totalMs', 'outcome', 'completedAt'].sort());
  assert.doesNotMatch(JSON.stringify(stored), /never-store|payments|token/);
  assert.equal(Object.hasOwn(stored, 'persisted'), false, 'persistence is the result of this read/write, not a trusted stored claim');
});

test('all four outcomes round-trip unchanged and shift changes retain one metric per user', () => {
  const storage = memoryStorage();
  for (const outcome of ['confirmed', 'rechecked', 'queued', 'unconfirmed']) {
    const saved = timing.saveCheckoutTiming(scope, { totalMs: 0, outcome }, storage);
    assert.equal(saved.outcome, outcome);
    assert.equal(timing.readCheckoutTiming(scope, storage).outcome, outcome);
  }
  for (let index = 0; index < 20; index++) {
    timing.saveCheckoutTiming(timing.checkoutTimingScope('cashier', `shop-${index}`, `shift-${index}`), measurement, storage);
  }
  assert.equal(storage.values.size, 1);
  assert.equal(timing.readCheckoutTiming(scope, storage), null);
  timing.saveCheckoutTiming(timing.checkoutTimingScope('other-cashier', 'branch', 'shift'), measurement, storage);
  assert.equal(storage.values.size, 2);
});

test('malformed versions, durations, outcomes, scopes and timestamps are ignored without throwing', () => {
  const storage = memoryStorage(); timing.saveCheckoutTiming(scope, measurement, storage);
  const [key, raw] = [...storage.values][0]; const valid = JSON.parse(raw);
  for (const invalid of ['{broken', 'null', '[]', ...[
    { version: 2 }, { totalMs: -1 }, { totalMs: '2400' }, { totalMs: null }, { outcome: 'paid' },
    { userId: 'other' }, { shopId: 'other' }, { shiftId: 'other' },
    { completedAt: '2026-10-15' }, { completedAt: 'invalid' }, { completedAt: 1234 },
    { completedAt: '2026-02-30T00:00:00.000Z' },
  ].map(patch => JSON.stringify({ ...valid, ...patch }))]) {
    storage.values.set(key, invalid);
    assert.equal(timing.readCheckoutTiming(scope, storage), null, invalid);
  }
  for (const invalid of [null, {}, { totalMs: NaN, outcome: 'confirmed' }, { totalMs: Infinity, outcome: 'confirmed' },
    { totalMs: -1, outcome: 'confirmed' }, { totalMs: 10, outcome: 'paid' }, { totalMs: '10', outcome: 'confirmed' }]) {
    assert.equal(timing.saveCheckoutTiming(scope, invalid, storage), null);
  }
  for (const invalidId of [null, undefined, '', ' ', ' cashier', 'cashier ', 'bad\nactor', 'x'.repeat(257), {}]) {
    assert.equal(timing.checkoutTimingScope(invalidId, 'branch', 'shift'), null);
    assert.equal(timing.checkoutTimingScope('cashier', invalidId, 'shift'), null);
    assert.equal(timing.checkoutTimingScope('cashier', 'branch', invalidId), null);
  }
  assert.equal(timing.saveCheckoutTiming(null, measurement, storage), null);
  assert.equal(timing.readCheckoutTiming(null, storage), null);
});

test('storage getters, reads, writes and JSON failures cannot break checkout or claim persistence', t => {
  const readFailure = { getItem: () => { throw new Error('Blocked read'); } };
  assert.equal(timing.readCheckoutTiming(scope, readFailure), null);
  const writeFailure = { setItem: () => { throw new Error('Quota exceeded'); } };
  assert.equal(timing.saveCheckoutTiming(scope, measurement, writeFailure).persisted, false);
  const methodGetterFailure = Object.defineProperties({}, {
    getItem: { get() { throw new Error('Blocked method'); } },
    setItem: { get() { throw new Error('Blocked method'); } },
  });
  assert.equal(timing.readCheckoutTiming(scope, methodGetterFailure), null);
  assert.equal(timing.saveCheckoutTiming(scope, measurement, methodGetterFailure).persisted, false);
  useStorage(t, undefined, () => { throw new Error('Blocked localStorage getter'); });
  assert.equal(timing.readCheckoutTiming(scope), null);
  const inMemory = timing.saveCheckoutTiming(scope, measurement);
  assert.equal(inMemory.totalMs, 2400); assert.equal(inMemory.outcome, 'confirmed'); assert.equal(inMemory.persisted, false);
  const stringify = JSON.stringify;
  try {
    JSON.stringify = () => { throw new Error('Serialization blocked'); };
    assert.equal(timing.saveCheckoutTiming(scope, measurement, memoryStorage()).persisted, false);
  } finally { JSON.stringify = stringify; }
  const hostile = Object.defineProperty({}, 'totalMs', { get() { throw new Error('Bad input'); } });
  assert.equal(timing.saveCheckoutTiming(scope, hostile, memoryStorage()), null);
});

test('actual hook restores its saved last result after unmount and same-shift reopen', t => {
  const storage = memoryStorage(); useStorage(t, storage); const useHook = loadHook();
  const first = mountHook(useHook);
  assert.equal(first.value().timing, null);
  const saved = first.record(measurement);
  assert.equal(saved.persisted, true);
  assert.equal(first.value().timing, saved);
  first.unmount();
  const reopened = mountHook(useHook);
  assert.deepEqual(reopened.value().timing, saved);
  assert.equal(reopened.renders[0].completedAt, saved.completedAt, 'same-scope reopening reads the saved time immediately');
  reopened.unmount();
});

test('actual hook hides scope mismatch immediately and rejects delayed old-scope completion', t => {
  const storage = memoryStorage(); useStorage(t, storage); const f = mountHook();
  f.record(measurement); const oldRecord = f.value().recordTiming;
  const nextScope = timing.checkoutTimingScope('cashier', 'central', 'next-shift');
  const next = timing.saveCheckoutTiming(nextScope, { totalMs: 1500, outcome: 'queued' }, storage);
  const before = f.renders.length;
  f.change(nextScope);
  assert.equal(f.renders[before], null, 'old time must disappear in render before scope effects run');
  assert.deepEqual(f.value().timing, next);
  const writes = storage.writes.length;
  assert.equal(oldRecord({ totalMs: 9999, outcome: 'confirmed' }), null);
  assert.equal(storage.writes.length, writes);
  assert.deepEqual(f.value().timing, next);
  assert.deepEqual(timing.readCheckoutTiming(nextScope, storage), next);
  f.change(timing.checkoutTimingScope('different-user', 'central', 'next-shift'));
  assert.equal(f.value().timing, null);
  f.change(null); assert.equal(f.value().recordTiming(measurement), null);
  assert.equal(storage.writes.length, writes);
  f.unmount();
});

test('actual hook keeps all outcomes in memory with persisted false when storage is blocked', t => {
  useStorage(t, undefined, () => { throw new Error('Browser storage denied'); });
  const f = mountHook();
  assert.equal(f.value().timing, null);
  for (const outcome of ['confirmed', 'rechecked', 'queued', 'unconfirmed']) {
    const saved = f.record({ totalMs: 1200, outcome });
    assert.equal(saved.persisted, false); assert.equal(saved.outcome, outcome);
    assert.equal(f.value().timing, saved);
  }
  const previous = f.value().timing;
  assert.equal(f.record({ totalMs: -1, outcome: 'confirmed' }), null);
  assert.equal(f.value().timing, previous);
  f.unmount();
});

test('a completion after leaving Kassa persists, but a newer mount blocks that old callback from overwriting its result', t => {
  const storage = memoryStorage(); useStorage(t, storage); const useHook = loadHook();
  const first = mountHook(useHook); const finishAfterLeave = first.value().recordTiming; first.unmount();
  const completed = finishAfterLeave(measurement);
  assert.equal(completed.persisted, true);
  assert.deepEqual(timing.readCheckoutTiming(scope, storage), completed);
  const nextScope = timing.checkoutTimingScope('cashier', 'central', 'next-shift');
  const newer = mountHook(useHook, nextScope); const saved = newer.record({ totalMs: 800, outcome: 'rechecked' });
  const writes = storage.writes.length;
  assert.equal(finishAfterLeave({ totalMs: 9000, outcome: 'confirmed' }), null);
  assert.equal(storage.writes.length, writes);
  assert.deepEqual(newer.value().timing, saved);
  assert.deepEqual(timing.readCheckoutTiming(nextScope, storage), saved);
  newer.unmount();
  assert.equal(finishAfterLeave(measurement), null, 'an older owner stays invalid after the newer page leaves');
});

test('actual hook safely recovers from corrupted storage and read failures, then persists a fresh measurement', t => {
  const storage = memoryStorage(); timing.saveCheckoutTiming(scope, measurement, storage);
  const key = [...storage.values.keys()][0]; storage.values.set(key, '{invalid');
  useStorage(t, storage); const f = mountHook();
  assert.equal(f.value().timing, null);
  const saved = f.record({ totalMs: 300, outcome: 'unconfirmed' });
  assert.equal(saved.persisted, true);
  assert.deepEqual(timing.readCheckoutTiming(scope, storage), saved);
  f.unmount();
  const get = storage.getItem; storage.getItem = () => { throw new Error('Read temporarily blocked'); };
  const reopened = mountHook(); assert.equal(reopened.value().timing, null);
  assert.equal(reopened.record(measurement).persisted, true, 'a read failure must not prevent a later successful write');
  storage.getItem = get; reopened.unmount();
});

test('late confirmation upgrades its pending metric and cannot overwrite the next checkout or be downgraded by local handoff', t => {
  const storage = memoryStorage(); useStorage(t, storage); const f = mountHook();
  f.record({ requestKey: 'pos-first-checkout', totalMs: 1000, outcome: 'queued' });
  const confirmed = f.record({ requestKey: 'pos-first-checkout', onlyIfCurrent: true, totalMs: 6200, outcome: 'confirmed' });
  assert.equal(confirmed.totalMs, 6200);
  assert.equal(f.record({ requestKey: 'pos-first-checkout', totalMs: 1001, outcome: 'queued' }), confirmed);
  f.record({ requestKey: 'pos-next-checkout', totalMs: 0, outcome: 'unconfirmed' });
  const writes = storage.writes.length;
  assert.equal(f.record({ requestKey: 'pos-first-checkout', onlyIfCurrent: true, totalMs: 9000, outcome: 'confirmed' }), null);
  assert.equal(storage.writes.length, writes);
  assert.equal(f.value().timing.requestKey, 'pos-next-checkout');
  assert.equal(timing.readCheckoutTiming(scope, storage).requestKey, 'pos-next-checkout');
  f.unmount();
});

test('reopening preserves the pending request identity and an unknown duration never becomes an invented zero-second confirmation', t => {
  const storage = memoryStorage(); useStorage(t, storage); const useHook = loadHook();
  const first = mountHook(useHook);
  first.record({ requestKey: 'pos-persisted-checkout', totalMs: 1000, outcome: 'queued' }); first.unmount();
  const reopened = mountHook(useHook);
  assert.equal(reopened.value().timing.requestKey, 'pos-persisted-checkout');
  const saved = reopened.record({ requestKey: 'pos-persisted-checkout', onlyIfCurrent: true,
    totalMs: 0, durationKnown: false, outcome: 'confirmed' });
  assert.equal(saved.durationKnown, false);
  assert.equal(timing.readCheckoutTiming(scope, storage).durationKnown, false);
  reopened.unmount();
});

test('actual status shows seconds only after server confirmation and hides the local one-second handoff', () => {
  const code = transformSync(readFileSync('src/components/pos/CheckoutTimingStatus.jsx', 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {})(name => {
    if (name === 'react') return React;
    if (name === '@/lib/uzbekistan-time') return { formatUzbekistanDateTime: value => value };
    throw new Error('Unexpected status dependency: ' + name);
  }, module, module.exports);
  const View = module.exports.default;
  const text = node => !node ? '' : typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : text(node.children);
  let tree;
  const show = props => act(() => {
    const element = React.createElement(View, { userRole: 'admin', ...props });
    if (tree) tree.update(element); else tree = TestRenderer.create(element);
  });
  show({ timing: { outcome: 'queued', totalMs: 1000 } });
  assert.match(text(tree.toJSON()), /Server tasdig‘i kutilmoqda/);
  assert.doesNotMatch(text(tree.toJSON()), /1,0 soniya/);
  show({ timing: { outcome: 'confirmed', totalMs: 6200 } });
  assert.match(text(tree.toJSON()), /6,2 soniya/);
  assert.match(text(tree.toJSON()), /qoldiq hisobi tasdiqlandi/);
  show({ timing: { outcome: 'confirmed', totalMs: 6200 }, pending: true });
  assert.doesNotMatch(text(tree.toJSON()), /6,2 soniya/);
  show({ timing: { outcome: 'confirmed', totalMs: 0, durationKnown: false } });
  assert.match(text(tree.toJSON()), /aniq vaqti o‘lchanmagan/);
  assert.doesNotMatch(text(tree.toJSON()), /0,0 soniya/);
  show({ userRole: 'cashier', timing: { outcome: 'confirmed', totalMs: 6200 } });
  assert.equal(tree.toJSON(), null);
  act(() => tree.unmount());
});

