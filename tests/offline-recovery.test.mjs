// Actual queue, hook and checkout callbacks; memory-only SDK/storage fixtures.
// No live sales, payments, printing, or connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as network from '../src/lib/pos-network.js';
import * as offline from '../src/lib/offline-sales.js';
import { memoryBackend } from './helpers/memory-backend.mjs';

const error = (status, message = 'Network Error') => Object.assign(new Error(message), status ? { response: { status } } : { code: 'ERR_NETWORK' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function memoryQueue(seed = []) {
  let rows = structuredClone(seed);
  const storage = {
    list: async userId => structuredClone(rows.filter(row => row.user_id === userId)),
    update: async (id, patch) => { Object.assign(rows.find(row => row.id === id), structuredClone(patch)); },
    remove: async id => { rows = rows.filter(row => row.id !== id); },
  };
  return { storage, rows: () => rows, save: async row => { rows.push(structuredClone(row)); } };
}
function record(index) {
  return offline.buildPendingSale({ idempotencyKey: `pos-offline-many-${String(index).padStart(8, '0')}`, recordedAt: new Date(Date.parse('2026-10-12T18:59:00Z') + index * 1000).toISOString(),
    shift: { id: 'shift', shop_id: 'shop' }, user: { id: 'cashier' },
    cart: [{ product_id: 'cake', product_name: 'Cake', price: 1000, quantity: 1 }],
    payments: [{ method: 'cash', amount: 1000 }] });
}
function clock() {
  let now = Date.now(), next = 0;
  const timers = new Map(), listeners = new Map();
  return { now: () => now, timers, listeners,
    setTimeout: (fn, delay) => { timers.set(++next, { fn, at: now + delay }); return next; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
    async run() { const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || []; if (!timer) return false;
      now = timer.at; timers.delete(id); await timer.fn(); return true; },
  };
}

test('two consecutive transport failures pause connections; validation/auth/server errors do not activate offline', () => {
  let state = { failures: 0, offline: false };
  state = network.nextPosConnectionState(state, error(0));
  assert.equal(state.offline, false);
  state = network.nextPosConnectionState(state, error(0));
  assert.equal(state.offline, true);
  assert.equal(network.nextPosConnectionState(state).offline, false);
  for (const status of [400, 401, 403, 409, 429, 500, 503]) {
    assert.equal(network.isPosNetworkError(error(status)), false);
    assert.equal(network.nextPosConnectionState({ failures: 1, offline: false }, error(status)).offline, false);
  }
  assert.equal(network.isPosNetworkError(new Error('Invalid product')), false);
  assert.equal(network.isPosNetworkError({ code: 'ERR_CANCELED', request: {} }), false);
  const recovering = network.nextPosConnectionState({ failures: 2, offline: true }, error(503));
  assert.equal(recovering.offline, true);
  const stillUnavailable = network.nextPosConnectionState(recovering, error(0));
  assert.equal(stillUnavailable.offline, true);
  assert.equal(network.nextPosConnectionState(stillUnavailable).offline, false);
  assert.equal(network.isPosNetworkError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), true);
  assert.equal(network.queueAuthorizationBlocked([{ last_error_status: 401 }]), true);
  assert.equal(network.isPosAuthorizationError(error(403)), true);
  assert.equal(network.isPosAuthorizationError({ response: { status: 403, data: { error: '100% chegirma uchun OWNER PIN noto‘g‘ri.' } } }), false);
});

test('ordinary POS eligibility retains all protected order, discount and rounding restrictions', () => {
  assert.equal(network.canQueuePosSale({}), true);
  for (const flags of [{ selectedTable: {} }, { takeawayOrder: {} }, { takeawayRequestId: 'order' },
    { discountCode: 'coupon' }, { roundingTarget: 1000 }]) assert.equal(network.canQueuePosSale(flags), false);
});

test('health probe is read-only, bounded and ignores late responses after timeout', async () => {
  const c = clock(), gate = deferred(), calls = [];
  const pending = network.probePosConnection({ functions: { invoke: (name, data) => { calls.push([name, data]); return gate.promise; } } }, { timers: c, timeoutMs: 20 });
  const rejected = assert.rejects(pending, e => e.code === 'ETIMEDOUT');
  await tick(); await c.run(); await rejected;
  gate.resolve({ data: { ok: true, shift: null } }); await tick();
  assert.deepEqual(calls, [['complete-sale', { action: 'get_current_shift' }]]);
  assert.equal(c.timers.size, 0);
  assert.equal(await network.probePosConnection({ functions: { invoke: async () => ({ data: { ok: true, shift: null } }) } }), null);
  await assert.rejects(network.probePosConnection({ functions: { invoke: async () => ({ data: { sale: { id: 'invalid-health' } } }) } }), /tasdiqlamadi/);
});

test('250 retained offline sales drain sequentially with their original keys, dates and payments', async () => {
  const input = Array.from({ length: 250 }, (_, i) => record(i));
  const q = memoryQueue(input), requests = [];
  const result = await offline.syncPendingSales({ userId: 'cashier', storage: q.storage, lock: work => work(),
    send: async request => { requests.push(structuredClone(request)); return { data: { sale: { id: request.idempotency_key } } }; } });
  assert.equal(result.synced, 250); assert.equal(result.remaining, 0); assert.equal(q.rows().length, 0);
  assert.equal(new Set(requests.map(row => row.idempotency_key)).size, 250);
  for (const original of input) {
    assert.deepEqual(requests.find(request => request.idempotency_key === original.id), original.request);
    assert.equal(original.local_sale.business_date, offline.tashkentDateKey(original.request.recorded_at));
  }
  assert.equal(requests.reduce((sum, r) => sum + r.payments[0].amount, 0), 250000);
});

test('lost acknowledgment retries the real server handler without creating a second payment', async () => {
  const f = memoryBackend({ User: [{ id: 'cashier', role: 'cashier', shop_id: 'shop', active: true }],
    Shift: [{ id: 'shift', user_id: 'cashier', shop_id: 'shop', shop_name: 'Shop', status: 'open', opened_at: '2026-10-12T06:00:00Z',
      expected_cash: 0, total_sales: 0, order_count: 0, sale_request_keys: [] }],
    Shop: [{ id: 'shop', name: 'Shop', active: true, location_type: 'shop', allows_pos: true }],
    Product: [{ id: 'cake', name: 'Cake', active: true, track_stock: false, price: 1000 }], Settings: [{ allow_negative_stock: false }],
    Sale: [], SaleItem: [], Payment: [], StockMovement: [], ActionHistory: [] }, { now: '2026-10-13T07:00:00Z' });
  const q = memoryQueue([record(0)]); let first = true;
  const send = async request => { const reply = await f.invoke('base44/functions/complete-sale/entry.ts', request);
    assert.equal(reply.status, 200, JSON.stringify(reply));
    if (first) { first = false; throw error(0); } return reply.data; };
  const run = extra => offline.syncPendingSales({ userId: 'cashier', storage: q.storage, lock: work => work(), send, ...extra });
  const before = structuredClone(q.rows()[0].request);
  await run(); assert.equal(q.rows().length, 1); assert.deepEqual(q.rows()[0].request, before);
  const result = await run({ retryFailed: true });
  assert.equal(result.synced, 1, JSON.stringify(result)); assert.equal(q.rows().length, 0);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1); assert.equal(f.db.SaleItem.length, 1);
  assert.equal(f.db.Shift[0].order_count, 1); assert.equal(f.db.Shift[0].expected_cash, 1000);
  assert.equal(f.db.Sale[0].business_date, '2026-10-12', 'upload day cannot change the original business day');
});

test('queue keeps malformed acknowledgments and remembers session failures for checkout protection', async () => {
  for (const reply of [{}, { sale: {} }, { data: { sale: {} } }]) {
    const q = memoryQueue([record(0)]);
    const result = await offline.syncPendingSales({ userId: 'cashier', storage: q.storage, lock: work => work(), send: async () => reply });
    assert.equal(result.synced, 0); assert.equal(q.rows().length, 1);
  }
  const q = memoryQueue([record(0)]);
  const result = await offline.syncPendingSales({ userId: 'cashier', storage: q.storage, lock: work => work(), send: async () => { throw error(403); } });
  assert.equal(result.failed.network, false); assert.equal(result.failed.status, 403);
  assert.equal(network.queueAuthorizationBlocked(q.rows()), true);
});

function mountHook({ connected = true, seed = [], transport = async () => ({ data: { ok: true, shift: { id: 'shift', status: 'open' } } }) } = {}) {
  const q = memoryQueue(seed), c = clock(), nav = { onLine: connected }, calls = [], listeners = new Set(), recovered = [];
  const module = { exports: {} };
  const data = { ...offline, listPendingSales: q.storage.list,
    savePendingSale: async row => { await q.save(row); for (const callback of listeners) callback(); },
    subscribePendingSales: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    pendingSaleRetryDelay: rows => offline.pendingSaleRetryDelay(rows, c.now()),
    syncPendingSales: options => offline.syncPendingSales({ ...options, storage: q.storage, lock: work => work(), now: c.now }) };
  const dependencies = { react: React, '@/api/base44Client': { base44: { functions: { invoke: async (name, body) => {
    calls.push([name, body]); return transport(name, body); } } } }, '@/lib/offline-sales': data, '@/lib/pos-network': network };
  const code = transformSync(readFileSync('src/hooks/useOfflineSaleQueue.js', 'utf8'), { loader: 'js', format: 'cjs' }).code;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { navigator: nav, window: c })(name => dependencies[name], module, module.exports);
  let value; const useQueue = module.exports.default;
  function Probe() { value = useQueue('cashier', () => {}, shift => recovered.push(shift)); return null; }
  let renderer;
  const mount = async () => { await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); await tick(); }); };
  return { q, c, nav, calls, recovered, data, mount, value: () => value,
    async unmount() { act(() => renderer.unmount()); },
    async timer() { await act(async () => { await c.run(); await tick(); }); } };
}

