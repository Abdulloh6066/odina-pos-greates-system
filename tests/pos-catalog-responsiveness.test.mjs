// Actual POS/catalog components with in-memory data. No live SDK, sales or stock writes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as pricing from '../src/lib/shop-pricing.js';
import * as categories from '../src/lib/shop-category.js';
import * as saleOptions from '../src/lib/sale-options.js';
import * as stockEvents from '../src/lib/pos-stock-events.js';
import * as productOrder from '../src/lib/pos-product-order.js';
import * as burgers from '../src/lib/burger-fries.js';
import * as teaOptions from '../src/lib/tea-options.js';
import * as catalogHelpers from '../src/lib/pos-catalog.js';
import * as thumbnails from '../src/lib/pos-thumbnails.js';

const text = node => typeof node === 'string' ? node : Array.isArray(node)
  ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node) === label);
const wrap = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const empty = Object.freeze([]);

async function fixture({ role = 'cashier', selectedShop = 'branch', extraProducts = [], extraCategories = [] } = {}) {
  const products = [
    { id: 'cake', name: 'Cake', category_id: 'cakes', active: true, price: 75000,
      shop_prices: { branch: 65000, other: 70000 }, sale_unit: 'piece', is_favorite: true },
    { id: 'tea', name: 'Tea', category_id: 'drinks', active: true, price: 10000, sale_unit: 'piece' },
    { id: 'branch-only', name: 'Branch cake', category_id: 'cakes', active: true, price: 5000,
      available_shop_ids: ['branch'], sale_unit: 'piece' },
    ...extraProducts,
  ];
  const cats = [{ id: 'cakes', name: 'Tortlar', active: true }, { id: 'drinks', name: 'Ichimliklar', active: true }, ...extraCategories];
  const shops = [{ id: 'branch', name: 'Branch', active: true }, { id: 'other', name: 'Other', active: true }];
  const stock = [{ id: 'stock', product_id: 'cake', location_id: 'branch', quantity: 9 }];
  const sourceSnapshot = structuredClone({ products, stock });
  let outlet = { user: { id: 'cashier', role, shop_id: 'branch' } };
  const scope = shopId => ({ isAdmin: true, shopId, specificShopId: shopId === 'all' ? '' : shopId,
    shops, ready: true, registerGuard: () => () => {} });
  if (role === 'admin') outlet.adminShopScope = scope(selectedShop);
  const reads = [], cardRenders = new Map();
  let cartRenders = 0, gridRenders = 0, gridProps, emitStock;
  const cache = new Map();
  const sdk = { entities: new Proxy({}, { get: (_target, name) => ({
    list: async () => { reads.push(name); return name === 'Product' ? products : name === 'Category' ? cats
      : name === 'Shop' ? shops : name === 'ProductStock' ? stock : []; },
    filter: async () => [],
    subscribe: callback => { if (name === 'ProductStock') emitStock = callback; return () => {}; },
  }) }), functions: { invoke: async (name, body) => {
    reads.push(name + ':' + body.action);
    if (name === 'supplier-ledger' && body.action === 'get_debts') return { data: { debts: {} } };
    if (name === 'waste-ledger' && body.action === 'get_alerts') return { data: { expired_items: [] } };
    throw Error('No business writes are allowed in this fixture: ' + name);
  } } };
  const stableQueue = { records: empty, syncing: false, isOnline: true, browserOnline: true,
    reportRequestSuccess() {}, reportRequestError() {} };
  function useOrder() {
    const [order, setOrder] = React.useState(empty);
    return { order, accept: next => setOrder(next.order) };
  }
  const stubs = {
    react: React,
    'react-router-dom': { useOutletContext: () => outlet, useNavigate: () => () => {},
      useLocation: () => ({ search: '', state: null }) },
    'lucide-react': new Proxy({}, { get: () => wrap('svg') }),
    '@/api/base44Client': { base44: sdk },
    '@/lib/operational-config': { loadOperationalSettings: async () => ({}) },
    '@/lib/current-pos-shift': { fetchCurrentPosShift: async () => ({ id: 'shift', user_id: 'cashier',
      shop_id: 'branch', shop_name: 'Branch', status: 'open' }) },
    '@/lib/shop-pricing': pricing, '@/lib/shop-category': categories, '@/lib/pos-catalog': catalogHelpers,
    '@/lib/pos-product-order': productOrder,
    '@/lib/sale-options': saleOptions, '@/lib/pos-stock-events': stockEvents,
    '@/lib/pos': { formatUZS: value => `${value} UZS` },
    '@/lib/product-photos': { productPhotoFallbackFor: () => null },
    '@/lib/pos-thumbnails': thumbnails,
    '@/lib/pos-thumbnail-preload': { preloadPosThumbnails: () => () => {} },
    '@/lib/odina-dialog': { odinaAlert: async () => {}, odinaConfirm: async () => false },
    '@/lib/burger-fries': burgers,
    '@/lib/tea-options': teaOptions,
    '@/lib/staff-order-ticket': { isStaffTicketEnabled: () => false },
    '@/lib/checkout-timing-outbox': { flushCheckoutTimings: async () => ({ hasMore: false }) },
    '@/lib/order-request-retry': { orderRequestScope: () => '', readOrderRequest: () => null },
    '@/lib/pos-network': { canQueuePosSale: () => true, isPosNetworkError: () => false },
    '@/lib/offline-sales': { syncErrorMessage: error => error.message },
    '@/lib/offline-restart': { restartRead: read => read(), savePosRestart: () => true,
      readShiftRestart: () => null, readPosRestart: () => null, saveShiftRestart() {}, restartCatalog: value => value },
    '@/lib/uzbekistan-time': { formatUzbekistanDateTime: String },
    '@/hooks/useCheckoutTiming': () => ({ timing: null, recordTiming() {} }),
    '@/hooks/useOfflineSaleQueue': () => stableQueue,
    '@/hooks/usePosProductOrder': useOrder,
    '@/components/pos/Cart': { __esModule: true, default: props => { cartRenders++; return React.createElement('cart-view', props); },
      DiscountRow: () => null, RoundingRow: () => null },
    '@/components/CategoryIcon': () => null,
    '@/components/pos/ProductOrderDialog': props => React.createElement('order-dialog', props),
    '@/components/pos/PosImageCacheButton': props => React.createElement('cache-images-button', props),
  };
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const code = transformSync(readFileSync(path, 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'transform' }).code;
    const module = { exports: {} };
    const require = name => {
      if (name === '@/components/pos/ProductGrid') {
        const Grid = load('src/components/pos/ProductGrid.jsx').default;
        if (!cache.has('grid-probe')) cache.set('grid-probe', React.memo(props => {
          gridRenders++; gridProps = props; return React.createElement(Grid, props);
        }));
        return { __esModule: true, default: cache.get('grid-probe') };
      }
      if (name === './ProductCard') return load('src/components/pos/ProductCard.jsx');
      if (name === '@/components/pos/PosCatalog') return load('src/components/pos/PosCatalog.jsx');
      if (name === '@/hooks/use-stable-event') return load('src/hooks/use-stable-event.js');
      if (name === 'react' && path.endsWith('ProductCard.jsx')) return { ...React, memo: render => React.memo(props => {
        cardRenders.set(props.product.id, (cardRenders.get(props.product.id) || 0) + 1);
        return render(props);
      }) };
      if (name in stubs) return stubs[name];
      if (name.endsWith('.css')) return {};
      if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, key) =>
        ['Dialog', 'Sheet'].includes(key) ? ({ open, children }) => open ? React.createElement('dialog', {}, children) : null
          : wrap(({ Button: 'button', Input: 'input', Image: 'img' })[key] || 'div') });
      if (name.startsWith('@/components/') || name.startsWith('@/pages/')) return new Proxy({ __esModule: true, default: () => null }, {
        get: (target, key) => key in target ? target[key] : () => null,
      });
      throw Error('Unexpected dependency ' + name + ' in ' + path);
    };
    const events = { addEventListener() {}, removeEventListener() {} };
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {
      console, URLSearchParams, performance, navigator: { onLine: true },
      window: { ...events, location: { origin: 'https://offline.test' }, setInterval: () => 1, clearInterval() {},
        matchMedia: () => ({ ...events, matches: false }) }, document: events,
    })(require, module, module.exports);
    cache.set(path, module.exports); return module.exports;
  }
  const POS = load('src/pages/POS.jsx').default;
  let caught;
  class Boundary extends React.Component {
    state = { error: false };
    static getDerivedStateFromError() { return { error: true }; }
    componentDidCatch(error) { caught = error; }
    render() { return this.state.error ? null : this.props.children; }
  }
  let tree; await act(async () => { tree = create(React.createElement(Boundary, {}, React.createElement(POS))); });
  if (caught) throw caught;
  return { tree, reads, cardRenders, sourceSnapshot, products, stock,
    get cartRenders() { return cartRenders; }, get gridRenders() { return gridRenders; }, get gridProps() { return gridProps; },
    emitStock: event => act(() => emitStock(event)),
    changeShop: async next => { outlet = { ...outlet, adminShopScope: scope(next) }; await act(async () => tree.update(React.createElement(Boundary, {}, React.createElement(POS)))); },
    close: async () => act(async () => tree.unmount()) };
}

