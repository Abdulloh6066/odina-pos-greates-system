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
    if (name.endsWith('/OpeningDebtPaymentDialog')) return { OpeningDebtPaymentButton: () => null, hasPendingOpeningDebtPayment: () => false };
    if (name.endsWith('/OpeningDebtDialog') || name.endsWith('/SupplierProductsDialog')) return { default: () => null };
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, exported) => exported === 'Dialog'
      ? ({ open, children, ...props }) => open ? React.createElement('dialog', props, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Textarea: 'textarea', Label: 'label' })[exported] || 'div') });
    throw Error(`Unexpected import: ${name}`);
  };
  const result = ts.transpileModule(readFileSync(path, 'utf8') + '\nexport { RecipientDialog as TestRecipientDialog };', { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  }, reportDiagnostics: true });
  assert.equal(result.diagnostics?.length || 0, 0);
  vm.runInNewContext('(function(require,module,exports){' + result.outputText + '\n})', { console })(require, module, module.exports);
  return module.exports.TestRecipientDialog;
}
const locations = [{ id: 'warehouse', name: 'Mock warehouse', location_type: 'production', active: true },
  { id: 'shop', name: 'Mock shop', location_type: 'shop', active: true }, { id: 'inactive', name: 'Inactive warehouse', location_type: 'production', active: false }];
const confirmed = payload => ({ data: { recipient: { id: 'new-recipient', ...payload.recipient }, opening_debt: payload.opening_debt
  ? { id: 'new-debt', supplier_id: 'new-recipient', debt_amount: payload.opening_debt.amount, remaining_debt: payload.opening_debt.amount,
    effective_date: payload.opening_debt.effective_date, location_id: payload.opening_debt.location_id } : null } });
async function fixture({ stored = new Map(), invoke = confirmed, props: override = {}, storageFailure = false } = {}) {
  const calls = [], updates = []; let saved = 0, closed = 0;
  const storage = { getItem: key => stored.get(key) || null, setItem: (key, value) => { if (storageFailure) throw Error('Mock storage failure'); stored.set(key, value); }, removeItem: key => stored.delete(key) };
  const backend = { functions: { invoke: async (name, payload) => { calls.push(structuredClone({ name, payload })); return invoke(payload); } },
    entities: { CashRecipient: { update: async (...args) => updates.push(structuredClone(args)), create: () => assert.fail('Direct creation is forbidden') } } };
  const Component = component('src/pages/CashRecipients.jsx', backend, storage);
  let props = { open: true, recipient: {}, locations, defaultLocationId: 'warehouse', user: { id: 'admin', role: 'admin' },
    onSaved() { saved++; }, onClose() { closed++; }, ...override };
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  return { tree, calls, updates, stored, saved: () => saved, closed: () => closed,
    async name(value = 'Mock supplier') { await act(async () => tree.root.findByProps({ placeholder: 'Masalan: Makro Trade' }).props.onChange({ target: { value } })); },
    async debt(amount = '120', date = '2026-11-07', location = 'warehouse') {
      await act(async () => tree.root.findByProps({ 'aria-label': 'Boshlang‘ich qarz kiritish' }).props.onChange({ target: { checked: true } }));
      await act(async () => { enter(tree, 'new-recipient-debt-amount', amount); enter(tree, 'new-recipient-debt-date', date); enter(tree, 'new-recipient-debt-location', location); });
    },
    async save() { await act(async () => tree.root.findAllByType('button').at(-1).props.onClick()); },
    async update(next) { props = { ...props, ...next }; await act(async () => tree.update(React.createElement(Component, props))); },
    async close() { await act(async () => tree.unmount()); },
  };
}

test('optional unchecked debt preserves no-debt creation through a single idempotent backend action', async () => {
  const f = await fixture();
  try {
    await f.name(); await f.save();
    assert.equal(f.saved(), 1); assert.equal(f.calls.length, 1); assert.equal(f.updates.length, 0);
    assert.deepEqual(f.calls[0], { name: 'supplier-ledger', payload: { action: 'create_recipient', recipient: {
      name: 'Mock supplier', recipient_type: 'supplier', notes: '', active: true, supplier_location_ids: ['warehouse'],
    }, idempotency_key: 'offline-test-key' } });
    assert.equal(f.stored.size, 0);
  } finally { await f.close(); }
});

test('optional debt uses current Tashkent date, explicit owing direction and active linked location', async () => {
  const f = await fixture();
  try {
    await f.name();
    await act(async () => f.tree.root.findByProps({ 'aria-label': 'Boshlang‘ich qarz kiritish' }).props.onChange({ target: { checked: true } }));
    assert.equal(f.tree.root.findByProps({ id: 'new-recipient-debt-date' }).props.value, dates.uzbekistanDateKey());
    assert.match(text(f.tree.toJSON()), /Biz bu yetkazib beruvchiga qarzdormiz/);
    const options = f.tree.root.findByProps({ id: 'new-recipient-debt-location' }).findAllByType('option').map(node => node.props.value);
    assert.deepEqual(options, ['', 'warehouse']);
    await f.debt(); await f.save(); assert.equal(f.saved(), 1);
    assert.deepEqual(f.calls[0].payload.opening_debt, { amount: 120, effective_date: '2026-11-07', location_id: 'warehouse' });
  } finally { await f.close(); }
});

