// Actual POS callbacks, fake clocks/storage/SDK only. No live sales or printers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as offline from '../src/lib/offline-sales.js';

const source = readFileSync('src/pages/POS.jsx', 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function declaration(name) {
  const ast = ts.createSourceFile('POS.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  let value;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) value = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(value, `Actual POS callback ${name}`);
  return `const ${name} = ${value};`;
}
let fixtureId = 0;
function fixture(flags = {}) {
  const key = `pos-race-${++fixtureId}`;
  const network = deferred(), durable = deferred();
  const requests = [], receipts = [], alerts = [], queued = [], stockReads = [], navigations = [], timingReports = [];
  const timers = new Map(); let timerId = 0;
  const clock = {
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const ctx = {
    saleSubmittingRef: { current: false }, checkoutReadyRef: { current: true }, checkoutCancelledRef: { current: false },
    checkoutRequestKeyRef: { current: key }, checkoutRecordedAtRef: { current: '2026-10-16T08:00:00.000Z' },
    checkoutAttemptRef: { current: null }, checkoutSessionRef: { current: {} }, reconciledSaleKeysRef: { current: new Set() },
    stockReadGenerationRef: { current: 0 }, confirmedStockRef: { current: new Map() },
    confirmedStockReadsRef: { current: new Map() }, latestStockSaleRef: { current: new Map() },
    shiftMutationRef: { current: 0 }, shiftReadGenerationRef: { current: 0 }, setShiftReadState: () => {},
    stockUserRef: { current: `cashier-${fixtureId}` }, takeawayRequestIdRef: { current: '' },
    cart: [{ product_id: 'cake', product_name: 'Tort', quantity: 1, subtotal: 1000, price: 1000 }],
    posScopeReadOnly: false,
    stockChecking: false, discountLoading: false, selectedTable: null, tableCartDirty: false,
    tableOrder: null, takeawayOrder: null, takeawayDirty: false, checkoutOffline: false,
    isDelivery: false, isOnline: true, queueEligible: true,
    discountCode: '', roundingTarget: null, adjustmentMode: null, discountPct: 0, discountOwnerPin: '', subtotal: 1000,
    shift: { id: 'shift', shop_id: 'shop', order_count: 0, expected_cash: 0 },
    user: { id: `cashier-${fixtureId}`, shop_id: 'shop' }, shops: [{ id: 'shop', name: 'Do‘kon' }],
    productStock: [{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 10 }],
    confirmedStockReservations: [], performance, navigator: { onLine: true },
    console: { info: () => {}, error: () => {}, warn: () => {} },
    recordCheckoutTiming: value => { ctx.lastCheckoutTiming = value; },
    timingUserRef: { current: `cashier-${fixtureId}` },
    createCheckoutTimingEventId: () => `diagnostic-${fixtureId}`,
    reportCheckoutTiming: event => { timingReports.push(event); return Promise.resolve({}); },
    useStableEvent: callback => callback,
    ...offline,
    waitForSaleResponse: (flight, options = {}) => offline.waitForSaleResponse(flight, { timers: clock, ...options }),
    createSaleIdempotencyKey: () => { throw new Error('Must preserve the checkout key'); },
    friesOptionFields: () => ({}), reportRequestSuccess: () => {}, reportRequestError: () => {},
    odinaAlert: message => alerts.push(message),
    isStaffTicketEnabled: () => false, posHomePath: '/pos',
    ...flags,
  };
  const state = name => value => { ctx[name] = typeof value === 'function' ? value(ctx[name]) : value; };
  Object.assign(ctx, {
    setMobileCartOpen: () => {}, setPayOpen: state('payOpen'), setPaying: state('paying'),
    setCheckoutOffline: state('checkoutOffline'), setCheckoutRetryPending: state('checkoutRetryPending'),
    setShift: state('shift'), setProductStock: state('productStock'),
    setConfirmedStockReservations: state('confirmedStockReservations'),
    resetCart: () => { ctx.cart = []; }, setTableOrder: state('tableOrder'), setTakeawayOrder: state('takeawayOrder'),
    loadWasteAlerts: () => Promise.resolve(), setReceiptPrintSale: sale => { if (sale) receipts.push(sale); },
    setStaffTicket: () => {}, navigate: (...args) => navigations.push(args), setTablePickerOpen: () => {},
    enqueueOfflineSale: async row => { await durable.promise; queued.push(row); },
    base44: {
      functions: { invoke: (_name, body) => { requests.push(body); return network.promise; } },
      entities: { ProductStock: { filter: (...args) => { const gate = deferred(); stockReads.push({ args, ...gate }); return gate.promise; } } },
    },
  });
  const names = ['confirmQueuedSale', 'loadCurrentShift', 'closePayment', 'finishSalePresentation', 'presentCompletedSale', 'finishQueuedSale',
    'mergeUnreservedStock', 'refreshConfirmedStock', 'reconcileCompletedSale', 'applyCompletedSale', 'completeSale'];
  vm.runInNewContext(names.map(declaration).join('\n')
    + '\nglobalThis.api={confirmQueuedSale,loadCurrentShift,completeSale,closePayment,reconcileCompletedSale,mergeUnreservedStock};', ctx);
  const payload = (quantity = 9, orderCount = 1, extra = {}) => ({
    sale: { id: `sale-${key}`, shop_id: 'shop', items: [{ product_id: 'cake', quantity: 1 }] },
    shift: { id: 'shift', shop_id: 'shop', order_count: orderCount, expected_cash: orderCount * 1000 },
    stock_updates: [{ product_id: 'cake', quantity }], ...extra,
  });
  return { ctx, key, network, durable, requests, receipts, alerts, queued, stockReads, navigations, timingReports, payload,
    ...ctx.api,
    async deadline(delay = offline.POS_CHECKOUT_RESPONSE_BUDGET_MS) {
      const due = [...timers].filter(([, timer]) => timer.delay === delay);
      assert.ok(due.length, `Expected a ${delay}ms non-aborting timer`);
      for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
      await tick();
    },
    quantity: () => ctx.productStock.find(row => row.product_id === 'cake')?.quantity,
    displayedQuantity: () => Number(ctx.productStock.find(row => row.product_id === 'cake')?.quantity || 0)
      - ctx.confirmedStockReservations.reduce((sum, row) => sum + (row.request.items || [])
        .filter(item => item.product_id === 'cake').reduce((n, item) => n + item.quantity, 0), 0),
  };
}
const payments = [{ method: 'cash', amount: 1000 }];

test('1s handoff later shows the real 6.2s server confirmation without clearing or printing the next cart', async t => {
  const f = fixture();
  const pending = f.completeSale(payments, true);
  await f.deadline();
  assert.equal(f.ctx.cart.length, 1); assert.equal(f.receipts.length, 0);
  assert.equal(f.ctx.paying, true, 'must wait for actual IndexedDB commit before acknowledging');
  f.durable.resolve(); await pending;
  assert.equal(f.queued.length, 1); assert.equal(f.receipts.length, 1);
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'queued');
  assert.equal(f.receipts[0].offline_pending, true); assert.equal(f.ctx.cart.length, 0);
  assert.equal(f.queued[0].id, f.requests[0].idempotency_key);
  assert.deepEqual(JSON.parse(JSON.stringify(f.queued[0].request)), JSON.parse(JSON.stringify(f.requests[0])));
  f.ctx.cart = [{ product_id: 'tea', quantity: 2 }];
  const actualStartedAt = Date.parse(f.queued[0].checkout_started_at);
  assert.ok(Number.isFinite(actualStartedAt), 'submission origin survives the durable queue');
  let wallNow = actualStartedAt + 6200;
  t.mock.method(Date, 'now', () => wallNow);
  f.network.resolve({ data: f.payload() }); await tick();
  wallNow += 3000; // A delayed drain must retain the earlier acknowledgment time.
  const rows = new Map(f.queued.map(row => [row.id, row])); let extraWrites = 0;
  const result = await offline.syncPendingSales({ userId: f.ctx.user.id,
    storage: { list: async () => [...rows.values()], update: async (id, patch) => Object.assign(rows.get(id), patch), remove: async id => rows.delete(id) },
    lock: work => work(), send: async () => { extraWrites++; return { data: f.payload() }; },
    onConfirmed: ({ payload, id, record, confirmationTiming }) => f.confirmQueuedSale(payload, id, record, confirmationTiming),
  });
  assert.equal(result.synced, 1); assert.equal(extraWrites, 0, 'drain consumes the original successful flight');
  assert.equal(f.stockReads.length, 1); assert.equal(f.displayedQuantity(), 9);
  f.stockReads[0].resolve([{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 9 }]); await tick();
  assert.equal(f.quantity(), 9); assert.equal(f.ctx.confirmedStockReservations.length, 0);
  assert.equal(f.ctx.cart[0].product_id, 'tea'); assert.equal(f.receipts.length, 1);
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'confirmed');
  assert.equal(f.ctx.lastCheckoutTiming.totalMs, 6200, 'server acknowledgment replaces the 1s local handoff metric');
  assert.equal(f.ctx.lastCheckoutTiming.requestKey, f.key);
  const confirmedReports = f.timingReports.filter(row => row.sale_id);
  assert.equal(confirmedReports.length, 1); assert.equal(confirmedReports[0].total_ms, 6200);
});

test('storage handoff failure exits promptly and same-key retry reuses eventual success with original methods', async () => {
  const f = fixture();
  const pending = f.completeSale(payments, true);
  f.durable.reject(new Error('Mock IndexedDB quota')); await f.deadline(); await pending;
  assert.equal(f.ctx.paying, false); assert.equal(f.ctx.payOpen, true);
  assert.equal(f.ctx.checkoutRetryPending, true); assert.equal(f.ctx.cart.length, 1);
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'unconfirmed');
  assert.equal(f.ctx.checkoutRequestKeyRef.current, f.key); assert.equal(f.receipts.length, 0);
  f.closePayment(); assert.equal(f.ctx.payOpen, true); assert.equal(f.ctx.checkoutRequestKeyRef.current, f.key);
  f.network.resolve({ data: f.payload() }); await tick();
  assert.equal(f.ctx.cart.length, 1); assert.equal(f.receipts.length, 0, 'observation does not commit UI without explicit recovery');
  await f.completeSale([{ method: 'card', amount: 1000 }], true);
  assert.equal(f.requests.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].payments)), [{ method: 'cash', amount: 1000, reference: '' }]);
  assert.equal(f.receipts.length, 1); assert.equal(f.quantity(), 9); assert.equal(f.ctx.cart.length, 0);
  assert.equal(f.ctx.checkoutRetryPending, false);
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'confirmed');
});

