import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';

// Real page components with isolated React state; every backend is a read-only mock.
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const wrap = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const empty = () => null;
const shops = [
  { id: 'branch', name: 'Branch', active: true, location_type: 'shop', table_count: 2, orders: [], is_main: true },
  { id: 'other', name: 'Other', active: true, location_type: 'shop', table_count: 3, orders: [] },
  { id: 'central', name: 'Central', active: true, location_type: 'production' },
];
const date = '2099-10-17';
const orders = [
  { id: 'b', order_number: 'BRANCH-ORDER', shop_id: 'branch', required_date: date, order_status: 'qabul_qilindi' },
  { id: 'o', order_number: 'OTHER-ORDER', shop_id: 'other', required_date: date, order_status: 'qabul_qilindi' },
  { id: 'h', order_number: 'OTHER-HISTORY', shop_id: 'other', required_date: date, order_status: 'yakunlandi' },
];

function scopeFixture(shopId = 'branch') {
  const guards = new Set();
  const scope = { isAdmin: true, shopId, specificShopId: shopId === 'all' ? '' : shopId, shops, ready: true,
    registerGuard: guard => { guards.add(guard); return () => guards.delete(guard); },
    selectShop: id => {
      if ([...guards].some(guard => guard())) return false;
      scope.shopId = id; scope.specificShopId = id === 'all' ? '' : id; return true;
    },
  };
  return { scope, guards };
}

