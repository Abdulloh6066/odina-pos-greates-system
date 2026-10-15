// In-memory frontend regressions only. No Base44, payment, stock or printer calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergePosStockEvent } from '../src/lib/pos-stock-events.js';
import { formatUzbekistanDateTime } from '../src/lib/uzbekistan-time.js';
import * as checkoutTimingStorage from '../src/lib/checkout-timing.js';

const read = path => readFileSync(path, 'utf8');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

// Extract and execute actual callbacks rather than maintaining a second implementation.
function declaration(source, name, optional = false) {
  const ast = ts.createSourceFile('POS.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  let initializer;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (optional && !initializer) return '';
  assert.ok(initializer, `Expected actual ${name} callback`);
  return `const ${name} = ${initializer};`;
}

function component(path, dependencies, globals = {}, exportName = 'default') {
  const module = { exports: {} };
  const code = transformSync(read(path), { loader: 'jsx', format: 'cjs', jsx: 'transform' }).code;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, globals)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name} in ${path}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports[exportName];
}

function loadingHarness({ productPromise = Promise.resolve([{ id: 'cake', name: 'Tort', active: true }]), optionalPromise = Promise.resolve([]) } = {}) {
  const source = read('src/pages/POS.jsx');
  const calls = [];
  const data = {
    Category: [{ id: 'category', name: 'Tortlar', active: true }],
    Shop: [{ id: 'branch', name: 'Branch', active: true }],
    Settings: [{ id: 'settings' }],
    ProductStock: [{ id: 'stock', product_id: 'cake', location_id: 'branch', quantity: 3 }],
  };
  const state = { loading: false };
  const entities = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, {
    list: async () => { calls.push(name); return rows; },
  }]));
  entities.Product = { list: () => { calls.push('Product'); return productPromise; } };
  const optional = name => typeof optionalPromise === 'function' ? optionalPromise(name) : optionalPromise;
  entities.CashRecipient = { list: () => { calls.push('CashRecipient'); return optional('CashRecipient'); } };
  const ctx = {
    base44: {
      entities,
      functions: { invoke: (name) => { calls.push(name); return optional(name); } },
    },
    loadCurrentShift: async () => ({ id: 'shift', shop_id: 'branch' }),
    setLoadingData: value => { state.loading = value; },
    setCategories: value => { state.categories = value; },
    setProducts: value => { state.products = value; },
    setProductStock: value => { state.stock = value; },
    setShops: value => { state.shops = value; },
    setSettings: value => { state.settings = value; },
    setCashRecipients: value => { state.recipients = value; },
    setSupplierDebts: value => { state.debts = value; },
    setWasteAlerts: value => { state.alerts = value; },
    setCashDataLoading: value => { state.cashLoading = value; },
    setCashDataError: value => { state.cashError = value; },
    loadGenerationRef: { current: 0 }, wasteAlertGenerationRef: { current: 0 },
    user: { id: 'owner', role: 'admin' },
  };
  const code = ['loadCashData', 'loadWasteAlerts'].map(name => declaration(source, name, true)).join('\n')
    + '\n' + declaration(source, 'loadAll') + '\nglobalThis.load = loadAll;';
  vm.runInNewContext(code, ctx);
  return { state, calls, load: ctx.load };
}

test('slow debt, waste and recipient reads do not hold the catalog loading screen', { timeout: 5000 }, async () => {
  const gate = deferred();
  const f = loadingHarness({ optionalPromise: gate.promise });
  let settled = false;
  const pending = f.load().then(() => { settled = true; });
  try {
    await tick();
    assert.equal(settled, true, 'essential catalog loading must finish while optional reads are pending');
    assert.equal(f.state.loading, false);
    assert.equal(f.state.products[0].id, 'cake');
    assert.equal(f.state.stock[0].quantity, 3);
    assert.equal(f.state.shops[0].id, 'branch');
    assert.ok(f.calls.includes('supplier-ledger'));
    assert.ok(f.calls.includes('waste-ledger'));
  } finally { gate.resolve({ data: { debts: {}, expired_items: [] } }); await pending; await tick(); }
});

test('catalog still waits for required product data and tolerates optional read errors', { timeout: 5000 }, async () => {
  const gate = deferred();
  const f = loadingHarness({ productPromise: gate.promise,
    optionalPromise: () => Promise.reject(new Error('Mock optional outage')) });
  const pending = f.load();
  await tick();
  assert.equal(f.state.loading, true);
  assert.equal(f.state.products, undefined);
  gate.resolve([{ id: 'cake', name: 'Tort', active: true }]);
  await pending; await tick();
  assert.equal(f.state.loading, false);
  assert.equal(f.state.products[0].id, 'cake');
  assert.equal(f.state.cashLoading, false);
  assert.match(f.state.cashError, /yuklanmadi/);
});

