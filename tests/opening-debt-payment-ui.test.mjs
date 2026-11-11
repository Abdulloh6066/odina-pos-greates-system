// Real JSX and retry logic, mocked SDK/storage only. Never calls a live service.
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
function component(path, backend, storage, context = {}) {
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const module = { exports: {} };
    const require = name => {
      if (name === 'react') return { ...React, default: React };
      if (name === '@/api/base44Client') return { base44: backend };
      if (name === '@/lib/pos') return { formatUZS: value => `${value} UZS`, formatNum: String };
      if (name === '@/lib/uzbekistan-time') return dates;
      if (name === '@/lib/orders') return { buildIdempotencyKey: () => 'offline-payment-key' };
      if (name === '@/lib/order-request-retry') return { ...retry,
        readOrderRequest: scope => retry.readOrderRequest(scope, storage),
        retainOrderRequest: (scope, payload) => retry.retainOrderRequest(scope, payload, storage),
        clearOrderRequest: scope => retry.clearOrderRequest(scope, storage),
      };
      if (name === 'react-router-dom') return { useOutletContext: () => context.current, Navigate: () => null };
      if (name === '@/lib/odina-dialog') return { odinaAlert: async () => {} };
      if (name.endsWith('/odina-select')) return { default: wrapper('select') };
      if (name.endsWith('/PageHeader')) return { default: wrapper('header') };
      if (name.endsWith('/OpeningDebtPaymentDialog')) return load('src/components/OpeningDebtPaymentDialog.jsx');
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
    cache.set(path, module.exports);
    return module.exports;
  }
  return load(path);
}
const debt = { id: 'opening', supplier_id: 'supplier', supplier_name_snapshot: 'Mock supplier', debt_amount: 120,
  remaining_debt: 80, status: 'partial', location_id: 'warehouse', location_name_snapshot: 'Mock warehouse' };
const user = { id: 'owner', role: 'admin' };
const confirmed = payload => ({ data: { paid: true, opening_debt_id: payload.opening_debt_id,
  amount: payload.amount, account: payload.account, location_id: payload.location_id || '', opening_remaining_debt: 40,
  payment_number: 'MOCK-PAY', payments: [{ id: 'mock-payment', opening_debt_id: payload.opening_debt_id,
    supplier_id: payload.supplier_id, amount: payload.amount }] } });
const summary = () => ({ data: { balances: [{ account: 'cash', balance: 1000 }, { account: 'bank', balance: 500 }] } });
const storageFor = stored => ({ getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) });
async function fixture({ invoke = confirmed, readSummary = summary, stored = new Map(), storage = storageFor(stored), props: override = {}, asButton = false } = {}) {
  const calls = []; let saved = 0, closed = 0;
  const backend = { functions: { invoke: async (name, payload) => {
    calls.push(structuredClone({ name, payload }));
    return payload.action === 'summary' ? readSummary() : invoke(payload);
  } } };
  const exports = component('src/components/OpeningDebtPaymentDialog.jsx', backend, storage);
  const Component = asButton ? exports.OpeningDebtPaymentButton : exports.default;
  let props = { debt, user, allowed: true, onSaved() { saved++; }, onClose() { closed++; }, ...override };
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  return { tree, stored, calls, payments: () => calls.filter(call => call.payload.action === 'pay_supplier'), saved: () => saved, closed: () => closed,
    async fill(amount = '40', account = 'cash', notes = 'Mock note') { await act(async () => { enter(tree, 'opening-payment-amount', amount); enter(tree, 'opening-payment-account', account); enter(tree, 'opening-payment-notes', notes); }); },
    async review() { await act(async () => button(tree, 'To‘lovni ko‘rib chiqish').props.onClick()); },
    async pin(value = '1234') { await act(async () => enter(tree, 'opening-payment-pin', value)); },
    async submit() { await act(async () => { await tree.root.findAllByType('button').at(-1).props.onClick(); }); },
    async update(next) { props = { ...props, ...next }; await act(async () => tree.update(React.createElement(Component, props))); },
    async close() { await act(async () => tree.unmount()); },
  };
}

