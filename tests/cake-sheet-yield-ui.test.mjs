// Actual React components with fixed in-memory SDK doubles. No app/API requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node.props.children).trim() === label);
const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function component(file, dependencies = {}, append = '') {
  const result = ts.transpileModule(readFileSync(file, 'utf8') + '\n' + append, {
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
    if (name === '@/lib/pos') return { formatUZS: String, formatNum: String, logAction() {} };
    if (name === '@/lib/shop-pricing') return { priceForShop: product => product.price };
    if (name === '@/lib/shop-category') return { categoryForShop: product => product.category_id, catalogForShop: products => products };
    if (name === '@/lib/cake-stock-shelf') return { loadAllInventoryItems: async entity => entity.list('name', 500, 0) };
    if (name === '@/lib/product-photos') return { productPhotoFallbackFor: () => null };
    if (name === 'react-router-dom') return { useOutletContext: () => ({ user: { role: 'admin' } }) };
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, exported) => exported === 'Dialog'
      ? ({ open, children, ...props }) => open ? React.createElement('dialog', props, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Label: 'label', Textarea: 'textarea', Image: 'img' })[exported] || 'div') });
    if (name.startsWith('@/components/')) return { default: wrapper('div') };
    throw Error('Unexpected dependency: ' + name);
  };
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + result.outputText + '\n})', {
    console, setTimeout, clearTimeout, structuredClone, AbortController,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {} },
  })(require, module, module.exports);
  return module.exports;
}

const categories = [{ id: 'cakes', name: 'Tortlar' }];
const admin = { id: 'owner', role: 'admin', full_name: 'Owner' };
const initialProducts = [
  { id: 'piece-a', name: 'Napoleon', category_id: 'cakes', category_name: 'Tortlar',
    active: true, track_stock: true, production_unit: 'piece', stock_unit: 'piece', sale_unit: 'piece', pieces_per_sheet: 1, price: 18000 },
  { id: 'piece-b', name: 'Medovik', category_id: 'cakes', category_name: 'Tortlar',
    active: true, track_stock: true, production_unit: 'piece', stock_unit: 'piece', sale_unit: 'piece', pieces_per_sheet: 1, price: 20000 },
  { id: 'sheet', name: 'Listli cake', category_id: 'cakes', category_name: 'Tortlar',
    active: true, track_stock: true, production_unit: 'sheet', stock_unit: 'piece', sale_unit: 'piece', pieces_per_sheet: 20, sheet_price: 300000, price: 15000 },
];

function labelledInput(tree, labelText) {
  const label = tree.root.findAllByType('label').find(node => text(node.props.children).trim() === labelText);
  assert.ok(label, 'Field label exists: ' + labelText);
  let field = label.parent;
  while (field && !field.findAllByType('input').length) field = field.parent;
  const input = field?.findAllByType('input')[0];
  assert.ok(input, 'Field input exists: ' + labelText);
  return input;
}

async function productDialogFixture(product = null) {
  const writes = [], alerts = []; let saved = 0;
  const ProductDialog = component('src/pages/Products.jsx', {
    '@/api/base44Client': { base44: { entities: { Product: {
      update: async (id, payload) => { writes.push({ action: 'update', id, payload: clone(payload) }); return { ...product, ...payload }; },
      create: async payload => { writes.push({ action: 'create', payload: clone(payload) }); return { id: 'new-product', ...payload }; },
    } } } },
    '@/lib/odina-dialog': { odinaAlert: async message => { alerts.push(message); }, odinaConfirm: async () => false },
  }, 'export { ProductDialog as TestProductDialog };').TestProductDialog;
  let tree;
  await act(async () => { tree = create(React.createElement(ProductDialog, {
    open: true, product, categories, shops: [], onClose() {}, onSaved() { saved += 1; }, user: admin, canArchive: true,
  })); });
  return { tree, writes, alerts, saved: () => saved, close: async () => act(async () => tree.unmount()) };
}

