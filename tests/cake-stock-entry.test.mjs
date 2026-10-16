// Render the real stock shelf; all balances and mutations stay in memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as shelf from '../src/lib/cake-stock-shelf.js';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node.props.children) === label);
const tile = (tree, name) => tree.root.findAllByType('button').find(node => node.props['aria-label']?.startsWith(name + ':'));
const changeQuantity = async (tree, value) => act(async () => {
  tree.root.findByProps({ id: 'cake-operation-quantity' }).props.onChange({ target: { value } });
});
const submit = tree => tree.root.findByType('form').props.onSubmit({ preventDefault() {} });


async function fixture({ role = 'cashier', invoke, products: suppliedProducts, categories = [], ingredients = [], ingredientRows = [], viewport = null } = {}) {
  const products = suppliedProducts || [
    { id: 'a', name: 'Cake A', active: true, price: 30000 },
    { id: 'b', name: 'Cake B', active: true, price: 32000 },
    { id: 'negative', name: 'Negative', active: true },
    { id: 'missing', name: 'Missing', active: true },
    { id: 'inactive', name: 'Inactive', active: false },
    { id: 'zero', name: 'Zero', active: true },
  ];
  const rows = [
    { id: 'sa', product_id: 'a', location_id: 'branch', quantity: 5, unit: 'piece' },
    { id: 'sb', product_id: 'b', location_id: 'branch', quantity: 9, unit: 'piece' },
    { id: 'sn', product_id: 'negative', location_id: 'branch', quantity: -3, unit: 'piece' },
    { id: 'si', product_id: 'inactive', location_id: 'branch', quantity: 2, unit: 'piece' },
    { id: 'sz', product_id: 'zero', location_id: 'branch', quantity: 0, unit: 'piece' },
    { id: 'other-a', product_id: 'a', location_id: 'other', quantity: 17, unit: 'piece' },
  ];
  rows.push(...ingredientRows.map(row => ({ ...row })));
  const sent = []; let reads = 0;
  const backend = { entities: {
    ProductStock: {
      filter: async query => { reads++; return rows.filter(row => row.product_id && row.location_id === query.location_id).map(row => ({ ...row })); },
      subscribe: () => () => {},
    },
    IngredientStock: {
      filter: async query => { reads++; return rows.filter(row => row.ingredient_id && row.location_id === query.location_id).map(row => ({ ...row })); },
      subscribe: () => () => {},
    },
    StockMovement: { filter: async () => [] },
    StockTransfer: { filter: async () => [] },
  }, functions: { invoke: async (name, payload) => {
    sent.push({ name, payload: structuredClone(payload) });
    if (invoke) return invoke(name, payload);
    const field = payload.item_kind === 'ingredient' ? 'ingredient_id' : 'product_id';
    const row = rows.find(row => row[field] === payload.item_id && row.location_id === payload.location_id);
    assert.equal(row.quantity, payload.expected_quantity);
    row.quantity = payload.counted_quantity ?? row.quantity + payload.quantity_change;
    return { data: { stock: { ...row } } };
  } } };
  const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const require = specifier => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === '@/api/base44Client') return { base44: backend };
    if (specifier === '@/lib/cake-stock-shelf') return shelf;
    if (specifier === '@/lib/pos') return { formatNum: String, formatUZS: String };
    if (specifier === '@/lib/shop-pricing') return { priceForShop: product => product.price };
    if (specifier === '@/lib/uzbekistan-time') return { formatUzbekistanTime: String, formatUzbekistanDateTime: String };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (specifier.endsWith('/odina-select')) return { default: wrapper('select') };
    if (specifier.endsWith('/TransfersPanel')) return { default: wrapper('div') };
    if (specifier.endsWith('.css')) return {};
    if (specifier.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, name) =>
      wrapper(({ Button: 'button', Input: 'input', Textarea: 'textarea', Label: 'label', Image: 'img' })[name] || 'div') });
    throw Error('Unexpected dependency: ' + specifier);
  };
  const source = ts.transpileModule(readFileSync('src/components/products/CakeStockShelf.jsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  const eventTarget = { addEventListener() {}, removeEventListener() {} };
  const context = {
    console, navigator: { onLine: true }, window: eventTarget,
    document: { ...eventTarget, visibilityState: 'visible' },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
  };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', context)(require, module, module.exports);
  let tree;
  await act(async () => { tree = create(React.createElement(module.exports.default, {
    user: { role, shop_id: 'branch' }, products, categories, ingredients,
    shops: [{ id: 'branch', name: 'Odina Branch' }, { id: 'other', name: 'Odina Central' }],
  }), { createNodeMock: element => element.props.className?.includes('cake-stock-category-scroll') ? viewport : null }); });
  return { tree, sent, rows, reads: () => reads, close: async () => act(async () => tree.unmount()) };
}

test('incoming mode opens the clicked cake and adds to its actual balance', async () => {
  const f = await fixture();
  try {
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    await act(async () => tile(f.tree, 'Cake B').props.onClick());
    assert.equal(f.tree.root.findByProps({ id: 'cake-operation-reason' }).props.value, 'Kelgan tortlar');
    await changeQuantity(f.tree, '3');
    assert.equal(button(f.tree, 'Kirimni saqlash').props.disabled, false);
    await act(async () => submit(f.tree));
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].name, 'warehouse-stock');
    assert.deepEqual(f.sent[0].payload, {
      action: 'adjust_stock', location_id: 'branch', item_kind: 'product', item_id: 'b',
      movement_type: 'adjustment', expected_quantity: 9, quantity_change: 3,
      reason: 'Tort kirimi: Kelgan tortlar',
    });
    assert.equal(f.rows.find(row => row.id === 'sb').quantity, 12);
    assert.equal(f.rows.find(row => row.id === 'sa').quantity, 5);
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    assert.ok(JSON.stringify(f.tree.toJSON()).includes('Cake B: qoldiq 12 dona.'));
  } finally { await f.close(); }
});

