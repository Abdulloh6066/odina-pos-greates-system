// Render actual JSX with mocked SDK/storage only. No production service is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as retry from '../src/lib/order-request-retry.js';
import * as dates from '../src/lib/uzbekistan-time.js';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node) === label);
const enter = (tree, id, value) => tree.root.findByProps({ id }).props.onChange({ target: { value } });
function component(path, backend, storage, context) {
  const module = { exports: {} };
  const require = name => {
    if (name === 'react') return { ...React, default: React };
    if (name === '@/api/base44Client') return { base44: backend };
    if (name === '@/lib/pos') return { formatUZS: value => `${value} UZS`, formatNum: String };
    if (name === '@/lib/uzbekistan-time') return dates;
    if (name === '@/lib/orders') return { buildIdempotencyKey: () => 'offline-test-key' };
    if (name === '@/lib/order-request-retry') return { ...retry,
      readOrderRequest: scope => retry.readOrderRequest(scope, storage),
      retainOrderRequest: (scope, payload) => retry.retainOrderRequest(scope, payload, storage),
      clearOrderRequest: scope => retry.clearOrderRequest(scope, storage),
    };
    if (name === 'react-router-dom') return { useOutletContext: () => context.current, Navigate: () => null };
    if (name === '@/lib/odina-dialog') return { odinaAlert: async () => {} };
    if (name.endsWith('/odina-select')) return { default: wrapper('select') };
    if (name.endsWith('/PageHeader')) return { default: wrapper('header') };
    if (name.endsWith('/OpeningDebtPaymentDialog')) return { OpeningDebtPaymentButton: () => null, hasPendingOpeningDebtPayment: () => false };
    if (name.endsWith('/OpeningDebtDialog') || name.endsWith('/SupplierProductsDialog')) return { default: () => null };
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, exported) => exported === 'Dialog'
      ? ({ open, children, ...props }) => open ? React.createElement('dialog', props, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Textarea: 'textarea', Label: 'label' })[exported] || 'div') });
    throw Error(`Unexpected import: ${name}`);
  };
  const result = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  }, reportDiagnostics: true });
  assert.equal(result.diagnostics?.length || 0, 0);
  vm.runInNewContext('(function(require,module,exports){' + result.outputText + '\n})', { console })(require, module, module.exports);
  return module.exports.default;
}
const opening = { id: 'opening-test', supplier_id: 'supplier-test', supplier_name_snapshot: 'Mock supplier',
  debt_amount: 120, remaining_debt: 80, status: 'partial', effective_date: '2020-01-01', created_at: '2026-10-01T01:00:00Z', notes: 'Old carried debt' };
const receipt = { id: 'receipt-test', supplier_id: 'supplier-test', supplier_name_snapshot: 'Mock supplier',
  total_amount: 200, debt_amount: 200, remaining_debt: 150, status: 'partial', location_id: 'shop-test',
  received_at: new Date().toISOString(), receipt_number: 'MOCK-RECEIPT' };
const payment = { id: 'payment-test', opening_debt_id: opening.id, supplier_id: opening.supplier_id,
  supplier_name_snapshot: opening.supplier_name_snapshot, payment_number: 'MOCK-OPENING-PAYMENT', amount: 40, paid_at: '2026-10-01T01:00:00Z' };