test('saving an existing piece product preserves its warehouse sheet factor', async () => {
  const f = await productDialogFixture({ ...initialProducts[0], pieces_per_sheet: 10 });
  try {
    await act(async () => labelledInput(f.tree, 'Nomi').props.onChange({ target: { value: 'Napoleon renamed' } }));
    await act(async () => button(f.tree, 'Saqlash').props.onClick());
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].action, 'update');
    assert.equal(f.writes[0].id, 'piece-a');
    assert.equal(f.writes[0].payload.name, 'Napoleon renamed');
    assert.equal(Object.hasOwn(f.writes[0].payload, 'pieces_per_sheet'), false);
    assert.equal(f.saved(), 1);
    assert.deepEqual(f.alerts, []);
  } finally { await f.close(); }
});

test('new piece product starts at factor one; new sheet product stores its entered cut count', async () => {
  for (const productionUnit of ['piece', 'sheet']) {
    const f = await productDialogFixture();
    try {
      await act(async () => labelledInput(f.tree, 'Nomi').props.onChange({ target: { value: 'New cake' } }));
      await act(async () => f.tree.root.findByProps({ placeholder: '45000' }).props.onChange({ target: { value: '18000' } }));
      if (productionUnit === 'sheet') {
        const typeSelect = f.tree.root.findAllByType('select').find(node => node.findAllByType('option').some(option => option.props.value === 'gram'));
        await act(async () => typeSelect.props.onChange({ target: { value: 'sheet' } }));
        await act(async () => labelledInput(f.tree, '1 listdan bo‘lak soni').props.onChange({ target: { value: '12' } }));
        await act(async () => labelledInput(f.tree, '1 list narxi (UZS)').props.onChange({ target: { value: '216000' } }));
      }
      await act(async () => button(f.tree, 'Saqlash').props.onClick());
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0].action, 'create');
      assert.equal(f.writes[0].payload.production_unit, productionUnit);
      assert.equal(f.writes[0].payload.pieces_per_sheet, productionUnit === 'sheet' ? 12 : 1);
      assert.equal(f.saved(), 1);
    } finally { await f.close(); }
  }
});

const actualYieldHelper = component('src/lib/cake-sheet-yield.js');
const yieldInput = (tree, name) => tree.root.findByProps({ 'aria-label': `${name}: 1 listdan bo‘lak soni` });
const yieldRow = (tree, name) => tree.root.findAllByType('section').find(node => node.props['aria-label'] === name);
const rowSave = (tree, name) => yieldRow(tree, name)?.findAllByType('button').find(node => text(node.props.children).trim() === 'Bo‘lak sonini saqlash');

async function yieldFixture({ role = 'admin', products = initialProducts, updateGate = null } = {}) {
  const records = new Map(products.map(product => [product.id, clone(product)]));
  const writes = [], reads = [], confirmations = [], notifications = [];
  let closed = 0, confirmAnswer = false, tree, props;
  const entity = {
    async updateMany(filter, payload) {
      writes.push({ filter: clone(filter), payload: clone(payload) });
      if (updateGate) await updateGate.promise;
      const stored = records.get(filter.id);
      assert.ok(stored, 'Only an existing fixture product may be updated');
      records.set(filter.id, { ...stored, ...clone(payload.$set) });
      return { success: true, updated: 1 };
    },
    async get(id) { reads.push(id); return clone(records.get(id)); },
  };
  const entities = new Proxy({ Product: entity }, { get(target, name) {
    if (name in target) return target[name];
    throw Error('Unexpected business entity request: ' + String(name));
  } });
  const YieldDialog = component('src/components/warehouse/CakeSheetYieldDialog.jsx', {
    '@/api/base44Client': { base44: { entities, functions: { invoke() { throw Error('No backend calls in visual settings tests'); } } } },
    '@/lib/cake-sheet-yield': actualYieldHelper,
    '@/lib/odina-dialog': { odinaConfirm: async (...args) => { confirmations.push(clone(args)); return confirmAnswer; } },
  }).default;
  props = { products: clone(products), user: { ...admin, role }, onClose() { closed += 1; },
    onProductUpdated(updated) {
      notifications.push(clone(updated));
      // Reproduce the parent list refresh: replace all product object identities.
      props = { ...props, products: props.products.map(product => product.id === updated.id ? clone(updated) : { ...product }) };
      tree.update(React.createElement(YieldDialog, props));
    } };
  const mount = async () => act(async () => { tree = create(React.createElement(YieldDialog, props)); });
  await mount();
  return {
    get tree() { return tree; }, records, writes, reads, confirmations, notifications,
    closed: () => closed, setConfirm: value => { confirmAnswer = value; },
    async edit(name, value) { await act(async () => yieldInput(tree, name).props.onChange({ target: { value } })); },
    async search(value) { await act(async () => tree.root.findByProps({ id: 'cake-sheet-yield-search' }).props.onChange({ target: { value } })); },
    async reopen() {
      await act(async () => tree.unmount());
      props = { ...props, products: [...records.values()].map(clone) };
      await mount();
    },
    async close() { await act(async () => tree.unmount()); },
  };
}