test('rapid duplicate submit sends only one incoming request', async () => {
  let resolve;
  const f = await fixture({ invoke: () => new Promise(done => { resolve = done; }) });
  try {
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    await act(async () => tile(f.tree, 'Cake A').props.onClick());
    await changeQuantity(f.tree, '2');
    let first;
    await act(async () => { first = submit(f.tree); await submit(f.tree); });
    assert.equal(f.sent.length, 1);
    await act(async () => { resolve({ data: { stock: { id: 'sa', product_id: 'a', quantity: 7 } } }); await first; });
    assert.equal(f.sent.length, 1);
  } finally { await f.close(); }
});

test('negative, missing and inactive balances cannot become an incoming receipt', async () => {
  const f = await fixture();
  try {
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    for (const name of ['Negative', 'Missing', 'Inactive']) {
      await act(async () => tile(f.tree, name).props.onClick());
      assert.equal(f.tree.root.findAllByType('form').length, 0);
    }
    assert.equal(f.sent.length, 0);
    await act(async () => tile(f.tree, 'Zero').props.onClick());
    assert.equal(f.tree.root.findAllByType('form').length, 1);
  } finally { await f.close(); }
});

test('changing shops exits incoming mode and uses the destination balance', async () => {
  const f = await fixture({ role: 'admin' });
  try {
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    await act(async () => f.tree.root.findByProps({ id: 'cake-stock-shop' }).props.onChange({ target: { value: 'other' } }));
    assert.equal(button(f.tree, 'Kirim kiritish').props['aria-pressed'], false);
    await act(async () => tile(f.tree, 'Cake A').props.onClick());
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    await act(async () => tile(f.tree, 'Cake A').props.onClick());
    await changeQuantity(f.tree, '2');
    await act(async () => submit(f.tree));
    assert.equal(f.sent[0].payload.location_id, 'other');
    assert.equal(f.sent[0].payload.expected_quantity, 17);
    assert.equal(f.rows.find(row => row.id === 'other-a').quantity, 19);
    assert.equal(f.rows.find(row => row.id === 'sa').quantity, 5);
  } finally { await f.close(); }
});

