// Render the actual dialogs with a mocked backend. Every mutation stays in memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as retry from '../src/lib/order-request-retry.js';
import * as timing from '../src/lib/order-action-timing.js';

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function dialog(name, backend, { clock = globalThis.performance, toasts = [] } = {}) {
  const module = { exports: {} }; let keyCount = 0;
  const wrapper = (tag) => ({ children, ...props }) => React.createElement(tag, props, children);
  const require = (specifier) => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === '@/lib/AuthContext') return { useAuth: () => ({ user: { id: 'staff', shop_id: 'shop', role: 'cashier' } }) };
    if (specifier === '@/lib/order-request-retry') return retry;
    if (specifier === '@/lib/order-action-timing') return { startOrderActionTiming: () => timing.startOrderActionTiming(clock) };
    if (specifier === '@/api/base44Client') return { base44: backend };
    if (specifier === '@/components/ui/use-toast') return { useToast: () => ({ toast: (value) => toasts.push(value) }) };
    if (specifier === '@/lib/pos') return { formatUZS: (amount) => `${amount} UZS`, PAYMENT_METHODS: [{ id: 'cash', label: 'Naqd' }] };
    if (specifier === '@/lib/orders') return { displayOrderNumber: (order) => order?.order_number || '', buildIdempotencyKey: (kind) => `${kind}-key-${++keyCount}`,
      ORDER_TYPES: [{ key: 'tugilgan_kun_va_boshqa', label: 'Buyurtma' }], FULFILMENT_TYPES: [], CAKE_SHAPES: [], MONTHS_UZ: [],
      tashkentNowParts: () => ({ year: 2026, month: 10, day: 15 }), tashkentNowStamp: () => '2026-10-15',
      composeRequiredDate: (year, month, day) => day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '',
      isFutureDateTime: () => true };
    if (specifier === '@/lib/shop-pricing') return { priceForShop: (product) => product.price };
    if (specifier.endsWith('/ProductCombobox') || specifier.endsWith('/ReferenceImageField')) return { default: wrapper('div') };
    if (specifier.endsWith('/odina-select')) return { default: wrapper('select') };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrapper('span') });
    if (specifier.startsWith('@/components/ui/')) return new Proxy({}, { get: (_obj, key) => wrapper(key === 'Button' ? 'button' : key === 'Input' ? 'input' : 'div') });
    throw new Error('Unexpected UI test dependency: ' + specifier);
  };
  const code = ts.transpileModule(readFileSync(`src/components/orders/${name}.jsx`, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console })(require, module, module.exports);
  return { Component: module.exports.default, keyCount: () => keyCount };
}
const order = { id: 'order', order_number: 'BO-1', remaining_balance: 10000, fulfilment_type: 'pickup' };
const submit = (tree) => tree.root.findAllByType('button').at(-1).props.onClick();
const mockClock = () => {
  let now = 1000; let reads = 0;
  return { now: () => { reads++; return now; }, advance: (milliseconds) => { now += milliseconds; }, reads: () => reads };
};
const formProps = {
  open: true, user: { id: 'staff', role: 'cashier', shop_id: 'shop' }, shops: [{ id: 'shop', name: 'Odina' }],
  onClose: () => {}, onCreated: () => {},
  prefill: { order: { ...order, customer_name: 'Vali', customer_phone: '+998901234567', order_type: 'tugilgan_kun_va_boshqa' },
    items: [{ product_id: 'cake', quantity: 1 }] },
};
const products = { Product: { list: async () => [{ id: 'cake', name: 'MINI tort', active: true, price: 20000, production_unit: 'piece' }] } };
async function chooseFormDate(tree) {
  const day = tree.root.findAllByType('select').find((select) => select.findAllByType('option').some((option) => option.props.children === 'Kun'));
  await act(async () => { day.props.onChange({ target: { value: '20' } }); });
}

