// Actual React component tests with memory-only UI/storage doubles. No SDK,
// network, payment processor, browser dialog or printer can be invoked here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Use the actual picker configuration while keeping the live SDK out of tests.
const methodDeclaration = readFileSync('src/lib/pos.js', 'utf8')
  .match(/export const PAYMENT_METHODS = (\[[\s\S]*?\n\]);/);
assert.ok(methodDeclaration, 'Expected the shared payment-method configuration');
const methods = JSON.parse(JSON.stringify(vm.runInNewContext(methodDeclaration[1], {})));
const text = node => typeof node === 'string' || typeof node === 'number'
  ? String(node) : (node.children || []).map(text).join('');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(initial = {}, preference = 'on') {
  const storage = new Map([['odina-pos:print-receipt', preference]]);
  const confirmations = [], closed = [];
  const Wrapper = ({ children }) => React.createElement('div', null, children);
  const Icon = props => React.createElement('svg', { ...props, 'aria-hidden': true });
  const dependencies = {
    react: React,
    '@/components/ui/odina-select': props => React.createElement('select', props),
    '@/components/ui/dialog': { Dialog: Wrapper, DialogContent: Wrapper, DialogHeader: Wrapper, DialogTitle: Wrapper },
    '@/components/ui/button': { Button: props => React.createElement('button', props) },
    '@/components/ui/input': { Input: props => React.createElement('input', props) },
    '@/components/ui/switch': { Switch: ({ onCheckedChange, ...props }) => React.createElement('input', {
      ...props, type: 'checkbox', onChange: event => onCheckedChange(event.target.checked),
    }) },
    'lucide-react': Object.fromEntries(['Plus', 'X', 'Check', 'CreditCard', 'Smartphone', 'Banknote', 'ReceiptText'].map(name => [name, Icon])),
    '@/lib/pos': { PAYMENT_METHODS: methods, formatUZS: value => `${Number(value) || 0} UZS` },
  };
  const module = { exports: {} };
  const source = readFileSync('src/components/pos/PaymentModal.jsx', 'utf8');
  const compiled = transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'transform' }).code;
  vm.runInNewContext(`(function(require,module,exports){${compiled}\n})`, {
    window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } },
  })(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected PaymentModal dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  const Modal = module.exports.default;
  let props = { open: true, total: 15000, attemptKey: 'attempt-a', loading: false,
    onClose: () => closed.push(true), onConfirm: (...args) => confirmations.push(clone(args)), ...initial };
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(Modal, props)); });
  const buttons = () => renderer.root.findAllByType('button');
  const click = button => {
    assert.ok(button, 'Expected a rendered button');
    assert.ok(!button.props.disabled, 'A disabled native button must not receive a user click');
    act(() => { button.props.onClick(); });
  };
  const update = next => {
    props = { ...props, ...next };
    act(() => { renderer.update(React.createElement(Modal, props)); });
  };
  const choose = id => {
    if (!buttons().some(button => button.props.className?.includes('odina-payment-method '))) {
      click(buttons().find(button => button.props['aria-expanded'] !== undefined));
    }
    click(buttons().find(button => button.props.className?.includes('odina-payment-method ')
      && text(button).includes(methods.find(method => method.id === id).label)));
  };
  const rows = () => renderer.root.findAllByType('select').map((select, index) => ({
    method: select.props.value,
    amount: renderer.root.findAllByType('input').filter(input => input.props.type === 'number')[index].props.value,
  }));
  const editAmount = (index, value) => act(() => {
    renderer.root.findAllByType('input').filter(input => input.props.type === 'number')[index]
      .props.onChange({ target: { value: String(value) } });
  });
  const changeMethod = (index, method) => act(() => {
    renderer.root.findAllByType('select')[index].props.onChange({ target: { value: method } });
  });
  const receipt = () => renderer.root.findByProps({ type: 'checkbox' });
  const setReceipt = checked => act(() => { receipt().props.onChange({ target: { checked } }); });
  const confirm = () => buttons().find(button => button.props.className?.includes('odina-payment-confirm'));
  const split = () => { choose('cash'); choose('bank_card'); editAmount(1, 5000); };
  return { renderer, buttons, click, update, choose, rows, editAmount, changeMethod, receipt, setReceipt,
    confirm, split, confirmations, closed, storage, unmount: () => act(() => renderer.unmount()) };
}

test('Kassa offers separate HUMO and UZCARD choices without removing existing payment methods', () => {
  assert.deepEqual(methods.map(method => method.id), ['cash', 'bank_card', 'uzcard', 'humo', 'online']);
  assert.equal(new Set(methods.map(method => method.id)).size, methods.length);
  const f = fixture();
  try {
    const picker = f.buttons().filter(button => button.props.className?.includes('odina-payment-method '));
    assert.deepEqual(picker.map(text), methods.map(method => method.label));
    assert.equal(methods.find(method => method.id === 'humo').label, 'HUMO');
    assert.equal(methods.find(method => method.id === 'uzcard').label, 'UZCARD');
  } finally { f.unmount(); }
});

for (const method of ['humo', 'uzcard']) {
  test(`${method}: full payment reaches Yakunlash with its own method ID and exact amount`, () => {
    const f = fixture({ total: 25000 });
    try {
      f.choose(method);
      assert.deepEqual(f.rows(), [{ method, amount: 25000 }]);
      f.click(f.confirm());
      assert.deepEqual(f.confirmations, [[[{ method, amount: 25000 }], true]]);
    } finally { f.unmount(); }
  });
}

