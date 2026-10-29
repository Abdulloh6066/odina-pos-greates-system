import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as network from '../lib/pos-network.js';
const staff = { id: 'u', role: 'cashier', shop_id: 's', active: true };
async function fixture({ online = false, cached = staff, meError, allowed = true } = {}) {
  let snapshot, calls = 0, cleared = 0;
  const listeners = {};
  const navigator = { onLine: online };
  const client = { auth: { me: async () => { calls++; if (meError) throw meError; return staff; } },
    functions: { invoke: async name => name === 'staff-email-check' ? { data: { allowed } } : { data: {} } },
    entities: { User: { get: async () => staff } } };
  const imports = {
    react: { ...React, default: React }, '@/api/base44Client': { base44: client },
    '@/lib/app-params': { appParams: { appId: 'app' } },
    '@base44/sdk/dist/utils/axios-client': { createAxiosClient: () => ({ get: async () => ({}) }) },
    '@/lib/pos-network': network,
    '@/lib/offline-restart': {
      readOfflineStaff: async () => cached, rememberOfflineStaff: async () => true,
      clearOfflineRestart: () => { cleared++; cached = null; }, restartRead: fn => fn(),
    },
  };
  const code = ts.transpileModule(readFileSync(new URL('../lib/AuthContext.jsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { navigator, console: { warn() {}, error() {} },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; } },
  })(name => { assert.ok(imports[name], name); return imports[name]; }, module, module.exports);
  function Consumer() { snapshot = module.exports.useAuth(); return null; }
  let tree;
  await act(async () => { tree = create(React.createElement(module.exports.AuthProvider, {}, React.createElement(Consumer))); });
  return { get state() { return snapshot; }, get calls() { return calls; }, get cleared() { return cleared; },
    reconnect: async () => { navigator.onLine = true; await act(async () => { listeners.online?.(); }); },
    close: () => act(async () => tree.unmount()) };
}
test('offline restart restores verified local staff without claiming server authentication', async () => {
  const f = await fixture();
  try { assert.equal(f.state.user.id, 'u'); assert.equal(f.state.offlineSession, true); assert.equal(f.state.isAuthenticated, false);
    assert.equal(f.state.isLoadingAuth, false); assert.equal(f.state.isLoadingPublicSettings, false); assert.equal(f.calls, 0); }
  finally { await f.close(); }
});
test('first-time offline opening stays blocked with a useful retry state', async () => {
  const f = await fixture({ cached: null });
  try { assert.equal(f.state.user, null); assert.equal(f.state.authError.type, 'offline_unavailable'); assert.equal(f.calls, 0); }
  finally { await f.close(); }
});
test('transport failure can recover cached continuity even when browser reports online', async () => {
  const f = await fixture({ online: true, meError: { code: 'ERR_NETWORK' } });
  try { assert.equal(f.state.offlineSession, true); assert.equal(f.state.user.id, 'u'); }
  finally { await f.close(); }
});
test('server authorization rejection never falls back to cached staff', async () => {
  const f = await fixture({ online: true, meError: { status: 401 } });
  try { assert.equal(f.state.user, null); assert.equal(f.state.offlineSession, false); assert.equal(f.state.authError.type, 'auth_required'); assert.ok(f.cleared); }
  finally { await f.close(); }
});
test('reconnection revalidates staff and exits local-only mode', async () => {
  const f = await fixture();
  try { await f.reconnect(); assert.equal(f.state.offlineSession, false); assert.equal(f.state.isAuthenticated, true); assert.equal(f.state.user.id, 'u'); }
  finally { await f.close(); }
});
test('revoked staff are locked out on reconnection without deleting the sales queue', async () => {
  const f = await fixture({ allowed: false });
  try { await f.reconnect(); assert.equal(f.state.user, null); assert.equal(f.state.authError.type, 'user_not_registered'); assert.ok(f.cleared); }
  finally { await f.close(); }
});