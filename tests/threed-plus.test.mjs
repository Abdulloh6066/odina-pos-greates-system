// Actual routes, permissions, cached preloader and Products UI with memory-only services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

const clone = value => structuredClone(value);
const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node).trim() === label);

function evaluate(file, dependencies = {}) {
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.length || 0, 0, file + ' compiles');
  const require = name => {
    if (name in dependencies) return dependencies[name];
    if (name === 'react') return { ...React, default: React };
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.endsWith('.css')) return {};
    if (name.endsWith('/odina-select')) return { default: wrapper('select') };
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, exported) => exported === 'Dialog'
      ? ({ open, children, ...props }) => open ? React.createElement('dialog', props, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Label: 'label', Image: 'img' })[exported] || 'div') });
    throw Error('Unexpected dependency: ' + name);
  };
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + result.outputText + '\n})', {
    React, console, URLSearchParams, setTimeout, clearTimeout,
    document: { title: '', body: { dataset: {} } },
  })(require, module, module.exports);
  return module.exports;
}

const forbiddenBackend = new Proxy({}, { get() { throw Error('Route/navigation must not access business services'); } });
const permissions = evaluate('src/lib/pos.js', {
  '@/api/base44Client': { base44: forbiddenBackend },
  './uzbekistan-time.js': { uzbekistanDateKey: () => '2026-10-18' },
});
const preloader = () => evaluate('src/lib/route-preload.js', { './pos.js': permissions });

test('renaming the product route preserves every role permission and role home', () => {
  assert.deepEqual(clone(permissions.ROLE_MENU), {
    admin: ['dashboard', 'pos', 'orders', 'tables', 'customers', 'waste', 'warehouse', 'products', 'categories', 'reports', 'profit', 'audit', 'security', 'dailyexport', 'discounts', 'sales', 'shifts', 'cashouts', 'recipients', 'budget', 'users', 'settings', 'screens'],
    manager: ['dashboard', 'pos', 'orders', 'tables', 'customers', 'waste', 'warehouse', 'products', 'categories', 'reports', 'profit', 'audit', 'dailyexport', 'discounts', 'sales', 'shifts', 'cashouts', 'recipients', 'users'],
    cashier: ['pos', 'orders', 'tables', 'customers', 'waste', 'warehouse', 'sales', 'shifts', 'cashouts'],
    accountant: ['dashboard', 'customers', 'warehouse', 'products', 'categories', 'reports', 'profit', 'dailyexport', 'discounts', 'sales', 'shifts'],
    production: ['warehouse', 'products', 'customers', 'screens'], warehouse: ['warehouse'],
  });
  assert.deepEqual(clone(permissions.ROLE_HOME), {
    admin: '/', manager: '/', cashier: '/pos', accountant: '/', production: '/products', warehouse: '/warehouse',
  });
});

test('new and legacy product URLs share one cached loader and identical permission checks', async () => {
  const tools = preloader(); let loads = 0;
  const module = { default: () => null };
  tools.PAGE_LOADERS.products = async () => { loads += 1; return module; };
  for (const role of ['admin', 'manager', 'accountant', 'production']) {
    assert.equal(tools.getPreloadKey('/3d-plus?view=stock#cake', role), 'products');
    assert.equal(tools.getPreloadKey('/products?view=stock#cake', role), 'products');
  }
  for (const role of ['cashier', 'warehouse', 'unknown']) {
    assert.equal(tools.getPreloadKey('/3d-plus', role), null);
    assert.equal(tools.getPreloadKey('/products', role), null);
    assert.equal(await tools.preloadRoute('/3d-plus', role), null);
  }
  assert.equal(loads, 0);
  const old = tools.preloadRoute('/products?view=stock#cake', 'production');
  const current = tools.preloadRoute('/3d-plus?view=stock#cake', 'production');
  assert.equal(old, current);
  assert.equal(await current, module);
  assert.equal(loads, 1);
});

