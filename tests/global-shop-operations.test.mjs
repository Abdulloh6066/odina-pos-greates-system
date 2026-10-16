// Real frontend components with an in-memory SDK; no network or business records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as shelf from '../src/lib/cake-stock-shelf.js';
import * as pricing from '../src/lib/shop-pricing.js';
import * as catalog from '../src/lib/shop-category.js';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node.props.children).trim() === label);
const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const shops = [
  { id: 'branch', name: 'Odina Branch', location_type: 'shop', active: true },
  { id: 'other', name: 'Odina Other', location_type: 'shop', active: true },
  { id: 'central', name: 'Odina Central', location_type: 'production', active: true, allows_pos: false },
];
const products = [
  { id: 'cake', name: 'Cake', active: true, price: 10000, shop_prices: { other: 17000 } },
  { id: 'restricted', name: 'Branch only', active: true, price: 12000, available_shop_ids: ['branch'] },
  { id: 'inactive', name: 'Hidden cake', active: false },
];

function scope(id = 'other') {
  const guards = new Set(); const selections = [];
  return { isAdmin: true, shopId: id, specificShopId: id === 'all' ? '' : id, shops, ready: true,
    guards, selections,
    selectShop(next) { selections.push(next); return ![...guards].some(guard => Boolean(guard())); },
    registerGuard(guard) { guards.add(guard); return () => guards.delete(guard); } };
}

function component(path, dependencies = {}) {
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    reportDiagnostics: true,
  });
  assert.equal(source.diagnostics?.length || 0, 0, path + ' compiles');
  const require = specifier => {
    if (specifier in dependencies) return dependencies[specifier];
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (specifier.endsWith('/odina-select')) return { default: wrapper('select') };
    if (specifier.endsWith('.css')) return {};
    if (specifier === '@/lib/pos') return { formatNum: String, formatUZS: String, logAction() {} };
    if (specifier === '@/lib/shop-pricing') return pricing;
    if (specifier === '@/lib/shop-category') return catalog;
    if (specifier === '@/lib/cake-stock-shelf') return shelf;
    if (specifier === '@/lib/uzbekistan-time') return { formatUzbekistanTime: String, formatUzbekistanDateTime: String };
    if (specifier === '@/lib/odina-dialog') return { odinaAlert: async () => {}, odinaConfirm: async () => false };
    if (specifier.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, name) => name === 'Dialog'
      ? ({ open, children }) => open ? React.createElement('dialog', {}, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Textarea: 'textarea', Label: 'label', Image: 'img' })[name] || 'div') });
    throw Error('Unexpected dependency: ' + specifier);
  };
  const module = { exports: {} };
  const eventTarget = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext('(function(require,module,exports){' + source.outputText + '\n})', {
    console, navigator: { onLine: true }, window: { ...eventTarget, location: { origin: 'https://offline.test' },
      setInterval: () => 1, clearInterval() {},
      matchMedia: () => ({ matches: false, ...eventTarget }) },
    document: { ...eventTarget, visibilityState: 'visible' },
    URLSearchParams, performance, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
  })(require, module, module.exports);
  return module.exports;
}

async function shelfFixture(adminShopScope, role = 'admin', options = {}) {
  const reads = []; const writes = [];
  const balances = shops.map((shop, index) => ({ id: 's-' + shop.id, product_id: 'cake', location_id: shop.id, quantity: (index + 1) * 5, unit: 'piece' }));
  const backend = { entities: {
    ProductStock: { filter: async query => { reads.push(query.location_id); const rows = balances.filter(row => row.location_id === query.location_id); return options.readBalances ? options.readBalances(query, rows, reads) : rows; }, subscribe: () => () => {} },
    IngredientStock: { filter: async () => [], subscribe: () => () => {} },
    StockMovement: { filter: async () => [] }, StockTransfer: { filter: async () => [] },
  }, functions: { invoke: async (...args) => { writes.push(args); throw Error('No writes in this fixture'); } } };
  const Component = component('src/components/products/CakeStockShelf.jsx', {
    '@/api/base44Client': { base44: backend }, '@/components/warehouse/TransfersPanel': { default: wrapper('transfers-panel') },
  }).default;
  let props = { user: { id: 'admin', role, shop_id: 'branch' }, products, categories: [], shops, adminShopScope };
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  return { tree, reads, writes, update: async next => act(async () => { props = { ...props, ...next }; tree.update(React.createElement(Component, props)); }), close: async () => act(async () => tree.unmount()) };
}