test('actual payment dialog retains key, method and amount after a lost reply and unmount', async () => {
  globalThis.sessionStorage = storage(); const sent = [];
  const backend = { functions: { invoke: async (_name, payload) => { sent.push(structuredClone(payload)); throw new Error('reply lost'); } } };
  const loaded = dialog('OrderPaymentDialog', backend); let tree;
  const props = { open: true, order, onClose: () => {}, onDone: () => {} };
  await act(async () => { tree = create(React.createElement(loaded.Component, props)); });
  await act(async () => { await submit(tree); });
  assert.equal(tree.root.findByType('fieldset').props.disabled, true);
  await act(async () => { tree.unmount(); tree = create(React.createElement(loaded.Component, props)); });
  await act(async () => { tree.root.findByType('input').props.onChange({ target: { value: '999999' } }); });
  await act(async () => { await submit(tree); });
  assert.deepEqual(sent[1], sent[0]); assert.equal(loaded.keyCount(), 1);
  await act(async () => { tree.unmount(); });
});

test('actual payment dialog retains a late HTTP 400 but permits edits after explicit preclaim rejection', async () => {
  for (const notStarted of [false, true]) {
    globalThis.sessionStorage = storage(); const sent = []; let attempts = 0;
    const backend = { functions: { invoke: async (_name, payload) => {
      sent.push(structuredClone(payload));
      if (++attempts === 1) throw Object.assign(new Error('request rejected'), { response: { status: 400, data: { request_not_started: notStarted } } });
      return { data: { payment: { id: 'saved' } } };
    } } };
    const loaded = dialog('OrderPaymentDialog', backend); let tree;
    await act(async () => { tree = create(React.createElement(loaded.Component, { open: true, order, onClose: () => {}, onDone: () => {} })); });
    await act(async () => { await submit(tree); });
    assert.equal(tree.root.findByType('fieldset').props.disabled, !notStarted);
    await act(async () => { tree.root.findByType('input').props.onChange({ target: { value: '5000' } }); });
    await act(async () => { await submit(tree); });
    if (notStarted) {
      assert.equal(sent[1].amount, 5000); assert.notEqual(sent[1].idempotency_key, sent[0].idempotency_key);
    } else assert.deepEqual(sent[1], sent[0]);
    await act(async () => { tree.unmount(); });
  }
});

test('actual completion dialog retries its frozen balance even if refreshed order is now fully paid', async () => {
  globalThis.sessionStorage = storage(); const sent = []; let attempts = 0; let done = 0;
  const backend = { functions: { invoke: async (_name, payload) => {
    sent.push(structuredClone(payload)); if (++attempts === 1) throw new Error('reply lost');
    return { data: { order: { ...order, order_status: 'yakunlandi' } } };
  } } };
  const loaded = dialog('OrderCompleteDialog', backend); let tree;
  const props = { open: true, order, onClose: () => {}, onDone: () => { done++; } };
  await act(async () => { tree = create(React.createElement(loaded.Component, props)); });
  await act(async () => { await submit(tree); });
  await act(async () => { tree.update(React.createElement(loaded.Component, { ...props, order: { ...order, remaining_balance: 0 } })); });
  await act(async () => { await submit(tree); });
  assert.deepEqual(sent[1], sent[0]); assert.equal(sent[1].amount, 10000); assert.equal(loaded.keyCount(), 1); assert.equal(done, 1);
  assert.equal(retry.readOrderRequest(retry.orderRequestScope('staff', 'complete_order', 'order')), null);
  await act(async () => { tree.unmount(); });
});