async function routeFixture({ pathname, role, search = '', hash = '', active = true, shopId = 'branch' }) {
  const location = { pathname, search, hash };
  const user = role ? { id: role, role, shop_id: shopId, active } : null;
  const auth = { AuthProvider: ({ children }) => children, useAuth: () => ({ user }) };
  const Navigate = props => React.createElement('redirect', props);
  const router = { useLocation: () => location, Navigate };
  const RoleRoute = evaluate('src/components/RoleRoute.jsx', {
    'react-router-dom': router, '@/lib/AuthContext': auth, '@/lib/pos': permissions,
  }).default;
  const tools = preloader(); const loads = [];
  for (const key of Object.keys(tools.PAGE_LOADERS)) tools.PAGE_LOADERS[key] = async () => {
    loads.push(key); return { default: () => React.createElement('fixture-page', { 'data-page': key }) };
  };
  const passthrough = ({ children }) => children;
  const Routes = ({ children }) => {
    const all = [];
    const collect = nodes => React.Children.forEach(nodes, node => {
      if (!React.isValidElement(node)) return;
      if (node.props.path) all.push(node);
      if (node.props.children) collect(node.props.children);
    });
    collect(children);
    const match = all.find(route => route.props.path === location.pathname);
    assert.ok(match, 'Actual App registers ' + location.pathname);
    return match.props.element;
  };
  const App = evaluate('src/App.jsx', {
    '@/components/ui/toaster': { Toaster: () => null },
    '@tanstack/react-query': { QueryClientProvider: passthrough }, '@/lib/query-client': { queryClientInstance: {} },
    'react-router-dom': { ...router, BrowserRouter: passthrough, Routes, Route: () => null, Outlet: () => null },
    './lib/PageNotFound': { default: () => null }, '@/lib/AuthContext': auth,
    '@/lib/AdminShopContext': { default: passthrough }, '@/components/ui/odina-dialog-provider': { default: passthrough },
    '@/components/UserNotRegisteredError': { default: () => null }, './components/ScrollToTop': { default: () => null },
    '@/components/RoleRoute': { default: RoleRoute }, '@/lib/route-preload': tools,
    '@/pages/Login': { default: () => null }, '@/pages/Register': { default: () => null },
    '@/pages/ForgotPassword': { default: () => null }, '@/pages/ResetPassword': { default: () => null },
    '@/components/Layout': { default: passthrough },
  }).default;
  let tree; await act(async () => { tree = create(React.createElement(App)); });
  return { tree, loads, close: async () => act(async () => tree.unmount()) };
}

test('legacy URL redirects permitted roles with search/hash and replace, without loading product data', async () => {
  for (const role of ['admin', 'manager', 'accountant', 'production']) {
    const f = await routeFixture({ pathname: '/products', search: '?view=stock&shop=branch', hash: '#cake-123', role });
    try {
      const redirect = f.tree.root.findByType('redirect');
      assert.deepEqual(clone(redirect.props.to), { pathname: '/3d-plus', search: '?view=stock&shop=branch', hash: '#cake-123' });
      assert.equal(redirect.props.replace, true);
      assert.deepEqual(f.loads, []);
    } finally { await f.close(); }
  }
});

test('canonical URL mounts the existing Products chunk under the original role guard', async () => {
  for (const role of ['admin', 'manager', 'accountant', 'production']) {
    const f = await routeFixture({ pathname: '/3d-plus', role });
    try {
      assert.equal(f.tree.root.findByType('fixture-page').props['data-page'], 'products');
      assert.deepEqual(f.loads, ['products']);
    } finally { await f.close(); }
  }
});

test('both product URLs deny cashier/warehouse and keep inactive/unassigned manager safeguards', async () => {
  for (const pathname of ['/products', '/3d-plus']) {
    for (const role of ['cashier', 'warehouse']) {
      const f = await routeFixture({ pathname, role });
      try {
        assert.equal(f.tree.root.findByType('redirect').props.to, role === 'cashier' ? '/pos' : '/warehouse');
        assert.deepEqual(f.loads, []);
      } finally { await f.close(); }
    }
    for (const options of [{ active: false }, { shopId: '' }]) {
      const f = await routeFixture({ pathname, role: 'manager', ...options });
      try {
        assert.match(text(f.tree.toJSON()), /faol ish joyi biriktirilishi kerak/);
        assert.equal(f.tree.root.findAllByType('fixture-page').length, 0);
        assert.deepEqual(f.loads, []);
      } finally { await f.close(); }
    }
  }
});

const fixtureProducts = [{ id: 'napoleon', name: 'Napoleon', category_id: 'cakes', category_name: 'Tortlar',
  active: true, track_stock: true, production_unit: 'piece', sale_unit: 'piece', pieces_per_sheet: 1, price: 18000 }];
const fixtureShops = [{ id: 'branch', name: 'Odina Branch', active: true, location_type: 'shop' }];