test('category columns follow each shop category and numeric category order', () => {
  const categories = [
    { id: '18', name: '18 somlik', sort_order: 0 },
    { id: 'mix', name: 'Aralash', sort_order: 0 },
    { id: '15', name: '15 somlik', sort_order: 0 },
  ];
  const products = [
    { id: 'nap', name: 'Napalon', category_id: 'mix', shop_category_ids: { branch: '18' } },
    { id: 'twix', name: 'Twix', category_id: '15' },
    { id: 'other', name: 'Uncategorized' },
  ];
  const branch = shelf.cakeStockColumns(products, categories, 'branch');
  assert.deepEqual(branch.map(column => column.name), ['15 somlik', '18 somlik', 'Kategoriyasiz']);
  assert.equal(branch.find(column => column.id === '18').products[0].id, 'nap');
  const central = shelf.cakeStockColumns(products, categories, 'other');
  assert.equal(central.find(column => column.id === 'mix').products[0].id, 'nap');
  assert.equal(central.some(column => column.id === '18'), false);
});

test('category rows show every product together and filters keep the right category and selection', async () => {
  const products = Array.from({ length: 23 }, (_, i) => ({
    id: 'group-' + i, name: 'Cake ' + i, active: true, category_id: i < 14 ? '15' : '18',
  }));
  const f = await fixture({ products, categories: [{ id: '18', name: '18 somlik' }, { id: '15', name: '15 somlik' }] });
  try {
    const rows = f.tree.root.findAllByProps({ className: 'cake-stock-category-row' });
    assert.deepEqual(rows.map(row => row.props['aria-label']), ['15 somlik', '18 somlik']);
    assert.deepEqual(rows.map(row => row.findAllByType('button').length), [14, 9]);
    const seen = rows.flatMap(row => row.findAllByType('button').map(node => {
      const name = node.props['aria-label'].split(':')[0];
      assert.equal(row.props['aria-label'], Number(name.slice(5)) < 14 ? '15 somlik' : '18 somlik');
      return name;
    }));
    assert.equal(seen.length, 23);
    assert.equal(new Set(seen).size, 23);
    assert.equal(f.tree.root.findAllByProps({ className: 'cake-stock-empty-cell' }).length, 0);
    assert.doesNotMatch(text(f.tree.toJSON()), /\d+ \/ \d+ sahifa/);
    await act(async () => tile(f.tree, 'Cake 22').props.onClick());
    assert.equal(text(f.tree.root.findByType('aside').findByType('h3').props.children), 'Cake 22');
    await act(async () => f.tree.root.findAllByType('select').find(node => node.props['aria-label'] === 'Tort kategoriyasi').props.onChange({ target: { value: '18' } }));
    const filtered = f.tree.root.findAllByProps({ className: 'cake-stock-category-row' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].props['aria-label'], '18 somlik');
    assert.equal(filtered[0].findAllByType('button').length, 9);
    assert.equal(text(f.tree.root.findByType('aside').findByType('h3').props.children), 'Cake 22');
    await act(async () => f.tree.root.findAllByType('select').find(node => node.props['aria-label'] === 'Tort kategoriyasi').props.onChange({ target: { value: '15' } }));
    assert.equal(text(f.tree.root.findByType('aside').findByType('h3').props.children), 'Cake 0');
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test('uncertain save freezes the form and reloads balances without resubmitting', async () => {
  const f = await fixture({ invoke: async () => { throw Error('Reply lost'); } });
  try {
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    await act(async () => tile(f.tree, 'Cake A').props.onClick());
    await changeQuantity(f.tree, '4');
    const before = f.reads();
    await act(async () => submit(f.tree));
    assert.equal(f.sent.length, 1);
    assert.equal(button(f.tree, 'Kirimni saqlash').props.disabled, true);
    assert.equal(f.tree.root.findByProps({ id: 'cake-operation-quantity' }).props.disabled, true);
    assert.ok(f.reads() > before);
    await act(async () => submit(f.tree));
    assert.equal(f.sent.length, 1);
  } finally { await f.close(); }
});
const milk = { id: 'milk', name: 'Sut Nestle 3.2%', category: 'food', base_unit: 'ml', purchase_unit: 'l', conversion_to_base: 1000 };
const coffee = { id: 'coffee', name: 'Qahva doni', category: 'food', base_unit: 'g', purchase_unit: 'kg', conversion_to_base: 1000 };
test('milk litres and coffee kilograms submit base-unit deltas to the existing ingredient ledger', async () => {
  const f = await fixture({ ingredients: [milk, coffee], ingredientRows: [
    { id: 'im', ingredient_id: 'milk', location_id: 'branch', quantity: 12500, unit: 'ml' },
    { id: 'ic', ingredient_id: 'coffee', location_id: 'branch', quantity: 5800, unit: 'g' },
  ] });
  try {
    await act(async () => button(f.tree, 'Sut, kofe va masalliqlar').props.onClick());
    assert.ok(tile(f.tree, milk.name).props['aria-label'].includes('12.5 litr'));
    assert.ok(tile(f.tree, coffee.name).props['aria-label'].includes('5.8 kg'));
    assert.equal(tile(f.tree, 'Cake A'), undefined);
    assert.equal(button(f.tree, 'Kelgan transferlar'), undefined);
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    await act(async () => tile(f.tree, milk.name).props.onClick());
    assert.equal(f.tree.root.findByProps({ id: 'cake-operation-quantity' }).props.step, 0.001);
    await changeQuantity(f.tree, '2.5');
    await act(async () => submit(f.tree));
    assert.deepEqual(f.sent[0].payload, {
      action: 'adjust_stock', location_id: 'branch', item_kind: 'ingredient', item_id: 'milk',
      movement_type: 'adjustment', expected_quantity: 12500, quantity_change: 2500,
      reason: 'Mahsulot kirimi: Kelgan mahsulotlar',
    });
    assert.equal(f.rows.find(row => row.id === 'im').quantity, 15000);
    assert.ok(JSON.stringify(f.tree.toJSON()).includes('Sut Nestle 3.2%: qoldiq 15 litr.'));
    await act(async () => tile(f.tree, coffee.name).props.onClick());
    await changeQuantity(f.tree, '0.125');
    await act(async () => submit(f.tree));
    assert.equal(f.sent[1].payload.item_kind, 'ingredient');
    assert.equal(f.sent[1].payload.quantity_change, 125);
    assert.equal(f.rows.find(row => row.id === 'ic').quantity, 5925);
    assert.equal(f.rows.find(row => row.id === 'sa').quantity, 5);
  } finally { await f.close(); }
});

test('ingredient counts repair negatives and shop or scope changes close stale forms', async () => {
  const f = await fixture({ role: 'admin', ingredients: [milk], ingredientRows: [
    { id: 'im', ingredient_id: 'milk', location_id: 'branch', quantity: -350, unit: 'ml' },
    { id: 'om', ingredient_id: 'milk', location_id: 'other', quantity: 24000, unit: 'ml' },
  ] });
  try {
    await act(async () => button(f.tree, 'Sut, kofe va masalliqlar').props.onClick());
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    await act(async () => tile(f.tree, milk.name).props.onClick());
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    await act(async () => button(f.tree, 'Haqiqiy sanoq').props.onClick());
    await changeQuantity(f.tree, '3.25');
    await act(async () => f.tree.root.findByProps({ id: 'cake-operation-reason' }).props.onChange({ target: { value: 'Haqiqiy sanoq' } }));
    await act(async () => submit(f.tree));
    assert.equal(f.sent[0].payload.counted_quantity, 3250);
    assert.equal(f.sent[0].payload.expected_quantity, -350);
    assert.equal(f.rows.find(row => row.id === 'im').quantity, 3250);
    await act(async () => tile(f.tree, milk.name).props.onClick());
    assert.equal(f.tree.root.findAllByType('form').length, 1);
    await act(async () => f.tree.root.findByProps({ id: 'cake-stock-shop' }).props.onChange({ target: { value: 'other' } }));
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    assert.ok(tile(f.tree, milk.name).props['aria-label'].includes('24 litr'));
    await act(async () => button(f.tree, 'Tortlar').props.onClick());
    assert.equal(tile(f.tree, milk.name), undefined);
    assert.equal(f.sent.length, 1);
    assert.equal(f.rows.find(row => row.id === 'om').quantity, 24000);
  } finally { await f.close(); }
});

test('ingredient scopes exclude inactive items and production-only layers; ready products respect stock and shop settings', () => {
  assert.deepEqual(shelf.shelfIngredients([milk, coffee,
    { id: 'off', name: 'Inactive', active: false }, { id: 'layer', name: 'Layer', is_cake_layer: true },
  ]).map(item => item.id).sort(), ['coffee', 'milk']);
  const items = shelf.shelfIngredients([milk, coffee]);
  assert.equal(shelf.inventoryStockChange('in', '1.2345', 0, items[0]).error.length > 0, true);
  assert.equal(shelf.inventoryStockChange('out', '6', 5800, items.find(item => item.id === 'coffee')).error.length > 0, true);
  const box = shelf.shelfIngredients([{ id: 'box', name: 'Quti', base_unit: 'piece', purchase_unit: 'piece', category: 'packaging' }])[0];
  assert.ok(shelf.inventoryStockChange('in', '1.5', 0, box).error);
  assert.equal(shelf.inventoryStockInfo([{ ingredient_id: milk.id, quantity: 4, unit: 'g' }], items.find(item => item.id === 'milk')).status, 'invalid');
  assert.deepEqual(shelf.allStockProducts([
    { id: 'cake' }, { id: 'coffee', source_type: 'shop_prepared', track_stock: true },
    { id: 'salad', sale_unit: 'gram' }, { id: 'off', track_stock: false },
    { id: 'hidden', category_id: 'h' }, { id: 'other', available_shop_ids: ['other'] },
  ], [{ id: 'h', hidden_shop_ids: ['branch'] }], 'branch').map(p => p.id), ['cake', 'coffee']);
});

const scrollport = (tree) => tree.root.findAllByType('div').find(node => node.props.className?.includes('cake-stock-category-scroll'));
function dragViewport(width = 1200, clientWidth = 600) {
  const captured = new Set();
  return { scrollWidth: width, clientWidth, scrollLeft: 0,
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id) };
}
function pointer(viewport, x, y = 100, extra = {}) {
  return { currentTarget: viewport, clientX: x, clientY: y, pointerId: 7,
    pointerType: 'mouse', button: 0, isPrimary: true, preventDefault() {}, ...extra };
}
function releaseClick(tree, name) {
  let blocked = false;
  scrollport(tree).props.onClickCapture({ detail: 1, preventDefault() { blocked = true; }, stopPropagation() {} });
  if (!blocked) tile(tree, name)?.props.onClick();
  return blocked;
}
test('drag pans the shelf and suppresses its release click; a deliberate receipt click still works', async () => {
  const viewport = dragViewport();
  const f = await fixture({ viewport });
  try {
    await act(async () => button(f.tree, 'Kirim kiritish').props.onClick());
    viewport.scrollLeft = 100;
    await act(async () => {
      scrollport(f.tree).props.onPointerDown(pointer(viewport, 300));
      scrollport(f.tree).props.onPointerMove(pointer(viewport, 220));
    });
    assert.equal(viewport.scrollLeft, 180);
    assert.equal(viewport.hasPointerCapture(7), true);
    assert.ok(scrollport(f.tree).props.className.includes('is-dragging'));
    await act(async () => {
      scrollport(f.tree).props.onPointerUp(pointer(viewport, 220));
      assert.equal(releaseClick(f.tree, 'Cake B'), true);
    });
    assert.equal(viewport.hasPointerCapture(7), false);
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    assert.equal(f.sent.length, 0);
    await act(async () => {
      scrollport(f.tree).props.onPointerDown(pointer(viewport, 220));
      scrollport(f.tree).props.onPointerUp(pointer(viewport, 220));
      assert.equal(releaseClick(f.tree, 'Cake B'), false);
    });
    assert.equal(f.tree.root.findAllByType('form').length, 1);
    assert.equal(f.tree.root.findByProps({ id: 'cake-operation-quantity' }).props.value, '');
  } finally { await f.close(); }
});
test('continuous dragging clamps at both ends and keeps every product in its category', async () => {
  const viewport = dragViewport(1800, 600);
  const products = Array.from({ length: 14 }, (_, i) => ({ id: 'swipe-' + i, name: 'Swipe ' + i, category_id: '15' }));
  const f = await fixture({ viewport, products, categories: [{ id: '15', name: '15 somlik' }] });
  const swipe = async (from, to) => act(async () => {
    scrollport(f.tree).props.onPointerDown(pointer(viewport, from));
    scrollport(f.tree).props.onPointerMove(pointer(viewport, to));
    scrollport(f.tree).props.onPointerUp(pointer(viewport, to));
    assert.equal(releaseClick(f.tree, 'Swipe 7'), true);
  });
  const allNames = () => f.tree.root.findByProps({ className: 'cake-stock-category-row' }).findAllByType('button').map(node => node.props['aria-label']);
  try {
    const before = allNames();
    assert.equal(before.length, 14);
    await swipe(300, 450);
    assert.equal(viewport.scrollLeft, 0);
    await swipe(1500, 0);
    assert.equal(viewport.scrollLeft, 1200);
    await swipe(300, 0);
    assert.equal(viewport.scrollLeft, 1200);
    assert.deepEqual(allNames(), before);
    await swipe(0, 1500);
    assert.equal(viewport.scrollLeft, 0);
    assert.deepEqual(allNames(), before);
    assert.equal(f.tree.root.findByProps({ className: 'cake-stock-category-row' }).props['aria-label'], '15 somlik');
    assert.equal(f.tree.root.findAllByProps({ className: 'cake-stock-board-footer' })[0].findAllByType('button').length, 0);
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test('cancelled, vertical, touch and right-button gestures preserve all products and native scrolling', async () => {
  const viewport = dragViewport(900, 600);
  const products = Array.from({ length: 9 }, (_, i) => ({ id: 'pan-' + i, name: 'Pan ' + i }));
  const f = await fixture({ viewport, products });
  try {
    await act(async () => {
      scrollport(f.tree).props.onPointerDown(pointer(viewport, 400));
      scrollport(f.tree).props.onPointerMove(pointer(viewport, 200));
      scrollport(f.tree).props.onPointerUp(pointer(viewport, 200));
    });
    assert.equal(viewport.scrollLeft, 200);
    assert.ok(tile(f.tree, 'Pan 0'));
    await act(async () => {
      scrollport(f.tree).props.onPointerDown(pointer(viewport, 400));
      scrollport(f.tree).props.onPointerMove(pointer(viewport, 200));
      scrollport(f.tree).props.onPointerCancel(pointer(viewport, 200));
    });
    assert.ok(tile(f.tree, 'Pan 0'));
    assert.equal(viewport.hasPointerCapture(7), false);
    assert.equal(scrollport(f.tree).props.className.includes('is-dragging'), false);
    for (const extra of [{ pointerType: 'touch' }, { button: 2 }]) {
      const before = viewport.scrollLeft;
      await act(async () => {
        scrollport(f.tree).props.onPointerDown(pointer(viewport, 500, 100, extra));
        scrollport(f.tree).props.onPointerMove(pointer(viewport, 100, 100, extra));
        scrollport(f.tree).props.onPointerUp(pointer(viewport, 100, 100, extra));
      });
      assert.equal(viewport.scrollLeft, before);
      assert.ok(tile(f.tree, 'Pan 0'));
    }
    await act(async () => {
      scrollport(f.tree).props.onPointerDown(pointer(viewport, 400, 100));
      scrollport(f.tree).props.onPointerMove(pointer(viewport, 250, 500));
      scrollport(f.tree).props.onPointerUp(pointer(viewport, 250, 500));
    });
    assert.ok(tile(f.tree, 'Pan 0'));
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});