test('actual order form restores and retries its saved creation/advance request without generating new keys', async () => {
  globalThis.sessionStorage = storage(); const sent = [];
  const payload = { action: 'create_order', idempotency_key: 'saved-order-key', shop_id: 'shop', order_type: 'tugilgan_kun_va_boshqa',
    customer_name: 'Vali', customer_phone: '+998901234567', required_date: '2026-10-20', required_time: '18:00',
    fulfilment_type: 'pickup', items: [{ product_id: 'cake', quantity: 1 }], advance_payment: { method: 'cash', amount: 10000, idempotency_key: 'saved-advance-key' } };
  retry.retainOrderRequest(retry.orderRequestScope('staff', 'create_order'), payload);
  const backend = { functions: { invoke: async (_name, body) => { sent.push(structuredClone(body)); throw new Error('still unknown'); } },
    entities: { Product: { list: async () => [{ id: 'cake', name: 'MINI tort', active: true, price: 20000, production_unit: 'piece' }] } } };
  const loaded = dialog('OrderForm', backend); let tree;
  await act(async () => { tree = create(React.createElement(loaded.Component, { open: true, user: { id: 'staff', role: 'cashier', shop_id: 'shop' },
    shops: [{ id: 'shop', name: 'Odina' }], onClose: () => {}, onCreated: () => {} })); });
  assert.equal(tree.root.findByType('fieldset').props.disabled, true);
  await act(async () => { await submit(tree); });
  assert.deepEqual(sent[0], payload); assert.equal(loaded.keyCount(), 0);
  await act(async () => { tree.unmount(); });
});

test('creation timing includes request preparation and response, excludes later callbacks, and labels saved replays', async () => {
  for (const alreadyExists of [false, true]) {
    globalThis.sessionStorage = storage(); const clock = mockClock(); const toasts = []; const sent = []; let created = 0;
    const setItem = globalThis.sessionStorage.setItem;
    globalThis.sessionStorage.setItem = (key, value) => { clock.advance(300); setItem(key, value); };
    const backend = { entities: products, functions: { invoke: async (_name, payload) => {
      sent.push(structuredClone(payload)); await Promise.resolve(); clock.advance(2100);
      return { data: { order: { ...order, order_number: '10' }, items: [], already_exists: alreadyExists } };
    } } };
    const loaded = dialog('OrderForm', backend, { clock, toasts }); let tree;
    await act(async () => { tree = create(React.createElement(loaded.Component, { ...formProps, onCreated: () => {
      assert.equal(clock.reads(), 2, 'timing stops before parent refresh/printing callbacks');
      clock.advance(90000); created++;
    } })); });
    await chooseFormDate(tree);
    assert.equal(clock.reads(), 0, 'rendering and editing do not read the action clock');
    await act(async () => { await submit(tree); });
    const success = toasts.find((toast) => toast.title === 'Buyurtma yaratildi');
    assert.equal(success?.description, `10 · ${alreadyExists ? 'Qayta tekshirish' : 'Saqlash'}: 2,4 soniya`);
    assert.equal(created, 1); assert.equal(clock.reads(), 2); assert.equal(sent.length, 1);
    assert.equal(Object.keys(sent[0]).some((key) => /duration|elapsed|timing/i.test(key)), false, 'timing never enters financial requests');
    assert.equal(retry.readOrderRequest(retry.orderRequestScope('staff', 'create_order')), null);
    await act(async () => { tree.unmount(); });
  }
});

test('completion timing stops before follow-up refresh and labels already-completed confirmations', async () => {
  for (const alreadyCompleted of [false, true]) {
    globalThis.sessionStorage = storage(); const clock = mockClock(); const toasts = []; const sent = [];
    const backend = { functions: { invoke: async (_name, payload) => {
      sent.push(structuredClone(payload)); await Promise.resolve(); clock.advance(2400);
      return { data: { order, already_completed: alreadyCompleted } };
    } } };
    const loaded = dialog('OrderCompleteDialog', backend, { clock, toasts }); let tree;
    await act(async () => { tree = create(React.createElement(loaded.Component, { open: true, order, onClose: () => {}, onDone: () => {
      assert.equal(clock.reads(), 2); clock.advance(90000);
    } })); });
    await act(async () => { await submit(tree); });
    assert.equal(toasts[0]?.description, `BO-1 · ${alreadyCompleted ? 'Qayta tekshirish' : 'Yakunlash'}: 2,4 soniya`);
    assert.equal(clock.reads(), 2); assert.equal(sent.length, 1);
    assert.equal(Object.keys(sent[0]).some((key) => /duration|elapsed|timing/i.test(key)), false);
    await act(async () => { tree.unmount(); });
  }
});

