// Exercise the actual financial dialogs with memory-only storage and backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as retry from '../src/lib/order-request-retry.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function dialog(file, name, backend) {
  const module = { exports: {} };
  const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const require = specifier => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === 'react-router-dom') return { useOutletContext: () => ({ user: { id: 'owner', role: 'admin' } }) };
    if (specifier === '@/lib/order-request-retry') return retry;
    if (specifier === '@/api/base44Client') return { base44: backend };
    if (specifier === '@/lib/odina-dialog') return { odinaAlert: async () => {} };
    if (specifier === '@/lib/pos') return { formatUZS: value => `${value} UZS`, formatNum: value => String(value) };
    if (specifier === '@/lib/uzbekistan-time') return { formatUzbekistanDateTime: () => '', uzbekistanDateKey: () => '2026-10-15', uzbekistanMonthStartKey: () => '2026-10-01' };
    if (specifier.endsWith('.css')) return {};
    if (specifier.endsWith('/OpeningDebtPaymentDialog')) return { OpeningDebtPaymentButton: () => null, hasPendingOpeningDebtPayment: () => false };
    if (specifier.endsWith('/SupplierProductsDialog')) return { default: () => null };
    if (specifier.endsWith('/odina-select')) return { default: wrapper('select') };
    if (specifier === '@/components/PageHeader') return { default: wrapper('div') };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrapper('span') });
    if (specifier.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, key) => wrapper(key === 'Button' ? 'button' : key === 'Input' ? 'input' : key === 'Textarea' ? 'textarea' : 'div') });
    throw new Error('Unexpected financial UI dependency: ' + specifier);
  };
  const source = readFileSync(file, 'utf8') + `\nexport { ${name} as TestDialog };`;
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console, crypto: webcrypto })(require, module, module.exports);
  return module.exports.TestDialog;
}
const submit = tree => tree.root.findAllByType('button').at(-1).props.onClick();
const input = (tree, type) => tree.root.findAllByType('input').find(node => node.props.type === type);
const enter = (node, value) => node.props.onChange({ target: { value } });
const withoutPin = payload => { const { owner_pin: _pin, ...rest } = payload; return rest; };

test('actual Budget adjustment dialog keeps its request through timeout/unmount and stale balance', async () => {
  globalThis.sessionStorage = storage(); const sent = []; let saved = 0;
  const backend = { functions: { invoke: async (_name, payload) => {
    sent.push(structuredClone(payload));
    if (sent.length === 1) throw new Error('Mock lost reply');
    return { data: { transaction: { id: 'transaction' } } };
  } } };
  const Component = dialog('src/pages/Budget.jsx', 'AdjustmentDialog', backend);
  const props = { actorId: 'owner', open: true, categories: [{ id: 'workers', name: 'Ishchilar uchun xarid' }], balances: { cash: 10000 }, onClose: () => {}, onSaved: () => { saved++; } };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, props)); });
  await act(async () => { tree.root.findAllByType('button')[1].props.onClick(); enter(input(tree, 'number'), '1000'); enter(tree.root.findByType('textarea'), 'Mock adjustment'); enter(input(tree, 'password'), '1234'); });
  await act(async () => { enter(tree.root.findAllByType('select')[1], 'workers'); });
  await act(async () => { await submit(tree); });
  const scope = retry.orderRequestScope('owner', 'manual_adjustment');
  assert.equal(retry.readOrderRequest(scope).amount, 1000);
  assert.equal(retry.readOrderRequest(scope).expense_category_id, 'workers');
  assert.equal(retry.readOrderRequest(scope).owner_pin, undefined);
  await act(async () => { tree.unmount(); tree = create(React.createElement(Component, { ...props, balances: { cash: 0 } })); });
  assert.equal(input(tree, 'number').props.disabled, true);
  assert.equal(input(tree, 'password').props.value, '');
  await act(async () => { enter(input(tree, 'number'), '999999'); enter(tree.root.findByType('textarea'), 'Changed note'); enter(input(tree, 'password'), '2468'); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, false);
  await act(async () => { await submit(tree); });
  assert.deepEqual(withoutPin(sent[1]), withoutPin(sent[0]));
  assert.equal(sent[1].owner_pin, '2468'); assert.equal(saved, 1);
  assert.equal(retry.readOrderRequest(scope), null);
  await act(async () => { tree.unmount(); });
});

