import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

async function fixture({ role = 'admin', offline = false, invoke } = {}) {
  let snapshot, clock = Date.now(), timerId = 0;
  let auth = { user: { id: 'owner', role, active: true }, offlineSession: offline };
  const listeners = new Map(), timers = new Map(), requests = [], navigation = [];
  const component = tag => props => React.createElement(tag, props, props.children);
  const imports = {
    react: { ...React, default: React },
    'react-router-dom': { useNavigate: () => navigate },
    'lucide-react': { ShieldCheck: component('shield'), LockKeyhole: component('lock') },
    '@/lib/AuthContext': { useAuth: () => auth },
    '@/api/base44Client': { base44: { functions: { invoke: async (name, body) => {
      requests.push(body); return invoke ? invoke(name, body, clock) : { data: { ok: true, token: 'signed-test-token', expires_at: clock + 900000 } };
    } } } },
    '@/components/ui/button': { Button: component('button') },
    '@/components/ui/input': { Input: component('input') },
    '@/components/ui/label': { Label: component('label') },
    '@/components/ui/dialog': Object.fromEntries(['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription'].map(name => [name, component(name)])),
  };
  const navigate = path => navigation.push(path);
  const window = {
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  class ClockDate extends Date { static now() { return clock; } }
  const code = ts.transpileModule(readFileSync(new URL('../components/admin/AdminAccessProvider.jsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { window, navigator: { onLine: true }, Date: ClockDate })(
    name => { assert.ok(imports[name], name); return imports[name]; }, module, module.exports);
  function Consumer() { snapshot = module.exports.useAdminAccess(); return null; }
  let tree;
  const render = () => React.createElement(module.exports.default, {}, React.createElement(Consumer));
  await act(async () => { tree = create(render()); });
  const emit = async (name, event = {}) => act(async () => { for (const fn of listeners.get(name) || []) await fn(event); });
  const enter = async () => {
    await act(async () => snapshot.requestOpen());
    await act(async () => tree.root.findByType('input').props.onChange({ target: { value: 'test-password' } }));
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  };
  return { get state() { return snapshot; }, tree, requests, navigation, emit, enter,
    shortcut: module.exports.isAdminShortcut,
    changeUser: async next => { auth = next; await act(async () => tree.update(render())); },
    advanceClock: delay => { clock += delay; },
    advanceToTimer: async delay => { clock += delay; await act(async () => [...timers.values()].find(timer => timer.delay === delay)?.fn()); },
    close: () => act(async () => tree.unmount()),
  };
}

test('Ctrl+Alt+A opens the password prompt; close-tab and repeated shortcuts do not match', async () => {
  const f = await fixture();
  try {
    let prevented = false;
    await f.emit('keydown', { ctrlKey: true, altKey: true, code: 'KeyA', key: 'a', preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(f.tree.root.findByType('Dialog').props.open, true);
    assert.equal(f.shortcut({ ctrlKey: true, key: 'w' }), false);
    assert.equal(f.shortcut({ ctrlKey: true, altKey: true, key: 'a', repeat: true }), false);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('server verification unlocks the panel and explicit lock removes access', async () => {
  const f = await fixture();
  try {
    await f.enter(); assert.equal(f.state.unlocked, true);
    assert.equal(f.navigation.at(-1), '/admin');
    assert.equal(f.tree.root.findByType('input').props.value, '');
    await act(async () => f.state.lock()); assert.equal(f.state.unlocked, false);
  } finally { await f.close(); }
});

test('cashier and offline continuity accounts cannot request an admin unlock', async () => {
  for (const options of [{ role: 'cashier' }, { offline: true }]) {
    const f = await fixture(options);
    try { await act(async () => f.state.requestOpen()); assert.equal(f.state.eligible, false);
      assert.equal(f.tree.root.findByType('Dialog').props.open, false); assert.equal(f.requests.length, 0); }
    finally { await f.close(); }
  }
});

test('wrong password keeps the panel locked and shows the server error', async () => {
  const f = await fixture({ invoke: async () => { throw { response: { data: { error: 'Admin paroli noto‘g‘ri.' } } }; } });
  try { await f.enter(); assert.equal(f.state.unlocked, false); assert.equal(f.navigation.length, 0);
    assert.equal(f.tree.root.findByProps({ role: 'alert' }).children[0], 'Admin paroli noto‘g‘ri.'); }
  finally { await f.close(); }
});

test('inactivity and loss of connectivity lock an unlocked session', async () => {
  const f = await fixture();
  try {
    await f.enter(); await f.advanceToTimer(300000); assert.equal(f.state.unlocked, false);
    await f.enter(); await f.emit('offline'); assert.equal(f.state.unlocked, false);
  } finally { await f.close(); }
});

test('returning after background timer throttling cannot renew an idle session', async () => {
  const f = await fixture();
  try { await f.enter(); f.advanceClock(300001); await f.emit('focus'); assert.equal(f.state.unlocked, false); }
  finally { await f.close(); }
});

test('logout or identity change invalidates an in-flight password result', async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const f = await fixture({ invoke: () => gate });
  try {
    await act(async () => f.state.requestOpen());
    await act(async () => f.tree.root.findByType('input').props.onChange({ target: { value: 'test-password' } }));
    let pending;
    await act(async () => { pending = f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    await f.changeUser({ user: null, offlineSession: false });
    await act(async () => { resolve({ data: { ok: true, token: 'late', expires_at: Date.now() + 900000 } }); await pending; });
    assert.equal(f.state.unlocked, false); assert.equal(f.navigation.length, 0);
  } finally { await f.close(); }
});

test('canceling the prompt invalidates an in-flight password result', async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const f = await fixture({ invoke: () => gate });
  try {
    await act(async () => f.state.requestOpen());
    await act(async () => f.tree.root.findByType('input').props.onChange({ target: { value: 'test-password' } }));
    let pending;
    await act(async () => { pending = f.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    await act(async () => f.tree.root.findByType('Dialog').props.onOpenChange(false));
    await act(async () => { resolve({ data: { ok: true, token: 'late', expires_at: Date.now() + 900000 } }); await pending; });
    assert.equal(f.state.unlocked, false); assert.equal(f.navigation.length, 0);
  } finally { await f.close(); }
});