async function renderPage(path, { role = 'admin', shopId = 'branch', custom = {}, props = {}, pending = null, orderItemsRead } = {}) {
  const { scope, guards } = scopeFixture(shopId);
  const calls = [], queries = [], alertInputs = [];
  const user = { id: 'self', role, shop_id: 'branch' };
  const ctx = { user, adminShopScope: scope };
  const read = rows => ({ list: async () => structuredClone(rows),
    filter: async query => structuredClone(rows.filter(row => !query?.order_status?.$nin?.includes(row.order_status))),
    subscribe: () => () => {} });
  const backend = { entities: {
    Shop: read(shops), Settings: read([{ id: 's', shop_name: 'GLOBAL-NAME' }]), Product: read([]),
    CustomerOrder: read(orders), CustomerOrderItem: read([]), IngredientStock: read([]), Recipe: read([]), RecipeItem: read([]),
  }, functions: { invoke: async (name, payload) => {
    calls.push({ name, payload });
    if (name === 'security-admin' && payload.action === 'status') return { data: { can_manage_admins: true, users: [
      { id: 'self', role: 'admin', full_name: 'SHARED-ADMIN', email: 'self@test.invalid' },
      { id: 'b', role: 'cashier', shop_id: 'branch', full_name: 'BRANCH-WORKER', email: 'b@test.invalid' },
      { id: 'o', role: 'cashier', shop_id: 'other', full_name: 'OTHER-WORKER', email: 'o@test.invalid' },
      { id: 'u', role: 'accountant', full_name: 'UNASSIGNED-WORKER', email: 'u@test.invalid' },
    ] } };
    if (name === 'restaurant-tables' && payload.action === 'status') return { data: { shops: shops.slice(0, 2), can_manage: true } };
    if (name === 'budget-ledger' && payload.action === 'summary') return { data: { balances: [{ account: 'cash', balance: 777 }], transactions: [
      { id: 'b', shop_id: 'branch', description: 'BRANCH-BUDGET', account: 'cash', amount: 11 },
      { id: 'o', shop_id: 'other', description: 'OTHER-BUDGET', account: 'cash', amount: 22 },
      { id: 'g', description: 'GLOBAL-BUDGET', account: 'cash', amount: 33 },
    ] } };
    if (name === 'production-run' && payload.action === 'tomorrow_ingredient_forecast') return { data: { global: true } };
    throw new Error('Unexpected write/API call in offline test: ' + name + '/' + payload.action);
  } } };
  if (orderItemsRead) backend.entities.CustomerOrderItem.filter = orderItemsRead;
  const dateModule = { uzbekistanDateKey: () => date, shiftDateKey: () => '2099-10-18', formatUzbekistanDateTime: value => value || '', formatUzbekistanTime: value => value || '' };
  const orderModule = {
    displayOrderNumber: order => order.order_number || order.id, typeLabel: value => value,
    tashkentNowParts: () => ({ day: 17, month: 10, year: 2099, hour: 8, minute: 0 }), tashkentNowStamp: () => date,
    pad2: value => String(value).padStart(2, '0'), composeRequiredDate: (y, m, d) => d ? `${y}-${m}-${d}` : '', isFutureDateTime: () => true,
    ORDER_TYPES: [{ key: 'toy_va_bazmlar', label: 'Toy' }], FULFILMENT_TYPES: [{ key: 'pickup', label: 'Pickup' }], CAKE_SHAPES: [], MONTHS_UZ: Array.from({ length: 12 }, (_, i) => String(i + 1)),
  };
  const captures = {};
  const capture = name => received => { captures[name] = received; return React.createElement('section', { 'data-capture': name }, received.order?.order_number); };
  const require = specifier => {
    if (specifier in custom) return custom[specifier];
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === 'react-router-dom') return { useOutletContext: () => ctx, useNavigate: () => empty, useLocation: () => ({ state: null }), Link: wrap('a'), Navigate: ({ to }) => React.createElement('nav', { 'data-redirect': to }) };
    if (specifier === '@/lib/AuthContext') return { useAuth: () => ctx };
    if (specifier === '@/api/base44Client') return { base44: backend };
    if (specifier === '@/lib/uzbekistan-time' || specifier === './uzbekistan-time.js') return dateModule;
    if (specifier === '@/lib/orders') return orderModule;
    if (specifier === '@/lib/pos') return { formatUZS: value => `${value} UZS`, logAction: empty, ROLE_HOME: {}, PAYMENT_METHODS: [] };
    if (specifier === '@/lib/shop-pricing') return { priceForShop: product => product.price || 0 };
    if (specifier === '@/lib/order-request-retry') return { orderRequestScope: () => 'offline', readOrderRequest: () => pending, retainOrderRequest: value => value, clearOrderRequest: empty };
    if (specifier === '@/lib/odina-dialog') return { odinaAlert: empty, odinaConfirm: async () => false };
    if (specifier === '@/lib/staff-order-ticket') return { isStaffTicketEnabled: () => false };
    if (specifier === '@/hooks/useOrderUpdates') return load('src/hooks/useOrderUpdates.js');
    if (specifier === '@/hooks/useEntityHistory') return { useEntityHistory: (_entity, query) => { queries.push(query); return { rows: orders, reload: empty, loadMore: empty }; } };
    if (specifier === '@/hooks/useOrderAlerts') return { useOrderAlerts: rows => { alertInputs.push(rows); return { alerts: [], counts: {} }; } };
    if (specifier === '@/components/ui/use-toast') return { useToast: () => ({ toast: empty }) };
    if (specifier === '@/lib/order-action-timing') return { startOrderActionTiming: () => () => 0 };
    if (specifier === '@/lib/history-pagination') return load('src/lib/history-pagination.js');
    if (specifier === '@/components/orders/OrderFilterRail') return { default: capture('filters') };
    if (specifier === '@/components/orders/OrderLedgerCard') return { default: capture('card') };
    if (specifier === '@/components/orders/OrderForm') return { default: capture('form') };
    if (specifier === '@/components/tables/TableFloorplan') return { default: capture('floorplan') };
    if (specifier === '@/components/tables/TableDetailSheet') return { default: capture('table-detail') };
    if (specifier === '@/components/PageHeader') return { default: ({ title, subtitle, actions }) => React.createElement('header', {}, title, subtitle, actions) };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrap('svg') });
    if (specifier.endsWith('/odina-select')) return { default: wrap('select') };
    if (specifier.endsWith('/dialog')) return new Proxy({ Dialog: ({ open, children }) => open ? React.createElement('div', {}, children) : null }, { get: (target, key) => target[key] || wrap('section') });
    if (specifier.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, key) => wrap(({ Button: 'button', Input: 'input', Label: 'label', Textarea: 'textarea' })[key] || 'div') });
    if (specifier.startsWith('@/components/') || specifier.endsWith('.css')) return { default: empty };
    throw new Error('Unmocked dependency: ' + specifier);
  };
  function load(filename) {
    const module = { exports: {} };
    const source = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
    const noEvents = { addEventListener: empty, removeEventListener: empty };
    vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {
      console, window: noEvents, document: { ...noEvents, visibilityState: 'visible' }, navigator: { onLine: true },
      setInterval: empty, clearInterval: empty, setTimeout: empty, clearTimeout: empty, URLSearchParams,
    })(require, module, module.exports);
    return module.exports;
  }
  const Component = load(path).default;
  const componentProps = { ...props };
  if (path.endsWith('OrderForm.jsx')) Object.assign(componentProps, { user, shops, open: true, onClose: empty, onCreated: empty, ...props, adminShopScope: scope });
  let tree;
  await act(async () => { tree = create(React.createElement(Component, componentProps)); });
  return { tree, scope, guards, calls, queries, alertInputs, captures, user,
    update: async (id, next = {}) => { scope.shopId = id; scope.specificShopId = id === 'all' ? '' : id; Object.assign(componentProps, next); await act(async () => tree.update(React.createElement(Component, componentProps))); },
    close: async () => act(async () => tree.unmount()),
  };
}