test('warehouse supplier history keeps balances and receipt navigation without initiating payments', async () => {
  const calls = [], opened = [];
  const backend = { functions: { invoke: async (...args) => { calls.push(args); throw new Error('History must not initiate payments'); } } };
  const Component = dialog('src/components/warehouse/SupplierLedgerPanel.jsx', 'SupplierDetailDialog', backend);
  const receipt = { id: 'receipt', receipt_number: 'KR-REVIEW', total_amount: 1000, debt_amount: 1000,
    paid_at_receipt: 0, remaining_debt: 600, status: 'partial' };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, {
    supplier: { id: 'supplier', name: 'Mock supplier', receipts: [receipt], payments: [] },
    onReceipt: value => opened.push(value.id), onClose: () => {},
  })); });
  const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
  const content = text(tree.toJSON());
  assert.ok(content.includes('Mock supplier'));
  assert.ok(content.includes('1000 UZS'));
  assert.ok(content.includes('400 UZS'));
  assert.ok(content.includes('600 UZS'));
  assert.equal(tree.root.findAllByType('input').length, 0);
  const receiptButton = tree.root.findAllByType('button').find(node => text(node).includes('KR-REVIEW'));
  assert.ok(receiptButton);
  await act(async () => receiptButton.props.onClick());
  assert.deepEqual(opened, ['receipt']);
  assert.equal(calls.length, 0);
  await act(async () => { tree.unmount(); });
});

test('double-click opens a numeric amount keypad, edits the value and Done never submits a withdrawal', async () => {
  const calls = [];
  const Component = dialog('src/components/pos/KassaActionDialogs.jsx', 'CashWithdrawalDialog', {});
  let tree;
  await act(async () => { tree = create(React.createElement(Component, {
    open: true, shift: { id: 'shift', expected_cash: 100000 }, user: { id: 'cashier', role: 'cashier' },
    onClose: () => {}, onConfirm: payload => calls.push(payload), loading: false,
  })); });
  const key = label => tree.root.findAllByType('button').find(node => node.props['aria-label'] === label);
  await act(async () => { enter(input(tree, 'number'), '50000'); });
  await act(async () => { input(tree, 'number').props.onDoubleClick({ preventDefault() {} }); });
  assert.equal(tree.root.findAllByProps({ role: 'group' }).length, 1);
  assert.equal(tree.root.findAllByType('button').filter(node => /^\d$/.test(node.props['aria-label'] || '')).length, 10);
  await act(async () => { for (const digit of ['2', '0', '0', '0', '0']) key(digit).props.onClick(); });
  assert.equal(input(tree, 'number').props.value, '20000', 'first digit replaces the old selected amount');
  await act(async () => { key('Oxirgi raqamni o‘chirish').props.onClick(); });
  assert.equal(input(tree, 'number').props.value, '2000');
  await act(async () => { key('Miqdorni tozalash').props.onClick(); key('0').props.onClick(); key('1').props.onClick(); key('2').props.onClick(); });
  assert.equal(input(tree, 'number').props.value, '12');
  await act(async () => { tree.root.findAllByType('button').find(node => node.children.includes('Tayyor')).props.onClick(); });
  assert.equal(tree.root.findAllByProps({ role: 'group' }).length, 0);
  assert.equal(calls.length, 0, 'closing the keypad is separate from saving money');
  await act(async () => { submit(tree); });
  assert.equal(calls[0].amount, 12); assert.equal(calls[0].reason, '');
  await act(async () => { tree.unmount(); });
});

test('nearby touch and pen double-taps open the keypad, while slow taps and scrolling do not', async () => {
  const Component = dialog('src/components/pos/KassaActionDialogs.jsx', 'CashWithdrawalDialog', {});
  for (const pointerType of ['touch', 'pen']) {
    let tree;
    await act(async () => { tree = create(React.createElement(Component, {
      open: true, shift: { id: 'shift', expected_cash: 100000 }, user: { role: 'cashier' },
      onClose: () => {}, onConfirm: () => assert.fail('a tap cannot withdraw money'), loading: false,
    })); });
    const tap = async (timeStamp, clientX = 40) => act(async () => {
      input(tree, 'number').props.onPointerUp({ pointerType, timeStamp, clientX, clientY: 40, preventDefault() {} });
    });
    await tap(1000); await tap(1600);
    assert.equal(tree.root.findAllByProps({ role: 'group' }).length, 0);
    await tap(1800, 200);
    assert.equal(tree.root.findAllByProps({ role: 'group' }).length, 0, 'separated touches cannot act as a double-tap');
    await tap(2000, 205);
    assert.equal(tree.root.findAllByProps({ role: 'group' }).length, 1);
    await act(async () => { tree.unmount(); });
  }
});