test('HUMO, UZCARD and cash split balances correctly and survives a same-attempt retry', () => {
  const f = fixture({ total: 25000 });
  try {
    f.choose('cash'); f.choose('humo'); f.editAmount(1, 10000);
    f.choose('uzcard'); f.editAmount(2, 5000); f.setReceipt(false);
    const expected = [{ method: 'cash', amount: 10000 }, { method: 'humo', amount: 10000 }, { method: 'uzcard', amount: 5000 }];
    assert.deepEqual(f.rows(), expected);
    for (const select of f.renderer.root.findAllByType('select')) {
      const choices = select.findAllByType('option').map(option => option.props.value);
      assert.ok(expected.filter(row => row.method !== select.props.value).every(row => !choices.includes(row.method)));
    }
    f.update({ open: false }); f.update({ open: true, retryPending: true });
    assert.deepEqual(f.rows(), expected);
    f.click(f.confirm());
    assert.deepEqual(f.confirmations, [[expected, false]]);
  } finally { f.unmount(); }
});

test('same checkout attempt preserves split methods, amounts and receipt preference across close and reopen', () => {
  const f = fixture();
  try {
    f.split(); f.changeMethod(0, 'online'); f.setReceipt(false);
    const expected = [{ method: 'online', amount: 10000 }, { method: 'bank_card', amount: 5000 }];
    assert.deepEqual(f.rows(), expected);
    f.update({ open: false }); assert.equal(f.renderer.toJSON(), null);
    f.update({ open: true });
    assert.deepEqual(f.rows(), expected);
    assert.equal(f.receipt().props.checked, false);
    assert.equal(f.storage.get('odina-pos:print-receipt'), 'off');
    assert.deepEqual(f.confirmations, [], 'lifecycle effects must never submit a payment');
  } finally { f.unmount(); }
});

test('a new attempt key resets prior payment rows even if the key changes while the modal is closed', () => {
  const f = fixture();
  try {
    f.split(); f.setReceipt(false);
    f.update({ open: false });
    f.update({ attemptKey: 'attempt-b', total: 22000 });
    f.update({ open: true });
    assert.deepEqual(f.rows(), []);
    assert.equal(f.receipt().props.checked, false, 'receipt preference is intentionally stored across attempts');
    f.choose('online');
    assert.deepEqual(f.rows(), [{ method: 'online', amount: 22000 }]);
  } finally { f.unmount(); }
});

test('legacy callers without attempt keys still start with empty payment rows on every open', () => {
  const f = fixture({ attemptKey: '' });
  try {
    f.choose('cash');
    f.update({ open: false }); f.update({ open: true });
    assert.deepEqual(f.rows(), []);
    assert.ok(f.confirm().props.disabled);
  } finally { f.unmount(); }
});

test('retryPending disables payment method, amount, add and remove controls without disabling the retry', () => {
  const f = fixture();
  try {
    f.split();
    f.click(f.buttons().find(button => button.props['aria-expanded'] !== undefined));
    f.update({ retryPending: true });
    assert.ok(f.renderer.root.findAllByType('select').every(select => select.props.disabled));
    assert.ok(f.renderer.root.findAllByType('input').filter(input => input.props.type === 'number').every(input => input.props.disabled));
    const removal = f.buttons().filter(button => button.props['aria-label'] === 'To‘lov usulini olib tashlash');
    assert.equal(removal.length, 2); assert.ok(removal.every(button => button.props.disabled));
    assert.ok(f.buttons().find(button => button.props['aria-expanded'] !== undefined).props.disabled);
    const picker = f.buttons().filter(button => button.props.className?.includes('odina-payment-method '));
    assert.equal(picker.length, methods.length - 2); assert.ok(picker.every(button => button.props.disabled));
    assert.ok(f.buttons().find(button => text(button) === 'Bekor qilish').props.disabled);
    assert.equal(f.confirm().props.disabled, false);
    assert.deepEqual(f.rows(), [{ method: 'cash', amount: 10000 }, { method: 'bank_card', amount: 5000 }]);
  } finally { f.unmount(); }
});

test('Yakunlash retries the preserved payment methods and print preference once after reopen', () => {
  const f = fixture();
  try {
    f.split(); f.setReceipt(false);
    f.update({ open: false }); f.update({ open: true, retryPending: true });
    f.click(f.confirm());
    assert.deepEqual(f.confirmations, [[[
      { method: 'cash', amount: 10000 }, { method: 'bank_card', amount: 5000 },
    ], false]]);
    f.update({ loading: true });
    assert.ok(f.confirm().props.disabled);
    act(() => { f.confirm().props.onClick(); });
    assert.equal(f.confirmations.length, 1, 'the current loading handler also rejects a stale/programmatic submit');
  } finally { f.unmount(); }
});

test('changing totals retains the existing full-payment and split-balance rules', () => {
  const f = fixture();
  try {
    f.choose('cash'); f.update({ total: 20000 });
    assert.deepEqual(f.rows(), [{ method: 'cash', amount: 20000 }]);
    f.choose('bank_card'); f.editAmount(1, 5000); f.update({ total: 18000 });
    assert.deepEqual(f.rows(), [{ method: 'cash', amount: 13000 }, { method: 'bank_card', amount: 5000 }]);
    f.click(f.confirm());
    assert.deepEqual(f.confirmations[0][0], f.rows());
  } finally { f.unmount(); }
});

test('a manually edited partial payment stays partial after a total change and cannot falsely confirm', () => {
  const f = fixture();
  try {
    f.choose('cash'); f.editAmount(0, 10000); f.update({ total: 20000 });
    assert.deepEqual(f.rows(), [{ method: 'cash', amount: 10000 }]);
    f.click(f.confirm());
    assert.equal(f.confirmations.length, 0);
    assert.ok(f.renderer.root.findAllByProps({ role: 'alert' }).some(node => text(node).includes('Farq:')));
  } finally { f.unmount(); }
});
