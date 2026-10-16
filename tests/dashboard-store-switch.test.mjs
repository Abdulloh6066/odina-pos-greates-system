// Render the actual dashboard with offline fixtures; no app or business records are touched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

const day = '2026-10-16';
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const reports = [
  { shop_id: 'branch', shop_name: 'Odina Branch', total_revenue: 1000, collections_total: 1200, order_payment_total: 200, sale_count: 2 },
  { shop_id: 'central', shop_name: 'Odina Central', total_revenue: 3000, collections_total: 3500, order_payment_total: 500, sale_count: 3 },
  { shop_id: 'empty', shop_name: 'Yangi do‘kon', total_revenue: 0, collections_total: 0, order_payment_total: 0, sale_count: 0 },
];
const sales = [
  { shop_id: 'branch', business_date: day, total: 1000, user_name: 'Branch kassiri', items: [{ product_id: 'branch-cake', product_name: 'Branch torti', quantity: 2 }] },
  { shop_id: 'central', business_date: day, total: 3000, user_name: 'Central kassiri', items: [{ product_id: 'central-cake', product_name: 'Central torti', quantity: 3 }] },
  { shop_id: 'branch', business_date: day, total: 9999, status: 'refunded', user_name: 'Qaytarilgan savdo', items: [{ product_name: 'Qaytarilgan tort', quantity: 99 }] },
  { shop_id: 'branch', business_date: '2026-10-15', total: 9999, user_name: 'Kechagi savdo', items: [{ product_name: 'Kechagi tort', quantity: 99 }] },
];
const products = [
  { id: 'branch-cake', available_shop_ids: ['branch'] },
  { id: 'central-cake', available_shop_ids: ['central'] },
  { id: 'shared-cake', available_shop_ids: [] },
  { id: 'archived-cake', archived: true, available_shop_ids: [] },
];
const expired = [
  { id: 'branch-old', location_id: 'branch' },
  { id: 'central-old-1', location_id: 'central' },
  { id: 'central-old-2', location_id: 'central' },
];

async function fixture({ role = 'admin', reportRows = reports, pendingCatalog = false } = {}) {
  const calls = [], navigations = [], timers = new Map(), listeners = new Map();
  let timerId = 0, resolveCatalog;
  const catalogPromise = pendingCatalog ? new Promise(resolve => { resolveCatalog = resolve; }) : Promise.resolve(sales);
  const user = { id: 'viewer', role, shop_id: 'branch', shop_name: 'Odina Branch' };
  const navigate = (...args) => navigations.push(structuredClone(args));
  const backend = {
    entities: {
      Sale: { list: async (...args) => { calls.push({ entity: 'Sale', action: 'list', args }); return catalogPromise; } },
      Product: { list: async (...args) => { calls.push({ entity: 'Product', action: 'list', args }); return structuredClone(products); } },
    },
    functions: { invoke: async (name, payload) => {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === 'waste-ledger' && payload.action === 'get_alerts') return { data: { expired_items: structuredClone(expired) } };
      if (name === 'daily-sales-export' && payload.action === 'preview') return { data: { reports: structuredClone(reportRows) } };
      throw new Error('Unexpected function or mutation: ' + name + '/' + payload.action);
    } },
  };
  const target = name => ({
    addEventListener: (event, callback) => listeners.set(name + ':' + event, callback),
    removeEventListener: (event, callback) => {
      if (listeners.get(name + ':' + event) === callback) listeners.delete(name + ':' + event);
    },
  });
  const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const require = specifier => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === 'react-router-dom') return { useOutletContext: () => ({ user }), useNavigate: () => navigate };
    if (specifier === '@/api/base44Client') return { base44: backend };
    if (specifier === '@/lib/pos') return {
      formatUZS: value => '$' + value,
      formatNum: value => String(value),
      saleBusinessDate: sale => sale.business_date,
      tashkentDateKey: () => day,
      canAccess: (_role, page) => page === 'pos',
    };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (specifier === '@/components/PageHeader') return { default: ({ title, subtitle, actions }) => React.createElement('header', {}, title, subtitle, actions) };
    if (specifier.endsWith('/odina-select')) return { default: wrapper('select') };
    if (specifier.endsWith('.css')) return {};
    throw new Error('Unexpected dependency: ' + specifier);
  };
  const source = ts.transpileModule(readFileSync('src/pages/Dashboard.jsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {
    console, window: target('window'), document: { ...target('document'), visibilityState: 'visible' }, navigator: { onLine: true },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  })(require, module, module.exports);
  let tree;
  await act(async () => { tree = create(React.createElement(module.exports.default)); });
  return {
    tree, calls, navigations, timers, listeners,
    finishCatalog: async () => act(async () => resolveCatalog?.(structuredClone(sales))),
    switchStore: async label => act(async () => storeButton(tree, label).props.onClick()),
    close: async () => act(async () => tree.unmount()),
  };
}