test('category and search changes stay inside the catalogue, retain product references and make no server reads', async () => {
  const f = await fixture();
  try {
    const cartCount = f.cartRenders, reads = f.reads.length;
    const cake = f.gridProps.products.find(product => product.id === 'cake');
    await act(async () => button(f.tree, 'Tortlar').props.onClick());
    assert.equal(f.cartRenders, cartCount, 'switching a category must not render the cart again');
    assert.strictEqual(f.gridProps.products.find(product => product.id === 'cake'), cake);
    assert.deepEqual(structuredClone(f.gridProps.products.map(product => product.id)), ['branch-only', 'cake']);
    const retainedRenders = f.cardRenders.get('branch-only');
    await act(async () => f.tree.root.findByProps({ 'aria-label': 'Mahsulotlarni qidirish' }).props.onChange({ target: { value: 'Branch cake' } }));
    assert.equal(f.cartRenders, cartCount, 'search must not render the cart again');
    assert.equal(f.reads.length, reads);
    assert.equal(f.cardRenders.get('branch-only'), retainedRenders, 'a retained unchanged product card stays memoized');
    assert.deepEqual(structuredClone(f.gridProps.products.map(product => product.id)), ['branch-only']);
  } finally { await f.close(); }
});

test('shop prices, latest product selection and read-only shop locks still reach the actual basket', async () => {
  const f = await fixture({ role: 'admin', selectedShop: 'other' });
  try {
    assert.equal(f.gridProps.disabled, true);
    assert.equal(f.gridProps.products.find(product => product.id === 'cake').price, 70000);
    assert.ok(!f.gridProps.products.some(product => product.id === 'branch-only'));
    await act(async () => f.gridProps.onAdd(f.gridProps.products[0]));
    assert.equal(f.tree.root.findByType('cart-view').props.cart.length, 0);
    await f.changeShop('branch');
    assert.equal(f.gridProps.disabled, false);
    const cake = f.gridProps.products.find(product => product.id === 'cake');
    assert.equal(cake.price, 65000);
    const gridCount = f.gridRenders;
    await act(async () => f.gridProps.onAdd(cake));
    const cart = f.tree.root.findByType('cart-view').props.cart;
    assert.equal(cart[0].price, 65000); assert.equal(cart[0].subtotal, 65000); assert.equal(cart[0].quantity, 1);
    assert.equal(f.gridRenders, gridCount, 'adding to basket must not redraw an unchanged catalogue');
    assert.deepEqual({ products: f.products, stock: f.stock }, f.sourceSnapshot);
  } finally { await f.close(); }
});