test('Orders scopes paginated history, active alerts and day counts; clear keeps global shop', async () => {
  const f = await renderPage('src/pages/Orders.jsx');
  try {
    assert.match(JSON.stringify(f.queries.at(-1)), /"shop_id":"branch"/);
    assert.deepEqual(Array.from(f.alertInputs.at(-1), order => order.id), ['b']);
    assert.match(text(f.tree.toJSON()), /BRANCH-ORDER/);
    assert.doesNotMatch(text(f.tree.toJSON()), /OTHER-ORDER|OTHER-HISTORY/);
    await act(async () => f.captures.filters.onClear());
    assert.equal(f.scope.specificShopId, 'branch');
    await f.update('other');
    assert.deepEqual(Array.from(f.alertInputs.at(-1), order => order.id), ['o']);
    assert.doesNotMatch(text(f.tree.toJSON()), /BRANCH-ORDER/);
    const history = f.tree.root.findAllByType('button').find(node => text(node) === 'Tarix');
    await act(async () => history.props.onClick());
    assert.match(text(f.tree.toJSON()), /OTHER-HISTORY/);
    assert.doesNotMatch(text(f.tree.toJSON()), /BRANCH-ORDER|OTHER-ORDER/);
    await act(async () => f.captures.filters.setters.shop(''));
    assert.equal(f.scope.shopId, 'all');
  } finally { await f.close(); }
});

test('All stores Orders restores all data and non-admin scope never overrides their existing shop filter', async () => {
  const all = await renderPage('src/pages/Orders.jsx', { shopId: 'all' });
  try { assert.equal(all.alertInputs.at(-1).length, 2); assert.doesNotMatch(JSON.stringify(all.queries.at(-1)), /shop_id/); } finally { await all.close(); }
  const worker = await renderPage('src/pages/Orders.jsx', { role: 'cashier', shopId: 'other' });
  try { assert.doesNotMatch(JSON.stringify(worker.queries.at(-1)), /shop_id/); assert.equal(worker.guards.size, 0); } finally { await worker.close(); }
});

test('deferred repeat blocks shop switches and a stale response cannot open an old-store draft', async () => {
  let resolveItems;
  const delayed = new Promise(resolve => { resolveItems = resolve; });
  let requests = 0;
  const f = await renderPage('src/pages/Orders.jsx', { orderItemsRead: () => { requests += 1; return delayed; } });
  try {
    let repeat;
    await act(async () => { repeat = f.captures.card.onRepeat(orders[0]); });
    assert.equal(f.scope.selectShop('other'), false);
    await act(async () => { void f.captures.card.onRepeat(orders[0]); });
    assert.equal(requests, 1, 'repeat loading is claimed synchronously');
    await f.update('other'); // A forced external update must also invalidate the in-flight response.
    await act(async () => { resolveItems([]); await repeat; });
    assert.equal(f.captures.form.open, false);
    assert.equal(f.captures.form.prefill, null);
    assert.equal(f.scope.specificShopId, 'other');
  } finally { await f.close(); }
});