const groups = tree => tree.root.findAllByProps({ role: 'group', 'aria-label': 'Do‘kon bo‘yicha ko‘rish' });
const storeButtons = tree => groups(tree)[0].findAllByType('button');
const storeButton = (tree, label) => storeButtons(tree).find(button => text(button) === label);
const selected = tree => storeButtons(tree).filter(button => button.props['aria-pressed'] === true).map(text);
const stat = (tree, label) => {
  const entry = tree.root.findAllByType('dt').find(dt => text(dt) === label).parent;
  return text(entry.findByType('dd'));
};
const collections = tree => text(tree.root.findByProps({ className: 'odina-home-collections-value' }));
const panel = (tree, title) => text(tree.root.findByProps({ 'aria-label': title }));
const scope = tree => text(tree.root.findByProps({ className: 'odina-home-filter-scope' }));
const expiry = tree => tree.root.findAllByType('button').find(button => text(button).includes('tur mahsulot 3 kundan oshgan'));

test('admin buttons switch every home indicator between all stores, Branch and Central without a request or write', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(storeButtons(f.tree).map(text), ['Barcha do‘konlar', 'Odina Branch', 'Odina Central', 'Yangi do‘kon']);
    assert.ok(storeButtons(f.tree).every(button => button.props.disabled === false));
    assert.deepEqual(selected(f.tree), ['Barcha do‘konlar']);
    assert.equal(collections(f.tree), '$4700');
    assert.equal(stat(f.tree, 'Kassa sof savdo'), '$4000');
    assert.equal(stat(f.tree, 'Buyurtma to‘lovlari'), '$700');
    assert.equal(stat(f.tree, 'Kassa savdolari'), '5');
    assert.equal(stat(f.tree, 'Kassa o‘rtacha sof savdosi'), '$800');
    assert.equal(stat(f.tree, 'Katalogdagi mahsulotlar'), '3');
    assert.match(text(expiry(f.tree)), /^3 tur mahsulot/);
    assert.match(panel(f.tree, 'Bugungi Kassa mahsulotlari'), /Branch torti/);
    assert.match(panel(f.tree, 'Bugungi Kassa mahsulotlari'), /Central torti/);
    assert.doesNotMatch(text(f.tree.toJSON()), /Qaytarilgan tort|Kechagi tort|Qaytarilgan savdo|Kechagi savdo/);
    const reads = structuredClone(f.calls);

    await f.switchStore('Odina Branch');
    assert.deepEqual(selected(f.tree), ['Odina Branch']);
    assert.equal(scope(f.tree), 'Odina Branch · Bugungi ko‘rsatkichlar');
    assert.equal(collections(f.tree), '$1200');
    assert.equal(stat(f.tree, 'Kassa sof savdo'), '$1000');
    assert.equal(stat(f.tree, 'Buyurtma to‘lovlari'), '$200');
    assert.equal(stat(f.tree, 'Kassa savdolari'), '2');
    assert.equal(stat(f.tree, 'Kassa o‘rtacha sof savdosi'), '$500');
    assert.equal(stat(f.tree, 'Katalogdagi mahsulotlar'), '2');
    assert.match(text(expiry(f.tree)), /^1 tur mahsulot/);
    assert.match(panel(f.tree, 'Bugungi Kassa mahsulotlari'), /Branch torti.*2 ta sotildi/);
    assert.doesNotMatch(panel(f.tree, 'Bugungi Kassa mahsulotlari'), /Central torti/);
    assert.match(panel(f.tree, 'Bugungi Kassa xodimlari'), /Branch kassiri.*\$1000/);
    assert.doesNotMatch(panel(f.tree, 'Bugungi Kassa xodimlari'), /Central kassiri/);

    await f.switchStore('Odina Central');
    assert.deepEqual(selected(f.tree), ['Odina Central']);
    assert.equal(scope(f.tree), 'Odina Central · Bugungi ko‘rsatkichlar');
    assert.equal(collections(f.tree), '$3500');
    assert.equal(stat(f.tree, 'Kassa sof savdo'), '$3000');
    assert.equal(stat(f.tree, 'Buyurtma to‘lovlari'), '$500');
    assert.equal(stat(f.tree, 'Kassa savdolari'), '3');
    assert.equal(stat(f.tree, 'Kassa o‘rtacha sof savdosi'), '$1000');
    assert.equal(stat(f.tree, 'Katalogdagi mahsulotlar'), '2');
    assert.match(text(expiry(f.tree)), /^2 tur mahsulot/);
    assert.match(panel(f.tree, 'Bugungi Kassa mahsulotlari'), /Central torti.*3 ta sotildi/);
    assert.doesNotMatch(panel(f.tree, 'Bugungi Kassa mahsulotlari'), /Branch torti/);
    assert.match(panel(f.tree, 'Bugungi Kassa xodimlari'), /Central kassiri.*\$3000/);
    assert.doesNotMatch(panel(f.tree, 'Bugungi Kassa xodimlari'), /Branch kassiri/);

    await f.switchStore('Barcha do‘konlar');
    assert.deepEqual(selected(f.tree), ['Barcha do‘konlar']);
    assert.equal(collections(f.tree), '$4700');
    assert.equal(stat(f.tree, 'Kassa savdolari'), '5');
    assert.equal(stat(f.tree, 'Kassa o‘rtacha sof savdosi'), '$800');
    assert.match(text(expiry(f.tree)), /^3 tur mahsulot/);
    assert.deepEqual(f.calls, reads, 'switching filters existing authorized reads without a network request');
    assert.deepEqual(f.calls.filter(call => call.name).map(call => [call.name, call.payload]), [
      ['waste-ledger', { action: 'get_alerts' }],
      ['daily-sales-export', { action: 'preview', business_date: day }],
    ]);
  } finally { await f.close(); }
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('a store with no sales remains selectable and shows zero totals, empty rankings and no expiry alert', async () => {
  const f = await fixture();
  try {
    await f.switchStore('Yangi do‘kon');
    assert.deepEqual(selected(f.tree), ['Yangi do‘kon']);
    assert.equal(scope(f.tree), 'Yangi do‘kon · Bugungi ko‘rsatkichlar');
    assert.equal(collections(f.tree), '$0');
    assert.equal(stat(f.tree, 'Kassa savdolari'), '0');
    assert.equal(stat(f.tree, 'Kassa o‘rtacha sof savdosi'), '$0');
    assert.equal(stat(f.tree, 'Katalogdagi mahsulotlar'), '1');
    assert.match(panel(f.tree, 'Bugungi Kassa mahsulotlari'), /Bugun hali savdo yo‘q/);
    assert.match(panel(f.tree, 'Bugungi Kassa xodimlari'), /Bugun hali savdo yo‘q/);
    assert.equal(expiry(f.tree), undefined);
  } finally { await f.close(); }
});