test('storage failure racing an already-confirmed original response records rechecked timing and presents once', async () => {
  const f = fixture();
  const pending = f.completeSale(payments, true);
  await f.deadline();
  f.network.resolve({ data: f.payload(9, 1, { already_processed: true }) }); await tick();
  f.durable.reject(new Error('Mock IndexedDB quota')); await pending;
  assert.equal(f.requests.length, 1); assert.equal(f.queued.length, 0);
  assert.equal(f.receipts.length, 1); assert.equal(f.ctx.cart.length, 0);
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'rechecked');
  assert.equal(f.ctx.checkoutRetryPending, false); assert.equal(f.ctx.paying, false);
});

test('protected table deadline retains cart/order/key and later acknowledgment cannot silently free an unreleased table', async () => {
  const table = { id: 'table-order', revision: 7, state: 'occupied' };
  const f = fixture({ selectedTable: { shopId: 'shop', number: 4 }, tableOrder: table, queueEligible: false });
  const pending = f.completeSale(payments, false);
  await f.deadline(offline.POS_PROTECTED_CHECKOUT_RESPONSE_BUDGET_MS); await pending;
  assert.equal(f.ctx.paying, false); assert.equal(f.ctx.checkoutRetryPending, true);
  assert.equal(f.ctx.lastCheckoutTiming.outcome, 'unconfirmed');
  assert.equal(f.ctx.cart.length, 1); assert.equal(f.ctx.tableOrder, table);
  assert.equal(f.queued.length, 0); assert.equal(f.receipts.length, 0); assert.equal(f.navigations.length, 0);
  f.closePayment(); assert.equal(f.ctx.checkoutRequestKeyRef.current, f.key);
  f.network.resolve({ data: f.payload(9, 1, { table_released: false }) }); await tick();
  await f.completeSale(payments, false);
  assert.equal(f.requests.length, 1); assert.equal(f.ctx.cart.length, 0);
  assert.equal(f.ctx.tableOrder, table); assert.equal(f.navigations.length, 0);
  assert.match(f.alerts.at(-1), /Qayta pul olmang/);
});