test('global shelf store is authoritative and local selector delegates to the shared context', async () => {
  const current = scope('other'); const f = await shelfFixture(current);
  try {
    assert.deepEqual(f.reads, ['other']);
    assert.equal(f.tree.root.findByProps({ id: 'cake-stock-shop' }).props.value, 'other');
    assert.ok(text(f.tree.toJSON()).includes('Odina Other · tort tokchasi'));
    assert.ok(!text(f.tree.toJSON()).includes('Branch only'));
    await act(async () => f.tree.root.findByProps({ id: 'cake-stock-shop' }).props.onChange({ target: { value: 'branch' } }));
    assert.deepEqual(current.selections, ['branch']);
    assert.equal(f.tree.root.findByProps({ id: 'cake-stock-shop' }).props.value, 'other');
    assert.equal(f.writes.length, 0);
    await f.update({ adminShopScope: scope('central') });
    assert.ok(text(f.tree.toJSON()).includes('Odina Central · tort tokchasi'));
    assert.ok(text(f.tree.toJSON()).includes('Branch only')); // Production inventory is independent of selling destinations.
    assert.equal(button(f.tree, 'Kirim kiritish').props.disabled, true);
    assert.equal(f.reads.at(-1), 'central');
  } finally { await f.close(); }
});

test('all-store shelf keeps balances separate, hides inactive products and offers no mutations', async () => {
  const f = await shelfFixture(scope('all'));
  try {
    assert.deepEqual([...new Set(f.reads)].sort(), ['branch', 'central', 'other']);
    const sections = f.tree.root.findAllByProps({ 'aria-label': 'Mahsulotlar jonli qoldig‘i' });
    assert.equal(sections.length, 3);
    assert.ok(text(sections[0]).includes('Odina Branch · tort tokchasi'));
    assert.ok(text(sections[1]).includes('Odina Other · tort tokchasi'));
    assert.ok(!text(f.tree.toJSON()).includes('Hidden cake'));
    assert.ok(f.tree.root.findAllByType('button').filter(node => text(node.props.children) === 'Kirim kiritish').every(node => node.props.disabled));
    assert.equal(f.tree.root.findAllByType('transfers-panel').length, 0);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('unknown global store never falls back to Branch; nonadmins keep their genuine assignment', async () => {
  const f = await shelfFixture(scope('unknown'));
  try { assert.deepEqual(f.reads, []); assert.ok(text(f.tree.toJSON()).includes('Tanlangan joylashuv mavjud emas')); }
  finally { await f.close(); }
  const worker = await shelfFixture(scope('other'), 'cashier');
  try { assert.deepEqual(worker.reads, ['branch']); assert.equal(worker.tree.root.findByProps({ id: 'cake-stock-shop' }).props.value, 'branch'); }
  finally { await worker.close(); }
});

test('an open stock operation prevents switching context and unmount releases its guard', async () => {
  const current = scope('other'); const f = await shelfFixture(current);
  await act(async () => button(f.tree, 'Kirim').props.onClick());
  assert.ok([...current.guards].some(guard => typeof guard() === 'string' && guard().length));
  assert.equal(current.selectShop('branch'), false);
  assert.equal(f.writes.length, 0);
  await f.close(); assert.equal(current.guards.size, 0);
});

test('open-shift dialog preselects global store while cashier assignment still wins', async () => {
  const Component = component('src/components/pos/ShiftDialog.jsx').OpenShiftDialog;
  const confirmed = []; let tree;
  const props = { open: true, shops, preferredShopId: 'other', user: { role: 'admin', shop_id: 'branch' }, onClose() {}, onConfirm: value => confirmed.push(value) };
  await act(async () => { tree = create(React.createElement(Component, props)); });
  try {
    assert.equal(tree.root.findByType('select').props.value, 'other');
    assert.equal(tree.root.findByType('select').props.disabled, true);
    await act(async () => button(tree, 'Smenani ochish').props.onClick());
    assert.equal(confirmed[0].shop.id, 'other');
    await act(async () => tree.update(React.createElement(Component, { ...props, user: { role: 'cashier', shop_id: 'branch' } })));
    await act(async () => button(tree, 'Smenani ochish').props.onClick());
    assert.equal(confirmed[1].shop.id, 'branch');
  } finally { await act(async () => tree.unmount()); }
});

test('stock-count history and new-count default follow the selected store', async () => {
  const current = scope('other'); const requests = [];
  const Component = component('src/components/warehouse/StockCountPanel.jsx', {
    '@/api/base44Client': { base44: { functions: { invoke: async (_name, body) => {
      requests.push(structuredClone(body));
      assert.equal(body.action, 'list_counts');
      return { data: { counts: [{ id: 'a', count_number: 'BRANCH-COUNT', location_id: 'branch', status: 'draft' },
        { id: 'b', count_number: 'OTHER-COUNT', location_id: 'other', status: 'draft' }] } };
    } } } }, './StockCountDraft': { default: wrapper('count-draft') },
  }).default;
  let tree; await act(async () => { tree = create(React.createElement(Component, { user: { role: 'admin', shop_id: 'branch' }, location: shops[1], locations: shops, adminShopScope: current })); });
  try {
    assert.ok(text(tree.toJSON()).includes('OTHER-COUNT'));
    assert.ok(!text(tree.toJSON()).includes('BRANCH-COUNT'));
    await act(async () => button(tree, 'Yangi sanoq').props.onClick());
    assert.equal(tree.root.findByType('select').props.value, 'other');
    assert.equal(tree.root.findByType('select').props.disabled, true);
    assert.equal(current.selectShop('branch'), false);
    assert.deepEqual(requests, [{ action: 'list_counts' }]);
  } finally { await act(async () => tree.unmount()); }
});

async function posFixture(id = 'other', role = 'admin') {
  const calls = []; const timingShops = [];
  const ownShift = { id: 'own-shift', user_id: 'owner', shop_id: 'branch', shop_name: 'Odina Branch', status: 'open' };
  let outlet = { user: { id: 'owner', role, shop_id: 'branch' }, adminShopScope: scope(id) };
  const backend = { entities: new Proxy({}, { get: (_object, name) => ({
    list: async () => name === 'Product' ? products : name === 'Shop' ? shops : [], subscribe: () => () => {},
    filter: async () => [],
  }) }), functions: { invoke: async (name, body) => {
    calls.push({ name, body: structuredClone(body) });
    if (name === 'supplier-ledger' && body.action === 'get_debts') return { data: { debts: {} } };
    if (name === 'waste-ledger' && body.action === 'get_alerts') return { data: { expired_items: [] } };
    throw Error('Unexpected write or read ' + name + ':' + body.action);
  } } };
  const dependencies = {
    'react-router-dom': { useOutletContext: () => outlet, useNavigate: () => () => {}, useLocation: () => ({ search: '', state: null }) },
    '@/api/base44Client': { base44: backend },
    '@/lib/current-pos-shift': { fetchCurrentPosShift: async () => ownShift, openPosShift: async () => { throw Error('No shifts created'); } },
    '@/hooks/useCheckoutTiming': { default: (_actor, shopId) => { timingShops.push(shopId); return { timing: null, recordTiming() {} }; } },
    '@/hooks/use-stable-event': { default: callback => callback },
    '@/hooks/usePosProductOrder': { default: () => ({ order: [], accept() {} }) },
    '@/hooks/useOfflineSaleQueue': { default: () => ({ records: [], syncing: false, isOnline: true, browserOnline: true, reportRequestSuccess() {}, reportRequestError() {} }) },
    '@/lib/checkout-timing-outbox': { flushCheckoutTimings: async () => ({ hasMore: false }) },
    '@/lib/order-request-retry': { orderRequestScope: () => '', readOrderRequest: () => null },
    '@/lib/burger-fries': { canPreviewBurgerFries: () => false, repriceBurgerCartForShop: rows => rows, saleLineKey: row => row.product_id },
    '@/lib/pos-product-order': { sortByShopOrder: rows => rows },
    '@/lib/pos-stock-events': { mergePosStockEvent: rows => rows },
    '@/lib/staff-order-ticket': { isStaffTicketEnabled: () => false },
    '@/lib/offline-sales': {}, '@/lib/pos-network': { canQueuePosSale: () => true },
    '@/components/pos/ProductGrid': { default: wrapper('pos-grid') },
    '@/components/pos/Cart': { default: wrapper('pos-cart'), DiscountRow: wrapper('discount'), RoundingRow: wrapper('rounding') },
  };
  const source = readFileSync('src/pages/POS.jsx', 'utf8');
  for (const match of source.matchAll(/from '(@\/components\/[^']+|@\/pages\/[^']+)'/g)) {
    if (!dependencies[match[1]] && !match[1].startsWith('@/components/ui/')) dependencies[match[1]] = new Proxy({}, { get: () => wrapper('mock-component') });
  }
  const Component = component('src/pages/POS.jsx', dependencies).default;
  let tree; await act(async () => { tree = create(React.createElement(Component)); });
  return { tree, calls, ownShift, timingShops, get current() { return outlet.adminShopScope; },
    update: async nextId => act(async () => { outlet = { ...outlet, adminShopScope: scope(nextId) }; tree.update(React.createElement(Component)); }),
    close: async () => act(async () => tree.unmount()) };
}

test('Kassa shows selected catalog but never borrows or retargets the admin’s own shift', async () => {
  const f = await posFixture('other');
  try {
    let grid = f.tree.root.findByType('pos-grid');
    assert.equal(grid.props.shopId, 'other');
    assert.equal(grid.props.products[0].price, 17000);
    assert.equal(grid.props.disabled, true);
    assert.ok(!grid.props.products.some(product => product.id === 'restricted'));
    assert.ok(text(f.tree.toJSON()).includes('Sizning ochiq smenangiz Odina Branchda'));
    await act(async () => grid.props.onAdd(grid.props.products[0]));
    assert.equal(f.tree.root.findAllByType('pos-cart')[0].props.cart.length, 0);
    await act(async () => f.tree.root.findAllByType('pos-cart')[0].props.onCheckout());
    assert.ok(f.calls.every(call => ['supplier-ledger', 'waste-ledger'].includes(call.name)));
    assert.ok(f.timingShops.filter(Boolean).every(id => id === 'branch'));
    await f.update('branch');
    grid = f.tree.root.findByType('pos-grid');
    assert.equal(grid.props.shopId, 'branch'); assert.equal(grid.props.disabled, false);
    await act(async () => grid.props.onAdd(grid.props.products[0]));
    assert.equal(f.tree.root.findAllByType('pos-cart')[0].props.cart.length, 1);
    assert.equal(f.current.selectShop('other'), false);
    assert.equal(f.ownShift.shop_id, 'branch');
  } finally { await f.close(); }
});

test('Kassa All stores is read-only and workers ignore injected admin viewing scope', async () => {
  const all = await posFixture('all');
  try {
    const grid = all.tree.root.findByType('pos-grid');
    assert.equal(grid.props.disabled, true);
    assert.ok(grid.props.products.some(product => product.id === 'restricted'));
    assert.equal(button(all.tree, 'Smenani yopish')?.props.disabled ?? all.tree.root.findByProps({ 'aria-label': 'Smenani yopish' }).props.disabled, true);
  } finally { await all.close(); }
  const worker = await posFixture('other', 'cashier');
  try { assert.equal(worker.tree.root.findByType('pos-grid').props.shopId, 'branch'); assert.equal(worker.tree.root.findByType('pos-grid').props.disabled, false); }
  finally { await worker.close(); }
});

test('Products catalog follows store availability and price without rewriting shared products', async () => {
  let outlet = { user: { role: 'admin', shop_id: 'branch' }, adminShopScope: scope('other') };
  const original = structuredClone(products);
  const Component = component('src/pages/Products.jsx', {
    'react-router-dom': { useOutletContext: () => outlet },
    '@/api/base44Client': { base44: { entities: new Proxy({}, { get: (_object, name) => ({ list: async () => name === 'Product' ? products : name === 'Shop' ? shops : [] }) }) } },
    '@/components/PageHeader': { default: wrapper('page-header') },
    '@/components/TestCatalogCleanup': { default: wrapper('catalog-cleanup') },
    '@/components/products/CakeStockShelf': { default: wrapper('stock-shelf') },
  }).default;
  let tree; await act(async () => { tree = create(React.createElement(Component)); });
  try {
    await act(async () => button(tree, 'Mahsulotlar katalogi').props.onClick());
    assert.ok(!text(tree.toJSON()).includes('Branch only'));
    const cake = tree.root.findAllByType('article').find(node => text(node).includes('Cake'));
    assert.ok(text(cake).includes('17000'));
    assert.ok(text(tree.toJSON()).includes('tahrirlash umumiy katalogga tegishli'));
    assert.equal(tree.root.findByType('page-header').props.subtitle, '2 ta mahsulot turi');
    assert.ok(button(tree, 'Barcha do‘konlarda sotuvdan olish'));
    outlet = { ...outlet, adminShopScope: scope('all') };
    await act(async () => tree.update(React.createElement(Component)));
    assert.ok(text(tree.toJSON()).includes('Branch only'));
    assert.deepEqual(products, original);
  } finally { await act(async () => tree.unmount()); }
});

test('receiving a transfer blocks global switching until its original request finishes', async () => {
  const current = scope('other'); let resolveReceive; const pending = new Promise(resolve => { resolveReceive = resolve; });
  const calls = []; let reloads = 0;
  const Component = component('src/components/warehouse/TransfersPanel.jsx', {
    '@/api/base44Client': { base44: { functions: { invoke: async (name, body) => { calls.push({ name, body: structuredClone(body) }); return pending; } } } },
    '@/lib/odina-dialog': { odinaConfirm: async () => true, odinaAlert: async () => {} },
  }).default;
  let tree; await act(async () => { tree = create(React.createElement(Component, {
    user: { role: 'admin', shop_id: 'branch' }, adminShopScope: current, location: shops[1], locations: shops,
    products, productStock: [], archivedProductIds: [], search: '', onReload: async () => { reloads++; },
    transfers: [{ id: 'transfer-other', transfer_number: 'T-1', product_id: 'cake', product_name_snapshot: 'Cake', quantity: 1, unit: 'piece', status: 'pending', source_location_id: 'central', destination_location_id: 'other' }],
  })); });
  try {
    let receiving;
    await act(async () => { receiving = button(tree, 'Qabul qildim').props.onClick(); });
    assert.equal(calls.length, 1); assert.equal(calls[0].body.transfer_id, 'transfer-other');
    assert.equal(current.selectShop('branch'), false);
    await act(async () => { resolveReceive({ data: { transfer: { id: 'transfer-other' } } }); await receiving; });
    assert.equal(reloads, 1); assert.equal(current.selectShop('branch'), true);
    assert.equal(calls[0].body.transfer_id, 'transfer-other');
  } finally { await act(async () => tree.unmount()); }
});

test('late stock-refresh completion cannot show an old store’s success notice in the new shelf', async () => {
  const current = scope('other'); let resolveRefresh; const pending = new Promise(resolve => { resolveRefresh = resolve; });
  const f = await shelfFixture(current, 'admin', { readBalances: (query, rows, reads) => query.location_id === 'other' && reads.length > 1 ? pending : rows });
  try {
    await act(async () => button(f.tree, 'Kirim').props.onClick());
    const operation = f.tree.root.findAll(node => typeof node.type === 'function' && node.type.name === 'CakeStockOperation')[0];
    let saving;
    await act(async () => { saving = operation.props.onSaved({ product_id: 'cake', quantity: 999 }); });
    assert.equal(current.selectShop('branch'), false);
    await f.update({ adminShopScope: scope('branch') }); // Defense against forced external context replacement.
    await act(async () => { resolveRefresh([{ id: 's-other', location_id: 'other', product_id: 'cake', quantity: 999, unit: 'piece' }]); await saving; });
    assert.ok(text(f.tree.toJSON()).includes('Odina Branch · tort tokchasi'));
    assert.ok(!text(f.tree.toJSON()).includes('qoldiq 999'));
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('Warehouse follows global location and All mode offers separated read-only inventory', async () => {
  let outlet = { user: { id: 'owner', role: 'admin', shop_id: 'branch' }, adminShopScope: scope('other') };
  let warehouseTab = 'ingredients';
  const calls = [];
  const backend = { entities: new Proxy({}, { get: (_object, name) => ({
    list: async () => name === 'Shop' ? shops : name === 'Product' ? products : name === 'Ingredient' ? [{ id: 'milk', name: 'Milk', active: true, base_unit: 'ml' }]
      : name === 'IngredientStock' ? [{ id: 'branch-milk', ingredient_id: 'milk', location_id: 'branch', quantity: 111, unit: 'ml' }, { id: 'other-milk', ingredient_id: 'milk', location_id: 'other', quantity: 222, unit: 'ml' }] : [],
    subscribe: () => () => {},
  }) }), functions: { invoke: async (_name, body) => { calls.push(structuredClone(body)); return { data: { transfers: [] } }; } } };
  const dependencies = {
    'react-router-dom': { useOutletContext: () => outlet, useSearchParams: () => [new URLSearchParams('tab=' + warehouseTab), () => {}] },
    '@/api/base44Client': { base44: backend }, '@/components/PageHeader': { default: wrapper('page-header') },
    '@/lib/test-catalog-cleanup': { TEST_PRODUCT_IDS: [] },
    '@/lib/cake-layer-inventory': { isCakeLayer: item => item.is_cake_layer === true, ingredientUnitLabel: item => item?.base_unit || 'piece' },
    '@/components/warehouse/WarehouseTables': { WarehouseHistoryTable: wrapper('history-table') },
  };
  for (const match of readFileSync('src/pages/Warehouse.jsx', 'utf8').matchAll(/from '(@\/components\/[^']+)'/g)) {
    if (!dependencies[match[1]] && !match[1].startsWith('@/components/ui/')) dependencies[match[1]] = { default: wrapper('mock-component') };
  }
  const Component = component('src/pages/Warehouse.jsx', dependencies).default;
  let tree; await act(async () => { tree = create(React.createElement(Component)); });
  try {
    const selector = tree.root.findAllByType('select').find(node => node.props.value === 'other');
    assert.ok(selector); assert.ok(text(tree.toJSON()).includes('222')); assert.ok(!text(tree.toJSON()).includes('111'));
    await act(async () => selector.props.onChange({ target: { value: 'branch' } }));
    assert.deepEqual(outlet.adminShopScope.selections, ['branch']);
    outlet = { ...outlet, adminShopScope: scope('all') };
    await act(async () => tree.update(React.createElement(Component)));
    const overview = tree.root.findByProps({ 'aria-label': 'Barcha omborlar qoldig‘i' });
    assert.ok(text(overview).includes('111')); assert.ok(text(overview).includes('222'));
    assert.equal(overview.findAllByType('button').length, 0);
    for (const tab of ['transfers', 'suppliers', 'count', 'recipes', 'production', 'cake_layers', 'demands']) {
      warehouseTab = tab;
      await act(async () => tree.update(React.createElement(Component)));
      const area = tree.root.findByProps({ 'aria-label': 'Barcha omborlar qoldig‘i' });
      assert.ok(!text(area).includes('Milk'), tab + ' must not silently show ingredient stock');
      assert.ok(text(area).includes('bitta do‘konni tanlang'), tab + ' explains the required concrete location');
    }
    assert.ok(calls.every(body => body.action === 'list_transfers'));
  } finally { await act(async () => tree.unmount()); }
});

test('an in-flight stock-count read blocks switching and late responses cannot open another store’s draft', async () => {
  const originalScope = scope('other'); let props = { user: { role: 'admin' }, location: shops[1], locations: shops, adminShopScope: originalScope };
  let resolveRead; const pending = new Promise(resolve => { resolveRead = resolve; });
  const Component = component('src/components/warehouse/StockCountPanel.jsx', {
    '@/api/base44Client': { base44: { functions: { invoke: async (_name, body) => body.action === 'list_counts'
      ? { data: { counts: [{ id: 'b', count_number: 'OTHER-COUNT', location_id: 'other', status: 'draft' }] } } : pending } } },
    './StockCountDraft': { default: wrapper('count-draft') },
  }).default;
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  try {
    let opening;
    await act(async () => { opening = tree.root.findAllByType('button').find(node => text(node).includes('OTHER-COUNT')).props.onClick(); });
    assert.equal(originalScope.selectShop('branch'), false);
    // Even a forced context replacement cannot resurrect an old-store editable draft.
    props = { ...props, location: shops[0], adminShopScope: scope('branch') };
    await act(async () => tree.update(React.createElement(Component, props)));
    await act(async () => { resolveRead({ data: { count: { id: 'b', location_id: 'other' }, items: [] } }); await opening; });
    assert.equal(tree.root.findAllByType('count-draft').length, 0);
  } finally { await act(async () => tree.unmount()); }
});

test('Yakunlash history uses global scope and retains legacy local filtering when no scope exists', async () => {
  const reads = [];
  const Component = component('src/components/pos/CheckoutTimingHistory.jsx', {
    '@/hooks/useCheckoutTimingHistory': { default: query => { reads.push(query); return { records: [], loading: false }; }, checkoutTimingRecordKey: record => record.id },
  }).default;
  let props = { open: true, userRole: 'admin', shops, adminShopScope: scope('other') };
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  try {
    assert.equal(reads.at(-1).shopId, 'other');
    assert.equal(tree.root.findByProps({ 'aria-label': 'Vaqtlar tarixidagi do‘kon' }).props.disabled, true);
    props = { ...props, adminShopScope: scope('all') };
    await act(async () => tree.update(React.createElement(Component, props)));
    assert.equal(reads.at(-1).shopId, '');
    props = { ...props, adminShopScope: undefined };
    await act(async () => tree.update(React.createElement(Component, props)));
    await act(async () => tree.root.findByProps({ 'aria-label': 'Vaqtlar tarixidagi do‘kon' }).props.onChange({ target: { value: 'branch' } }));
    assert.equal(reads.at(-1).shopId, 'branch');
  } finally { await act(async () => tree.unmount()); }
});

test('demand lists follow the selected store while creation keeps the real employee assignment', async () => {
  const actor = { id: 'owner', role: 'admin', shop_id: 'branch', shop_name: 'Odina Branch' };
  const current = scope('other'); const actions = [];
  const requests = [{ id: 'branch-request', shop_id: 'branch', status: 'yangi' }, { id: 'other-request', shop_id: 'other', shop_name_snapshot: 'Odina Other', status: 'yangi' }];
  const state = { requests, itemsByRequest: {}, loading: false, busy: false,
    safe: async callback => callback(), create: async data => actions.push({ action: 'create', data }),
    update: async data => actions.push({ action: 'update', data }), accept: async id => actions.push({ action: 'accept', id }) };
  const Component = component('src/components/shop-demand/ShopDemandPanel.jsx', {
    '@/components/shop-demand/useShopDemand': { useShopDemand: user => { assert.equal(user, actor); return state; } },
    '@/lib/shop-demand': { DEMAND_STATUSES: [], sortRequests: rows => rows },
    '@/components/shop-demand/ShopDemandCard': { default: wrapper('demand-card') },
    '@/components/shop-demand/ShopDemandForm': { default: wrapper('demand-form') },
  }).default;
  let props = { user: actor, products, locations: shops, adminShopScope: current };
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  try {
    let cards = tree.root.findAllByType('demand-card');
    assert.equal(cards.length, 1); assert.equal(cards[0].props.request.id, 'other-request');
    assert.equal(button(tree, 'Markazga talab yuborish'), undefined);
    await act(async () => cards[0].props.actions.accept('branch-request'));
    assert.equal(actions.length, 0);
    await act(async () => cards[0].props.actions.onEdit(cards[0].props.request));
    const form = tree.root.findByType('demand-form');
    assert.equal(form.props.user, actor); assert.equal(form.props.shopName, 'Odina Other');
    assert.equal(current.selectShop('branch'), false);
    await act(async () => form.props.onSubmit({ required_date: '2026-10-18', items: [] }));
    assert.equal(actions[0].action, 'update'); assert.equal(actions[0].data.request_id, 'other-request');
    props = { ...props, adminShopScope: scope('all') };
    await act(async () => tree.update(React.createElement(Component, props)));
    cards = tree.root.findAllByType('demand-card');
    assert.equal(cards.length, 2); assert.ok(cards.every(card => card.props.readOnly));
    await act(async () => cards[0].props.actions.accept('branch-request'));
    assert.equal(actions.length, 1);
    props = { ...props, adminShopScope: scope('branch') };
    await act(async () => tree.update(React.createElement(Component, props)));
    assert.ok(button(tree, 'Markazga talab yuborish'));
    assert.equal(actor.shop_id, 'branch');
  } finally { await act(async () => tree.unmount()); }
});

test('read-only demand cards suppress every mutation control without replacing the actor role', async () => {
  const Component = component('src/components/shop-demand/ShopDemandCard.jsx', {
    '@/lib/shop-demand': { demandStatus: () => ({ label: 'Yangi' }), remainingForItem: () => 1, displayDate: String, unitLabel: String },
    '@/lib/uzbekistan-time': { uzbekistanDateKey: () => '2026-10-17', formatUzbekistanDateTime: String },
    '@/components/shop-demand/ShopDemandSendDialog': { default: wrapper('demand-send') },
  }).default;
  let tree; await act(async () => { tree = create(React.createElement(Component, {
    request: { id: 'request', status: 'yangi', items: [] }, user: { role: 'admin', shop_id: 'branch' }, actions: {}, readOnly: true,
  })); });
  try { assert.equal(tree.root.findAllByType('button').length, 0); }
  finally { await act(async () => tree.unmount()); }
});
