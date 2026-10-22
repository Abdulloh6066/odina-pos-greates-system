// Actual supplier receipt UI with in-memory list reads and blocked mutation APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as retry from '../src/lib/order-request-retry.js';
import * as requisitionTools from '../src/lib/ingredient-requisitions.js';

const clone = value => structuredClone(value);
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node).trim() === label);
const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const enter = (node, value) => node.props.onChange({ target: { value } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

const ingredients = [
  { id: 'a', name: 'Slivka', active: true, purchase_unit: 'kg', base_unit: 'g' },
  { id: 'b', name: 'Inactive sugar', active: false, purchase_unit: 'kg', base_unit: 'g' },
  { id: 'c', name: 'Flour', active: true, purchase_unit: 'kg', base_unit: 'g' },
  { id: 'd', name: 'Unassigned box', active: true, purchase_unit: 'piece', base_unit: 'piece' },
];
const suppliers = [
  { id: 'dayim', name: 'Dayim', recipient_type: 'supplier', active: true, supplied_ingredient_ids: ['a', 'b'] },
  { id: 'other', name: 'Other supplier', recipient_type: 'company', active: true, supplied_ingredient_ids: ['c'] },
  { id: 'legacy', name: 'Unconfigured supplier', recipient_type: 'supplier', active: true },
  { id: 'empty', name: 'Empty supplier', recipient_type: 'supplier', active: true, supplied_ingredient_ids: [] },
  { id: 'inactive', name: 'Inactive supplier', recipient_type: 'supplier', active: false, supplied_ingredient_ids: ['a'] },
  { id: 'person', name: 'Person', recipient_type: 'person', active: true, supplied_ingredient_ids: ['a'] },
];

function receiptComponent(backend) {
  const module = { exports: {} };
  const require = name => {
    if (name === 'react') return { ...React, default: React };
    if (name === '@/api/base44Client') return { base44: backend };
    if (name === '@/lib/odina-dialog') return { odinaAlert: async () => {} };
    if (name === '@/lib/pos') return { formatUZS: value => `${value} UZS`, formatNum: String };
    if (name === '@/lib/uzbekistan-time') return { formatUzbekistanDateTime: () => '', uzbekistanDateKey: () => '2026-10-22', uzbekistanMonthStartKey: () => '2026-10-01' };
    if (name.endsWith('/odina-select')) return { default: wrapper('select') };
    if (name.endsWith('/SupplierProductsDialog')) return {
      default: props => React.createElement('supplier-products-dialog', props),
    };
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, exported) => exported === 'Dialog'
      ? ({ open, children, ...props }) => open ? React.createElement('dialog', props, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Textarea: 'textarea', Label: 'label' })[exported] || 'div') });
    throw Error('Unexpected receipt test dependency: ' + name);
  };
  const source = readFileSync('src/components/warehouse/SupplierLedgerPanel.jsx', 'utf8') + '\nexport { ReceiptDialog as TestReceiptDialog };';
  const result = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  }, reportDiagnostics: true });
  assert.equal(result.diagnostics?.length || 0, 0, 'Receipt dialog source compiles');
  vm.runInNewContext('(function(require,module,exports){' + result.outputText + '\n})', { console })(require, module, module.exports);
  return module.exports.TestReceiptDialog;
}

const supplierSelect = tree => tree.root.findAllByType('select')[0];
const ingredientSelects = tree => tree.root.findAllByType('select').slice(1);
const optionValues = node => node.findAllByType('option').map(option => option.props.value).filter(Boolean);
const quantities = tree => tree.root.findAllByType('input').filter(node => node.props.type === 'number' && node.props.placeholder === '0');
const unitPrices = tree => tree.root.findAllByType('input').filter(node => node.props.type === 'number' && node.props.placeholder === '0 UZS');
const submit = tree => button(tree, 'Kirim va qarzni yaratish');