test('hook accepts many offline sales, keeps them across remount, then recovers and sends each once', async () => {
  const f = mountHook({ connected: false, transport: async (_, body) => body.action === 'get_current_shift'
    ? { data: { ok: true, shift: { id: 'shift', status: 'open' } } } : { data: { sale: { id: body.idempotency_key } } } });
  await f.mount();
  try {
    await act(async () => { for (let i = 0; i < 30; i++) await f.value().enqueue(record(i)); });
    assert.equal(f.value().records.length, 30); assert.equal(f.calls.length, 0);
    await f.unmount(); await f.mount(); assert.equal(f.value().records.length, 30);
    f.nav.onLine = true;
    await act(async () => { f.c.listeners.get('online')(); await tick(); await tick(); });
    assert.equal(f.q.rows().length, 0);
    assert.equal(f.calls.filter(([, body]) => body.action === 'complete_sale').length, 30);
  } finally { await f.unmount(); }
});

test('two network failures while browser stays online pause writes; read-only recovery resumes the queue', async () => {
  let down = true;
  const f = mountHook({ seed: [record(0)], transport: async (_, body) => {
    if (down) throw error(0);
    return body.action === 'get_current_shift' ? { data: { ok: true, shift: null } } : { data: { sale: { id: body.idempotency_key } } };
  } });
  await f.mount();
  try {
    assert.equal(f.value().connectionPaused, false);
    await f.timer();
    assert.equal(f.value().connectionPaused, true); assert.equal(f.value().isOnline, false);
    await act(async () => { for (let i = 1; i < 10; i++) await f.value().enqueue(record(i)); });
    assert.equal(f.calls.length, 2, 'additional offline receipts make no foreground write requests');
    down = false;
    await f.timer(); await f.timer();
    assert.equal(f.recovered.at(-1), null, 'recovery reports closed/missing active shift before enabling payments');
    assert.equal(f.q.rows().length, 0);
    assert.equal(f.calls.filter(([, body]) => body.action === 'get_current_shift').length, 1);
    assert.equal(f.calls.filter(([, body]) => body.action === 'complete_sale').length, 12);
  } finally { await f.unmount(); }
});