test('late background data from an earlier catalog load cannot overwrite its replacement', { timeout: 5000 }, async () => {
  const gates = [deferred(), deferred()]; const attempts = new Map();
  const f = loadingHarness({ optionalPromise: name => {
    const generation = attempts.get(name) || 0; attempts.set(name, generation + 1);
    return gates[generation].promise.then(() => name === 'CashRecipient'
      ? [{ id: `supplier-${generation}`, active: true }]
      : { data: name === 'supplier-ledger' ? { debts: { [`supplier-${generation}`]: 100 } }
        : { expired_items: [{ id: `waste-${generation}` }] } });
  } });
  await f.load(); await f.load();
  gates[1].resolve(); await tick();
  assert.equal(f.state.recipients[0].id, 'supplier-1');
  assert.equal(f.state.alerts[0].id, 'waste-1');
  gates[0].resolve(); await tick();
  assert.equal(f.state.recipients[0].id, 'supplier-1');
  assert.deepEqual(Object.keys(f.state.debts), ['supplier-1']);
  assert.equal(f.state.alerts[0].id, 'waste-1');
});

function gridFixture() {
  const renders = new Map();
  const SearchIcon = props => React.createElement('svg', { ...props, 'aria-hidden': true });
  const instrumentedReact = { ...React, memo: (render, compare) => React.memo(props => {
    renders.set(props.product.id, (renders.get(props.product.id) || 0) + 1);
    return render(props);
  }, compare) };
  const Card = component('src/components/pos/ProductCard.jsx', {
    react: instrumentedReact,
    '@/components/ui/image': { Image: props => React.createElement('img', props) },
    '@/lib/pos': { formatUZS: amount => `${amount} UZS` },
    '@/lib/pos-thumbnails': { posThumbnailFor: () => null },
  });
  const Grid = component('src/components/pos/ProductGrid.jsx', {
    react: React,
    'lucide-react': { Search: SearchIcon, PackageSearch: SearchIcon },
    '@/components/pos/ProductCard': Card,
    './ProductCard': Card,
  });
  const products = [{ id: 'cake', name: 'Tort', price: 15000 }, { id: 'tea', name: 'Choy', price: 10000 }];
  const added = [];
  const props = { products, shopId: 'branch', stockByProduct: { cake: 3, tea: 2 }, showStock: true,
    onAdd: product => added.push(product.id), disabled: false, loading: false };
  return { Grid, props, renders, added };
}

test('unrelated parent cart/payment state does not render catalog cards again; checkout locks still update', () => {
  const f = gridFixture();
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(f.Grid, f.props)); });
  assert.deepEqual([...f.renders.values()], [1, 1]);
  act(() => { renderer.update(React.createElement(f.Grid, { ...f.props })); });
  assert.deepEqual([...f.renders.values()], [1, 1], 'unchanged catalog inputs should skip card renders');
  act(() => { renderer.root.findAllByType('button')[0].props.onClick(); });
  assert.deepEqual(f.added, ['cake']);
  act(() => { renderer.update(React.createElement(f.Grid, { ...f.props, disabled: true })); });
  assert.ok(renderer.root.findAllByType('button').every(button => button.props.disabled));
  assert.deepEqual([...f.renders.values()], [2, 2]);
  act(() => { renderer.update(React.createElement(f.Grid, f.props)); });
  assert.ok(renderer.root.findAllByType('button').every(button => !button.props.disabled));
  act(() => { renderer.unmount(); });
});

test('stock updates still reach the affected product while unchanged cards stay memoized', () => {
  const f = gridFixture(); let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(f.Grid, f.props)); });
  act(() => { renderer.update(React.createElement(f.Grid, { ...f.props, stockByProduct: { cake: 2, tea: 2 } })); });
  assert.equal(f.renders.get('cake'), 2);
  assert.equal(f.renders.get('tea'), 1);
  act(() => { renderer.unmount(); });
});

test('stock echoes and unrelated deletes avoid redraws but real changes and other shops remain correct', () => {
  const rows = [{ id: 'branch-stock', product_id: 'cake', location_id: 'branch', quantity: 3 },
    { id: 'central-stock', product_id: 'cake', location_id: 'central', quantity: 8 }];
  assert.equal(mergePosStockEvent(rows, { type: 'update', data: { id: 'branch-stock', quantity: 3, updated_at: 'later' } }), rows);
  assert.equal(mergePosStockEvent(rows, { type: 'delete', id: 'unknown' }), rows);
  const changed = mergePosStockEvent(rows, { type: 'update', data: { id: 'central-stock', quantity: 7 } });
  assert.notEqual(changed, rows);
  assert.equal(changed[0], rows[0]);
  assert.equal(changed[1].quantity, 7, 'keep other shop data valid when the user changes shifts');
  assert.equal(rows[1].quantity, 8, 'never mutate the prior state');
  assert.equal(mergePosStockEvent(changed, { type: 'delete', id: 'branch-stock' }).length, 1);
});