test('takeaway, rounding, discount and PIN deadlines require real online acknowledgment without durable queued receipts', async () => {
  for (const protectedFlags of [
    { takeawayOrder: { id: 'takeaway', revision: 3, state: 'occupied' }, queueEligible: false },
    { adjustmentMode: 'rounding', roundingTarget: 1000, queueEligible: false },
    { discountCode: 'coupon', discountPct: 10, queueEligible: false },
    { discountPct: 100, discountOwnerPin: '1234' },
  ]) {
    const f = fixture(protectedFlags); const pending = f.completeSale(payments, true);
    await f.deadline(offline.POS_PROTECTED_CHECKOUT_RESPONSE_BUDGET_MS); await pending;
    assert.equal(f.queued.length, 0); assert.equal(f.receipts.length, 0); assert.equal(f.ctx.cart.length, 1);
    assert.equal(f.ctx.checkoutRetryPending, true); assert.equal(f.ctx.checkoutRequestKeyRef.current, f.key);
    f.network.resolve({ data: f.payload() }); await tick();
    offline.releaseSaleRequest(f.key, f.ctx.checkoutAttemptRef.current.flight);
  }
});

test('authorization rejection never becomes an offline acknowledged sale', async () => {
  const f = fixture(); const pending = f.completeSale(payments, true);
  f.network.reject(Object.assign(new Error('Mock session denied'), { status: 403 })); await pending;
  assert.equal(f.ctx.cart.length, 1); assert.equal(f.receipts.length, 0); assert.equal(f.queued.length, 0);
  assert.equal(f.ctx.checkoutRetryPending, false); assert.equal(f.ctx.paying, false);
});