test('a frozen supplier retry or saving state cannot open a keypad to alter the amount', async () => {
  const Component = dialog('src/components/pos/KassaActionDialogs.jsx', 'CashWithdrawalDialog', {});
  for (const extra of [{ loading: true }, { pendingSupplierPayment: { key: 'frozen-payment',
    payload: { shift_id: 'shift', supplier_id: 'supplier', amount: 20000, notes: '' } } }]) {
    let tree;
    await act(async () => { tree = create(React.createElement(Component, {
      open: true, shift: { id: 'shift', expected_cash: 100000 }, user: { role: 'cashier' },
      onClose: () => {}, onConfirm: () => assert.fail('read-only amount'), loading: false, ...extra,
    })); });
    assert.equal(input(tree, 'number').props.disabled, true);
    await act(async () => { input(tree, 'number').props.onDoubleClick({ preventDefault() {} }); });
    assert.equal(tree.root.findAllByProps({ role: 'group' }).length, 0);
    await act(async () => { tree.unmount(); });
  }
});

test('cash withdrawal can submit without a reason and preserves an optional entered note', async () => {
  const calls = [];
  const Component = dialog('src/components/pos/KassaActionDialogs.jsx', 'CashWithdrawalDialog', {});
  let tree;
  await act(async () => { tree = create(React.createElement(Component, {
    open: true, shift: { id: 'shift', expected_cash: 100000 }, user: { id: 'cashier', role: 'cashier' },
    onClose: () => {}, onConfirm: payload => calls.push(payload), loading: false,
  })); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, true);
  await act(async () => { enter(input(tree, 'number'), '20000'); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, false);
  await act(async () => { submit(tree); });
  assert.equal(calls[0].amount, 20000); assert.equal(calls[0].reason, '');
  await act(async () => { enter(tree.root.findByType('textarea'), '   '); submit(tree); });
  assert.equal(calls[1].reason, '');
  await act(async () => { enter(tree.root.findByType('textarea'), '  Transport xarajati  '); });
  await act(async () => { submit(tree); });
  assert.equal(calls[2].reason, 'Transport xarajati');
  await act(async () => { enter(input(tree, 'number'), '100001'); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, true);
  await act(async () => { tree.unmount(); });
});

test('actual cash dialog restores a pending supplier intent without applying current cash/debt limits', async () => {
  const calls = [];
  const Component = dialog('src/components/pos/KassaActionDialogs.jsx', 'CashWithdrawalDialog', {});
  const pending = { key: 'supplier-request', payload: { shift_id: 'shift', supplier_id: 'supplier', amount: 1000, notes: 'Frozen supplier note' } };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, {
    open: true, shift: { id: 'shift', expected_cash: 100 }, user: { id: 'cashier', role: 'cashier' },
    recipients: [{ id: 'supplier', name: 'Mock supplier' }], supplierDebts: { supplier: 0 }, pendingSupplierPayment: pending,
    onClose: () => {}, onConfirm: payload => calls.push(payload), loading: false,
  })); });
  assert.equal(input(tree, 'number').props.value, '1000');
  assert.equal(input(tree, 'number').props.disabled, true);
  assert.equal(tree.root.findByType('textarea').props.disabled, true);
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, true);
  await act(async () => { enter(input(tree, 'password'), '2468'); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, false);
  await act(async () => { submit(tree); });
  assert.equal(calls[0].amount, 1000); assert.equal(calls[0].reason, 'Frozen supplier note');
  assert.equal(calls[0].recipient_id, 'supplier'); assert.equal(calls[0].owner_pin, '2468');
  await act(async () => { tree.unmount(); });
});