const summaries = tree => tree.root.findAll(node => typeof node.type === 'function' && node.type.name === 'Summary');
const summary = (tree, label) => summaries(tree).find(node => node.props.label === label)?.props.value;
const select = (tree, index, value) => tree.root.findAllByType('select')[index].props.onChange({ target: { value } });
async function fixture({ receipts = [], debts = [opening], openingRead, props: overrides = {} } = {}) {
  const calls = [];
  const backend = { entities: {
    SupplierReceipt: { list: async (_sort, limit, skip = 0) => structuredClone(receipts.slice(skip, skip + limit)) },
    SupplierReceiptItem: { list: async () => [] },
    SupplierPayment: { list: async () => [structuredClone(payment)] },
  }, functions: { invoke: async (name, payload) => {
    calls.push({ name, payload });
    assert.equal(payload.action, 'list_opening_debts');
    return openingRead ? openingRead(calls.length) : { data: { opening_debts: structuredClone(debts), payments: [structuredClone(payment)] } };
  } } };
  const Component = component('src/components/warehouse/SupplierLedgerPanel.jsx', backend, {});
  let props = { user: { id: 'admin-test', role: 'admin' }, allLocations: true, readOnly: true, location: null, recipients: [], ingredients: [], ...overrides };
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  return { tree, calls,
    async update(next) { props = { ...props, ...next }; await act(async () => tree.update(React.createElement(Component, props))); },
    async close() { await act(async () => tree.unmount()); },
  };
}

test('global opening-only balance is nonzero, carried beyond purchase dates, and never a purchase', async () => {
  const f = await fixture();
  try {
    assert.equal(summary(f.tree, 'Qolgan qarz'), '80 UZS'); assert.equal(summary(f.tree, 'Jami faol kirim'), '0 UZS');
    assert.equal(summary(f.tree, 'To‘langan'), '40 UZS');
    assert.match(text(f.tree.toJSON()), /2020-01-01/); assert.match(text(f.tree.toJSON()), /Sana filtri faqat kirimlarga/);
    assert.equal(button(f.tree, 'Yangi kirim'), undefined);
    const inputs = f.tree.root.findAllByType('input');
    await act(async () => { inputs[0].props.onChange({ target: { value: '2025-01-01' } }); inputs[1].props.onChange({ target: { value: '2025-02-01' } }); });
    assert.equal(summary(f.tree, 'Qolgan qarz'), '80 UZS');
  } finally { await f.close(); }
});

test('mixed totals include opening debt once, preserve purchases and disjoint payment history', async () => {
  const f = await fixture({ receipts: [receipt], debts: [opening, opening] });
  try {
    assert.equal(summary(f.tree, 'Qolgan qarz'), '230 UZS');
    assert.equal(summary(f.tree, 'Jami faol kirim'), '200 UZS');
    assert.equal(summary(f.tree, 'To‘langan'), '90 UZS');
    assert.equal((text(f.tree.toJSON()).match(/MOCK-OPENING-PAYMENT/g) || []).length, 1);
    const supplier = f.tree.root.findAllByType('button').find(node => text(node).includes('Mock supplier') && text(node).includes('ta kirim'));
    await act(async () => supplier.props.onClick());
    const detail = f.tree.root.findByType('dialog');
    assert.match(text(detail), /Boshlang‘ich qarz tarixi|Boshlang‘ich qarzlar/);
    assert.match(text(detail), /Old carried debt/); assert.match(text(detail), /230 UZS/);
    assert.equal((text(detail).match(/MOCK-OPENING-PAYMENT/g) || []).length, 1);
  } finally { await f.close(); }
});

test('opening-only supplier has a working detail history without a synthetic receipt', async () => {
  const f = await fixture();
  try {
    const supplier = f.tree.root.findAllByType('button').find(node => text(node).includes('Mock supplier'));
    await act(async () => supplier.props.onClick());
    const detail = f.tree.root.findByType('dialog');
    assert.match(text(detail), /80 UZS/); assert.match(text(detail), /MOCK-OPENING-PAYMENT/);
    assert.equal(detail.findAllByType('button').length, 1);
  } finally { await f.close(); }
});