test('stable catalog callback sees the latest state and locks instead of capturing an old cart', async () => {
  const module = await import('../src/hooks/use-stable-event.js');
  const useStableEvent = module.default || module.useStableEvent;
  assert.equal(typeof useStableEvent, 'function');
  let latest;
  function Probe({ count, locked }) {
    latest = useStableEvent(() => locked ? 'locked' : count);
    return null;
  }
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(Probe, { count: 1, locked: false })); });
  const original = latest;
  act(() => { renderer.update(React.createElement(Probe, { count: 2, locked: false })); });
  assert.equal(latest, original);
  assert.equal(original(), 2);
  act(() => { renderer.update(React.createElement(Probe, { count: 2, locked: true })); });
  assert.equal(latest, original);
  assert.equal(original(), 'locked');
  act(() => { renderer.unmount(); });
});

test('pre-shift product order remains null-safe and stable, then refreshes the selected shop normally', async () => {
  const events = new Map(); const calls = []; let version = 1; let observed;
  const useOrder = component('src/hooks/usePosProductOrder.js', {
    react: React,
    '@/api/base44Client': { base44: {
      functions: { invoke: async (name, request) => {
        calls.push([name, request]);
        return { data: { shop_id: request.shop_id, version, order: ['tea', 'cake'] } };
      } },
      entities: { Shop: { subscribe: () => () => {} } },
    } },
  }, {
    window: { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) },
    document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout, clearTimeout,
  });
  function Probe({ shopId }) { observed = useOrder(shopId, 'owner'); return null; }
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(Probe, {})); });
  const fallback = observed.order;
  assert.deepEqual([...fallback], []);
  act(() => { renderer.update(React.createElement(Probe, {})); });
  assert.equal(observed.order, fallback);
  assert.equal(calls.length, 0, 'without a shop there is no backend lookup');
  await act(async () => { renderer.update(React.createElement(Probe, { shopId: 'branch' })); await tick(); });
  assert.deepEqual([...observed.order], ['tea', 'cake']);
  version = 2;
  await act(async () => { await events.get('focus')(); });
  assert.equal(calls.length, 2);
  assert.deepEqual([...observed.order], ['tea', 'cake']);
  const loaded = observed.order;
  act(() => { renderer.update(React.createElement(Probe, { shopId: 'branch' })); });
  assert.equal(observed.order, loaded);
  act(() => { renderer.unmount(); });
});

test('saving status is accessible while saving and clears after the server responds', () => {
  const Icon = () => React.createElement('svg', { 'aria-hidden': true });
  const Status = component('src/components/pos/PaymentSavingStatus.jsx', {
    react: React, 'lucide-react': { Loader2: Icon, RefreshCw: Icon, Clock: Icon, CheckCircle2: Icon },
  });
  const saving = renderToStaticMarkup(React.createElement(Status, { saving: true }));
  assert.match(saving, /role="status"/);
  assert.match(saving, /saqlan/i);
  assert.doesNotMatch(saving, /Savdo saqlandi/);
  assert.equal(renderToStaticMarkup(React.createElement(Status, { saving: false })), '');
});