test('already-processed empty snapshot retains reservation until scoped stock read; general reads cannot double subtract', async () => {
  const f = fixture(); const request = { shift_id: 'shift', recorded_at: '2026-10-16T07:00:00.000Z', items: [{ product_id: 'cake', quantity: 1 }] };
  const record = { id: 'old-confirmed', shop_id: 'shop', shift_id: 'shift', request };
  const reconciling = f.reconcileCompletedSale(f.payload(9, 1, { already_processed: true, stock_updates: [] }), record.id, record);
  assert.equal(f.displayedQuantity(), 9); assert.equal(f.quantity(), 10);
  const merged = f.mergeUnreservedStock(f.ctx.productStock, [{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 9 }]);
  assert.equal(merged[0].quantity, 10, 'preserve base while the same sale reservation is held');
  assert.deepEqual(JSON.parse(JSON.stringify(f.stockReads[0].args[0])), { location_id: 'shop', product_id: { $in: ['cake'] } });
  f.stockReads[0].resolve([{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 9 }]); await reconciling;
  assert.equal(f.displayedQuantity(), 9); assert.equal(f.ctx.confirmedStockReservations.length, 0);
  await f.reconcileCompletedSale(f.payload(), record.id, record);
  assert.equal(f.stockReads.length, 1, 'same acknowledgment cannot reconcile twice');
});