test('opening, searching, and closing unchanged settings never read or mutate business data', async () => {
  const f = await yieldFixture({ products: [...initialProducts,
    { ...initialProducts[0], id: 'hidden', name: 'Inactive cake', active: false },
    { ...initialProducts[0], id: 'weighted', name: 'Weighted cake', sale_unit: 'gram' },
  ] });
  try {
    assert.equal(f.tree.root.findAllByType('section').length, 3);
    assert.equal(text(f.tree.toJSON()).includes('Inactive cake'), false);
    assert.equal(text(f.tree.toJSON()).includes('Weighted cake'), false);
    await f.search('NAP');
    assert.equal(f.tree.root.findAllByType('section').length, 1);
    assert.ok(yieldRow(f.tree, 'Napoleon'));
    await f.search('does not exist');
    assert.match(text(f.tree.toJSON()), /mos tort topilmadi/);
    await f.search('');
    await act(async () => button(f.tree, 'Yopish').props.onClick());
    assert.equal(f.closed(), 1);
    assert.deepEqual(f.confirmations, []);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('sheet products and unauthorized workers stay read-only without business writes', async () => {
  for (const role of ['admin', 'cashier', 'production', 'manager']) {
    const f = await yieldFixture({ role });
    try {
      assert.equal(yieldInput(f.tree, 'Listli cake').props.disabled, true);
      assert.equal(rowSave(f.tree, 'Listli cake'), undefined);
      if (role !== 'admin') {
        assert.equal(yieldInput(f.tree, 'Napoleon').props.disabled, true);
        assert.equal(rowSave(f.tree, 'Napoleon').props.disabled, true);
        // A stale/programmatic callback also cannot bypass the role guard.
        await f.edit('Napoleon', '10');
        await act(async () => rowSave(f.tree, 'Napoleon').props.onClick());
      }
      assert.deepEqual(f.reads, []);
      assert.deepEqual(f.writes, []);
    } finally { await f.close(); }
  }
});

test('saving 1 to 10 writes only ratio metadata, verifies readback, and survives reopening', async () => {
  const f = await yieldFixture();
  try {
    const before = clone(f.records.get('piece-a'));
    await f.edit('Napoleon', '10');
    assert.equal(rowSave(f.tree, 'Napoleon').props.disabled, false);
    await act(async () => rowSave(f.tree, 'Napoleon').props.onClick());
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].payload, { $set: { pieces_per_sheet: 10 } });
    assert.equal(f.writes[0].filter.id, 'piece-a');
    assert.equal(f.writes[0].filter.pieces_per_sheet, 1);
    assert.equal(f.writes[0].filter.production_unit, 'piece');
    assert.deepEqual(f.records.get('piece-a'), { ...before, pieces_per_sheet: 10 });
    assert.deepEqual(f.records.get('piece-b'), initialProducts[1]);
    assert.deepEqual(f.records.get('sheet'), initialProducts[2]);
    assert.deepEqual(f.reads, ['piece-a']);
    assert.equal(f.notifications.length, 1);
    assert.match(text(f.tree.root.findByProps({ role: 'status' })), /Saqlandi/);
    assert.equal(yieldInput(f.tree, 'Napoleon').props.value, '10');
    assert.equal(rowSave(f.tree, 'Napoleon').props.disabled, true);
    await f.reopen();
    assert.equal(yieldInput(f.tree, 'Napoleon').props.value, '10');
    assert.equal(f.writes.length, 1);
    assert.match(text(yieldRow(f.tree, 'Napoleon')), /Saqlangan qiymat: 10 bo‘lak/);
  } finally { await f.close(); }
});

test('another unsaved ratio survives the parent product refresh after a row save', async () => {
  const f = await yieldFixture();
  try {
    await f.edit('Medovik', '12');
    await f.edit('Napoleon', '10');
    await act(async () => rowSave(f.tree, 'Napoleon').props.onClick());
    assert.equal(f.notifications.length, 1);
    assert.equal(yieldInput(f.tree, 'Medovik').props.value, '12');
    assert.equal(rowSave(f.tree, 'Medovik').props.disabled, false);
    assert.match(text(f.tree.toJSON()), /Saqlanmagan: 1 ta/);
    assert.equal(f.records.get('piece-b').pieces_per_sheet, 1);
    assert.deepEqual(f.writes.map(row => row.filter.id), ['piece-a']);
  } finally { await f.close(); }
});

test('blank, fractional, negative and unsafe counts cannot save', async () => {
  const f = await yieldFixture();
  try {
    for (const value of ['', '0', '-1', '1.5', '1e2', '9007199254740992']) {
      await f.edit('Napoleon', value);
      assert.equal(rowSave(f.tree, 'Napoleon').props.disabled, true, value + ' is blocked');
      assert.equal(yieldInput(f.tree, 'Napoleon').props['aria-invalid'], true);
      // Rejected by actual helper too, even if a disabled callback were invoked.
      await act(async () => rowSave(f.tree, 'Napoleon').props.onClick());
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.reads, []);
      assert.equal(f.notifications.length, 0);
    }
  } finally { await f.close(); }
});