test('new clean order follows admin shop; a dirty draft blocks global switches', async () => {
  const f = await renderPage('src/components/orders/OrderForm.jsx', { shopId: 'other' });
  try {
    const shop = () => f.tree.root.findAllByType('select').find(node => node.props.children?.[0]?.props?.children === 'Tanlang');
    assert.equal(shop().props.value, 'other');
    assert.ok([...f.guards].every(guard => !guard()));
    await f.update('branch');
    assert.equal(shop().props.value, 'branch');
    const input = f.tree.root.findAllByType('input').find(node => node.props.value === '' && !node.props.type);
    await act(async () => input.props.onChange({ target: { value: 'Unfinished customer' } }));
    assert.equal(f.scope.selectShop('other'), false);
    assert.equal(shop().props.value, 'branch');
    await f.update('branch', { open: false });
    assert.equal(f.scope.selectShop('other'), false, 'closing preserves the draft and its scope guard');
    await f.update('branch', { open: true });
    const clear = f.tree.root.findAllByType('button').find(node => text(node) === 'Qoralamani tozalash va yopish');
    await act(async () => clear.props.onClick());
    assert.equal(f.scope.selectShop('other'), true, 'explicitly clearing the unsaved draft releases the guard');
    await f.update('other');
    assert.equal(shop().props.value, 'other');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('uncertain saved order retains original shop and prevents retargeting even with form closed', async () => {
  const pending = { shop_id: 'branch', required_date: date, required_time: '18:00', customer_name: 'Existing retry', items: [] };
  const f = await renderPage('src/components/orders/OrderForm.jsx', { shopId: 'other', pending });
  try {
    const shop = f.tree.root.findAllByType('select').find(node => node.props.children?.[0]?.props?.children === 'Tanlang');
    assert.equal(shop.props.value, 'branch');
    await f.update('other', { open: false });
    assert.equal(f.scope.selectShop('central'), false);
    assert.equal(pending.shop_id, 'branch');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('repeat order preserves the source shop and cashier new order ignores admin scope', async () => {
  const prefill = { order: { id: 'repeat', shop_id: 'branch', customer_name: 'Repeat customer' }, items: [] };
  const repeated = await renderPage('src/components/orders/OrderForm.jsx', { shopId: 'other', props: { prefill } });
  try {
    const shop = repeated.tree.root.findAllByType('select').find(node => node.props.children?.[0]?.props?.children === 'Tanlang');
    assert.equal(shop.props.value, 'branch');
    assert.equal(repeated.scope.selectShop('central'), false);
    assert.equal(prefill.order.shop_id, 'branch');
  } finally { await repeated.close(); }
  const worker = await renderPage('src/components/orders/OrderForm.jsx', { role: 'cashier', shopId: 'other' });
  try {
    const shop = worker.tree.root.findAllByType('select').find(node => node.props.children?.[0]?.props?.children === 'Tanlang');
    assert.equal(shop.props.value, 'branch');
    assert.equal(shop.props.disabled, true);
    assert.equal(worker.guards.size, 0);
  } finally { await worker.close(); }
});

test('staff display scopes workers and explicitly retains shared admins/unassigned accounts', async () => {
  const f = await renderPage('src/pages/Users.jsx');
  try {
    assert.match(text(f.tree.toJSON()), /BRANCH-WORKER|SHARED-ADMIN/);
    assert.match(text(f.tree.toJSON()), /UNASSIGNED-WORKER/);
    assert.doesNotMatch(text(f.tree.toJSON()), /OTHER-WORKER/);
    assert.match(text(f.tree.toJSON()), /Barcha do‘konlar uchun umumiy hisob/);
    await f.update('other');
    assert.doesNotMatch(text(f.tree.toJSON()), /BRANCH-WORKER/);
    assert.match(text(f.tree.toJSON()), /OTHER-WORKER/);
    assert.ok(f.calls.every(call => call.payload.action === 'status'));
  } finally { await f.close(); }
});

test('selected Budget filters history but preserves shared balances and global unassigned history in all mode', async () => {
  const f = await renderPage('src/pages/Budget.jsx');
  try {
    assert.match(text(f.tree.toJSON()), /BRANCH-BUDGET/);
    assert.doesNotMatch(text(f.tree.toJSON()), /OTHER-BUDGET|GLOBAL-BUDGET/);
    assert.match(text(f.tree.toJSON()), /777 UZS/);
    assert.match(text(f.tree.toJSON()), /qoldiqlari barcha do‘konlar uchun umumiy/);
    await f.update('all');
    assert.match(text(f.tree.toJSON()), /OTHER-BUDGET/);
    assert.match(text(f.tree.toJSON()), /GLOBAL-BUDGET/);
    assert.match(text(f.tree.toJSON()), /777 UZS/);
    assert.ok(f.calls.every(call => call.payload.action === 'summary'));
  } finally { await f.close(); }
});

test('Settings scopes only shop contact cards and preserves explicitly global configuration', async () => {
  const f = await renderPage('src/pages/Settings.jsx');
  try {
    const cards = () => f.tree.root.findAll(node => node.type === 'div' && node.props.className?.includes('odina-shop-settings-card'));
    assert.equal(cards().length, 1);
    assert.match(text(cards()[0]), /Branch/);
    assert.ok(f.tree.root.findAllByType('input').some(node => node.props.value === 'GLOBAL-NAME'));
    await f.update('all'); assert.equal(cards().length, 3);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('Tables follows selected store and unsupported Central never falls back to another hall', async () => {
  const f = await renderPage('src/pages/RestaurantTables.jsx', { shopId: 'other' });
  try {
    assert.equal(f.captures.floorplan.shop.id, 'other');
    await f.update('central');
    assert.match(text(f.tree.toJSON()), /Tanlangan joyda kassa stollari mavjud emas/);
    assert.equal(f.tree.root.findAll(node => node.props['data-capture'] === 'floorplan').length, 0);
    await f.update('branch');
    await act(async () => f.captures.floorplan.onEditingChange(true));
    assert.equal(f.scope.selectShop('other'), false);
    assert.ok(f.calls.every(call => call.payload.action === 'status'));
  } finally { await f.close(); }
});

test('All stores retains table hall selection and choosing another hall updates global scope', async () => {
  const f = await renderPage('src/pages/RestaurantTables.jsx', { shopId: 'all' });
  try {
    assert.equal(f.captures.floorplan.shop.id, 'branch');
    const chooser = f.tree.root.findByProps({ 'aria-label': 'Do‘kon tanlash' });
    const other = chooser.findAllByType('button').find(node => text(node).includes('Other'));
    await act(async () => other.props.onClick());
    assert.equal(f.scope.specificShopId, 'other');
    assert.equal(f.captures.floorplan.shop.id, 'other');
    assert.ok(f.calls.every(call => call.payload.action === 'status'));
  } finally { await f.close(); }
});

test('blank and invalid table-count drafts block global switches without enabling save', async () => {
  const f = await renderPage('src/pages/RestaurantTables.jsx');
  try {
    const input = f.tree.root.findAllByType('input').find(node => node.props.value === '2');
    assert.ok(input);
    for (const value of ['', '31', 'invalid']) {
      await act(async () => input.props.onChange({ target: { value } }));
      assert.equal(f.scope.selectShop('other'), false, `must preserve draft '${value}'`);
      const save = f.tree.root.findAllByType('button').find(node => text(node) === 'Stollarni saqlash');
      assert.ok(save);
      assert.equal(save.props.disabled, true);
    }
    await act(async () => input.props.onChange({ target: { value: '2' } }));
    assert.equal(f.scope.selectShop('other'), true);
    assert.ok(f.calls.every(call => call.payload.action === 'status'));
  } finally { await f.close(); }
});

test('Production scopes orders and keeps central forecast explicitly shared', async () => {
  const f = await renderPage('src/pages/ProductionScreen.jsx');
  try {
    assert.match(text(f.tree.toJSON()), /BRANCH-ORDER/);
    assert.doesNotMatch(text(f.tree.toJSON()), /OTHER-ORDER/);
    assert.match(text(f.tree.toJSON()), /ishlab chiqarish talablari barcha do‘konlar uchun umumiy/);
    await f.update('other');
    assert.doesNotMatch(text(f.tree.toJSON()), /BRANCH-ORDER/);
    assert.match(text(f.tree.toJSON()), /OTHER-ORDER/);
    assert.ok(f.calls.every(call => call.payload.action === 'tomorrow_ingredient_forecast'));
  } finally { await f.close(); }
});
