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
    if (name === '@/lib/pos') return { formatUZS: value => `${value} UZS` };
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
const recipient = { id: 'supplier-test', name: 'Mock supplier' };
async function fixture({ invoke, stored = new Map(), props = {} } = {}) {
  const storage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const calls = []; let saved = 0;
  const Component = component('src/components/OpeningDebtDialog.jsx', { functions: { async invoke(name, payload) {
    calls.push(structuredClone({ name, payload }));
    return invoke ? invoke(payload, calls.length) : { data: { opening_debt: { id: 'debt-test', supplier_id: recipient.id } } };
  } } }, storage);
  let tree;
  await act(async () => { tree = create(React.createElement(Component, {
    recipient, user: { id: 'admin-test', role: 'admin' }, allowed: true, onClose() {}, onSaved() { saved++; }, ...props,
  })); });
  return { tree, calls, stored, saved: () => saved,
    async fill(amount = '120', date = '2026-10-01') { await act(async () => { enter(tree, 'opening-debt-amount', amount); enter(tree, 'opening-debt-date', date); enter(tree, 'opening-debt-notes', 'Mock note'); }); },
    async save() { await act(async () => { await tree.root.findAllByType('button').at(-1).props.onClick(); }); },
    async close() { await act(async () => tree.unmount()); },
  };
}

test('requires an explicit valid date and positive safe integer UZS; sends only an opening-debt request', async () => {
  const f = await fixture();
  try {
    assert.equal(button(f.tree, 'Boshlang‘ich qarzni saqlash').props.disabled, true);
    for (const [amount, date] of [['0', '2026-10-01'], ['-1', '2026-10-01'], ['1.2', '2026-10-01'], ['1e3', '2026-10-01'], ['9007199254740992', '2026-10-01'], ['120', '2026-02-30'], ['120', '']]) {
      await f.fill(amount, date); await f.save(); assert.equal(f.calls.length, 0);
    }
    await f.fill(); await f.save();
    assert.equal(f.saved(), 1); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { name: 'supplier-ledger', payload: { action: 'create_opening_debt', supplier_id: recipient.id,
      amount: 120, effective_date: '2026-10-01', notes: 'Mock note', idempotency_key: 'offline-test-key' } });
    assert.equal(f.stored.size, 0);
  } finally { await f.close(); }
});

test('lost response persists exact payload across remount and ignores changed retry inputs', async () => {
  const stored = new Map();
  const first = await fixture({ stored, invoke: () => { throw Error('Mock lost reply'); } });
  await first.fill(); await first.save();
  const original = first.calls[0];
  assert.equal(first.saved(), 0); assert.equal(stored.size, 1);
  assert.equal(first.tree.root.findByProps({ id: 'opening-debt-amount' }).props.disabled, true);
  await first.close();
  const second = await fixture({ stored });
  try {
    await second.fill('999', '2026-10-02'); await second.save();
    assert.deepEqual(second.calls[0], original); assert.equal(second.saved(), 1); assert.equal(stored.size, 0);
  } finally { await second.close(); }
});

test('unconfirmed success never clears intent or announces success', async () => {
  const f = await fixture({ invoke: () => ({ data: { already_processed: true } }) });
  try { await f.fill(); await f.save(); assert.equal(f.saved(), 0); assert.equal(f.stored.size, 1); }
  finally { await f.close(); }
});

