// Offline interaction checks for the compact Orders presentation; no SDK/network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as orders from '../src/lib/orders.js';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const wrap = tag => ({ children, ...props }) => React.createElement(tag, props, children);
function load(name) {
  const module = { exports: {} };
  const require = specifier => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrap('svg') });
    if (specifier === '@/lib/orders') return orders;
    if (specifier === '@/lib/pos') return { formatUZS: value => String(value || 0) + ' UZS' };
    if (specifier === '@/lib/uzbekistan-time') return { uzbekistanDateKey: () => '2026-10-29' };
    if (specifier === 'date-fns/locale') return { uz: {} };
    if (specifier.endsWith('/odina-select')) return { default: wrap('select') };
    if (specifier.endsWith('/calendar')) return { Calendar: wrap('calendar') };
    if (specifier.endsWith('/image')) return { Image: wrap('img') };
    if (specifier.endsWith('/popover')) return new Proxy({}, { get: () => wrap('popover-part') });
    if (specifier.endsWith('/dropdown-menu')) return new Proxy({}, { get: (_target, key) => wrap(key === 'DropdownMenuItem' ? 'menu-item' : 'menu-part') });
    throw Error('Unexpected dependency (network is not allowed): ' + specifier);
  };
  const source = ts.transpileModule(readFileSync('src/components/orders/' + name + '.jsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    reportDiagnostics: true,
  });
  assert.equal(source.diagnostics.length, 0);
  vm.runInNewContext('(function(require,module,exports){' + source.outputText + '\n})', { console })(require, module, module.exports);
  return module.exports.default;
}
const Row = load('OrderLedgerCard');
const Filters = load('OrderFilterRail');
const Hero = load('OrderLedgerHero');
const snapshot = {
  id: 'historical-order', order_sequence: 41, order_number: 'KEEP-TECHNICAL-NUMBER',
  customer_name: 'Malika Karimova', customer_phone: '+998 90 000 00 00', shop_name_snapshot: 'Own shop',
  required_date: '2026-10-29', required_time: '13:30', order_type: 'tugilgan_kun_va_boshqa',
  fulfilment_type: 'delivery', total: 245000, subtotal: 230000, delivery_fee: 15000,
  remaining_balance: 95000, payment_status: 'partial', order_status: 'tayyorlanmoqda',
  creator_name: 'Original creator', creator_role: 'cashier', reference_image: '/offline-reference.png',
};
async function rowFixture(props = {}) {
  const opened = [], repeated = [];
  let tree;
  await act(async () => { tree = create(React.createElement('table', {}, React.createElement('tbody', {},
    React.createElement(Row, { order: snapshot, isAdmin: true, today: '2026-10-29', onOpen: value => opened.push(value), onRepeat: value => repeated.push(value), ...props })))); });
  return { tree, opened, repeated, close: async () => act(async () => tree.unmount()) };
}

test('compact row opens the same historical order from row, primary button and menu', async () => {
  const f = await rowFixture(); let stopped = false;
  try {
    await act(async () => f.tree.root.findByType('tr').props.onClick());
    const primary = f.tree.root.findAllByType('button').find(node => node.props.className === 'opl-row-open');
    await act(async () => primary.props.onClick({ stopPropagation() { stopped = true; } }));
    await act(async () => f.tree.root.findAllByType('menu-item').find(node => text(node).trim() === 'Batafsil ko‘rish').props.onSelect());
    assert.equal(stopped, true);
    assert.equal(f.opened.length, 3);
    assert.ok(f.opened.every(value => value === snapshot));
  } finally { await f.close(); }
});
test('repeat menu delegates the original snapshot once and leaves every historical field intact', async () => {
  const before = structuredClone(snapshot), f = await rowFixture();
  try {
    const item = f.tree.root.findAllByType('menu-item').find(node => text(node).trim() === 'Qayta buyurtma');
    await act(async () => item.props.onSelect());
    assert.deepEqual(f.repeated, [snapshot]);
    assert.deepEqual(snapshot, before);
    assert.match(text(f.tree.toJSON()), /245000 UZS/);
    assert.match(text(f.tree.toJSON()), /95000 UZS qoldi/);
    assert.match(text(f.tree.toJSON()), /230000 UZS/);
    assert.match(text(f.tree.toJSON()), /15000 UZS/);
    assert.equal(f.tree.root.findByType('img').props.src, snapshot.reference_image);
  } finally { await f.close(); }
});
test('non-admin rows keep customer details without exposing the admin-only shop caption', async () => {
  const f = await rowFixture({ isAdmin: false, onRepeat: null });
  try {
    const output = text(f.tree.toJSON());
    assert.doesNotMatch(output, /Own shop/);
    assert.match(output, /Malika Karimova/);
    assert.match(output, /\+998 90 000 00 00/);
    assert.match(output, /Bugun/);
    assert.equal(f.tree.root.findAllByType('menu-item').length, 1);
  } finally { await f.close(); }
});
async function filterFixture(isAdmin = true, date = '') {
  const calls = [], setters = Object.fromEntries(['query', 'shop', 'type', 'status', 'pay', 'date'].map(key => [key, value => calls.push([key, value])]));
  const options = [{ value: '', label: 'Barchasi' }, { value: 'test', label: 'Sinov' }];
  let tree;
  await act(async () => { tree = create(React.createElement(Filters, { isAdmin, shops: [{ id: 'own', name: 'Own shop' }],
    filters: { query: '', shop: '', type: '', status: '', pay: '', date }, setters,
    typeOptions: options, statusOptions: options, payOptions: options, hasFilters: !!date, onClear: () => calls.push(['clear']) })); });
  return { tree, calls, close: async () => act(async () => tree.unmount()) };
}
test('search, status, payment, type and shop filters preserve their existing callback contracts', async () => {
  const f = await filterFixture();
  try {
    await act(async () => f.tree.root.findByType('input').props.onChange({ target: { value: 'customer or number' } }));
    for (const [label, key] of [['Buyurtma holati', 'status'], ['Buyurtma do‘koni', 'shop'], ['Buyurtma turi', 'type'], ['Buyurtma to‘lovi', 'pay']]) {
      await act(async () => f.tree.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value: key + '-value' } }));
    }
    assert.deepEqual(f.calls, [['query', 'customer or number'], ['status', 'status-value'], ['shop', 'shop-value'], ['type', 'type-value'], ['pay', 'pay-value']]);
  } finally { await f.close(); }
});
test('calendar selects a business date and list control clears the date through the same setter', async () => {
  const f = await filterFixture(true, '2026-10-29');
  try {
    const calendar = f.tree.root.findByType('calendar');
    assert.equal(calendar.props.today.getDate(), 29);
    await act(async () => calendar.props.onSelect(new Date(2026, 11, 31, 12)));
    const list = f.tree.root.findAllByType('button').find(node => node.props['aria-pressed'] !== undefined);
    await act(async () => list.props.onClick());
    assert.deepEqual(f.calls, [['date', '2026-12-31'], ['date', '']]);
  } finally { await f.close(); }
});
test('worker filter toolbar has no shop selector and create remains a single existing callback', async () => {
  const f = await filterFixture(false);
  try { assert.equal(f.tree.root.findAllByProps({ 'aria-label': 'Buyurtma do‘koni' }).length, 0); }
  finally { await f.close(); }
  let created = 0, tree;
  await act(async () => { tree = create(React.createElement(Hero, { onCreate: () => { created++; } })); });
  try { await act(async () => tree.root.findByType('button').props.onClick()); assert.equal(created, 1); }
  finally { await act(async () => tree.unmount()); }
});