function declaration(source, name) {
  const ast = ts.createSourceFile('POS.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX); let initializer;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer?.getText(ast); ts.forEachChild(node, visit); };
  visit(ast); assert.ok(initializer, name); return `const ${name} = ${initializer};`;
}
function checkout({ pending = [], syncing = false, online = true, ...flags } = {}) {
  const alerts = [], requests = [], saved = [], printed = []; const gate = deferred();
  const ctx = { selectedTable: null, takeawayOrder: null, takeawayRequestIdRef: { current: '' }, tableSelectionError: '', tableShop: null,
    shift: { id: 'shift', shop_id: 'shop' }, user: { id: 'cashier' }, shiftReadState: 'ready',
    cart: [{ product_id: 'cake', product_name: 'Cake', price: 1000, quantity: 1, subtotal: 1000 }], subtotal: 1000, total: 1000,
    payOpen: false, paying: false, discountPct: 0, stockChecking: false, offlineSyncing: syncing, tableLocked: false,
    discountCode: '', roundingTarget: null, adjustmentMode: null, discountOwnerPin: '', discountLoading: false,
    isOnline: online, navigator: { onLine: online }, offlineSales: pending, offlineSyncError: '', queueAuthorizationError: false,
    productsById: { cake: { track_stock: false } }, stockByProduct: {}, settings: { allow_negative_stock: false },
    checkoutCancelledRef: { current: false }, checkoutReadyRef: { current: false }, checkoutRequestKeyRef: { current: '' }, checkoutRecordedAtRef: { current: '' },
    saleSubmittingRef: { current: false }, tableCartDirty: false, tableOrder: null, takeawayDirty: false, checkoutOffline: false,
    shops: [{ id: 'shop' }], performance, console: { info: () => {}, error: () => {} },
    ...flags,
  };
  Object.assign(ctx, { queueEligible: network.canQueuePosSale({ ...ctx, takeawayRequestId: ctx.takeawayRequestIdRef.current }),
    odinaAlert: async message => { alerts.push(message); }, odinaConfirm: async () => true,
    createSaleIdempotencyKey: () => `pos-checkout-record-${saved.length}`, reportRequestSuccess: () => {}, reportRequestError: () => {},
    setStockChecking: value => { ctx.stockChecking = value; }, setCheckoutOffline: value => { ctx.checkoutOffline = value; },
    setPayOpen: value => { ctx.payOpen = value; }, setOpenShiftOpen: () => {}, setMobileCartOpen: () => {}, setPaying: value => { ctx.paying = value; },
    syncOfflineSales: () => { throw new Error('Foreground must not wait for queue drain'); }, syncErrorMessage: error => error.message,
    base44: { functions: { invoke: (_, body) => { requests.push(body); throw new Error('Unexpected request'); } } },
    buildPendingSale: offline.buildPendingSale, isRetryableSyncError: offline.isRetryableSyncError, friesOptionFields: () => ({}),
    enqueueOfflineSale: async row => { await gate.promise; saved.push(row); }, resetCart: () => { ctx.cart = []; },
    setReceiptPrintSale: sale => printed.push(sale), isStaffTicketEnabled: () => false,
    setTakeawayOrder: () => {}, setTableOrder: () => {}, setStaffTicket: () => {}, navigate: () => {}, setTablePickerOpen: () => {},
  });
  const source = readFileSync('src/pages/POS.jsx', 'utf8');
  const names = ['confirmStockWarnings','openPayment','openOfflinePayment','openCheckout','finishSalePresentation','presentCompletedSale','finishQueuedSale','completeSale'];
  vm.runInNewContext(names.map(name => declaration(source, name)).join('\n') + '\nglobalThis.api={openCheckout, completeSale};', ctx);
  return { ctx, alerts, requests, saved, printed, gate, ...ctx.api };
}

test('next ordinary checkout immediately joins the queue even while background synchronization runs', async () => {
  for (const syncing of [false, true]) {
    const f = checkout({ pending: [record(0)], syncing });
    await f.openCheckout();
    assert.equal(f.ctx.payOpen, true); assert.equal(f.ctx.checkoutOffline, true); assert.equal(f.requests.length, 0); assert.deepEqual(f.alerts, []);
    const payment = f.completeSale([{ method: 'cash', amount: 1000 }], true);
    assert.equal(f.ctx.cart.length, 1); assert.equal(f.printed.length, 0, 'nothing prints before durable storage acknowledgment');
    f.gate.resolve(); await payment;
    assert.equal(f.saved.length, 1); assert.equal(f.printed.length, 1); assert.equal(f.ctx.cart.length, 0);
  }
});

test('storage failure preserves the basket and request key instead of printing an unrecorded sale', async () => {
  const f = checkout({ online: false }); await f.openCheckout();
  const key = f.ctx.checkoutRequestKeyRef.current;
  const payment = f.completeSale([{ method: 'cash', amount: 1000 }], true);
  f.gate.reject(new Error('Quota exceeded')); await payment;
  assert.equal(f.ctx.cart.length, 1); assert.equal(f.ctx.checkoutRequestKeyRef.current, key);
  assert.equal(f.saved.length, 0); assert.equal(f.printed.length, 0); assert.match(f.alerts[0], /Quota/);
});

test('known session rejection and protected discounts cannot be bypassed by the queued-sale route', async () => {
  const rejected = checkout({ pending: [record(0)], queueAuthorizationError: true });
  await rejected.openCheckout(); assert.equal(rejected.ctx.payOpen, false); assert.match(rejected.alerts[0], /seansi/);
  for (const flags of [{ discountCode: 'coupon' }, { roundingTarget: 1000 }, { takeawayOrder: { id: 'order' } }]) {
    const f = checkout({ online: false, ...flags });
    await f.openCheckout(); assert.equal(f.ctx.checkoutReadyRef.current, false); assert.equal(f.saved.length, 0);
  }
});


test('an online response without a real sale ID queues the ordinary sale instead of claiming server confirmation', async () => {
  const f = checkout();
  f.ctx.checkoutReadyRef.current = true;
  f.ctx.base44.functions.invoke = async () => ({ data: { sale: {} } });
  const pending = f.completeSale([{ method: 'cash', amount: 1000 }], true);
  await tick();
  assert.equal(f.ctx.cart.length, 1); assert.equal(f.printed.length, 0);
  f.gate.resolve(); await pending;
  assert.equal(f.saved.length, 1); assert.equal(f.printed[0].offline_pending, true);
});


test('unknown local storage state cannot be mistaken for an empty queue when closing a shift', async () => {
  const alerts = [], calls = [];
  const source = readFileSync('src/pages/POS.jsx', 'utf8');
  const ctx = { offlineStorageError: 'Read failed', isOnline: true, navigator: { onLine: true },
    closingShiftRef: { current: false }, shiftToClose: { id: 'shift' }, offlineSales: [],
    odinaAlert: async message => alerts.push(message), base44: { functions: { invoke: async () => calls.push('write') } } };
  vm.runInNewContext(declaration(source, 'requestCloseShift') + '\n' + declaration(source, 'closeShift') + '\nglobalThis.api={requestCloseShift, closeShift};', ctx);
  await ctx.api.requestCloseShift(); await ctx.api.closeShift({ actual_cash: 0 });
  assert.equal(calls.length, 0); assert.equal(alerts.length, 2);
});