test('supplier-payment UI distinguishes loading and errors from a genuinely empty debt list', () => {
  const Icon = () => React.createElement('svg');
  const Wrapper = ({ children }) => React.createElement('div', null, children);
  const input = props => React.createElement('input', props);
  const Cash = component('src/components/pos/KassaActionDialogs.jsx', {
    react: React, '@/components/ui/odina-select': props => React.createElement('select', props),
    'lucide-react': { ShieldCheck: Icon, Banknote: Icon, RotateCcw: Icon },
    '@/components/ui/dialog': { Dialog: Wrapper, DialogContent: Wrapper, DialogHeader: Wrapper, DialogTitle: Wrapper, DialogFooter: Wrapper },
    '@/components/ui/button': { Button: props => React.createElement('button', props) },
    '@/components/ui/input': { Input: input }, '@/components/ui/label': { Label: Wrapper },
    '@/components/ui/textarea': { Textarea: props => React.createElement('textarea', props) },
    '@/lib/pos': { formatUZS: value => `${value || 0} UZS` },
  }, {}, 'CashWithdrawalDialog');
  let retries = 0; let renderer;
  const props = { open: true, user: { role: 'admin' }, shift: { expected_cash: 1000 },
    recipients: [], supplierDebts: {}, onClose: () => {}, onConfirm: () => {},
    loading: false, dataLoading: true, onRetryData: () => { retries++; } };
  act(() => { renderer = TestRenderer.create(React.createElement(Cash, props)); });
  act(() => { renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'goods_payment' } }); });
  assert.ok(renderer.root.findAllByType('select')[1].props.disabled);
  assert.equal(renderer.root.findAllByProps({ role: 'status' }).length, 1);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /yetkazib beruvchi qarzi yo‘q/);
  act(() => { renderer.update(React.createElement(Cash, { ...props, dataLoading: false, dataError: 'Mock supplier outage' })); });
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /yetkazib beruvchi qarzi yo‘q/);
  act(() => { renderer.root.findAllByType('button').find(button => button.children.includes('Qayta yuklash')).props.onClick(); });
  assert.equal(retries, 1);
  act(() => { renderer.update(React.createElement(Cash, { ...props, dataLoading: false, dataError: '' })); });
  assert.match(JSON.stringify(renderer.toJSON()), /yetkazib beruvchi qarzi yo‘q/);
  assert.equal(renderer.root.findAllByType('select')[1].props.disabled, false);
  assert.ok(renderer.root.findAllByType('button').at(-1).props.disabled);
  act(() => { renderer.unmount(); });
});

function checkoutHarness({ clock = performance } = {}) {
  const gate = deferred(); const calls = []; const alerts = []; const receipts = []; const timings = []; const logs = [];
  const ctx = {
    saleSubmittingRef: { current: false }, checkoutReadyRef: { current: true },
    checkoutCancelledRef: { current: false }, checkoutRequestKeyRef: { current: 'same-checkout-key' },
    checkoutRecordedAtRef: { current: '2026-10-13T02:00:00+05:00' }, takeawayRequestIdRef: { current: '' },
    cart: [{ product_id: 'cake', product_name: 'Tort', quantity: 1, subtotal: 15000, price: 15000 }],
    stockChecking: false, discountLoading: false, selectedTable: null, tableCartDirty: false,
    tableOrder: null, takeawayOrder: null, takeawayDirty: false, checkoutOffline: false,
    isOnline: true, queueEligible: true, reportRequestSuccess: () => {}, reportRequestError: () => {},
    discountCode: '', roundingTarget: null, adjustmentMode: null, discountPct: 0,
    discountOwnerPin: '', subtotal: 15000, shift: { id: 'shift', shop_id: 'branch' },
    user: { id: 'owner', shop_id: 'branch' }, shops: [{ id: 'branch' }],
    performance: clock, navigator: { onLine: true }, console: {
      info: (label, value) => { logs.push([label, JSON.parse(value)]); }, error: () => {},
    },
    createSaleIdempotencyKey: () => 'unexpected-new-key', buildPendingSale: () => null,
    friesOptionFields: () => ({}), isRetryableSyncError: () => false,
    syncErrorMessage: error => error.message, odinaAlert: text => alerts.push(text),
    isStaffTicketEnabled: () => true,
    base44: { functions: { invoke: (name, request) => {
      calls.push([name, request]);
      return name === 'complete-sale' ? gate.promise : Promise.resolve({ data: { expired_items: [] } });
    } } },
    setMobileCartOpen: () => {}, setPayOpen: value => { ctx.payOpen = value; },
    setPaying: value => { ctx.paying = value; }, setCheckoutOffline: value => { ctx.checkoutOffline = value; },
    recordCheckoutTiming: value => { ctx.lastCheckoutTiming = { ...value, shiftId: ctx.shift.id }; timings.push(value); },
    setShift: value => { ctx.shift = value; },
    productStock: [{ id: 'stock', product_id: 'cake', location_id: 'branch', quantity: 3 }],
    setProductStock: update => { ctx.productStock = update(ctx.productStock); },
    resetCart: () => { ctx.cart = []; }, setTableOrder: value => { ctx.tableOrder = value; },
    setTakeawayOrder: value => { ctx.takeawayOrder = value; }, setWasteAlerts: () => {},
    loadWasteAlerts: () => Promise.resolve(),
    setReceiptPrintSale: sale => { receipts.push(sale); }, setStaffTicket: () => {},
    navigate: () => {}, setTablePickerOpen: () => {}, posHomePath: '/pos',
    enqueueOfflineSale: () => { throw new Error('Unexpected offline queue'); },
  };
  const source = read('src/pages/POS.jsx');
  const names = ['finishSalePresentation', 'presentCompletedSale', 'finishQueuedSale', 'applyCompletedSale', 'completeSale'];
  vm.runInNewContext(names.map(name => declaration(source, name)).join('\n') + '\nglobalThis.submit = completeSale;', ctx);
  return { ctx, gate, calls, alerts, receipts, timings, logs, submit: ctx.submit };
}