test('older queued stock9/shift1 cannot overwrite newer stock8/shift2 and an in-flight read is fenced', async () => {
  const f = fixture();
  f.ctx.checkoutAttemptRef.current = { request: { shift_id: 'shift', recorded_at: '2026-10-16T08:02:00.000Z', items: [{ product_id: 'cake', quantity: 1 }] } };
  await f.reconcileCompletedSale(f.payload(8, 2), 'new-sale');
  assert.equal(f.quantity(), 8); assert.equal(f.ctx.shift.order_count, 2);
  const oldRecord = { id: 'old-sale', shift_id: 'shift', shop_id: 'shop', request: {
    shift_id: 'shift', recorded_at: '2026-10-16T08:01:00.000Z', items: [{ product_id: 'cake', quantity: 1 }],
  } };
  const old = f.reconcileCompletedSale(f.payload(9, 1), oldRecord.id, oldRecord);
  assert.equal(f.quantity(), 8, 'old absolute acknowledgment must never restore9');
  assert.equal(f.ctx.shift.order_count, 2); assert.equal(f.ctx.shift.expected_cash, 2000);
  // A further sale confirms while the first authoritative read is in flight.
  f.ctx.checkoutAttemptRef.current.request.recorded_at = '2026-10-16T08:03:00.000Z';
  const newer = f.reconcileCompletedSale(f.payload(7, 3), 'newest-sale');
  f.stockReads[0].resolve([{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 8 }]); await tick();
  assert.equal(f.stockReads.length, 2); assert.equal(f.quantity(), 8, 'superseded read cannot publish');
  f.stockReads[1].resolve([{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 7 }]);
  await Promise.all([old, newer]);
  assert.equal(f.quantity(), 7); assert.equal(f.ctx.shift.order_count, 3); assert.equal(f.ctx.shift.expected_cash, 3000);
  assert.equal(f.ctx.confirmedStockReservations.length, 0);
});

test('failed or timed-out scoped reconciliation retains reservation without another financial write', async () => {
  const f = fixture(); const record = { id: 'read-retry', shop_id: 'shop', shift_id: 'shift',
    request: { shift_id: 'shift', items: [{ product_id: 'cake', quantity: 1 }] } };
  const first = f.reconcileCompletedSale(f.payload(9, 1, { stock_updates: [] }), record.id, record);
  const rejection = assert.rejects(first, /kutilmoqda/);
  await f.deadline(10000); await rejection;
  assert.equal(f.displayedQuantity(), 9); assert.equal(f.ctx.confirmedStockReservations.length, 1);
  const retry = f.reconcileCompletedSale(f.payload(9, 1, { stock_updates: [] }), record.id, record);
  f.stockReads[1].resolve([{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 9 }]); await retry;
  assert.equal(f.displayedQuantity(), 9); assert.equal(f.requests.length, 0);
});

test('queued authoritative reconciliation advances the stock frontier before an older direct response arrives', async () => {
  const f = fixture();
  f.ctx.checkoutAttemptRef.current = { request: { shift_id: 'shift', recorded_at: '2026-10-16T08:01:00.000Z', items: [{ product_id: 'cake', quantity: 1 }] } };
  await f.reconcileCompletedSale(f.payload(9, 1), 'direct-one');
  const row = { id: 'queued-three', shop_id: 'shop', shift_id: 'shift', request: {
    shift_id: 'shift', recorded_at: '2026-10-16T08:03:00.000Z', items: [{ product_id: 'cake', quantity: 1 }],
  } };
  const queued = f.reconcileCompletedSale(f.payload(7, 3), row.id, row);
  f.stockReads[0].resolve([{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 7 }]); await queued;
  f.ctx.checkoutAttemptRef.current.request.recorded_at = '2026-10-16T08:02:00.000Z';
  const older = f.reconcileCompletedSale(f.payload(8, 2), 'direct-two');
  assert.equal(f.quantity(), 7, 'older direct stock8 must not replace authoritative stock7');
  assert.equal(f.ctx.shift.order_count, 3); assert.equal(f.ctx.shift.expected_cash, 3000);
  assert.equal(f.stockReads.length, 2, 'older acknowledgment must read current stock');
  f.stockReads[1].resolve([{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 7 }]); await older;
  assert.equal(f.quantity(), 7);
});