test('supplier, search and status filters apply to opening balances coherently', async () => {
  const f = await fixture({ debts: [opening, { ...opening, id: 'other', supplier_id: 'other', supplier_name_snapshot: 'Other', remaining_debt: 0, status: 'paid' }] });
  try {
    await act(async () => select(f.tree, 0, 'other')); assert.equal(summary(f.tree, 'Qolgan qarz'), '0 UZS');
    await act(async () => select(f.tree, 0, 'all'));
    await act(async () => select(f.tree, 1, 'cancelled')); assert.equal(summary(f.tree, 'Qolgan qarz'), '0 UZS');
    assert.doesNotMatch(text(f.tree.toJSON()), /Old carried debt/);
    await act(async () => select(f.tree, 1, 'debt')); assert.equal(summary(f.tree, 'Qolgan qarz'), '80 UZS');
    await f.update({ search: 'missing' }); assert.equal(summary(f.tree, 'Qolgan qarz'), '0 UZS');
    await f.update({ search: 'Old carried' }); assert.equal(summary(f.tree, 'Qolgan qarz'), '80 UZS');
  } finally { await f.close(); }
});

test('specific shop excludes unassigned debt and nonadmin never requests opening debts', async () => {
  for (const props of [{ allLocations: false, location: { id: 'shop-test' } }, { user: { id: 'manager', role: 'manager' }, location: { id: 'shop-test' } }]) {
    const f = await fixture({ props, receipts: [receipt] });
    try {
      assert.equal(f.calls.length, props.user ? 0 : 1);
      if (!props.user) assert.equal(f.calls[0].payload.location_id, 'shop-test');
      assert.equal(summary(f.tree, 'Qolgan qarz'), '150 UZS');
      assert.doesNotMatch(text(f.tree.toJSON()), /Old carried debt|MOCK-OPENING-PAYMENT/);
    } finally { await f.close(); }
  }
});

test('late global response cannot expose opening debt after scope/user change', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = await fixture({ openingRead: () => pending });
  try {
    await f.update({ user: { id: 'manager', role: 'manager' }, location: { id: 'shop-test' }, allLocations: false });
    await act(async () => { resolve({ data: { opening_debts: [opening], payments: [payment] } }); await pending; });
    assert.doesNotMatch(text(f.tree.toJSON()), /Old carried debt|MOCK-OPENING-PAYMENT/);
    assert.equal(summary(f.tree, 'Qolgan qarz'), '0 UZS');
  } finally { await f.close(); }
});

test('failed opening load never silently displays a zero total and can retry', async () => {
  const f = await fixture({ openingRead: attempt => { if (attempt === 1) throw Error('Mock opening failure'); return { data: { opening_debts: [opening], payments: [] } }; } });
  try {
    assert.equal(summary(f.tree, 'Qolgan qarz'), undefined);
    assert.match(text(f.tree.toJSON()), /Jami qarz hisoblanmadi.*Mock opening failure/);
    await act(async () => button(f.tree, 'Qayta yuklash').props.onClick());
    assert.equal(summary(f.tree, 'Qolgan qarz'), '80 UZS');
  } finally { await f.close(); }
});