test('payment cannot clear cart or print before acknowledgment and cannot submit twice while pending', { timeout: 5000 }, async () => {
  const f = checkoutHarness();
  const pending = f.submit([{ method: 'cash', amount: 15000 }], true);
  assert.equal(f.ctx.paying, true);
  assert.equal(f.ctx.cart.length, 1);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.calls.length, 1);
  await f.submit([{ method: 'cash', amount: 15000 }], true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].idempotency_key, 'same-checkout-key');
  const sale = { id: 'sale', shop_id: 'branch', items: f.ctx.cart };
  f.gate.resolve({ data: { sale, shift: f.ctx.shift, stock_updates: [{ product_id: 'cake', quantity: 2 }] } });
  await pending;
  assert.equal(f.ctx.paying, false);
  assert.equal(f.ctx.cart.length, 0);
  assert.equal(f.ctx.productStock[0].quantity, 2);
  assert.deepEqual(f.receipts, [sale]);
  assert.deepEqual(f.alerts, []);
});

test('failed payment keeps the cart and receipt unprinted for the same checkout retry', { timeout: 5000 }, async () => {
  const f = checkoutHarness();
  const pending = f.submit([{ method: 'cash', amount: 15000 }], true);
  f.gate.reject(new Error('Mock validation failure'));
  await pending;
  assert.equal(f.ctx.paying, false);
  assert.equal(f.ctx.payOpen, true);
  assert.equal(f.ctx.cart.length, 1);
  assert.equal(f.ctx.productStock[0].quantity, 3);
  assert.equal(f.ctx.checkoutRequestKeyRef.current, 'same-checkout-key');
  assert.equal(f.receipts.length, 0);
  assert.equal(f.alerts.length, 1);
});

function checkoutClock() {
  let elapsed = 1000; let reads = 0;
  return { now: () => { reads++; return elapsed; }, advance: ms => { elapsed += ms; }, get reads() { return reads; } };
}

test('visible checkout time reuses the existing total, includes synchronous preparation and presentation, and excludes later work', async () => {
  const clock = checkoutClock(); const f = checkoutHarness({ clock }); const background = deferred();
  f.ctx.setMobileCartOpen = () => clock.advance(300);
  const showReceipt = f.ctx.setReceiptPrintSale;
  f.ctx.setReceiptPrintSale = sale => { clock.advance(150); showReceipt(sale); };
  f.ctx.loadWasteAlerts = () => background.promise;
  const pending = f.submit([{ method: 'cash', amount: 15000 }], true);
  assert.equal(f.timings.length, 0, 'no confirmed time before the server reply');
  assert.equal(clock.reads, 2);
  await f.submit([{ method: 'cash', amount: 15000 }], false);
  assert.equal(clock.reads, 2, 'a blocked second click must not start another clock');
  assert.equal(f.calls.length, 1);
  clock.advance(2100);
  f.gate.resolve({ data: { sale: { id: 'sale', shop_id: 'branch', items: f.ctx.cart }, backend_timing: { total_ms: 1800 } } });
  await pending;
  assert.equal(clock.reads, 4, 'the existing four online reads also drive the visible result');
  assert.equal(f.timings.length, 1);
  assert.equal(f.ctx.lastCheckoutTiming.totalMs, 2550);
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'confirmed');
  assert.equal(f.ctx.lastCheckoutTiming.shiftId, 'shift');
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0][0], '[Odina checkout timing]');
  assert.equal(f.logs[0][1].total_ms, f.ctx.lastCheckoutTiming.totalMs);
  assert.equal(f.logs[0][1].server_ms, 2100);
  assert.equal(f.logs[0][1].backend.total_ms, 1800);
  assert.equal(f.calls.length, 1, 'displaying timing must not add a request');
  clock.advance(90000); background.resolve(); await tick();
  assert.equal(f.ctx.lastCheckoutTiming.totalMs, 2550, 'later refresh and printing time cannot change the finished attempt');
  assert.equal(clock.reads, 4);
});