test('saving blocks duplicate submission and both close paths until verified', async () => {
  const updateGate = deferred();
  const f = await yieldFixture({ updateGate });
  try {
    await f.edit('Napoleon', '10');
    const save = rowSave(f.tree, 'Napoleon').props.onClick;
    await act(async () => { save(); });
    assert.equal(f.writes.length, 1);
    assert.equal(button(f.tree, 'Yopish').props.disabled, true);
    assert.equal(yieldInput(f.tree, 'Medovik').props.disabled, true);
    await act(async () => { save(); button(f.tree, 'Yopish').props.onClick(); f.tree.root.findByType('dialog').props.onOpenChange(false); });
    assert.equal(f.closed(), 0);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.confirmations, []);
    await act(async () => { updateGate.resolve(); await updateGate.promise; });
    assert.deepEqual(f.reads, ['piece-a']);
    assert.equal(button(f.tree, 'Yopish').props.disabled, false);
    await act(async () => button(f.tree, 'Yopish').props.onClick());
    assert.equal(f.closed(), 1);
  } finally { updateGate.resolve(); await f.close(); }
});

test('cancelling dirty-close confirmation preserves drafts and never writes them', async () => {
  const f = await yieldFixture();
  try {
    await f.edit('Napoleon', '10');
    f.setConfirm(false);
    await act(async () => f.tree.root.findByType('dialog').props.onOpenChange(false));
    assert.equal(f.confirmations.length, 1);
    assert.equal(f.closed(), 0);
    assert.equal(yieldInput(f.tree, 'Napoleon').props.value, '10');
    f.setConfirm(true);
    await act(async () => button(f.tree, 'Yopish').props.onClick());
    assert.equal(f.confirmations.length, 2);
    assert.equal(f.closed(), 1);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.reads, []);
    assert.equal(f.records.get('piece-a').pieces_per_sheet, 1);
  } finally { await f.close(); }
});