test('a stale current-shift read cannot undo a newer sale or same-count cash withdrawal', async () => {
  const f = fixture(), oldRead = deferred();
  f.ctx.fetchCurrentPosShift = () => oldRead.promise;
  const reading = f.loadCurrentShift();
  const superseded = assert.rejects(reading, /yangilandi/);
  f.ctx.checkoutAttemptRef.current = { request: { shift_id: 'shift', recorded_at: '2026-10-16T08:01:00.000Z' } };
  await f.reconcileCompletedSale(f.payload(8, 2), 'confirmed-new');
  oldRead.resolve({ id: 'shift', shop_id: 'shop', order_count: 0, expected_cash: 0 }); await superseded;
  assert.equal(f.ctx.shift.order_count, 2); assert.equal(f.ctx.shift.expected_cash, 2000);
  // A withdrawal is a confirmed mutation without changing the sales count.
  f.ctx.shiftMutationRef.current++;
  f.ctx.shift = { ...f.ctx.shift, expected_cash: 1500 };
  const row = { id: 'already-counted', shop_id: 'shop', shift_id: 'shift', request: {
    shift_id: 'shift', recorded_at: '2026-10-16T08:00:00.000Z', items: [{ product_id: 'cake', quantity: 1 }],
  } };
  const reconciled = f.reconcileCompletedSale(f.payload(8, 2), row.id, row);
  assert.equal(f.ctx.shift.expected_cash, 1500, 'same-count old ack must not reverse a withdrawal');
  f.stockReads[0].resolve([{ id: 'stock', product_id: 'cake', location_id: 'shop', quantity: 8 }]); await reconciled;
});

test('failed background reconciliation after a confirmed direct sale cannot reopen payment or reject presentation', async () => {
  const f = fixture(); const pending = f.completeSale(payments, true);
  f.network.resolve({ data: f.payload(9, 1, { already_processed: true, stock_updates: [] }) }); await pending;
  assert.equal(f.receipts.length, 1); assert.equal(f.ctx.cart.length, 0); assert.equal(f.ctx.paying, false);
  f.stockReads[0].reject(new Error('Mock read denied')); await tick();
  assert.equal(f.ctx.cart.length, 0); assert.equal(f.ctx.payOpen, false); assert.equal(f.alerts.length, 0);
  assert.equal(f.ctx.confirmedStockReservations.length, 1); assert.equal(f.requests.length, 1);
});

test('old user success or authorization failure cannot change the next user’s cart, lock, shift, or network status', async () => {
  for (const rejected of [false, true]) {
    const f = fixture(); let successes = 0, failures = 0;
    f.ctx.reportRequestSuccess = () => { successes++; };
    f.ctx.reportRequestError = () => { failures++; };
    const pending = f.completeSale(payments, true);
    f.ctx.checkoutSessionRef.current = { userId: 'different-user' };
    f.ctx.stockUserRef.current = 'different-user'; f.ctx.user = { id: 'different-user' };
    f.ctx.cart = [{ product_id: 'different-user-cart', quantity: 4 }];
    f.ctx.shift = { id: 'different-user-shift', order_count: 20 };
    f.ctx.paying = false; f.ctx.saleSubmittingRef.current = true;
    if (rejected) f.network.reject(Object.assign(new Error('Old session denied'), { status: 403 }));
    else f.network.resolve({ data: f.payload() });
    await pending;
    assert.equal(f.ctx.cart[0].product_id, 'different-user-cart'); assert.equal(f.ctx.shift.id, 'different-user-shift');
    assert.equal(f.ctx.paying, false); assert.equal(f.ctx.saleSubmittingRef.current, true, 'old finally cannot unlock a new attempt');
    assert.equal(f.receipts.length, 0); assert.equal(successes, 0); assert.equal(failures, 0);
  }
});