test('retry timing measures only this confirmation attempt and preserves the exact financial intent', async () => {
  globalThis.sessionStorage = storage(); const clock = mockClock(); const toasts = []; const sent = []; let attempts = 0;
  const backend = { functions: { invoke: async (_name, payload) => {
    sent.push(structuredClone(payload));
    if (++attempts === 1) { clock.advance(900); throw new Error('reply lost'); }
    clock.advance(2400); return { data: { order } };
  } } };
  const loaded = dialog('OrderCompleteDialog', backend, { clock, toasts }); let tree;
  const props = { open: true, order, onClose: () => {}, onDone: () => {} };
  await act(async () => { tree = create(React.createElement(loaded.Component, props)); });
  await act(async () => { await submit(tree); });
  assert.equal(toasts.length, 1); assert.equal(toasts[0].variant, 'destructive'); assert.doesNotMatch(toasts[0].description, /soniya/);
  clock.advance(60000);
  await act(async () => { tree.unmount(); tree = create(React.createElement(loaded.Component, props)); });
  await act(async () => { await submit(tree); });
  assert.equal(toasts[1]?.description, 'BO-1 · Qayta tekshirish: 2,4 soniya');
  assert.deepEqual(sent[1], sent[0]); assert.equal(loaded.keyCount(), 1); assert.equal(clock.reads(), 3);
  await act(async () => { tree.unmount(); });
});

test('invalid forms and failed responses never display a successful elapsed duration', async () => {
  globalThis.sessionStorage = storage(); const clock = mockClock(); const toasts = []; let calls = 0;
  const backend = { entities: products, functions: { invoke: async () => { calls++; clock.advance(1000); return { data: { error: 'Natija noaniq', operation_pending: true } }; } } };
  const form = dialog('OrderForm', backend, { clock, toasts }); let tree;
  await act(async () => { tree = create(React.createElement(form.Component, { ...formProps, prefill: null })); });
  await act(async () => { await submit(tree); });
  assert.equal(calls, 0); assert.equal(clock.reads(), 0, 'invalid submit never starts timing');
  assert.ok(toasts.every((toast) => toast.variant === 'destructive' && !String(toast.description).includes('soniya')));
  await act(async () => { tree.unmount(); });
  toasts.length = 0;
  const complete = dialog('OrderCompleteDialog', backend, { clock, toasts });
  await act(async () => { tree = create(React.createElement(complete.Component, { open: true, order, onClose: () => {}, onDone: () => assert.fail('failed response cannot complete') })); });
  await act(async () => { await submit(tree); });
  assert.equal(calls, 1); assert.equal(clock.reads(), 1, 'only a valid successful response stops and publishes timing');
  assert.equal(toasts.length, 1); assert.equal(toasts[0].variant, 'destructive'); assert.doesNotMatch(toasts[0].description, /soniya/);
  assert.ok(retry.readOrderRequest(retry.orderRequestScope('staff', 'complete_order', 'order')), 'ambiguous requests stay frozen');
  await act(async () => { tree.unmount(); });
});

test('elapsed formatting uses two reads with a safe Date.now fallback and clamps backward clocks', () => {
  const originalNow = Date.now; let now = 1000; let reads = 0;
  Date.now = () => { reads++; return now; };
  try {
    const stop = timing.startOrderActionTiming({}); now = 3400;
    assert.equal(stop(), '2,4'); assert.equal(reads, 2);
  } finally { Date.now = originalNow; }
  const values = [5000, 4000];
  const stop = timing.startOrderActionTiming({ now: () => values.shift() });
  assert.equal(stop(), '0,0'); assert.equal(values.length, 0);
});