async function productsFixture(role = 'admin') {
  const reads = [], writes = [], guards = new Set();
  const scope = { isAdmin: true, ready: true, shopId: 'branch', specificShopId: 'branch', shops: fixtureShops,
    registerGuard(callback) { guards.add(callback); return () => guards.delete(callback); } };
  const user = { id: role, role, active: true, shop_id: 'branch', full_name: role };
  const entities = Object.fromEntries(['Product', 'Ingredient', 'Category', 'Shop'].map(name => [name, new Proxy({
    list: async (...args) => {
      reads.push({ entity: name, args });
      return clone(({ Product: fixtureProducts, Ingredient: [], Category: [{ id: 'cakes', name: 'Tortlar' }], Shop: fixtureShops })[name]);
    },
  }, { get(target, key) {
    if (key in target) return target[key];
    return async (...args) => { writes.push({ entity: name, action: String(key), args }); throw Error('No mutation allowed in page-opening tests'); };
  } })]));
  const backend = { entities, functions: { invoke: async (...args) => { writes.push(args); throw Error('No function writes allowed'); } } };
  const dialogService = { odinaAlert: async () => {}, odinaConfirm: async () => false };
  const helper = evaluate('src/lib/cake-sheet-yield.js');
  const YieldDialog = evaluate('src/components/warehouse/CakeSheetYieldDialog.jsx', {
    '@/api/base44Client': { base44: backend }, '@/lib/odina-dialog': dialogService, '@/lib/cake-sheet-yield': helper,
  }).default;
  const Products = evaluate('src/pages/Products.jsx', {
    'react-router-dom': { useOutletContext: () => ({ user, adminShopScope: scope }) },
    '@/api/base44Client': { base44: backend }, '@/lib/odina-dialog': dialogService,
    '@/lib/pos': { formatUZS: String, logAction: async () => { throw Error('Page-opening tests must not log mutations'); } },
    '@/lib/shop-pricing': { priceForShop: product => product.price },
    '@/lib/shop-category': { categoryForShop: product => product.category_id,
      catalogForShop: (products, categories) => ({ products, categories }) },
    '@/lib/cake-stock-shelf': { loadAllInventoryItems: entity => entity.list('name', 500, 0) },
    '@/lib/product-photos': { productPhotoFallbackFor: () => null },
    '@/components/PageHeader': { default: ({ title, subtitle, actions }) => React.createElement('header', {},
      React.createElement('h1', {}, title), React.createElement('p', {}, subtitle), actions) },
    '@/components/TestCatalogCleanup': { default: () => null },
    '@/components/products/CakeStockShelf': { default: props => React.createElement('stock-shelf', { 'data-role': props.user.role }) },
    '@/components/warehouse/CakeSheetYieldDialog': { default: YieldDialog },
  }).default;
  let tree; await act(async () => { tree = create(React.createElement(Products)); });
  return { tree, reads, writes, guards, close: async () => act(async () => tree.unmount()) };
}

test('3D + opens catalog for admin/accountant and inventory for manager/production without mutations', async () => {
  for (const role of ['admin', 'accountant', 'manager', 'production']) {
    const f = await productsFixture(role);
    try {
      assert.equal(text(f.tree.root.findByType('h1')), '3D +');
      const catalogFirst = ['admin', 'accountant'].includes(role);
      assert.equal(button(f.tree, 'Mahsulotlar katalogi').props['aria-pressed'], catalogFirst);
      assert.equal(button(f.tree, 'Kirim va qoldiq').props['aria-pressed'], !catalogFirst);
      assert.equal(f.tree.root.findAllByType('stock-shelf').length, catalogFirst ? 0 : 1);
      assert.equal(Boolean(button(f.tree, 'Tort listlari')), catalogFirst);
      assert.equal(Boolean(button(f.tree, 'Yangi mahsulot turi')), catalogFirst);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.reads.map(read => read.entity).sort(), ['Category', 'Ingredient', 'Product', 'Shop']);
    } finally { await f.close(); }
  }
});

test('new product and moved sheet-yield dialogs open/close from 3D + without writes and guard global shop switching', async () => {
  const f = await productsFixture('admin');
  const blocked = () => [...f.guards].some(guard => Boolean(guard()));
  try {
    assert.equal(blocked(), false);
    await act(async () => button(f.tree, 'Yangi mahsulot turi').props.onClick());
    assert.equal(f.tree.root.findAllByType('dialog').length, 1);
    assert.match(text(f.tree.toJSON()), /Yangi mahsulot/);
    assert.equal(blocked(), true);
    await act(async () => button(f.tree, 'Bekor qilish').props.onClick());
    assert.equal(blocked(), false);
    const readsBeforeYield = f.reads.length;
    await act(async () => button(f.tree, 'Tort listlari').props.onClick());
    assert.match(text(f.tree.toJSON()), /Tortlar: 1 listdan bo‘lak soni/);
    assert.equal(f.tree.root.findByProps({ 'aria-label': 'Napoleon: 1 listdan bo‘lak soni' }).props.value, '1');
    assert.equal(blocked(), true);
    await act(async () => button(f.tree, 'Yopish').props.onClick());
    assert.equal(f.tree.root.findAllByType('dialog').length, 0);
    assert.equal(blocked(), false);
    assert.equal(f.reads.length, readsBeforeYield);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
  assert.equal(f.guards.size, 0);
});