async function fixture({ role = 'admin', rows = suppliers, read = null } = {}) {
  const listReads = [], mutations = [];
  let saved = 0, closed = 0;
  const backend = {
    entities: new Proxy({ CashRecipient: { async list(...args) {
      listReads.push(args);
      return read ? read(listReads.length, args) : clone(rows);
    } } }, { get(target, key) {
      if (key in target) return target[key];
      throw Error('Unexpected receipt entity: ' + String(key));
    } }),
    functions: { async invoke(...args) { mutations.push(clone(args)); throw Error('No receipt API invocation allowed in filtering tests'); } },
  };
  const Component = receiptComponent(backend);
  let props = { open: true, location: { id: 'warehouse', name: 'Production warehouse' }, ingredients: clone(ingredients), recipients: clone(rows),
    user: { id: role, role, active: true }, onClose() { closed += 1; }, onSaved() { saved += 1; } };
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  return {
    tree, listReads, mutations, saved: () => saved, closed: () => closed,
    choose: async id => act(async () => enter(supplierSelect(tree), id)),
    fill: async (id = 'a', quantity = '2', price = '15000') => {
      await act(async () => enter(ingredientSelects(tree)[0], id));
      await act(async () => { enter(quantities(tree)[0], quantity); enter(unitPrices(tree)[0], price); });
    },
    async update(next) { props = { ...props, ...next }; await act(async () => tree.update(React.createElement(Component, props))); },
    close: async () => act(async () => tree.unmount()),
  };
}

