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
  const props = { actorId: 'owner', open: true, balances: { cash: 10000 }, onClose: () => {}, onSaved: () => { saved++; } };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, props)); });
  await act(async () => { tree.root.findAllByType('button')[1].props.onClick(); enter(input(tree, 'number'), '1000'); enter(tree.root.findByType('textarea'), 'Mock adjustment'); enter(input(tree, 'password'), '1234'); });
  await act(async () => { await submit(tree); });
  const scope = retry.orderRequestScope('owner', 'manual_adjustment');
  assert.equal(retry.readOrderRequest(scope).amount, 1000);
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

test('actual Budget supplier dialog restores a frozen payment after refresh even when debt is now zero', async () => {
  globalThis.sessionStorage = storage(); const sent = []; let paid = 0; let available = 10000;
  const backend = { functions: { invoke: async (_name, payload) => {
    if (payload.action === 'summary') return { data: { balances: [{ account: 'cash', balance: available }] } };
    sent.push(structuredClone(payload));
    if (sent.length === 1) throw new Error('Mock lost reply');
    return { data: { paid: true } };
  } } };
  const Component = dialog('src/components/warehouse/SupplierLedgerPanel.jsx', 'BudgetSupplierPaymentDialog', backend);
  const supplier = { id: 'supplier', name: 'Mock supplier', receipts: [{ remaining_debt: 1000, status: 'unpaid' }] };
  const props = { actorId: 'owner', supplier, onClose: () => {}, onPaid: () => { paid++; } };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, props)); });
  await act(async () => { enter(tree.root.findByType('textarea'), 'Mock supplier note'); enter(input(tree, 'password'), '1234'); });
  await act(async () => { await submit(tree); });
  const scope = retry.orderRequestScope('owner', 'pay_supplier');
  assert.equal(retry.readOrderRequest(scope).owner_pin, undefined);
  available = 0;
  await act(async () => { tree.unmount(); tree = create(React.createElement(Component, { ...props, supplier: { ...supplier, receipts: [{ remaining_debt: 0, status: 'paid' }] } })); });
  assert.equal(input(tree, 'number').props.disabled, true);
  await act(async () => { enter(input(tree, 'number'), '2000'); enter(tree.root.findByType('textarea'), 'Changed note'); enter(input(tree, 'password'), '2468'); });
  assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, false);
  await act(async () => { await submit(tree); });
  assert.deepEqual(withoutPin(sent[1]), withoutPin(sent[0]));
  assert.equal(paid, 1); assert.equal(retry.readOrderRequest(scope), null);
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