test('opening debt Bank selection reviews and spends the combined existing Bank and card balance', async () => {
  const f = await fixture({ readSummary: () => ({ data: { balances: [
    { account: 'bank', balance: 0 }, { account: 'uzcard', balance: 30 }, { account: 'humo', balance: 20 },
  ] } }) });
  try {
    const options = f.tree.root.findByProps({ id: 'opening-payment-account' }).findAllByType('option');
    assert.deepEqual(options.map(option => option.props.value), ['cash', 'bank_all', 'online']);
    assert.ok(options.some(option => text(option) === 'Bank · 50 UZS'));
    await f.fill('40', 'bank_all');
    assert.equal(button(f.tree, 'To‘lovni ko‘rib chiqish').props.disabled, false);
    await f.review(); assert.match(text(f.tree.toJSON()), /Bank: 50 UZS → 10 UZS/);
    await f.pin(); await f.submit();
    assert.equal(f.payments().length, 1);
    assert.equal(f.payments()[0].payload.account, 'bank_all');
    assert.equal(f.payments()[0].payload.amount, 40); assert.equal(f.saved(), 1);
  } finally { await f.close(); }
});

test('selected debt requires valid amount, sufficient Budget, review and ephemeral PIN before paying', async () => {
  const f = await fixture();
  try {
    for (const amount of ['', '0', '-1', '1.5', '1e2', '9007199254740992', '81']) {
      await f.fill(amount); assert.equal(button(f.tree, 'To‘lovni ko‘rib chiqish').props.disabled, true);
      await f.review(); assert.equal(f.payments().length, 0); assert.equal(f.tree.root.findAllByProps({ id: 'opening-payment-pin' }).length, 0);
    }
    await f.fill('40', 'humo'); assert.equal(button(f.tree, 'To‘lovni ko‘rib chiqish').props.disabled, true);
    await f.fill(); await f.review();
    assert.match(text(f.tree.toJSON()), /Naqd pul: 1000 UZS → 960 UZS/);
    assert.match(text(f.tree.toJSON()), /qarz: 80 UZS → 40 UZS/);
    assert.equal(button(f.tree, 'Budgetdan to‘lash').props.disabled, true);
    await f.submit(); assert.equal(f.payments().length, 0);
    await f.pin(); await f.submit();
    assert.deepEqual(f.payments()[0], { name: 'budget-ledger', payload: { action: 'pay_supplier', supplier_id: debt.supplier_id,
      opening_debt_id: debt.id, location_id: debt.location_id, account: 'cash', amount: 40, notes: 'Mock note',
      idempotency_key: 'offline-payment-key', owner_pin: '1234' } });
    assert.equal(f.saved(), 1); assert.equal(f.stored.size, 0);
    assert.equal(f.tree.root.findByProps({ id: 'opening-payment-pin' }).props.value, '');
  } finally { await f.close(); }
});

test('Back and Cancel before payment make no financial request and clear PIN', async () => {
  const f = await fixture();
  try {
    await f.fill(); await f.review(); await f.pin();
    await act(async () => button(f.tree, 'Orqaga').props.onClick());
    await f.review(); assert.equal(f.tree.root.findByProps({ id: 'opening-payment-pin' }).props.value, '');
    await f.pin(); await act(async () => button(f.tree, 'Bekor qilish').props.onClick());
    assert.equal(f.closed(), 1); assert.equal(f.payments().length, 0); assert.equal(f.stored.size, 0);
    assert.equal(f.tree.root.findByProps({ id: 'opening-payment-pin' }).props.value, '');
  } finally { await f.close(); }
});

test('lost response persists exact intent without PIN across remount and ignores edited inputs', async () => {
  const stored = new Map();
  const first = await fixture({ stored, invoke: () => { throw Error('Mock lost reply'); } });
  await first.fill(); await first.review(); await first.pin(); await first.submit();
  const original = first.payments()[0]; assert.equal(first.saved(), 0); assert.equal(stored.size, 1);
  assert.doesNotMatch([...stored.values()].join(''), /owner_pin|1234/);
  assert.equal(first.tree.root.findByProps({ id: 'opening-payment-pin' }).props.value, '');
  await first.close();
  const second = await fixture({ stored, props: { debt: { ...debt, status: 'paid', remaining_debt: 0 } }, readSummary: () => ({ data: { balances: [] } }) });
  try {
    await second.fill('77', 'bank', 'Changed'); await second.pin(); await second.submit();
    assert.deepEqual(second.payments()[0], original); assert.equal(second.saved(), 1); assert.equal(stored.size, 0);
  } finally { await second.close(); }
});