test('existing debt is immutable and shows original, remaining and payment history', async () => {
  const f = await fixture({ props: { debt: { id: 'debt-test', supplier_id: recipient.id, debt_amount: 120, remaining_debt: 80,
    effective_date: '2026-10-01', created_at: '2026-10-01T20:30:00Z', created_by_name: 'Mock admin' },
    payments: [{ id: 'pay-test', amount: 40, payment_number: 'MOCK-PAY', paid_at: '2026-10-02T01:00:00Z' }] } });
  try {
    assert.equal(f.tree.root.findAllByType('input').length, 0);
    assert.match(text(f.tree.toJSON()), /120 UZS/); assert.match(text(f.tree.toJSON()), /80 UZS/);
    assert.match(text(f.tree.toJSON()), /MOCK-PAY/); assert.match(text(f.tree.toJSON()), /40 UZS/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('dialog stays hidden from managers and shop-specific admin contexts', async () => {
  for (const props of [{ user: { id: 'manager', role: 'manager' } }, { allowed: false }]) {
    const f = await fixture({ props });
    try { assert.equal(f.tree.toJSON(), null); assert.equal(f.calls.length, 0); } finally { await f.close(); }
  }
});

test('recipient page only loads opening debts for admin/all-shops and hides them on scope change', async () => {
  const calls = [];
  const context = { current: { user: { id: 'admin-test', role: 'admin' }, adminShopScope: { isAdmin: true, shopId: 'all', shops: [] } } };
  const backend = { entities: { CashRecipient: { list: async () => [recipient] } }, functions: { invoke: async (name, payload) => {
    calls.push({ name, payload }); return { data: { opening_debts: [{ id: 'debt-test', supplier_id: recipient.id, debt_amount: 120, remaining_debt: 80 }], payments: [] } };
  } } };
  const Component = component('src/pages/CashRecipients.jsx', backend, {}, context);
  let tree; await act(async () => { tree = create(React.createElement(Component)); });
  try {
    assert.equal(calls.length, 1); assert.match(text(tree.toJSON()), /120 UZS/);
    for (const next of [{ user: { id: 'admin-test', role: 'admin' }, adminShopScope: { isAdmin: true, shopId: 'shop-test', shops: [] } },
      { user: { id: 'manager-test', role: 'manager' }, adminShopScope: { isAdmin: false, shopId: 'all', shops: [] } }]) {
      context.current = next; await act(async () => tree.update(React.createElement(Component)));
      assert.equal(calls.length, 1); assert.doesNotMatch(text(tree.toJSON()), /Boshlang‘ich|120 UZS/);
    }
  } finally { await act(async () => tree.unmount()); }
});

test('rapid repeated submit sends once and waits for the server confirmation', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const f = await fixture({ invoke: () => response });
  try {
    await f.fill();
    const submit = button(f.tree, 'Boshlang‘ich qarzni saqlash').props.onClick;
    let first;
    await act(async () => { first = submit(); void submit(); });
    assert.equal(f.calls.length, 1); assert.equal(f.saved(), 0);
    await act(async () => { resolve({ data: { opening_debt: { id: 'debt-test', supplier_id: recipient.id } } }); await first; });
    assert.equal(f.saved(), 1);
  } finally { await f.close(); }
});

test('opening-debt list failure blocks entry until a successful retry', async () => {
  let attempts = 0;
  const context = { current: { user: { id: 'admin-test', role: 'admin' }, adminShopScope: { isAdmin: true, shopId: 'all', shops: [] } } };
  const Component = component('src/pages/CashRecipients.jsx', {
    entities: { CashRecipient: { list: async () => [recipient] } }, functions: { invoke: async () => {
      if (++attempts === 1) throw Error('Mock read failure');
      return { data: { opening_debts: [], payments: [] } };
    } },
  }, {}, context);
  let tree; await act(async () => { tree = create(React.createElement(Component)); });
  try {
    assert.match(text(tree.toJSON()), /Mock read failure/);
    assert.equal(button(tree, 'Boshlang‘ich qarz kiritish'), undefined);
    await act(async () => button(tree, 'Qarzlarni qayta yuklash').props.onClick());
    assert.equal(attempts, 2); assert.ok(button(tree, 'Boshlang‘ich qarz kiritish'));
  } finally { await act(async () => tree.unmount()); }
});


const unassignedDebt = { id: 'debt-test', supplier_id: recipient.id, debt_amount: 120, remaining_debt: 80,
  effective_date: '2026-10-01', created_at: '2026-10-01T01:00:00Z' };
const assignmentProps = { debt: unassignedDebt, recipient: { ...recipient, supplier_location_ids: ['warehouse-test', 'inactive-test'] }, locations: [{ id: 'warehouse-test', name: 'Mock warehouse', active: true },
  { id: 'inactive-test', name: 'Inactive warehouse', active: false }] };
const chooseLocation = (tree, value) => tree.root.findByProps({ id: 'opening-debt-location' }).props.onChange({ target: { value } });

test('admin assignment submits no monetary/date fields and hides inactive locations', async () => {
  const f = await fixture({ props: assignmentProps, invoke: payload => ({ data: { opening_debt: { ...unassignedDebt, location_id: payload.location_id } } }) });
  try {
    assert.equal(button(f.tree, 'Omborga biriktirish').props.disabled, true);
    assert.doesNotMatch(text(f.tree.toJSON()), /Inactive warehouse/);
    await act(async () => chooseLocation(f.tree, 'inactive-test'));
    await act(async () => button(f.tree, 'Omborga biriktirish').props.onClick());
    assert.equal(f.calls.length, 0);
    await act(async () => chooseLocation(f.tree, 'warehouse-test'));
    await act(async () => button(f.tree, 'Omborga biriktirish').props.onClick());
    assert.deepEqual(f.calls[0], { name: 'supplier-ledger', payload: { action: 'assign_opening_debt_location', opening_debt_id: 'debt-test', location_id: 'warehouse-test', idempotency_key: 'offline-test-key' } });
    assert.equal(f.saved(), 1); assert.equal(f.stored.size, 0);
  } finally { await f.close(); }
});

test('ambiguous assignment keeps exact location and key across remount with no premature success', async () => {
  const stored = new Map();
  const first = await fixture({ props: assignmentProps, stored, invoke: () => { throw Error('Mock assignment timeout'); } });
  await act(async () => chooseLocation(first.tree, 'warehouse-test'));
  await act(async () => button(first.tree, 'Omborga biriktirish').props.onClick());
  const original = first.calls[0];
  assert.equal(first.saved(), 0); assert.equal(stored.size, 1);
  await first.close();
  const second = await fixture({ props: assignmentProps, stored, invoke: payload => ({ data: { opening_debt: { ...unassignedDebt, location_id: payload.location_id }, already_processed: true } }) });
  try {
    assert.equal(second.tree.root.findByProps({ id: 'opening-debt-location' }).props.disabled, true);
    await act(async () => chooseLocation(second.tree, 'other-test'));
    await act(async () => button(second.tree, 'Biriktirishni qayta tekshirish').props.onClick());
    assert.deepEqual(second.calls[0], original); assert.equal(second.saved(), 1); assert.equal(stored.size, 0);
  } finally { await second.close(); }
});

test('already assigned debt displays location/audit and cannot be reassigned', async () => {
  const f = await fixture({ props: { ...assignmentProps, debt: { ...unassignedDebt, location_id: 'warehouse-test', location_name_snapshot: 'Mock warehouse',
    location_assigned_at: '2026-10-02T01:00:00Z', location_assigned_by_name: 'Mock admin' } } });
  try {
    assert.match(text(f.tree.toJSON()), /Mock warehouse/); assert.match(text(f.tree.toJSON()), /Biriktirildi:.*Mock admin/);
    assert.equal(f.tree.root.findAllByType('select').length, 0); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('assignment waits for matching server confirmation and double clicks send once', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = await fixture({ props: assignmentProps, invoke: () => pending });
  try {
    await act(async () => chooseLocation(f.tree, 'warehouse-test'));
    const submit = button(f.tree, 'Omborga biriktirish').props.onClick;
    let first;
    await act(async () => { first = submit(); void submit(); });
    assert.equal(f.calls.length, 1); assert.equal(f.saved(), 0);
    await act(async () => { resolve({ data: { opening_debt: { ...unassignedDebt, location_id: 'wrong-location' } } }); await first; });
    assert.equal(f.saved(), 0); assert.equal(f.stored.size, 1); assert.match(text(f.tree.toJSON()), /tasdiqlanmadi/);
  } finally { await f.close(); }
});


test('unassigned recipient with no eligible warehouse cannot assign by a stale callback', async () => {
  const f = await fixture({ props: { ...assignmentProps, recipient: { ...recipient, supplier_location_ids: ['inactive-test'] } } });
  try {
    assert.equal(button(f.tree, 'Omborga biriktirish').props.disabled, true);
    assert.match(text(f.tree.toJSON()), /biriktirilgan faol ombor yo‘q/);
    await act(async () => chooseLocation(f.tree, 'warehouse-test'));
    await act(async () => button(f.tree, 'Omborga biriktirish').props.onClick());
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('pending assignment retry retains original warehouse after supplier membership changes', async () => {
  const stored = new Map();
  const first = await fixture({ props: assignmentProps, stored, invoke: () => { throw Error('Mock lost reply'); } });
  await act(async () => chooseLocation(first.tree, 'warehouse-test'));
  await act(async () => button(first.tree, 'Omborga biriktirish').props.onClick());
  const original = first.calls[0]; await first.close();
  const second = await fixture({ stored, props: { ...assignmentProps, recipient: { ...recipient, supplier_location_ids: [] } },
    invoke: payload => ({ data: { opening_debt: { ...unassignedDebt, location_id: payload.location_id }, already_processed: true } }) });
  try {
    await act(async () => button(second.tree, 'Biriktirishni qayta tekshirish').props.onClick());
    assert.deepEqual(second.calls[0], original); assert.equal(second.saved(), 1);
  } finally { await second.close(); }
});

const correctionDebt = { ...unassignedDebt, status: 'unpaid', remaining_debt: 120, can_correct_amount: true, location_id: 'warehouse-test' };
const confirmedCorrection = payload => ({ data: { opening_debt: { ...correctionDebt,
  corrected_debt_amount: payload.amount, remaining_debt: payload.amount, amount_correction_reason: payload.reason,
  amount_correction_key: payload.idempotency_key, amount_corrected_at: '2026-11-01T00:00:00Z', amount_corrected_by_name: 'Mock admin' } } });
const fillCorrection = async (f, amount = '80', reason = 'Mock typo correction') => act(async () => {
  enter(f.tree, 'opening-correction-amount', amount); enter(f.tree, 'opening-correction-reason', reason);
});

test('one-time correction validates positive safe integer and reason, preserving financial history fields', async () => {
  const f = await fixture({ props: { debt: correctionDebt }, invoke: confirmedCorrection });
  try {
    for (const [amount, reason] of [['0', 'Mock'], ['-1', 'Mock'], ['1.2', 'Mock'], ['1e3', 'Mock'], ['9007199254740992', 'Mock'], ['120', 'Mock'], ['80', '']]) {
      await fillCorrection(f, amount, reason);
      await act(async () => button(f.tree, 'Sabab bilan summani tuzatish').props.onClick());
      assert.equal(f.calls.length, 0);
    }
    await fillCorrection(f); await act(async () => button(f.tree, 'Sabab bilan summani tuzatish').props.onClick());
    assert.deepEqual(f.calls[0].payload, { action: 'correct_opening_debt_amount', opening_debt_id: 'debt-test', amount: 80,
      reason: 'Mock typo correction', idempotency_key: 'offline-test-key' });
    assert.equal(f.saved(), 1); assert.equal(f.stored.size, 0);
    assert.equal(correctionDebt.debt_amount, 120); assert.equal(correctionDebt.remaining_debt, 120);
  } finally { await f.close(); }
});

test('payment, journal eligibility and prior correction each prevent correction UI', async () => {
  for (const props of [{ debt: { ...correctionDebt, can_correct_amount: false } }, { debt: { ...correctionDebt, can_correct_amount: undefined } },
    { debt: correctionDebt, payments: [{ id: 'pay', amount: 1 }] }, { debt: { ...correctionDebt, remaining_debt: 119 } },
    { debt: { ...correctionDebt, corrected_debt_amount: 80, remaining_debt: 80, amount_correction_key: 'past' } }]) {
    const f = await fixture({ props });
    try { assert.equal(button(f.tree, 'Sabab bilan summani tuzatish'), undefined); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  }
});

test('correction timeout keeps amount/reason/key across remount, ignores changed retry and confirms matching response', async () => {
  const stored = new Map();
  const first = await fixture({ stored, props: { debt: correctionDebt }, invoke: () => { throw Error('Mock lost correction reply'); } });
  await fillCorrection(first); await act(async () => button(first.tree, 'Sabab bilan summani tuzatish').props.onClick());
  assert.equal(first.saved(), 0); const original = first.calls[0]; await first.close();
  const second = await fixture({ stored, props: { debt: { ...correctionDebt, can_correct_amount: false } }, invoke: confirmedCorrection });
  try {
    assert.equal(second.tree.root.findByProps({ id: 'opening-correction-amount' }).props.disabled, true);
    await fillCorrection(second, '90', 'Changed'); await act(async () => button(second.tree, 'Tuzatishni qayta tekshirish').props.onClick());
    assert.deepEqual(second.calls[0], original); assert.equal(second.saved(), 1); assert.equal(stored.size, 0);
  } finally { await second.close(); }
});

test('corrected history displays effective principal and immutable original audit without a payment', async () => {
  const debt = confirmedCorrection({ amount: 80, reason: 'Mock typo correction', idempotency_key: 'past' }).data.opening_debt;
  const f = await fixture({ props: { debt } });
  try {
    const dl = f.tree.root.findByType('dl'); assert.match(text(dl), /Boshlang‘ich summa80 UZS/);
    assert.match(text(f.tree.toJSON()), /Dastlabki summa: 120 UZS/); assert.match(text(f.tree.toJSON()), /Mock typo correction/);
    assert.match(text(f.tree.toJSON()), /Mock admin/); assert.match(text(f.tree.toJSON()), /Hali to‘lov yo‘q/);
    assert.equal(button(f.tree, 'Sabab bilan summani tuzatish'), undefined);
  } finally { await f.close(); }
});

test('mismatched correction confirmation retains request and never announces success', async () => {
  const f = await fixture({ props: { debt: correctionDebt }, invoke: payload => confirmedCorrection({ ...payload, amount: 90 }) });
  try {
    await fillCorrection(f); await act(async () => button(f.tree, 'Sabab bilan summani tuzatish').props.onClick());
    assert.equal(f.saved(), 0); assert.equal(f.stored.size, 1); assert.match(text(f.tree.toJSON()), /Tuzatish tasdiqlanmadi/);
  } finally { await f.close(); }
});