test('buttons wait for catalog loading and remain disabled when no authorized stores are available', async () => {
  const loading = await fixture({ pendingCatalog: true });
  try {
    assert.ok(storeButtons(loading.tree).every(button => button.props.disabled === true));
    await loading.finishCatalog();
    assert.ok(storeButtons(loading.tree).every(button => button.props.disabled === false));
  } finally { await loading.close(); }
  const empty = await fixture({ reportRows: [] });
  try {
    assert.deepEqual(storeButtons(empty.tree).map(text), ['Barcha do‘konlar']);
    assert.equal(storeButton(empty.tree, 'Barcha do‘konlar').props.disabled, true);
  } finally { await empty.close(); }
});

test('manager keeps only the assigned shop and cannot select all stores or admin buttons', async () => {
  // Include unassigned rows deliberately: the frontend must still enforce the manager scope.
  const f = await fixture({ role: 'manager' });
  try {
    assert.equal(groups(f.tree).length, 0);
    const select = f.tree.root.findByType('select');
    assert.equal(select.props.value, 'branch');
    assert.deepEqual(select.findAllByType('option').map(option => option.props.value), ['branch']);
    assert.equal(collections(f.tree), '$1200');
    assert.equal(stat(f.tree, 'Kassa savdolari'), '2');
    assert.doesNotMatch(panel(f.tree, 'Bugungi Kassa xodimlari'), /Central kassiri/);
    const reads = structuredClone(f.calls);
    await act(async () => select.props.onChange({ target: { value: 'all' } }));
    assert.equal(f.tree.root.findByType('select').props.value, 'branch');
    assert.equal(collections(f.tree), '$1200');
    assert.equal(stat(f.tree, 'Kassa savdolari'), '2');
    assert.deepEqual(f.calls, reads);
  } finally { await f.close(); }
});

test('cashier redirects to Kassa without dashboard controls or data requests', async () => {
  const f = await fixture({ role: 'cashier' });
  try {
    assert.equal(f.tree.toJSON(), null);
    assert.deepEqual(f.navigations, [['/pos', { replace: true }]]);
    assert.deepEqual(f.calls, []);
    assert.equal(f.timers.size, 0);
    assert.equal(f.listeners.size, 0);
  } finally { await f.close(); }
});