test('wrong PIN on uncertain retry never clears the earlier intent or allows a new payment', async () => {
  const stored = new Map(); let attempts = 0;
  const f = await fixture({ stored, invoke: payload => {
    if (++attempts === 1) throw Error('Success response lost');
    if (attempts === 2) throw Object.assign(Error('Wrong PIN'), { data: { request_not_started: true } });
    return confirmed(payload);
  } });
  try {
    await f.fill(); await f.review(); await f.pin(); await f.submit();
    const original = [...stored.values()][0];
    await f.pin('9999'); await f.submit();
    assert.equal([...stored.values()][0], original); assert.equal(f.tree.root.findByProps({ id: 'opening-payment-amount' }).props.disabled, true);
    await f.pin(); await f.submit(); assert.equal(f.saved(), 1);
    assert.equal(new Set(f.payments().map(call => call.payload.idempotency_key)).size, 1);
  } finally { await f.close(); }
});

test('fully paid pending request remains reachable and retries after later location assignment', async () => {
  const stored = new Map();
  const f = await fixture({ stored, props: { debt: { ...debt, location_id: '', location_name_snapshot: '' } }, invoke: () => { throw Error('Lost reply'); } });
  await f.fill('80'); await f.review(); await f.pin(); await f.submit(); const original = f.payments()[0]; await f.close();
  const retrying = await fixture({ stored, asButton: true, props: { debt: { ...debt, remaining_debt: 0, status: 'paid' } } });
  try {
    assert.ok(button(retrying.tree, 'To‘lovni qayta tekshirish')); assert.equal(retrying.calls.length, 0);
    await act(async () => button(retrying.tree, 'To‘lovni qayta tekshirish').props.onClick());
    assert.match(text(retrying.tree.toJSON()), /ombor ma’lumoti keyin o‘zgargan/);
    await retrying.pin(); await retrying.submit();
    assert.deepEqual(retrying.payments()[0], original); assert.equal(retrying.saved(), 1); assert.equal(stored.size, 0);
    assert.equal(button(retrying.tree, 'To‘lov'), undefined);
  } finally { await retrying.close(); }
});

test('new definitely rejected and reversed payments unlock editing, ambiguous failures never do', async () => {
  for (const [errorData, unlocks] of [[{ request_not_started: true }, true], [{ operation_reversed: true }, true], [{ operation_pending: true }, false], [{}, false]]) {
    const f = await fixture({ invoke: () => { throw Object.assign(Error('Mock error'), { data: errorData, status: 400 }); } });
    try {
      await f.fill(); await f.review(); await f.pin(); await f.submit();
      assert.equal(f.stored.size, unlocks ? 0 : 1); assert.equal(f.saved(), 0);
      assert.equal(f.tree.root.findByProps({ id: 'opening-payment-amount' }).props.disabled, !unlocks);
    } finally { await f.close(); }
  }
});