test('opening receipt loads persisted supplier settings but shows no ingredients before supplier selection', async () => {
  const f = await fixture();
  try {
    assert.equal(f.listReads.length, 1);
    assert.deepEqual(optionValues(supplierSelect(f.tree)), ['dayim', 'other', 'legacy', 'empty']);
    assert.equal(supplierSelect(f.tree).props.value, '');
    assert.equal(ingredientSelects(f.tree).length, 1);
    assert.deepEqual(optionValues(ingredientSelects(f.tree)[0]), []);
    assert.equal(ingredientSelects(f.tree)[0].props.disabled, true);
    assert.equal(submit(f.tree).props.disabled, true);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test('Dayim receipt offers only assigned active ingredients, excluding another supplier and inactive items', async () => {
  const f = await fixture();
  try {
    await f.choose('dayim');
    assert.deepEqual(optionValues(ingredientSelects(f.tree)[0]), ['a']);
    assert.equal(ingredientSelects(f.tree)[0].props.disabled, false);
    assert.equal(text(f.tree.toJSON()).includes('Inactive sugar'), false);
    assert.equal(text(f.tree.toJSON()).includes('Unassigned box'), false);
    await f.fill();
    assert.equal(submit(f.tree).props.disabled, false);
    assert.match(text(f.tree.toJSON()), /30000 UZS/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test('switching suppliers clears the old ingredient, quantity, price and computed debt', async () => {
  const f = await fixture();
  try {
    await f.choose('dayim');
    await f.fill();
    assert.equal(submit(f.tree).props.disabled, false);
    await f.choose('other');
    assert.equal(ingredientSelects(f.tree).length, 1);
    assert.deepEqual(optionValues(ingredientSelects(f.tree)[0]), ['c']);
    assert.equal(ingredientSelects(f.tree)[0].props.value, '');
    assert.equal(quantities(f.tree)[0].props.value, '');
    assert.equal(unitPrices(f.tree)[0].props.value, '');
    assert.equal(text(f.tree.toJSON()).includes('30000 UZS'), false);
    assert.match(text(f.tree.toJSON()), /0 UZS/);
    assert.equal(submit(f.tree).props.disabled, true);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test('missing and explicitly empty assignments both fail closed, including a stale ingredient callback', async () => {
  const f = await fixture();
  try {
    for (const supplierId of ['legacy', 'empty', '']) {
      await f.choose(supplierId);
      assert.deepEqual(optionValues(ingredientSelects(f.tree)[0]), []);
      assert.equal(ingredientSelects(f.tree)[0].props.disabled, true);
      assert.equal(submit(f.tree).props.disabled, true);
      await f.fill('a');
      assert.equal(submit(f.tree).props.disabled, true);
      await act(async () => submit(f.tree).props.onClick());
      assert.deepEqual(f.mutations, []);
      assert.equal(f.saved(), 0);
    }
  } finally { await f.close(); }
});

test('a manually supplied ingredient outside Dayim assignments cannot enable receipt submission', async () => {
  const f = await fixture();
  try {
    await f.choose('dayim');
    for (const ingredientId of ['b', 'c', 'd']) {
      await f.fill(ingredientId);
      assert.equal(submit(f.tree).props.disabled, true);
      await act(async () => submit(f.tree).props.onClick());
      assert.deepEqual(f.mutations, []);
    }
  } finally { await f.close(); }
});

test('only admin sees the assignment shortcut; a saved mapping refreshes available receipt ingredients', async () => {
  const f = await fixture();
  try {
    await f.choose('dayim');
    await f.fill();
    const shortcut = button(f.tree, 'Mahsulotlarni belgilash');
    assert.ok(shortcut);
    await act(async () => shortcut.props.onClick());
    const editor = f.tree.root.findByType('supplier-products-dialog');
    assert.equal(editor.props.supplier.id, 'dayim');
    assert.equal(editor.props.user.role, 'admin');
    await act(async () => editor.props.onSaved({ ...suppliers[0], supplied_ingredient_ids: ['c'] }));
    assert.deepEqual(optionValues(ingredientSelects(f.tree)[0]), ['c']);
    assert.equal(ingredientSelects(f.tree)[0].props.value, '');
    assert.equal(quantities(f.tree)[0].props.value, '');
    assert.equal(unitPrices(f.tree)[0].props.value, '');
    assert.equal(submit(f.tree).props.disabled, true);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
  for (const role of ['manager', 'accountant', 'warehouse']) {
    const worker = await fixture({ role });
    try {
      await worker.choose('dayim');
      assert.equal(button(worker.tree, 'Mahsulotlarni belgilash'), undefined);
      assert.deepEqual(worker.mutations, []);
    } finally { await worker.close(); }
  }
});

test('a delayed supplier settings read keeps receipt selection disabled until persisted data arrives', async () => {
  const pending = deferred();
  const f = await fixture({ read: () => pending.promise });
  try {
    assert.equal(supplierSelect(f.tree).props.disabled, true);
    assert.equal(submit(f.tree).props.disabled, true);
    await act(async () => { pending.resolve(clone(suppliers)); await pending.promise; });
    assert.equal(supplierSelect(f.tree).props.disabled, false);
    await f.choose('dayim');
    assert.deepEqual(optionValues(ingredientSelects(f.tree)[0]), ['a']);
    assert.deepEqual(f.mutations, []);
  } finally { pending.resolve([]); await f.close(); }
});

test('supplier settings load failure blocks receipt submission and retry restores the persisted assignments', async () => {
  const f = await fixture({ read: attempt => attempt === 1 ? Promise.reject(Error('Mock supplier read failed')) : clone(suppliers) });
  try {
    assert.match(text(f.tree.toJSON()), /Mock supplier read failed/);
    assert.equal(supplierSelect(f.tree).props.disabled, true);
    assert.equal(ingredientSelects(f.tree)[0].props.disabled, true);
    await f.choose('dayim');
    await f.fill();
    assert.equal(submit(f.tree).props.disabled, true);
    await act(async () => submit(f.tree).props.onClick());
    assert.deepEqual(f.mutations, []);
    await act(async () => button(f.tree, 'Qayta yuklash').props.onClick());
    assert.equal(f.listReads.length, 2);
    assert.equal(supplierSelect(f.tree).props.disabled, false);
    await f.choose('dayim');
    assert.deepEqual(optionValues(ingredientSelects(f.tree)[0]), ['a']);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

const requisitionItems = [
  { ingredient_id: 'a', ingredient_name: 'Slivka', purchase_unit: 'kg', base_unit: 'g', requested_quantity: 10, received_quantity: 2, remaining_quantity: 8 },
  { ingredient_id: 'b', ingredient_name: 'Inactive sugar', purchase_unit: 'kg', base_unit: 'g', requested_quantity: 10, received_quantity: 0, remaining_quantity: 10 },
  { ingredient_id: 'c', ingredient_name: 'Flour', purchase_unit: 'kg', base_unit: 'g', requested_quantity: 20, received_quantity: 5, remaining_quantity: 15 },
];
const request = {
  id: 'request-1', request_number: 'TALAB-MEMORY', location_id: 'warehouse', location_name: 'Production warehouse',
  source_kind: 'purchase', required_date: '2026-10-23', status: 'partial', created_by_name: 'Manager', version: 2,
  items: requisitionItems,
  history: [{ key: 'past-receipt', actor_name: 'Earlier worker', received_at: '2026-10-20T08:00:00Z',
    items: [{ ingredient_id: 'c', quantity: 5 }], total_amount: 15000 }],
};

function requisitionComponent(backend, memoryStorage) {
  const module = { exports: {} };
  const require = name => {
    if (name === 'react') return { ...React, default: React };
    if (name === '@/api/base44Client') return { base44: backend };
    if (name === '@/lib/odina-dialog') return { odinaConfirm: async () => false };
    if (name === '@/lib/pos') return { formatUZS: value => `${value} UZS` };
    if (name === '@/lib/uzbekistan-time') return { formatUzbekistanDateTime: String };
    if (name === '@/lib/ingredient-requisitions') return requisitionTools;
    if (name === '@/lib/order-request-retry') return { ...retry,
      readOrderRequest: scope => retry.readOrderRequest(scope, memoryStorage),
      retainOrderRequest: (scope, payload) => retry.retainOrderRequest(scope, payload, memoryStorage),
      clearOrderRequest: scope => retry.clearOrderRequest(scope, memoryStorage),
    };
    if (name === './IngredientRequisitionTicket') return { default: () => null, IngredientRequisitionTicketContent: wrapper('ticket-preview') };
    if (name === './SupplierProductsDialog') return { default: props => props.supplier ? React.createElement('supplier-products-dialog', props) : null };
    if (name.endsWith('/odina-select')) return { default: wrapper('select') };
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, exported) => exported === 'Dialog'
      ? ({ open, children, ...props }) => open ? React.createElement('dialog', props, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Textarea: 'textarea' })[exported] || 'div') });
    throw Error('Unexpected requisition test dependency: ' + name);
  };
  const result = ts.transpileModule(readFileSync('src/components/warehouse/IngredientRequisitionsPanel.jsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React }, reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.length || 0, 0, 'Actual requisition UI compiles');
  vm.runInNewContext('(function(require,module,exports){' + result.outputText + '\n})', {
    console, crypto: { randomUUID: () => 'offline-fixed-key' },
  })(require, module, module.exports);
  return module.exports.default;
}

async function requisitionFixture({ selectedRequest = request, frozenReceipt = null, supplierRows = suppliers } = {}) {
  const reads = [], mutations = [], stored = new Map();
  const storage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const scope = retry.orderRequestScope('admin', 'ingredient-requisition-receive', selectedRequest.id);
  if (frozenReceipt) storage.setItem(scope, JSON.stringify(frozenReceipt));
  const backend = { functions: { async invoke(name, payload) {
    if (payload.action === 'catalog') {
      reads.push(clone(payload));
      return { data: { ingredients: clone(ingredients.filter(item => item.active !== false).map(item => ({ ...item, ingredient_name: item.name }))),
        warehouses: [], suppliers: clone(supplierRows.filter(item => item.active !== false && ['supplier', 'company'].includes(item.recipient_type))),
        can_purchase_receive: true, can_transfer_receive: true, can_create: false } };
    }
    if (payload.action === 'list') { reads.push(clone(payload)); return { data: { requests: [clone(selectedRequest)], has_more: false } }; }
    mutations.push({ name, payload: clone(payload) });
    throw Error('Mock lost reply; no remote operation exists');
  } } };
  const Component = requisitionComponent(backend, storage);
  let tree; await act(async () => { tree = create(React.createElement(Component, {
    user: { id: 'admin', role: 'admin' }, location: { id: 'warehouse', name: 'Production warehouse' },
  })); });
  await act(async () => button(tree, 'Ochish / Qabul qilish').props.onClick());
  return { tree, reads, mutations, storage, scope,
    choose: async id => act(async () => tree.root.findByProps({ 'aria-label': 'Yetkazib beruvchi' }).props.onChange({ target: { value: id } })),
    close: async () => act(async () => tree.unmount()) };
}
const requestTableNames = tree => tree.root.findByType('dialog').findAllByType('tbody')[0].findAllByType('tr')
  .map(row => text(row.findAllByType('td')[0]).replace(/kg$/, ''));

test('new requisition receipt narrows only editable rows, excludes inactive items, and clears prior values on supplier switch', async () => {
  const f = await requisitionFixture();
  try {
    assert.deepEqual(requestTableNames(f.tree), ['Slivka', 'Inactive sugar', 'Flour']);
    assert.equal(f.tree.root.findByProps({ 'aria-label': 'Slivka: kelgan miqdor' }).props.disabled, true);
    await f.choose('dayim');
    assert.deepEqual(requestTableNames(f.tree), ['Slivka']);
    assert.match(text(f.tree.root.findByType('dialog')), /Flour 5 kg/);
    await act(async () => {
      enter(f.tree.root.findByProps({ 'aria-label': 'Slivka: kelgan miqdor' }), '2');
      enter(f.tree.root.findByProps({ 'aria-label': 'Slivka: birlik narxi' }), '1000');
      f.tree.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } });
    });
    assert.equal(button(f.tree, 'Tekshirildi — kirim qilish').props.disabled, false);
    assert.match(text(f.tree.root.findByType('dialog')), /2000 UZS/);
    await f.choose('other');
    assert.deepEqual(requestTableNames(f.tree), ['Flour']);
    assert.equal(f.tree.root.findByProps({ 'aria-label': 'Flour: kelgan miqdor' }).props.value, '');
    assert.equal(f.tree.root.findByProps({ 'aria-label': 'Flour: birlik narxi' }).props.value, '');
    assert.equal(f.tree.root.findByProps({ type: 'checkbox' }).props.checked, false);
    assert.equal(button(f.tree, 'Tekshirildi — kirim qilish').props.disabled, true);
    assert.equal(text(f.tree.root.findByType('dialog')).includes('2000 UZS'), false);
    assert.match(text(f.tree.root.findByType('dialog')), /Flour 5 kg/);
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test('unset and explicitly empty suppliers cannot receive any new requisition items', async () => {
  const f = await requisitionFixture();
  try {
    for (const id of ['legacy', 'empty']) {
      await f.choose(id);
      assert.deepEqual(requestTableNames(f.tree), []);
      assert.equal(button(f.tree, 'Hammasi so‘ralgandek keldi').props.disabled, true);
      assert.equal(button(f.tree, 'Tekshirildi — kirim qilish').props.disabled, true);
      assert.match(text(f.tree.root.findByType('dialog')), /Flour 5 kg/);
    }
    assert.deepEqual(f.mutations, []);
  } finally { await f.close(); }
});

test('completed requisition history and warehouse-transfer rows remain unchanged by supplier assignments', async () => {
  for (const selectedRequest of [{ ...request, status: 'received' }, { ...request, source_kind: 'warehouse', source_location_name: 'Central', approved_by: 'owner', approved_by_name: 'Owner' }]) {
    const f = await requisitionFixture({ selectedRequest });
    try {
      assert.deepEqual(requestTableNames(f.tree), ['Slivka', 'Inactive sugar', 'Flour']);
      assert.match(text(f.tree.root.findByType('dialog')), /Flour 5 kg/);
      assert.equal(f.tree.root.findAllByProps({ 'aria-label': 'Yetkazib beruvchi' }).length, 0);
      if (selectedRequest.status === 'received') {
        assert.equal(f.tree.root.findAllByProps({ 'aria-label': 'Slivka: kelgan miqdor' }).length, 0);
        assert.equal(button(f.tree, 'Tekshirildi — kirim qilish'), undefined);
      } else {
        assert.equal(f.tree.root.findByProps({ 'aria-label': 'Slivka: kelgan miqdor' }).props.disabled, false);
      }
      assert.deepEqual(f.mutations, []);
    } finally { await f.close(); }
  }
});

test('a frozen receipt keeps its original rows and exact retry payload after assignments are removed', async () => {
  const frozen = { action: 'receive', request_id: request.id, idempotency_key: 'frozen-receipt-key', expected_version: 2,
    verified: true, supplier_id: 'other', payment_state: 'unpaid', invoice_reference: 'OLD-INVOICE',
    items: [{ ingredient_id: 'c', quantity: '3', unit_price: '1000' }] };
  const f = await requisitionFixture({ frozenReceipt: frozen, supplierRows: suppliers.map(supplier => ({ ...supplier, supplied_ingredient_ids: [] })) });
  try {
    assert.deepEqual(requestTableNames(f.tree), ['Slivka', 'Inactive sugar', 'Flour']);
    assert.equal(f.tree.root.findByProps({ 'aria-label': 'Flour: kelgan miqdor' }).props.value, '3');
    assert.equal(f.tree.root.findByProps({ 'aria-label': 'Flour: kelgan miqdor' }).props.disabled, true);
    assert.equal(button(f.tree, 'Qabulni qayta tekshirish').props.disabled, false);
    await act(async () => button(f.tree, 'Qabulni qayta tekshirish').props.onClick());
    assert.deepEqual(f.mutations, [{ name: 'ingredient-request', payload: frozen }]);
    assert.deepEqual(retry.readOrderRequest(f.scope, f.storage), frozen);
    assert.match(text(f.tree.root.findByType('dialog')), /Flour 5 kg/);
  } finally { await f.close(); }
});
