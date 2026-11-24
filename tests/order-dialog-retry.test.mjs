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
import * as orders from '../src/lib/orders.js';
import * as shopCategory from '../src/lib/shop-category.js';
import { loadAllInventoryItems } from '../src/lib/cake-stock-shelf.js';
import { priceForShop } from '../src/lib/shop-pricing.js';

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function dialog(name, backend, { clock = globalThis.performance, toasts = [], shopStamp = () => '2026-10-15 12:00', browser = {} } = {}) {
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
    if (specifier === '@/lib/orders') return { ...orders, buildIdempotencyKey: (kind) => `${kind}-key-${++keyCount}`,
      tashkentNowStamp: shopStamp, isFutureDateTime: (date, time) => `${date} ${time}` >= shopStamp() };
    if (specifier === '@/lib/shop-pricing') return { priceForShop };
    if (specifier === '@/lib/shop-category') return shopCategory;
    if (specifier === '@/lib/cake-stock-shelf') return { loadAllInventoryItems };
    if (specifier === '@/lib/product-photos') return { productPhotoFallbackFor: () => '' };
    if (specifier.endsWith('/ProductCombobox') || specifier.endsWith('/ReferenceImageField')) return { default: wrapper('div') };
    if (specifier.endsWith('/odina-select')) return { default: wrapper('select') };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrapper('span') });
    if (specifier.startsWith('@/components/ui/')) return new Proxy({}, { get: (_obj, key) => wrapper(key === 'Button' ? 'button' : key === 'Input' ? 'input' : 'div') });
    throw new Error('Unexpected UI test dependency: ' + specifier);
  };
  const code = ts.transpileModule(readFileSync(`src/components/orders/${name}.jsx`, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console, ...browser })(require, module, module.exports);
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
const cakeCategory = { id: shopCategory.CAKE_CATEGORY_ID, name: 'Tortlar', active: true };
const products = { Category: { get: async () => cakeCategory }, Product: { list: async () => [
  { id: 'cake', category_id: cakeCategory.id, name: 'Bento', active: true, price: 20000, production_unit: 'piece' },
] } };
const dueSelect = (tree, part) => tree.root.findAllByType('select').find(node => node.props.id === 'order-due-' + part);
const options = (tree, part) => dueSelect(tree, part).findAllByType('option').map(node => Number(node.props.value));
const chooseDatePart = (tree, part, value) => act(async () => {
  dueSelect(tree, part).props.onChange({ target: { value: String(value) } });
});

