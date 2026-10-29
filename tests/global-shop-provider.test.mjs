// Real React context integration with offline Shop reads and browser-only preferences.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

const admin = { id: 'owner', role: 'admin', shop_id: 'assigned', full_name: 'Owner' };
const locations = [
  { id: 'branch', name: 'Odina Branch', active: true },
  { id: 'central', name: 'Odina Central', active: true },
  { id: 'production', name: 'Central Production Warehouse', location_type: 'production', active: true },
  { id: 'inactive', name: 'Closed', active: false },
];

function compile(path, require, extra = '', globals = {}) {
  const source = readFileSync(path, 'utf8') + extra;
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console, ...globals })(require, module, module.exports);
  return module.exports;
}

async function fixture({ user = admin, saved = {}, read, storageBlocked = false } = {}) {
  const values = new Map(Object.entries(saved)), requests = [];
  let visibleModal = false, snapshot, currentUser = user;
  const storage = {
    getItem: key => { if (storageBlocked) throw Error('Storage disabled'); return values.get(key) || null; },
    setItem: (key, value) => { if (storageBlocked) throw Error('Storage disabled'); values.set(key, value); },
  };
  const client = { entities: { Shop: { list: async (...args) => {
    requests.push(args);
    return read ? read() : structuredClone(locations);
  } } } };
  const restart = compile('src/lib/offline-restart.js', () => { throw Error('Unexpected restart import'); }, '', {
    localStorage: storage, setTimeout, clearTimeout,
  });
  const network = compile('src/lib/pos-network.js', () => { throw Error('Unexpected network import'); });
  const authModule = compile('src/lib/AuthContext.jsx', id => {
    if (id === '@/lib/offline-restart') return restart;
    if (id === '@/lib/pos-network') return network;
    if (id === 'react') return { ...React, default: React };
    if (id === '@/api/base44Client') return { base44: client };
    if (id === '@/lib/app-params') return { appParams: {} };
    if (id === '@base44/sdk/dist/utils/axios-client') return {};
    throw Error('Unexpected auth import: ' + id);
  }, '\nexport { AuthContext };');
  const provider = compile('src/lib/AdminShopContext.jsx', id => {
    if (id === '@/lib/offline-restart') return restart;
    if (id === '@/lib/pos-network') return network;
    if (id === 'react') return { ...React, default: React };
    if (id === '@/api/base44Client') return { base44: client };
    if (id === '@/lib/AuthContext') return authModule;
    throw Error('Unexpected provider import: ' + id);
  }, '', { localStorage: storage, document: {
    querySelector: () => visibleModal ? { getClientRects: () => [1] } : null,
  } });
  function Page({ route }) {
    snapshot = { ...authModule.useAuth(), route };
    return React.createElement('output', {}, snapshot.adminShopScope.shopId);
  }
  const render = route => React.createElement(authModule.AuthContext.Provider, { value: { user: currentUser } },
    React.createElement(provider.default, {}, React.createElement(Page, { route })));
  let tree;
  await act(async () => { tree = create(render('/')); });
  return {
    get scope() { return snapshot.adminShopScope; }, get snapshot() { return snapshot; },
    requests, values, provider,
    select: async id => { let accepted; await act(async () => { accepted = snapshot.adminShopScope.selectShop(id); }); return accepted; },
    route: async route => act(async () => tree.update(render(route))),
    auth: async user => act(async () => { currentUser = user; tree.update(render('/')); }),
    modal: value => { visibleModal = value; },
    reload: async () => act(async () => snapshot.adminShopScope.reload()),
    close: async () => act(async () => tree.unmount()),
  };
}

test('one selected store survives route changes and remount without changing authenticated identity', async () => {
  const f = await fixture();
  try {
    assert.equal(f.scope.shopId, 'all');
    assert.equal(f.scope.ready, true);
    assert.deepEqual(f.scope.shops.map(shop => shop.id), ['branch', 'central', 'production']);
    assert.equal(await f.select('branch'), true);
    for (const route of ['/products', '/warehouse', '/orders', '/reports', '/pos']) {
      await f.route(route);
      assert.equal(f.scope.shopId, 'branch');
      assert.equal(f.snapshot.user, admin);
      assert.equal(f.snapshot.user.shop_id, 'assigned');
    }
    assert.equal(f.requests.length, 1, 'navigation and switching do not repeat Shop reads');
    const saved = Object.fromEntries(f.values);
    const reopened = await fixture({ saved });
    try { assert.equal(reopened.scope.shopId, 'branch'); } finally { await reopened.close(); }
    assert.equal(await f.select('all'), true);
    assert.equal(f.scope.specificShopId, '');
  } finally { await f.close(); }
});

test('each admin has its own saved selection and invalid or inactive locations cannot be selected', async () => {
  const f = await fixture({ saved: { 'odina-admin-shop:owner': 'central', 'odina-admin-shop:second': 'production' } });
  try {
    assert.equal(f.scope.shopId, 'central');
    assert.equal(await f.select('inactive'), false);
    assert.equal(await f.select('unknown'), false);
    assert.equal(f.scope.shopId, 'central');
    await f.auth({ ...admin, id: 'second' });
    assert.equal(f.scope.shopId, 'production');
    await f.auth(admin);
    assert.equal(f.scope.shopId, 'central');
  } finally { await f.close(); }
  const stale = await fixture({ saved: { 'odina-admin-shop:owner': 'inactive' } });
  try { assert.equal(stale.scope.shopId, 'all'); } finally { await stale.close(); }
});

test('cashier and manager cannot use saved admin preferences or load an admin shop catalog', async () => {
  for (const role of ['cashier', 'manager']) {
    const user = { id: 'worker', role, shop_id: 'branch' };
    const f = await fixture({ user, saved: { 'odina-admin-shop:worker': 'central' } });
    try {
      assert.equal(f.scope.isAdmin, false);
      assert.equal(f.scope.shopId, 'all');
      assert.equal(await f.select('central'), false);
      assert.equal(f.requests.length, 0);
      assert.equal(f.snapshot.user, user);
    } finally { await f.close(); }
  }
});

test('unsaved work and visible dialogs block changes without overwriting the saved selection', async () => {
  const f = await fixture();
  try {
    await f.select('branch');
    const unregister = f.scope.registerGuard(() => 'Savatdagi ishni yakunlang.');
    assert.equal(await f.select('central'), false);
    assert.equal(f.scope.shopId, 'branch');
    assert.equal(f.values.get('odina-admin-shop:owner'), 'branch');
    assert.equal(f.scope.blockedReason, 'Savatdagi ishni yakunlang.');
    unregister();
    f.modal(true);
    assert.equal(await f.select('central'), false);
    f.modal(false);
    assert.equal(await f.select('central'), true);
    assert.equal(f.scope.blockedReason, '');
  } finally { await f.close(); }
});

test('storage failure keeps in-memory switching usable and failed shop reads can recover', async () => {
  const f = await fixture({ storageBlocked: true });
  try { assert.equal(await f.select('central'), true); assert.equal(f.scope.shopId, 'central'); }
  finally { await f.close(); }
  let fail = true;
  const broken = await fixture({ read: async () => { if (fail) throw Error('offline'); return locations; } });
  try {
    assert.equal(broken.scope.ready, false);
    assert.ok(broken.scope.error);
    assert.equal(await broken.select('branch'), false);
    fail = false;
    await broken.reload();
    assert.equal(broken.scope.ready, true);
    assert.equal(await broken.select('branch'), true);
  } finally { await broken.close(); }
});