test('all-shops receipt details offer no cancellation or creation even if readOnly is omitted', async () => {
  const f = await fixture({ receipts: [{ ...receipt, status: 'unpaid', remaining_debt: 200 }], props: { readOnly: false } });
  try {
    const details = f.tree.root.findAllByType('button').find(node => text(node).includes('Batafsil'));
    await act(async () => details.props.onClick());
    assert.doesNotMatch(text(f.tree.root.findByType('dialog')), /Bekor qilish/);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});


test('global purchase history paginates past 500 without losing purchases or doubling opening debt', async () => {
  const receipts = Array.from({ length: 501 }, (_, index) => ({ ...receipt, id: `receipt-${index}` }));
  const f = await fixture({ receipts });
  try {
    assert.equal(summary(f.tree, 'Jami faol kirim'), `${501 * 200} UZS`);
    assert.equal(summary(f.tree, 'Qolgan qarz'), `${501 * 150 + 80} UZS`);
  } finally { await f.close(); }
});


test('assigned opening debt appears only in its admin location and is counted once globally', async () => {
  const allocated = { ...opening, location_id: 'shop-test', location_name_snapshot: 'Mock warehouse' };
  const f = await fixture({ debts: [allocated, { ...opening, id: 'unassigned', remaining_debt: 25 }, { ...allocated, id: 'elsewhere', location_id: 'other-shop', remaining_debt: 35 }], receipts: [receipt], props: { allLocations: false, location: { id: 'shop-test' } } });
  try {
    assert.equal(f.calls[0].payload.location_id, 'shop-test');
    assert.equal(summary(f.tree, 'Qolgan qarz'), '230 UZS');
    assert.equal(summary(f.tree, 'Jami faol kirim'), '200 UZS');
    assert.match(text(f.tree.toJSON()), /Mock warehouse/);
    await f.update({ allLocations: true, location: null });
    assert.equal(f.calls.at(-1).payload.location_id, undefined);
    assert.equal(summary(f.tree, 'Qolgan qarz'), '290 UZS');
    await f.update({ allLocations: false, location: { id: 'no-debt-shop' } });
    assert.equal(summary(f.tree, 'Qolgan qarz'), '0 UZS');
    assert.doesNotMatch(text(f.tree.toJSON()), /MOCK-OPENING-PAYMENT/);
  } finally { await f.close(); }
});

test('late location response cannot replace the new warehouse opening balance', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = await fixture({ props: { allLocations: false, location: { id: 'shop-test' } }, openingRead: attempt => attempt === 1 ? pending : { data: { opening_debts: [{ ...opening, location_id: 'next-shop', remaining_debt: 35 }], payments: [] } } });
  try {
    await f.update({ location: { id: 'next-shop' } });
    assert.equal(summary(f.tree, 'Qolgan qarz'), '35 UZS');
    await act(async () => { resolve({ data: { opening_debts: [{ ...opening, location_id: 'shop-test' }], payments: [payment] } }); await pending; });
    assert.equal(summary(f.tree, 'Qolgan qarz'), '35 UZS');
    assert.doesNotMatch(text(f.tree.toJSON()), /MOCK-OPENING-PAYMENT/);
  } finally { await f.close(); }
});

test('corrected opening principal never becomes a fake payment in global or warehouse totals', async () => {
  const debt = { ...opening, debt_amount: 120, corrected_debt_amount: 80, remaining_debt: 80, status: 'unpaid',
    location_id: 'shop-test', amount_correction_reason: 'Mock typo', amount_corrected_at: '2026-11-01T00:00:00Z', amount_corrected_by_name: 'Mock admin' };
  const f = await fixture({ openingRead: () => ({ data: { opening_debts: [debt], payments: [] } }) });
  try {
    for (const props of [{ allLocations: true, location: null }, { allLocations: false, location: { id: 'shop-test' } }]) {
      await f.update(props);
      assert.equal(summary(f.tree, 'Qolgan qarz'), '80 UZS'); assert.equal(summary(f.tree, 'To‘langan'), '0 UZS');
      assert.equal(summary(f.tree, 'Jami faol kirim'), '0 UZS');
      assert.match(text(f.tree.toJSON()), /Dastlabki summa: 120 UZS/); assert.match(text(f.tree.toJSON()), /Mock typo/);
      const supplier = f.tree.root.findAllByType('button').find(node => text(node).includes('Mock supplier'));
      await act(async () => supplier.props.onClick());
      const detail = f.tree.root.findByType('dialog');
      assert.match(text(detail), /To‘langan0 UZS/); assert.match(text(detail), /Hali to‘lov qilinmagan/);
      await act(async () => button(f.tree, 'Yopish').props.onClick());
      await act(async () => select(f.tree, 1, 'paid')); assert.equal(summary(f.tree, 'Qolgan qarz'), '0 UZS');
      await act(async () => select(f.tree, 1, 'debt')); assert.equal(summary(f.tree, 'Qolgan qarz'), '80 UZS');
    }
  } finally { await f.close(); }
});