test('the birthday picker mirrors the receiving shop’s POS cakes across pages, type changes and shop changes', async () => {
  globalThis.sessionStorage = storage();
  const base = { active: true, production_unit: 'piece', category_id: cakeCategory.id, price: 100000 };
  const records = [
    { ...base, id: 'sheet', name: 'MINI desert', category_id: 'dessert' },
    { ...base, id: 'other', name: 'Other shop cake', available_shop_ids: ['other'] },
    { ...base, id: 'moved-out', name: 'TORT 99999', shop_category_ids: { shop: 'dessert' } },
    { ...base, id: 'inactive', name: 'Inactive cake', active: false },
    { ...base, id: 'archived', name: 'Archived cake', archived: true },
    ...Array.from({ length: 495 }, (_, i) => ({ ...base, id: 'drink-' + i, name: 'Choy', category_id: 'drinks' })),
    { ...base, id: 'moved-in', name: 'Bento', category_id: 'dessert', category_name: 'Desertlar',
      shop_category_ids: { shop: cakeCategory.id }, shop_prices: { shop: 55000 } },
    { ...base, id: 'tier', name: 'TORT 100000' },
  ];
  const offsets = [];
  const sent = [];
  const backend = { entities: { Category: { get: async () => cakeCategory }, Product: { list: async (_sort, size, skip) => {
    offsets.push(skip); return records.slice(skip, skip + size);
  } } }, functions: { invoke: async (_name, payload) => { sent.push(structuredClone(payload)); return { data: { order } }; } } };
  const { Component } = dialog('OrderForm', backend);
  const prefill = { order: { ...formProps.prefill.order, order_type: 'toy_va_bazmlar', shop_id: 'shop' },
    items: [{ product_id: 'sheet', quantity: 2 }] };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, { ...formProps, prefill, user: { ...formProps.user, role: 'admin' },
    shops: [...formProps.shops, { id: 'other', name: 'Other' }] })); });
  const picker = () => tree.root.findAllByType('div').find(n => typeof n.props.onAdd === 'function').props;
  const ids = () => Array.from(picker().products, p => p.id);
  const select = (value) => tree.root.findAllByType('select').find(n => n.findAllByType('option').some(o => o.props.value === value));
  const change = (selectNode, value) => act(async () => selectNode.props.onChange({ target: { value } }));
  try {
    assert.deepEqual(offsets, [0, 500]);
    assert.deepEqual(ids(), ['sheet']);
    await change(select('tugilgan_kun_va_boshqa'), 'tugilgan_kun_va_boshqa');
    assert.deepEqual(ids(), ['moved-in', 'tier']);
    assert.equal(picker().products[0].category_name, 'Tortlar');
    assert.equal(picker().products[0].price, 55000);
    assert.equal(picker().cakeOnly, true);
    await act(async () => picker().onAdd(picker().products[0], 1));
    await act(async () => submit(tree));
    assert.equal(sent.length, 0, 'staff must review the previous draft item');
    await change(select('other'), 'other');
    assert.deepEqual(ids(), ['other', 'moved-out', 'tier']);
    await change(select('other'), 'shop');
    await act(async () => tree.root.findAllByType('button').find(n => n.props.children === 'Mos kelmaganlarini olib tashlash').props.onClick());
    await act(async () => submit(tree));
    assert.deepEqual(sent[0].items.map(i => i.product_id), ['moved-in']);
    assert.equal(sent[0].shop_id, 'shop');
  } finally { await act(async () => tree.unmount()); }
});

test('a failed cake category read offers a retry and never falls back to pastries', async () => {
  globalThis.sessionStorage = storage();
  let reads = 0;
  const backend = { entities: { ...products, Category: { get: async () => {
    if (++reads === 1) throw new Error('network'); return cakeCategory;
  } } } };
  const { Component } = dialog('OrderForm', backend);
  let tree;
  await act(async () => { tree = create(React.createElement(Component, formProps)); });
  try {
    assert.equal(tree.root.findAllByType('div').some(n => n.props.onAdd), false);
    assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, true);
    await act(async () => tree.root.findAllByType('button').find(n => n.props.children === 'Qayta yuklash').props.onClick());
    const picker = tree.root.findAllByType('div').find(n => n.props.onAdd);
    assert.deepEqual(Array.from(picker.props.products, p => p.name), ['Bento']);
    assert.equal(reads, 2);
  } finally { await act(async () => tree.unmount()); }
});

test('the cake picker opens, searches and adds the selected cake and quantity', async () => {
  const { Component } = dialog('ProductCombobox', {});
  const chosen = [];
  const rows = [
    { id: 'bento', name: 'Bento', price: 55000, category_id: cakeCategory.id, category_name: 'Tortlar' },
    { id: 'tier', name: 'TORT 100000', price: 100000, category_id: cakeCategory.id, category_name: 'Tortlar' },
  ];
  let tree;
  await act(async () => { tree = create(React.createElement(Component, { products: rows, cakeOnly: true,
    onAdd: (product, qty) => chosen.push([product.id, qty]) })); });
  try {
    await act(async () => tree.root.findAllByType('button')[0].props.onClick());
    const search = tree.root.findAllByType('input').find(n => n.props.placeholder === 'Tort nomini yozing...');
    await act(async () => search.props.onChange({ target: { value: 'bento' } }));
    const pick = tree.root.findAllByType('button').find(n => n.props['aria-label'] === 'Bentoni tanlash');
    assert.ok(pick);
    assert.equal(tree.root.findAllByType('button').some(n => n.props['aria-label'] === 'TORT 100000ni tanlash'), false);
    await act(async () => pick.props.onClick());
    await act(async () => tree.root.findAllByType('button').find(n => n.props['aria-label'] === 'Miqdorni ko‘paytirish').props.onClick());
    await act(async () => tree.root.findAllByType('button').at(-1).props.onClick());
    assert.deepEqual(chosen, [['bento', 2]]);
  } finally { await act(async () => tree.unmount()); }
});