test('retry timing excludes the human pause and preserves the checkout key, timestamp, items and payment', async () => {
  const clock = checkoutClock(); const f = checkoutHarness({ clock });
  const payments = [{ method: 'cash', amount: 15000 }];
  const failed = f.submit(payments, false);
  const originalRequest = JSON.stringify(f.calls[0][1]);
  clock.advance(500); f.gate.reject(new Error('Mock rejected request')); await failed;
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'unconfirmed');
  assert.equal(f.ctx.lastCheckoutTiming.totalMs, 500);
  assert.equal(f.ctx.cart.length, 1);
  assert.equal(f.ctx.checkoutRequestKeyRef.current, 'same-checkout-key');
  clock.advance(60000);
  const retry = deferred();
  f.ctx.base44.functions.invoke = (name, request) => { f.calls.push([name, request]); return retry.promise; };
  const pending = f.submit(payments, false);
  clock.advance(2400);
  retry.resolve({ data: { sale: { id: 'original-sale', shop_id: 'branch', items: f.ctx.cart }, already_processed: true } });
  await pending;
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(f.calls[1][1]), originalRequest);
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'rechecked');
  assert.equal(f.ctx.lastCheckoutTiming.totalMs, 2400);
  assert.equal(f.logs.at(-1)[1].server_ms, 2400);
  assert.equal(f.ctx.cart.length, 0);
  assert.equal(f.ctx.checkoutRequestKeyRef.current, '');
});

test('offline and transport-fallback timing confirms a queued sale only after local storage succeeds', async () => {
  for (const fallback of [false, true]) {
    const clock = checkoutClock(); const f = checkoutHarness({ clock }); const storage = deferred(); const saved = [];
    const localSale = { id: 'local-sale', offline_pending: true, shop_id: 'branch', items: f.ctx.cart };
    const queued = { request: { action: 'complete_sale', idempotency_key: 'same-checkout-key' }, local_sale: localSale };
    f.ctx.buildPendingSale = () => queued;
    f.ctx.isOnline = fallback;
    f.ctx.isRetryableSyncError = () => true;
    f.ctx.enqueueOfflineSale = async row => { await storage.promise; saved.push(row); };
    const pending = f.submit([{ method: 'cash', amount: 15000 }], true);
    if (fallback) { clock.advance(2000); f.gate.reject(new Error('Mock lost reply')); await tick(); }
    assert.equal(f.timings.length, 0);
    assert.equal(f.ctx.cart.length, 1);
    assert.equal(f.receipts.length, 0);
    assert.equal(f.ctx.checkoutRequestKeyRef.current, 'same-checkout-key');
    await f.submit([{ method: 'cash', amount: 15000 }], true);
    clock.advance(250); storage.resolve(); await pending;
    assert.equal(saved.length, 1);
    assert.equal(saved[0], queued);
    assert.equal(f.calls.length, fallback ? 1 : 0);
    assert.equal(clock.reads, fallback ? 3 : 2);
    assert.equal(f.ctx.lastCheckoutTiming.outcome, 'queued');
    assert.equal(f.ctx.lastCheckoutTiming.totalMs, fallback ? 2250 : 250);
    assert.equal(f.logs[0][1].total_ms, f.ctx.lastCheckoutTiming.totalMs);
    assert.equal(f.logs[0][1].server_ms, null, 'a lost reply must not invent a confirmed server duration');
    assert.equal(f.receipts.at(-1), localSale);
    assert.equal(f.ctx.cart.length, 0);
  }
});

test('queue failure and malformed online acknowledgment never display confirmed or queued success', async () => {
  for (const mode of ['offline', 'fallback', 'malformed']) {
    const clock = checkoutClock(); const f = checkoutHarness({ clock });
    if (mode === 'malformed') {
      const pending = f.submit([{ method: 'cash', amount: 15000 }], true);
      clock.advance(700); f.gate.resolve({ data: { sale: {} } }); await pending;
    } else {
      f.ctx.isOnline = mode === 'fallback';
      f.ctx.buildPendingSale = () => ({ local_sale: { id: 'local-sale', offline_pending: true } });
      f.ctx.isRetryableSyncError = () => true;
      const storage = deferred(); f.ctx.enqueueOfflineSale = () => storage.promise;
      const pending = f.submit([{ method: 'cash', amount: 15000 }], true);
      if (mode === 'fallback') { clock.advance(500); f.gate.reject(new Error('Mock lost reply')); await tick(); }
      clock.advance(mode === 'fallback' ? 200 : 700); storage.reject(new Error('Quota exceeded')); await pending;
    }
    assert.equal(f.ctx.lastCheckoutTiming.outcome, 'unconfirmed');
    assert.equal(f.ctx.lastCheckoutTiming.totalMs, 700);
    assert.equal(f.ctx.cart.length, 1);
    assert.equal(f.ctx.payOpen, true);
    assert.equal(f.ctx.checkoutRequestKeyRef.current, 'same-checkout-key');
    assert.equal(f.receipts.length, 0);
    assert.equal(f.alerts.length, 1);
    assert.equal(f.logs[0][1].completed, false);
    assert.equal(f.calls.length, mode === 'offline' ? 0 : 1);
  }
});

