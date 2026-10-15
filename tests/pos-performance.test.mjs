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

function checkoutHarness() {
  const gate = deferred(); const calls = []; const alerts = []; const receipts = [];
  const ctx = {
    saleSubmittingRef: { current: false }, checkoutReadyRef: { current: true },
    checkoutCancelledRef: { current: false }, checkoutRequestKeyRef: { current: 'same-checkout-key' },
    checkoutRecordedAtRef: { current: '2026-10-13T02:00:00+05:00' }, takeawayRequestIdRef: { current: '' },
    cart: [{ product_id: 'cake', product_name: 'Tort', quantity: 1, subtotal: 15000, price: 15000 }],
    stockChecking: false, discountLoading: false, selectedTable: null, tableCartDirty: false,
    tableOrder: null, takeawayOrder: null, takeawayDirty: false, checkoutOffline: false,
    isDelivery: false, isOnline: true, queueEligible: true, reportRequestSuccess: () => {}, reportRequestError: () => {},
    discountCode: '', roundingTarget: null, adjustmentMode: null, discountPct: 0,
    discountOwnerPin: '', subtotal: 15000, shift: { id: 'shift', shop_id: 'branch' },
    user: { id: 'owner', shop_id: 'branch' }, shops: [{ id: 'branch' }],
    performance, navigator: { onLine: true }, console: { info: () => {}, error: () => {} },
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
  return { ctx, gate, calls, alerts, receipts, submit: ctx.submit };
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