test('zero/fraction/unsafe amounts, impossible date and unrelated warehouse cannot submit', async () => {
  const f = await fixture();
  try {
    await f.name();
    for (const [amount, date, location] of [['0', '2026-11-07', 'warehouse'], ['1.5', '2026-11-07', 'warehouse'], ['9007199254740992', '2026-11-07', 'warehouse'], ['120', '2026-02-30', 'warehouse'], ['120', '2026-11-07', 'shop']]) {
      await f.debt(amount, date, location); await f.save(); assert.equal(f.calls.length, 0);
    }
    await f.debt('0'); assert.match(text(f.tree.toJSON()), /Qarz bo‘lmasa/);
    await act(async () => f.tree.root.findByProps({ 'aria-label': 'Boshlang‘ich qarz kiritish' }).props.onChange({ target: { checked: false } }));
    await f.save(); assert.equal(f.saved(), 1); assert.equal(f.calls[0].payload.opening_debt, undefined);
  } finally { await f.close(); }
});

test('partial recipient confirmation keeps full payload across close/navigation/remount, changed retry ignored', async () => {
  const stored = new Map();
  const first = await fixture({ stored, invoke: payload => ({ data: { recipient: { id: 'new-recipient', ...payload.recipient }, opening_debt: null } }) });
  await first.name(); await first.debt(); await first.save();
  assert.equal(first.saved(), 0); assert.equal(stored.size, 1);
  const original = first.calls[0];
  await act(async () => button(first.tree, 'Yopish').props.onClick()); assert.equal(first.closed(), 1);
  await first.update({ open: false }); await first.update({ open: true });
  assert.equal(first.tree.root.findByProps({ placeholder: 'Masalan: Makro Trade' }).props.value, 'Mock supplier');
  await first.close();
  const second = await fixture({ stored, props: { locations: [], defaultLocationId: 'other' } });
  try {
    await second.name('Changed name'); await second.debt('999', '2026-11-08', 'other'); await second.save();
    assert.deepEqual(second.calls[0], original); assert.equal(second.saved(), 1); assert.equal(stored.size, 0);
  } finally { await second.close(); }
});

test('lost response retains no-debt payload too and storage failure prevents API writes', async () => {
  const f = await fixture({ invoke: () => { throw Error('Mock timeout'); } });
  try { await f.name(); await f.save(); assert.equal(f.saved(), 0); assert.equal(f.stored.size, 1); }
  finally { await f.close(); }
  const blocked = await fixture({ storageFailure: true });
  try { await blocked.name(); await blocked.debt(); await blocked.save(); assert.equal(blocked.calls.length, 0); assert.equal(blocked.saved(), 0); }
  finally { await blocked.close(); }
});

test('rapid repeated submit sends once and pending work cannot be dismissed until response', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const f = await fixture({ invoke: () => pending });
  try {
    await f.name(); await f.debt(); const submit = button(f.tree, 'Saqlash').props.onClick; let first;
    await act(async () => { first = submit(); void submit(); });
    assert.equal(f.calls.length, 1); assert.equal(f.saved(), 0);
    await act(async () => f.tree.root.findByType('dialog').props.onOpenChange(false)); assert.equal(f.closed(), 0);
    await act(async () => { resolve(confirmed(f.calls[0].payload)); await first; }); assert.equal(f.saved(), 1);
  } finally { await f.close(); }
});

test('definitely rejected validation clears intent, but ambiguous backend errors do not', async () => {
  for (const rejected of [true, false]) {
    const f = await fixture({ invoke: () => { throw Object.assign(Error('Generic'), { response: { data: { error: 'Mock rejection', request_not_started: rejected } } }); } });
    try { await f.name(); await f.debt(); await f.save(); assert.equal(f.stored.size, rejected ? 0 : 1); assert.match(text(f.tree.toJSON()), /Mock rejection/); }
    finally { await f.close(); }
  }
});

test('existing-recipient edit never exposes or writes opening debt; nonadmin cannot create', async () => {
  const f = await fixture({ props: { recipient: { id: 'existing', name: 'Old name', supplier_location_ids: ['warehouse'] } } });
  try {
    assert.equal(f.tree.root.findAllByProps({ 'aria-label': 'Boshlang‘ich qarz kiritish' }).length, 0);
    await f.name('Updated name'); await f.save(); assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 1);
    assert.deepEqual(Object.keys(f.updates[0][1]).sort(), ['active', 'name', 'notes', 'recipient_type', 'supplier_location_ids']);
  } finally { await f.close(); }
  const manager = await fixture({ props: { user: { id: 'manager', role: 'manager' } } });
  try { assert.equal(manager.tree.toJSON(), null); assert.equal(manager.calls.length, 0); } finally { await manager.close(); }
});


test('linked active retail location is eligible and inactive/unlinked locations stay excluded', async () => {
  const f = await fixture({ props: { defaultLocationId: 'shop' } });
  try {
    await f.name(); await f.debt('120', '2026-11-07', 'shop');
    const options = f.tree.root.findByProps({ id: 'new-recipient-debt-location' }).findAllByType('option').map(node => node.props.value);
    assert.deepEqual(options, ['', 'shop']);
    await f.save(); assert.equal(f.saved(), 1); assert.equal(f.calls[0].payload.opening_debt.location_id, 'shop');
  } finally { await f.close(); }
});

test('malformed success with mismatched debt amount/date/location remains pending', async () => {
  for (const changed of [{ debt_amount: 121 }, { effective_date: '2026-11-08' }, { location_id: 'other' }, { supplier_id: 'other-recipient' }]) {
    const f = await fixture({ invoke: payload => {
      const response = confirmed(payload); Object.assign(response.data.opening_debt, changed); return response;
    } });
    try {
      await f.name(); await f.debt(); await f.save();
      assert.equal(f.saved(), 0); assert.equal(f.stored.size, 1);
      assert.match(text(f.tree.toJSON()), /to‘liq tasdiqlanmadi/);
    } finally { await f.close(); }
  }
});