test('category dialog cancels without writes, resets on reopen, and prevents repeated clicks', async () => {
  const calls = []; let resolveSave; let saved = 0; let closed = 0;
  const Component = dialog('src/pages/Budget.jsx', 'CategoryDialog', { functions: { invoke: async (_name, payload) => {
    calls.push(payload); return new Promise(resolve => { resolveSave = resolve; });
  } } });
  const props = { open: true, onClose: () => { closed++; }, onSaved: () => { saved++; } };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, props)); });
  await act(async () => { enter(tree.root.findByType('input'), 'Cancelled'); });
  await act(async () => { tree.root.findAllByType('button')[0].props.onClick(); });
  assert.equal(closed, 1); assert.equal(calls.length, 0);
  await act(async () => { tree.update(React.createElement(Component, { ...props, open: false })); });
  await act(async () => { tree.update(React.createElement(Component, props)); });
  assert.equal(tree.root.findByType('input').props.value, '');
  await act(async () => { enter(tree.root.findByType('input'), 'Ishchilar uchun xarid'); });
  let pending;
  await act(async () => { pending = submit(tree); submit(tree); });
  assert.equal(calls.length, 1);
  await act(async () => { resolveSave({ data: { category: { id: 'workers', name: 'Ishchilar uchun xarid' } } }); await pending; });
  assert.equal(saved, 1);
  await act(async () => { tree.unmount(); });
});

test('actual Kassa dialog offers opening-only suppliers, caps debt/cash and keeps cashier PIN required', async () => {
  const Component = dialog('src/components/pos/KassaActionDialogs.jsx', 'CashWithdrawalDialog', {});
  const calls = []; let tree;
  const props = { open: true, shift: { id: 'shift', expected_cash: 3000 }, user: { id: 'cashier', role: 'cashier' },
    recipients: [{ id: 'opening-only', name: 'Opening supplier' }, { id: 'paid', name: 'Paid supplier' },
      { id: 'cancelled', name: 'Cancelled supplier' }], supplierDebts: { 'opening-only': 5000 },
    onClose: () => {}, onConfirm: payload => calls.push(payload), loading: false };
  await act(async () => { tree = create(React.createElement(Component, props)); });
  await act(async () => { enter(tree.root.findByType('select'), 'goods_payment'); });
  const suppliers = tree.root.findAllByType('select')[1];
  assert.deepEqual(suppliers.findAllByType('option').map(n => n.props.value), ['', 'opening-only']);
  await act(async () => { enter(suppliers, 'opening-only'); enter(input(tree, 'number'), '1000'); });
  assert.equal(input(tree, 'number').props.max, 3000);
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, true, 'missing owner PIN blocks cashier');
  await act(async () => { enter(input(tree, 'password'), '2468'); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, false);
  await act(async () => { enter(input(tree, 'number'), '3001'); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, true, 'cash cap enforced');
  await act(async () => { tree.update(React.createElement(Component, { ...props, shift: { id: 'shift', expected_cash: 10000 } })); });
  assert.equal(input(tree, 'number').props.max, 5000);
  await act(async () => { enter(input(tree, 'number'), '5001'); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, true, 'debt cap enforced');
  await act(async () => { enter(input(tree, 'number'), '1000'); });
  await act(async () => { await submit(tree); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipient_id, 'opening-only'); assert.equal(calls[0].amount, 1000);
  assert.equal(calls[0].owner_pin, '2468');
  await act(async () => { tree.unmount(); });
});

test('POS cash refresh reads only and ignores an older response after newer debt totals arrive', async () => {
  const source = readFileSync('src/pages/POS.jsx', 'utf8');
  const start = source.indexOf('  const loadCashData = async');
  const end = source.indexOf('\n  const loadWasteAlerts', start);
  assert.ok(start >= 0 && end > start);
  const pending = [], calls = [], state = {};
  const context = { loadGenerationRef: { current: 1 }, cashDataReadGenerationRef: { current: 0 },
    setCashDataLoading: value => { state.loading = value; }, setCashDataError: value => { state.error = value; },
    setCashRecipients: value => { state.recipients = value; }, setSupplierDebts: value => { state.debts = value; },
    base44: { entities: { CashRecipient: { list: async () => [{ id: 'supplier', active: true }] } },
      functions: { invoke: (name, payload) => { calls.push([name, payload]); return new Promise(resolve => pending.push(resolve)); } } } };
  const load = vm.runInNewContext(source.slice(start, end) + '\nloadCashData;', context);
  const old = load(); const fresh = load();
  pending[1]({ data: { debts: { supplier: 4000 } } }); await fresh;
  pending[0]({ data: { debts: { supplier: 5000 } } }); await old;
  assert.equal(state.debts.supplier, 4000); assert.equal(state.loading, false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([name, payload]) => name === 'supplier-ledger' && payload.action === 'get_debts'));
  assert.match(source, /onClick=\{\(\) => \{ void loadCashData\(\); setCashWithdrawalOpen\(true\); \}\}/);
});