test('new orders start on November 23 and the picker lists only valid dates in each selected month and year', async () => {
  globalThis.sessionStorage = storage();
  const { Component } = dialog('OrderForm', { entities: products }, { shopStamp: () => '2026-11-23 13:16' });
  let tree;
  await act(async () => { tree = create(React.createElement(Component, { ...formProps, prefill: null })); });
  try {
    assert.equal(dueSelect(tree, 'day').props.value, '23');
    assert.deepEqual(options(tree, 'day'), [23, 24, 25, 26, 27, 28, 29, 30]);
    assert.deepEqual(options(tree, 'month'), [11, 12]);
    await chooseDatePart(tree, 'month', 12);
    assert.deepEqual(options(tree, 'day'), Array.from({ length: 31 }, (_, i) => i + 1));
    await chooseDatePart(tree, 'day', 1);
    await chooseDatePart(tree, 'month', 11);
    assert.equal(dueSelect(tree, 'day').props.value, '23');
    await chooseDatePart(tree, 'month', 12);
    await chooseDatePart(tree, 'day', 31);
    await chooseDatePart(tree, 'year', 2028);
    assert.equal(options(tree, 'month')[0], 1);
    await chooseDatePart(tree, 'month', 2);
    assert.equal(dueSelect(tree, 'day').props.value, '29');
    await chooseDatePart(tree, 'year', 2027);
    assert.equal(dueSelect(tree, 'day').props.value, '28');
    await chooseDatePart(tree, 'year', 2026);
    assert.equal(dueSelect(tree, 'month').props.value, '11');
    assert.equal(dueSelect(tree, 'day').props.value, '23');
  } finally { await act(async () => tree.unmount()); }
});

test('an open repeat order follows Tashkent midnight and submits the displayed day without reselecting it', async (t) => {
  globalThis.sessionStorage = storage();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-12-31T18:59:00Z') });
  const sent = [];
  const backend = { entities: products, functions: { invoke: async (_name, payload) => {
    sent.push(structuredClone(payload)); return { data: { order, items: [] } };
  } } };
  let tick;
  const browser = { window: new EventTarget(), document: new EventTarget(),
    setTimeout: (callback) => { tick = callback; return 1; }, clearTimeout: () => { tick = null; } };
  const { Component } = dialog('OrderForm', backend, { shopStamp: orders.tashkentNowStamp, browser });
  const prefill = { ...formProps.prefill, order: { ...formProps.prefill.order, required_date: '2024-06-05' } };
  let tree;
  await act(async () => { tree = create(React.createElement(Component, { ...formProps, prefill })); });
  try {
    assert.deepEqual(options(tree, 'day'), [31]);
    assert.deepEqual(options(tree, 'month'), [12]);
    assert.equal(tree.root.findAllByType('button').at(-1).props.disabled, true, '18:00 has passed today');
    t.mock.timers.tick(60000);
    await act(async () => tick());
    assert.equal(dueSelect(tree, 'year').props.value, '2027');
    assert.equal(dueSelect(tree, 'month').props.value, '1');
    assert.equal(dueSelect(tree, 'day').props.value, '1');
    assert.equal(options(tree, 'day').length, 31);
    await act(async () => { await submit(tree); });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].required_date, '2027-01-01');
    assert.equal(sent[0].required_time, '18:00');
  } finally { await act(async () => tree.unmount()); }
});

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
    entities: { ...products, Category: { get: async () => ({ ...cakeCategory, active: false }) } } };
  const loaded = dialog('OrderForm', backend, { shopStamp: () => '2027-01-01 08:00' }); let tree;
  await act(async () => { tree = create(React.createElement(loaded.Component, { open: true, user: { id: 'staff', role: 'cashier', shop_id: 'shop' },
    shops: [{ id: 'shop', name: 'Odina' }], onClose: () => {}, onCreated: () => {} })); });
  assert.equal(tree.root.findByType('fieldset').props.disabled, true);
  assert.deepEqual(options(tree, 'year'), [2026]);
  assert.deepEqual(options(tree, 'month'), [10]);
  assert.deepEqual(options(tree, 'day'), [20]);
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
    await chooseDatePart(tree, 'day', 20);
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
