// Real Warehouse page and forms, with all reads and writes held in memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as quantities from '../base44/shared/product-stock-quantity.js';
import * as stockFormatting from '../src/lib/stock-quantity.js';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node.props.children).trim() === label);

async function fixture() {
  let tab = 'ingredients';
  const writes = [];
  const shop = { id: 'central', name: 'Markaziy ombor', active: true, location_type: 'production' };
  const products = [
    { id: 'snikers', name: 'Snikers oq', active: true, production_unit: 'piece' },
    { id: 'sheet', name: 'Matilda list', active: true, production_unit: 'sheet' },
  ];
  const balances = [
    { id: 'stock-snikers', location_id: shop.id, product_id: 'snikers', quantity: 10.5, unit: 'piece' },
    { id: 'stock-sheet', location_id: shop.id, product_id: 'sheet', quantity: 2.5, unit: 'sheet' },
  ];
  const outlet = {
    user: { id: 'owner', role: 'admin', shop_id: shop.id },
    adminShopScope: { isAdmin: true, ready: true, shopId: shop.id, specificShopId: shop.id,
      shops: [shop], registerGuard: () => () => {}, selectShop() {} },
  };
  const backend = { entities: new Proxy({}, { get: (_target, name) => ({
    list: async () => name === 'Shop' ? [shop] : name === 'Product' ? products
      : name === 'ProductStock' ? balances.map(row => ({ ...row })) : [],
    subscribe: () => () => {},
  }) }), functions: { invoke: async (name, payload) => {
    if (name === 'stock-transfer') return { data: { transfers: [] } };
    assert.equal(name, 'warehouse-stock');
    const row = balances.find(item => item.product_id === payload.item_id);
    assert.equal(payload.expected_quantity, row.quantity);
    writes.push(structuredClone(payload));
    row.quantity += payload.quantity_change;
    return { data: { stock: { ...row } } };
  } } };
  const dependencies = {
    'react': { ...React, default: React },
    'react-router-dom': { useOutletContext: () => outlet,
      useSearchParams: () => [new URLSearchParams('tab=' + tab), next => { tab = next.tab; }] },
    '@/api/base44Client': { base44: backend },
    '@/lib/odina-dialog': { odinaAlert: async message => { throw Error(message); } },
    '@/lib/pos': { formatNum: value => String(Math.round(Number(value || 0))) },
    '@/lib/stock-quantity': stockFormatting,
    '@/lib/uzbekistan-time': { formatUzbekistanDateTime: String },
    '@/lib/test-catalog-cleanup': { TEST_PRODUCT_IDS: [] },
    '@/lib/cake-layer-inventory': { isCakeLayer: item => item?.is_cake_layer === true, ingredientUnitLabel: item => item?.base_unit },
    '../../base44/shared/product-stock-quantity.js': quantities,
    '@/components/PageHeader': { default: ({ title, actions }) => React.createElement('header', {}, title, actions) },
    '@/components/warehouse/WarehouseTables': { WarehouseHistoryTable: wrapper('history-table') },
  };
  const require = name => {
    if (dependencies[name]) return dependencies[name];
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.endsWith('.css')) return {};
    if (name.endsWith('/odina-select')) return { default: wrapper('select') };
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, key) => key === 'Dialog'
      ? ({ open, children }) => open ? React.createElement('dialog', {}, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Label: 'label', Textarea: 'textarea' })[key] || 'div') });
    if (name.startsWith('@/components/')) return { default: wrapper('mock-component') };
    throw Error('Unexpected dependency: ' + name);
  };
  const js = ts.transpileModule(readFileSync('src/pages/Warehouse.jsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})',
    { console, URLSearchParams })(require, module, module.exports);
  const Component = module.exports.default;
  let tree;
  await act(async () => { tree = create(React.createElement(Component)); });
  return { tree, writes, balances, async products() {
    tab = 'products';
    await act(async () => tree.update(React.createElement(Component)));
  }, async close() { await act(async () => tree.unmount()); } };
}

test('stock formatting preserves halves and base-unit decimals without rounding them to pieces', () => {
  assert.equal(stockFormatting.formatInventoryQuantity(10.5), '10.5');
  assert.equal(stockFormatting.formatInventoryQuantity(0.5), '0.5');
  assert.equal(stockFormatting.formatInventoryQuantity(1250.125), '1 250.125');
  assert.equal(stockFormatting.formatInventoryQuantity(-0.5), '-0.5');
  assert.equal(stockFormatting.formatInventoryQuantity(20), '20');
});

test('warehouse products always use a list and retain dona/list and half balances', async () => {
  const f = await fixture();
  try {
    await act(async () => button(f.tree, 'Kartalar ko‘rinishi').props.onClick());
    await f.products();
    assert.equal(f.tree.root.findAllByType('table').length, 1);
    assert.equal(button(f.tree, 'Kartalar ko‘rinishi'), undefined);
    assert.equal(button(f.tree, 'Ro‘yxat ko‘rinishi'), undefined);
    assert.equal(button(f.tree, 'Yangi masalliq'), undefined);
    const rows = f.tree.root.findAllByType('tr').map(row => text(row));
    assert.ok(rows.some(row => row.includes('Snikers oq') && row.includes('10.5') && row.includes('dona')));
    assert.ok(rows.some(row => row.includes('Matilda list') && row.includes('2.5') && row.includes('list')));
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('warehouse half shortcut saves 0.5 dona with the observed balance and history reason', async () => {
  const f = await fixture();
  try {
    await f.products();
    const adjust = f.tree.root.findAllByType('button').find(node => node.props['aria-label'] === 'Snikers oq — qoldiqni tuzatish');
    await act(async () => adjust.props.onClick());
    const input = f.tree.root.findByProps({ id: 'warehouse-adjust-quantity' });
    assert.equal(input.props.step, 0.5);
    assert.equal(input.props.min, 0.5);
    await act(async () => button(f.tree, '+ Yarim (0.5 dona)').props.onClick());
    assert.equal(f.tree.root.findByProps({ id: 'warehouse-adjust-quantity' }).props.value, '0.5');
    await act(async () => f.tree.root.findByType('textarea').props.onChange({ target: { value: 'Haqiqiy qoldiq tekshirildi' } }));
    await act(async () => button(f.tree, 'Faqat qoldiqni saqlash').props.onClick());
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].quantity_change, 0.5);
    assert.equal(f.writes[0].expected_quantity, 10.5);
    assert.equal(f.writes[0].item_kind, 'product');
    assert.equal(f.balances[0].quantity, 11);
    assert.equal(f.balances[1].quantity, 2.5);
  } finally { await f.close(); }
});

test('warehouse blocks quarter pieces and labels half sheets as list', async () => {
  const f = await fixture();
  try {
    await f.products();
    const adjust = f.tree.root.findAllByType('button').find(node => node.props['aria-label'] === 'Matilda list — qoldiqni tuzatish');
    await act(async () => adjust.props.onClick());
    assert.ok(button(f.tree, '+ Yarim (0.5 list)'));
    await act(async () => f.tree.root.findByProps({ id: 'warehouse-adjust-quantity' }).props.onChange({ target: { value: '0.25' } }));
    await act(async () => f.tree.root.findByType('textarea').props.onChange({ target: { value: 'Tekshiruv' } }));
    assert.equal(button(f.tree, 'Faqat qoldiqni saqlash').props.disabled, true);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});