test('presentation failure after server confirmation preserves confirmed timing without queueing or charging again', async () => {
  const clock = checkoutClock(); const f = checkoutHarness({ clock });
  f.ctx.setReceiptPrintSale = sale => { if (sale) throw new Error('Mock receipt presentation failure'); };
  const pending = f.submit([{ method: 'cash', amount: 15000 }], true);
  clock.advance(2400); f.gate.resolve({ data: { sale: { id: 'saved-sale', shop_id: 'branch', items: f.ctx.cart } } });
  await pending;
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'confirmed');
  assert.equal(f.ctx.lastCheckoutTiming.totalMs, 2400);
  assert.equal(f.logs[0][1].completed, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.ctx.payOpen, false);
  assert.equal(f.ctx.cart.length, 0);
  assert.match(f.alerts[0], /Savdo saqlandi/);
  await f.submit([{ method: 'cash', amount: 15000 }], true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timings.length, 1);
});

test('invalid or blocked final submission does not start a measurement or request', async () => {
  for (const flags of [{ cart: [] }, { stockChecking: true }, { discountLoading: true },
    { checkoutReadyRef: { current: false } }, { saleSubmittingRef: { current: true } }]) {
    const clock = checkoutClock(); const f = checkoutHarness({ clock }); Object.assign(f.ctx, flags);
    await f.submit([{ method: 'cash', amount: 15000 }], true);
    assert.equal(clock.reads, 0); assert.equal(f.calls.length, 0); assert.equal(f.timings.length, 0);
  }
});

function checkoutStatusFixture() {
  const Status = component('src/components/pos/CheckoutTimingStatus.jsx', {
    react: React, '@/lib/uzbekistan-time': { formatUzbekistanDateTime },
  });
  const source = read('src/pages/POS.jsx');
  const ast = ts.createSourceFile('POS.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  let element;
  const visit = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'CheckoutTimingStatus') element = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(element, 'the real POS must render its checkout timing status');
  const code = transformSync(`globalThis.ScopedStatus = ({ lastCheckoutTiming, shift, paying, user = { role: 'admin' } }) => (${element});`, { loader: 'jsx', jsx: 'transform' }).code;
  const ctx = { React, CheckoutTimingStatus: Status }; vm.runInNewContext(code, ctx);
  return props => renderToStaticMarkup(React.createElement(ctx.ScopedStatus, props));
}

test('real Kassa status displays localized seconds and distinct confirmed, replay, queued and unconfirmed results', () => {
  const render = checkoutStatusFixture();
  const copies = {
    confirmed: [/Yakunlash:/, /Savdo saqlandi/],
    rechecked: [/Qayta tekshirish:/, /Saqlangan savdo tasdiqlandi/],
    queued: [/Qurilmaga saqlash:/, /Server tasdig‘i kutilmoqda/],
    unconfirmed: [/Yakunlash tasdiqlanmadi:/, /Savdo holatini tekshiring/],
  };
  for (const [outcome, patterns] of Object.entries(copies)) {
    const html = render({ shift: { id: 'shift' }, lastCheckoutTiming: { shiftId: 'shift', totalMs: 2400, outcome }, paying: false });
    assert.match(html, /role="status"/); assert.match(html, /aria-live="polite"/);
    assert.match(html, /2,4 soniya/); patterns.forEach(pattern => assert.match(html, pattern));
    if (outcome === 'queued' || outcome === 'unconfirmed') assert.doesNotMatch(html, /Savdo saqlandi\./);
  }
});

test('real Kassa timing is visible only to owner/admin and renders nothing for workers or unknown roles', () => {
  const render = checkoutStatusFixture();
  const props = { shift: { id: 'shift' }, paying: false,
    lastCheckoutTiming: { shiftId: 'shift', totalMs: 2400, outcome: 'confirmed',
      completedAt: '2026-10-15T10:00:00.000Z', persisted: false } };
  assert.match(render({ ...props, user: { role: 'admin' } }), /2,4 soniya/);
  for (const user of [null, {}, { role: 'manager' }, { role: 'cashier' }, { role: 'user' },
    { role: 'staff' }, { role: 'admin ' }, { role: 'cashier', data: { role: 'admin' } }]) {
    for (const lastCheckoutTiming of [null, props.lastCheckoutTiming]) {
      for (const paying of [false, true]) {
        assert.equal(render({ ...props, user, lastCheckoutTiming, paying }), '',
          'workers must see no seconds, timestamp, placeholder, pending text or persistence warning');
      }
    }
  }
});

