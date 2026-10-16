// Actual navigation components with memory-only router and service stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

const shops = [
  { id: 'branch', name: 'Odina Branch', location_type: 'shop', allows_pos: true },
  { id: 'central', name: 'Odina Central', location_type: 'shop', allows_pos: true },
  { id: 'sex', name: 'Central Production Warehouse', location_type: 'production', allows_pos: false },
];
const scope = shopId => ({ isAdmin: true, shopId, specificShopId: shopId === 'all' ? '' : shopId, shops, ready: true });

async function fixture({ pathname = '/warehouse', shopId = 'sex', role = 'admin', collapsed = false, mobileOpen = false } = {}) {
  let location = { pathname, search: '' };
  const preloads = [], serviceCalls = [];
  const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const backend = { auth: { logout: async () => {} }, entities: new Proxy({}, { get: () => {
    serviceCalls.push('entity'); throw Error('Navigation must not read business data');
  } }) };
  const evaluate = (file, require) => {
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText;
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {
      console, URLSearchParams, navigator: { connection: { saveData: false } },
      window: {
        location: { get pathname() { return location.pathname; } },
        requestIdleCallback: callback => { callback(); return 1; }, cancelIdleCallback() {},
      },
    })(require, module, module.exports);
    return module.exports;
  };
  const permissions = evaluate('src/lib/pos.js', name => {
    if (name === '@/api/base44Client') return { base44: backend };
    if (name === './uzbekistan-time.js') return { uzbekistanDateKey: () => '2026-10-17' };
    throw Error('Unexpected menu dependency: ' + name);
  });
  const routerLink = ({ to, children, className, ...props }) => React.createElement('a', {
    ...props, href: to, className: typeof className === 'function' ? className({ isActive: location.pathname === to }) : className,
  }, children);
  const Component = evaluate('src/components/Sidebar.jsx', name => {
    if (name === 'react') return { ...React, default: React };
    if (name === 'react-router-dom') return { Link: routerLink, NavLink: routerLink, useLocation: () => location };
    if (name === '@/lib/pos') return permissions;
    if (name === '@/api/base44Client') return { base44: backend };
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.endsWith('/OdinaBrand')) return { default: wrapper('div') };
    if (name.endsWith('/ScreenLaunchButton')) return { default: ({ to, label }) => React.createElement('a', { href: to }, label) };
    if (name === '@/components/ui/sheet') return {
      Sheet: ({ open, children }) => open ? React.createElement('section', { 'data-mobile-menu': true }, children) : null,
      SheetContent: wrapper('div'), SheetTitle: wrapper('h2'), SheetDescription: wrapper('p'),
    };
    if (name === '@/lib/route-preload') return {
      likelyRoutesForRole: () => ['/pos', '/warehouse', '/users'],
      preloadRoute: path => { preloads.push(path); return Promise.resolve(); },
    };
    throw Error('Unexpected sidebar dependency: ' + name);
  }).default;
  let props = { user: { id: 'owner', role }, adminShopScope: role === 'admin' ? scope(shopId) : null,
    collapsed, mobileOpen, onClose() {}, onToggle() {} };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, props)); });
  return {
    tree, preloads, serviceCalls,
    async update(next) {
      if (next.pathname) location = { ...location, pathname: next.pathname };
      props = { ...props, ...(next.shopId ? { adminShopScope: scope(next.shopId) } : {}), ...next };
      await act(async () => { tree.update(React.createElement(Component, props)); });
    },
    async openScreens() {
      const button = tree.root.findAllByType('button').find(node => node.props['aria-label'] === 'Ekranlar');
      if (button) await act(async () => button.props.onClick());
    },
    async close() { await act(async () => tree.unmount()); },
  };
}
const posLinks = tree => tree.root.findAllByType('a').filter(node => node.props.href?.split('?')[0] === '/pos');
const kassaButtons = tree => tree.root.findAllByType('button').filter(node => node.props['aria-label'] === 'Kassa');

for (const mobileOpen of [false, true]) {
  for (const collapsed of [false, true]) {
    test('warehouse menu omits POS on ' + (mobileOpen ? 'mobile' : 'desktop') + (collapsed ? ' collapsed' : ''), async () => {
      const f = await fixture({ mobileOpen, collapsed, shopId: 'sex' });
      try {
        await f.openScreens();
        assert.equal(kassaButtons(f.tree).length, 0);
        assert.equal(posLinks(f.tree).length, 0);
        assert.ok(f.tree.root.findAllByType('a').some(node => node.props.href === '/products'));
        assert.ok(f.tree.root.findAllByType('a').some(node => node.props.href === '/warehouse?tab=production'));
        assert.ok(!f.preloads.includes('/pos'));
        assert.equal(f.serviceCalls.length, 0);
      } finally { await f.close(); }
    });
  }
}
test('production selection removes POS and retail shop changes restore it without a stale menu', async () => {
  const f = await fixture({ pathname: '/products', shopId: 'sex', mobileOpen: true });
  try {
    await f.openScreens();
    assert.equal(kassaButtons(f.tree).length, 0);
    assert.equal(posLinks(f.tree).length, 0);
    for (const shopId of ['central', 'branch', 'all']) {
      await f.update({ shopId });
      assert.ok(kassaButtons(f.tree).length > 0, shopId + ' keeps Kassa');
      assert.ok(posLinks(f.tree).length > 0, shopId + ' keeps POS entry');
    }
    await f.update({ shopId: 'sex' });
    assert.equal(kassaButtons(f.tree).length, 0);
    assert.equal(posLinks(f.tree).length, 0);
    assert.equal(f.serviceCalls.length, 0);
  } finally { await f.close(); }
});
test('Branch and Central retain POS on their warehouse inventory page', async () => {
  const f = await fixture({ pathname: '/warehouse', shopId: 'central', mobileOpen: true });
  try {
    assert.ok(kassaButtons(f.tree).length > 0);
    await f.update({ shopId: 'branch' });
    assert.ok(kassaButtons(f.tree).length > 0);
    await f.update({ shopId: 'sex' });
    assert.equal(kassaButtons(f.tree).length, 0);
    await f.openScreens();
    assert.equal(posLinks(f.tree).length, 0);
    await f.update({ shopId: 'central' });
    assert.ok(kassaButtons(f.tree).length > 0);
    assert.ok(posLinks(f.tree).length > 0);
  } finally { await f.close(); }
});
test('cashier retail navigation remains available', async () => {
  const f = await fixture({ role: 'cashier', pathname: '/products', mobileOpen: true });
  try {
    assert.ok(kassaButtons(f.tree).length > 0);
    assert.ok(posLinks(f.tree).length > 0);
  } finally { await f.close(); }
});