test('stock events still reach the catalogue and reorder opens with its current category', async () => {
  const f = await fixture({ role: 'admin' });
  try {
    f.emitStock({ type: 'update', data: { id: 'stock', product_id: 'cake', location_id: 'branch', quantity: 7 } });
    assert.equal(f.gridProps.stockByProduct.cake, 7);
    await act(async () => button(f.tree, 'Tortlar').props.onClick());
    const cake = f.gridProps.products.find(product => product.id === 'cake');
    await act(async () => f.tree.root.findByProps({ 'aria-label': 'Mahsulotlar tartibini tahrirlash' }).props.onClick());
    assert.equal(f.tree.root.findByType('order-dialog').props.initialCategory, 'cakes');
    await act(async () => f.tree.root.findByType('order-dialog').props.onSaved({ shop_id: 'branch', order: ['cake', 'branch-only'], version: 1 }));
    assert.deepEqual(structuredClone(f.gridProps.products.map(product => product.id)), ['cake', 'branch-only']);
    assert.strictEqual(f.gridProps.products[0], cake);
    await act(async () => f.tree.root.findByType('order-dialog').props.onClose());
    await act(async () => button(f.tree, 'Sevimlilar').props.onClick());
    await act(async () => f.tree.root.findByProps({ 'aria-label': 'Mahsulotlar tartibini tahrirlash' }).props.onClick());
    assert.equal(f.tree.root.findByType('order-dialog').props.initialCategory, 'all');
  } finally { await f.close(); }
});