test('real Kassa status hides old shift or pending attempt seconds, handles invalid metrics and stays accessible without timers', () => {
  const render = checkoutStatusFixture();
  const lastCheckoutTiming = { shiftId: 'old-shift', totalMs: 2400, outcome: 'confirmed' };
  const placeholder = render({ shift: { id: 'new-shift' }, lastCheckoutTiming, paying: false });
  assert.match(placeholder, /Yakunlashdan so‘ng vaqt shu yerda ko‘rinadi/);
  assert.doesNotMatch(placeholder, /2,4 soniya|Savdo saqlandi/);
  const pending = render({ shift: { id: 'old-shift' }, lastCheckoutTiming, paying: true });
  assert.match(pending, /Yakunlash vaqti o‘lchanmoqda/); assert.doesNotMatch(pending, /2,4 soniya|Savdo saqlandi/);
  for (const totalMs of [NaN, Infinity, undefined]) {
    const html = render({ shift: { id: 'old-shift' }, lastCheckoutTiming: { ...lastCheckoutTiming, totalMs }, paying: false });
    assert.doesNotMatch(html, /soniya|NaN|Infinity|Savdo saqlandi/);
  }
  const zero = render({ shift: { id: 'old-shift' }, lastCheckoutTiming: { ...lastCheckoutTiming, totalMs: -100 }, paying: false });
  assert.match(zero, /0,0 soniya/);
});

test('remembered checkout shows its finish timestamp in Tashkent and explains an actual device-storage failure', () => {
  const render = checkoutStatusFixture();
  const completedAt = '2026-10-14T20:15:30.000Z';
  const props = { shift: { id: 'shift' }, paying: false,
    lastCheckoutTiming: { shiftId: 'shift', totalMs: 2400, outcome: 'confirmed', completedAt, persisted: true } };
  const saved = render(props);
  assert.match(saved, /2,4 soniya/);
  assert.match(saved, /datetime="2026-10-14T20:15:30.000Z"/i);
  assert.ok(saved.includes(formatUzbekistanDateTime(completedAt, { second: '2-digit' })));
  assert.match(saved, /01:15:30/);
  assert.doesNotMatch(saved, /qurilmaga saqlab bo‘lmadi/);
  const unavailable = render({ ...props, lastCheckoutTiming: { ...props.lastCheckoutTiming, persisted: false } });
  assert.match(unavailable, /Savdo saqlandi/);
  assert.match(unavailable, /2,4 soniya/);
  assert.match(unavailable, /Vaqt faqat shu oynada: qurilmaga saqlab bo‘lmadi/);
});

test('actual final checkout records its existing measured seconds once and restores the real Kassa status after reopening', async () => {
  const rows = new Map(); let writes = 0; let observed;
  const storage = { getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => { writes++; rows.set(key, value); } };
  const useTiming = component('src/hooks/useCheckoutTiming.js', {
    react: React, '@/lib/checkout-timing': {
      ...checkoutTimingStorage,
      readCheckoutTiming: scope => checkoutTimingStorage.readCheckoutTiming(scope, storage),
      saveCheckoutTiming: (scope, value) => checkoutTimingStorage.saveCheckoutTiming(scope, value, storage),
    },
  });
  function Probe() { observed = useTiming('owner', 'branch', 'shift'); return null; }
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
  const clock = checkoutClock(); const f = checkoutHarness({ clock });
  f.ctx.recordCheckoutTiming = observed.recordTiming;
  const pending = f.submit([{ method: 'cash', amount: 15000 }], false);
  assert.equal(writes, 0, 'starting a checkout must not save an unfinished measurement');
  clock.advance(2400);
  await act(async () => {
    f.gate.resolve({ data: { sale: { id: 'sale', shop_id: 'branch', items: f.ctx.cart } } });
    await pending;
  });
  assert.equal(writes, 1);
  assert.equal(f.calls.length, 1, 'remembering timing must not add a backend request');
  assert.equal(clock.reads, 4);
  assert.equal(observed.timing.totalMs, f.logs[0][1].total_ms);
  assert.equal(observed.timing.outcome, 'confirmed');
  const completedAt = observed.timing.completedAt;
  act(() => { renderer.unmount(); });
  act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
  try {
    assert.equal(writes, 1, 'reopening only reads the remembered metric');
    assert.equal(observed.timing.completedAt, completedAt);
    assert.equal(observed.timing.persisted, true);
    const html = checkoutStatusFixture()({ shift: { id: 'shift' }, lastCheckoutTiming: observed.timing, paying: false });
    assert.match(html, /Yakunlash:/);
    assert.match(html, /2,4 soniya/);
    assert.match(html, /Savdo saqlandi/);
    assert.ok(html.includes(formatUzbekistanDateTime(completedAt, { second: '2-digit' })));
  } finally { act(() => { renderer.unmount(); }); }
});