test('duplicate submit and Close/Escape during flight cannot repeat or dismiss payment', async () => {
  let resolve; const result = new Promise(done => { resolve = done; });
  const f = await fixture({ invoke: () => result });
  try {
    await f.fill(); await f.review(); await f.pin();
    const submit = button(f.tree, 'Budgetdan to‘lash').props.onClick; let first;
    await act(async () => { first = submit(); void submit(); });
    assert.equal(f.payments().length, 1); assert.equal(f.saved(), 0);
    await act(async () => { f.tree.root.findByType('dialog').props.onOpenChange(false); button(f.tree, 'Yopish').props.onClick(); });
    assert.equal(f.closed(), 0); assert.equal(button(f.tree, 'Yopish').props.disabled, true);
    let prevented = false; f.tree.root.findAllByType('div').find(node => node.props.onEscapeKeyDown).props.onEscapeKeyDown({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    await act(async () => { resolve(confirmed(f.payments()[0].payload)); await first; }); assert.equal(f.saved(), 1);
  } finally { await f.close(); }
});

test('incomplete or wrong-target success never clears retry intent or announces success', async () => {
  for (const change of [{ paid: false }, { amount: 41 }, { account: 'bank' }, { location_id: 'other' }, { opening_debt_id: 'other' },
    { payments: [] }, { payments: [{ opening_debt_id: debt.id, supplier_id: 'other', amount: 40 }] }, { opening_remaining_debt: -1 }]) {
    const f = await fixture({ invoke: payload => ({ data: { ...confirmed(payload).data, ...change } }) });
    try { await f.fill(); await f.review(); await f.pin(); await f.submit(); assert.equal(f.saved(), 0); assert.equal(f.stored.size, 1); }
    finally { await f.close(); }
  }
});

test('Budget read failure blocks new payment and permits safe reload', async () => {
  let reads = 0;
  const f = await fixture({ readSummary: () => { if (++reads === 1) throw Error('Offline Budget'); return summary(); } });
  try {
    await f.fill(); assert.equal(button(f.tree, 'To‘lovni ko‘rib chiqish').props.disabled, true);
    await act(async () => button(f.tree, 'Budgetni qayta yuklash').props.onClick());
    assert.equal(button(f.tree, 'To‘lovni ko‘rib chiqish').props.disabled, false); assert.equal(f.payments().length, 0);
  } finally { await f.close(); }
});

test('storage failure happens before financial call and PIN is not retained', async () => {
  const stored = new Map();
  const f = await fixture({ stored, storage: { ...storageFor(stored), setItem() { throw Error('Storage unavailable'); } } });
  try {
    await f.fill(); await f.review(); await f.pin(); await f.submit();
    assert.equal(f.payments().length, 0); assert.equal(stored.size, 0); assert.equal(f.saved(), 0);
    assert.equal(f.tree.root.findByProps({ id: 'opening-payment-pin' }).props.value, '');
  } finally { await f.close(); }
});

test('unauthorized or paid rows expose no control or Budget read', async () => {
  for (const props of [{ allowed: false }, { user: { id: 'manager', role: 'manager' } }, { user: null }, { debt: { ...debt, status: 'paid', remaining_debt: 0 } }]) {
    const f = await fixture({ asButton: true, props });
    try { assert.equal(f.tree.toJSON(), null); assert.equal(f.calls.length, 0); } finally { await f.close(); }
  }
});

test('unmount after request prevents stale success callback in a changed page scope', async () => {
  let resolve; const result = new Promise(done => { resolve = done; });
  const f = await fixture({ invoke: () => result });
  await f.fill(); await f.review(); await f.pin(); let request;
  await act(async () => { request = button(f.tree, 'Budgetdan to‘lash').props.onClick(); });
  await f.close(); await act(async () => { resolve(confirmed(f.payments()[0].payload)); await request; });
  assert.equal(f.saved(), 0); assert.equal(f.stored.size, 0);
});

async function pageFixture(path, { actor = user, location = null, allLocations = true, debts = [debt], stored = new Map() } = {}) {
  const calls = [];
  const context = { current: { user: actor, adminShopScope: { isAdmin: actor.role === 'admin', shopId: 'all', shops: [] } } };
  const backend = { entities: {
    SupplierReceipt: { list: async () => [] }, SupplierReceiptItem: { list: async () => [] }, SupplierPayment: { list: async () => [] },
    CashRecipient: { list: async () => [{ id: debt.supplier_id, name: debt.supplier_name_snapshot, recipient_type: 'supplier', supplier_location_ids: [debt.location_id] }] },
  }, functions: { invoke: async (name, payload) => {
    calls.push(structuredClone({ name, payload }));
    if (payload.action === 'summary') return summary();
    if (payload.action === 'pay_supplier') return confirmed(payload);
    return { data: { opening_debts: structuredClone(debts), payments: [] } };
  } } };
  const Component = component(path, backend, storageFor(stored), context).default;
  let props = { user: actor, location, allLocations, readOnly: true, recipients: [], ingredients: [] };
  let tree; await act(async () => { tree = create(React.createElement(Component, props)); });
  return { tree, calls, async update(next, nextContext) { props = { ...props, ...next }; if (nextContext) context.current = nextContext; await act(async () => tree.update(React.createElement(Component, props))); },
    async close() { await act(async () => tree.unmount()); } };
}

test('warehouse global and assigned-location cards offer targeted pay, never other-location or nonadmin debts', async () => {
  for (const config of [{}, { location: { id: 'warehouse' }, allLocations: false }, { location: { id: 'other' }, allLocations: false }, { actor: { id: 'manager', role: 'manager' } }]) {
    const f = await pageFixture('src/components/warehouse/SupplierLedgerPanel.jsx', config);
    try {
      const expected = !config.actor && config.location?.id !== 'other';
      assert.equal(Boolean(button(f.tree, 'To‘lov')), expected);
      assert.equal(f.calls.some(call => call.payload.action === 'summary'), false);
      if (expected) {
        await act(async () => button(f.tree, 'To‘lov').props.onClick());
        assert.match(text(f.tree.root.findByType('dialog')), /Faqat shu boshlang‘ich qarz/);
        await f.update({ user: { id: 'manager', role: 'manager' } });
        assert.equal(f.tree.root.findAllByType('dialog').length, 0); assert.equal(button(f.tree, 'To‘lov'), undefined);
      }
    } finally { await f.close(); }
  }
});

test('recipient payment controls remain admin/all-shops and vanish on scope change', async () => {
  const f = await pageFixture('src/pages/CashRecipients.jsx');
  try {
    assert.ok(button(f.tree, 'To‘lov')); await act(async () => button(f.tree, 'To‘lov').props.onClick());
    assert.equal(f.tree.root.findAllByType('dialog').length, 1);
    await f.update({}, { user, adminShopScope: { isAdmin: true, shopId: 'warehouse', shops: [] } });
    assert.equal(f.tree.root.findAllByType('dialog').length, 0); assert.equal(button(f.tree, 'To‘lov'), undefined);
    assert.equal(f.calls.filter(call => call.payload.action === 'pay_supplier').length, 0);
  } finally { await f.close(); }
});


test('unassigned payment may confirm a backend assignment race without losing exact debt identity', async () => {
  const f = await fixture({ props: { debt: { ...debt, location_id: '', location_name_snapshot: '' } },
    invoke: payload => ({ data: { ...confirmed(payload).data, location_id: 'warehouse' } }) });
  try { await f.fill(); await f.review(); await f.pin(); await f.submit(); assert.equal(f.saved(), 1); assert.equal(f.stored.size, 0); }
  finally { await f.close(); }
});

test('paid debt with lost response stays recoverable outside warehouse status filters without changing totals', async () => {
  const stored = new Map();
  const first = await fixture({ stored, invoke: () => { throw Error('Lost reply after committed payment'); } });
  await first.fill('80'); await first.review(); await first.pin(); await first.submit();
  const original = first.payments()[0]; await first.close();
  const f = await pageFixture('src/components/warehouse/SupplierLedgerPanel.jsx', { stored, debts: [{ ...debt, remaining_debt: 0, status: 'paid' }] });
  try {
    for (const status of ['debt', 'cancelled']) {
      await act(async () => f.tree.root.findAllByType('select')[1].props.onChange({ target: { value: status } }));
      assert.ok(f.tree.root.findByProps({ 'aria-label': 'Tasdiq kutilayotgan to‘lovlar' }));
      assert.ok(button(f.tree, 'To‘lovni qayta tekshirish'));
      const paid = f.tree.root.findAll(node => typeof node.type === 'function' && node.type.name === 'Summary').find(node => node.props.label === 'To‘langan');
      assert.equal(paid.props.value, '0 UZS');
    }
    await act(async () => button(f.tree, 'To‘lovni qayta tekshirish').props.onClick());
    await act(async () => enter(f.tree, 'opening-payment-pin', '1234'));
    await act(async () => button(f.tree, 'Avvalgi to‘lovni tekshirish').props.onClick());
    assert.deepEqual(f.calls.find(call => call.payload.action === 'pay_supplier'), original);
    assert.equal(stored.size, 0); assert.equal(f.tree.root.findAllByType('dialog').length, 0);
    assert.equal(f.calls.filter(call => call.payload.action === 'list_opening_debts').length, 2);
  } finally { await f.close(); }
});