test('table-save success resets catalogue browsing only after confirmation; failure keeps the view', async () => {
  const source = readFileSync('src/pages/POS.jsx', 'utf8');
  const start = source.indexOf('const saveAndStartNextOrder = async () => {');
  const action = source.slice(start, source.indexOf('const tableShop = selectedTable', start));
  for (const succeeds of [false, true]) {
    const events = [];
    const context = {
      selectedTable: { number: 2, shopId: 'branch' }, tableShop: { id: 'branch' }, tableOrder: { id: 'order' },
      tableOrderLoading: false, savingTableRef: { current: false }, paying: false, payOpen: false,
      stockChecking: false, tableOrderError: '', tableCartDirty: true,
      saveTableOrder: async () => { events.push('server'); return succeeds; },
      resetCart: () => events.push('basket-reset'), setTableOrder() {}, setTableSaveError() {}, setMobileCartOpen() {},
      catalogRef: { current: { reset: () => events.push('catalogue-reset') } },
      posHomePath: '/pos', navigate: () => events.push('next-order'), isStaffTicketEnabled: () => false,
    };
    vm.runInNewContext(action + '\nglobalThis.run = saveAndStartNextOrder;', context);
    await context.run();
    assert.deepEqual(events, succeeds ? ['server', 'basket-reset', 'catalogue-reset', 'next-order'] : ['server']);
  }
});

test('image warmup receives only the viewed shop catalogue and sits immediately before the compact button', async () => {
  const f = await fixture({ role: 'admin', selectedShop: 'other' });
  try {
    const header = f.tree.root.findAllByType('div').find(node => node.props.className?.includes('odina-pos-header'));
    const controls = header.findAll(node => node.type === 'cache-images-button'
      || (node.type === 'button' && node.props['aria-label'] === 'Ixcham kassa ko‘rinishi'));
    assert.deepEqual(controls.map(node => node.type), ['cache-images-button', 'button']);
    assert.ok(!controls[0].props.products.some(row => row.id === 'branch-only'));
    assert.equal(controls[0].props.scopeKey, 'cashier:other');
    assert.equal(controls[0].props.online, true);
  } finally { await f.close(); }
});

test('opening any product category requests its photos before a product is selected', async () => {
  const groups = [
    { id: 'pastry', name: 'Pishiriqlar', count: 27 },
    { id: 'cakes', name: 'Tortlar', count: 95 },
    { id: 'salads', name: 'Salatlar', count: 12 },
  ];
  const extraProducts = groups.flatMap(({ id, count }) => Array.from({ length: count }, (_, index) => {
    const productId = `${id}-${index}`;
    const source = `/images/${productId}.png`;
    return { id: productId, name: `Photo ${productId}`, category_id: id, active: true, price: 5000,
      is_favorite: id === 'pastry', image_url: source,
      ...(index < count - 3 ? { pos_thumbnail_url: `/images/${productId}.webp`, pos_thumbnail_source: source } : {}) };
  }));
  const extraCategories = groups.filter(({ id }) => id !== 'cakes').map(({ id, name }) => ({ id, name, active: true }));
  const f = await fixture({ extraProducts, extraCategories });
  try {
    const photos = () => f.tree.root.findAllByType('img').filter(({ props }) => props.alt?.startsWith('Photo '));
    const cartRenders = f.cartRenders;
    assert.ok(photos().some(({ props }) => props.loading === 'lazy'));
    for (const { name, count } of groups) {
      await act(async () => button(f.tree, name).props.onClick());
      const categoryPhotos = photos();
      assert.equal(categoryPhotos.length, count);
      assert.ok(categoryPhotos.every(({ props }) => props.loading === 'eager'), `${name} should request every photo on selection`);
      assert.equal(categoryPhotos.filter(({ props }) => props.decoding === 'sync' && props.src.endsWith('.webp')).length, count - 3);
      assert.equal(categoryPhotos.filter(({ props }) => props.decoding === 'async' && props.src.endsWith('.png')).length, 3);
    }
    assert.equal(f.cartRenders, cartRenders);
    assert.equal(f.tree.root.findByType('cart-view').props.cart.length, 0);
    for (const filter of ['Sevimlilar', 'Barchasi']) {
      await act(async () => button(f.tree, filter).props.onClick());
      assert.ok(photos().some(({ props }) => props.loading === 'lazy'));
      assert.ok(photos().every(({ props }) => props.decoding === 'async'));
    }
  } finally { await f.close(); }
});
