import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { orderRequestScope, retainOrderRequest, readOrderRequest, clearOrderRequest, orderRequestDefinitelyRejected } from '../src/lib/order-request-retry.js';

const handler = 'base44/functions/customer-orders/entry.ts';
function fixture() {
  return memoryBackend({
    User: [{ id: 'staff', email: 'staff@example.test', role: 'cashier', shop_id: 'shop', active: true }],
    Settings: [{ id: 'settings', shop_name: 'Odina', customer_order_last_number: 0, allow_negative_stock: false }],
    Shop: [{ id: 'shop', name: 'Odina', active: true, location_type: 'shop' }],
    Product: [{ id: 'cake', name: 'Tort', active: true, price: 10000, production_unit: 'piece', track_stock: true }],
    ProductStock: [{ id: 'stock', location_id: 'shop', product_id: 'cake', quantity: 20, unit: 'piece' }],
    Shift: [{ id: 'shift', user_id: 'staff', shop_id: 'shop', status: 'open', total_sales: 0, order_count: 0, cash_sales: 0, expected_cash: 0 }],
    CustomerOrder: [], CustomerOrderItem: [], OrderPayment: [], StockMovement: [], ProductionBatch: [], Customer: [], ActionHistory: [],
  }, { now: '2026-10-15T07:00:00.000Z' });
}
const createRequest = (overrides = {}) => ({ action: 'create_order', idempotency_key: 'new-order', shop_id: 'shop',
  order_type: 'tugilgan_kun_va_boshqa', customer_name: 'Vali', customer_phone: '+998901234567',
  required_date: '2026-10-20', required_time: '18:00', fulfilment_type: 'pickup', items: [{ product_id: 'cake', quantity: 2 }], ...overrides });
const paymentRequest = (orderId, overrides = {}) => ({ action: 'record_payment', idempotency_key: 'new-payment', order_id: orderId,
  method: 'cash', amount: 10000, payment_kind: 'balance', ...overrides });
async function create(f, overrides) {
  const result = await f.invoke(handler, createRequest(overrides));
  assert.equal(result.status, 200, JSON.stringify(result));
  return result.data.order;
}
function loseReply(entity, operation, predicate = () => true) {
  const original = entity[operation]; let lost = false;
  entity[operation] = async (...args) => {
    const saved = await original(...args);
    if (!lost && predicate(...args)) { lost = true; throw new Error('committed reply lost'); }
    return saved;
  };
  return () => { entity[operation] = original; };
}

test('normal create/advance/balance preserves prices and maps Bank card and Online once', async () => {
  const f = fixture();
  const order = await create(f, { advance_payment: { method: 'bank_card', amount: 5000 } });
  f.db.Product[0].price = 999999;
  assert.equal(order.paid_amount, 5000);
  assert.equal(f.db.CustomerOrderItem[0].unit_price_snapshot, 10000);
  assert.equal(f.db.Shift[0].uzcard_sales, 5000);
  const res = await f.invoke(handler, paymentRequest(order.id, { method: 'online', amount: 15000 }));
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(f.db.Shift[0].online_sales, 15000);
  assert.equal(f.db.Shift[0].total_sales, 20000);
  assert.equal(f.db.CustomerOrder[0].payment_status, 'paid');
  assert.equal(f.calls.some((call) => call[1] === 'delete'), false);
});

test('lost order-create and complete item-save replies preserve one order and its immutable items', async () => {
  for (const [entity, operation] of [['CustomerOrder', 'create'], ['CustomerOrderItem', 'bulkCreate']]) {
    const f = fixture(); loseReply(f.entities[entity], operation);
    await create(f);
    const retry = await f.invoke(handler, createRequest());
    assert.equal(retry.status, 200, JSON.stringify(retry));
    assert.equal(f.db.CustomerOrder.length, 1);
    assert.equal(f.db.CustomerOrderItem.length, 1);
    assert.equal(f.calls.some((call) => call[1] === 'delete'), false);
  }
});

test('a creation advance never moves to a new shift if the initially accepted shift closes during item save', async () => {
  const f = fixture(); const createItems = f.entities.CustomerOrderItem.bulkCreate;
  f.entities.CustomerOrderItem.bulkCreate = async (items) => {
    const saved = await createItems(items);
    f.db.Shift[0].status = 'closed';
    f.db.Shift.push({ ...structuredClone(f.db.Shift[0]), id: 'later-shift', status: 'open' });
    return saved;
  };
  const body = createRequest({ advance_payment: { method: 'cash', amount: 10000 } });
  const result = await f.invoke(handler, body);
  assert.equal(result.status, 503, JSON.stringify(result)); assert.equal(result.data.operation_pending, true);
  assert.equal(f.db.CustomerOrder[0].creation_advance_shift_id, 'shift');
  assert.equal(f.db.OrderPayment.length, 0); assert.equal(f.db.CustomerOrder[0].paid_amount, 0);
  assert.equal(f.db.Shift.find((shift) => shift.id === 'later-shift').expected_cash, 0);
  assert.equal((await f.invoke(handler, body)).status, 503);
});

test('concurrent creation claims the same request once and later confirms its saved result', async () => {
  const f = fixture();
  const results = await Promise.all([f.invoke(handler, createRequest()), f.invoke(handler, createRequest())]);
  assert.ok(results.some((res) => res.status === 200), JSON.stringify(results));
  assert.equal(f.db.CustomerOrder.length, 1);
  assert.equal(f.db.CustomerOrderItem.length, 1);
  assert.equal((await f.invoke(handler, createRequest())).status, 200);
  assert.equal(f.db.Settings[0].customer_order_last_number, 1);
});

test('creation retry rejects changed payloads, another actor and another shop before exposing records', async () => {
  const f = fixture(); await create(f);
  assert.equal((await f.invoke(handler, createRequest({ customer_name: 'Changed' }))).status, 409);
  f.db.User[0].id = 'other-staff';
  assert.equal((await f.invoke(handler, createRequest())).status, 403);
  f.db.User[0].id = 'staff'; f.db.User[0].shop_id = 'other-shop';
  assert.equal((await f.invoke(handler, createRequest())).status, 403);
  assert.equal(f.db.CustomerOrder.length, 1);
});

test('partial item save retains snapshots and never reports a complete order or duplicates its missing items', async () => {
  const f = fixture();
  f.entities.CustomerOrderItem.bulkCreate = async (items) => { await f.entities.CustomerOrderItem.create(items[0]); throw new Error('second save unknown'); };
  const req = createRequest({ items: [{ product_id: 'cake', quantity: 1 }, { product_id: 'cake', quantity: 2 }] });
  const result = await f.invoke(handler, req);
  assert.equal(result.status, 503); assert.equal(result.data.operation_pending, true);
  const retry = await f.invoke(handler, req);
  assert.equal(retry.status, 503);
  assert.equal(f.db.CustomerOrder.length, 1); assert.equal(f.db.CustomerOrderItem.length, 1);
  const incompleteId = f.db.CustomerOrder[0].id;
  assert.equal((await f.invoke(handler, paymentRequest(incompleteId))).status, 503);
  f.db.User[0].role = 'admin';
  assert.equal((await f.invoke(handler, { action: 'update_production_status', order_id: incompleteId, step: 'ready' })).status, 409);
  f.db.CustomerOrder[0].order_status = 'tayyor';
  assert.equal((await f.invoke(handler, { action: 'complete_order', order_id: incompleteId, idempotency_key: 'incomplete-handoff', amount: 30000, method: 'cash' })).status, 409);
});

test('committed payment, order-total and shift replies can each be lost without losing or double-posting money', async () => {
  for (const entity of ['OrderPayment', 'CustomerOrder', 'Shift']) {
    const f = fixture(); const order = await create(f);
    loseReply(f.entities[entity], entity === 'OrderPayment' ? 'create' : 'updateMany',
      entity === 'CustomerOrder' ? (_q, ops) => ops.$push?.payment_applied_keys : () => true);
    const result = await f.invoke(handler, paymentRequest(order.id));
    assert.equal(result.status, 200, JSON.stringify(result));
    const retry = await f.invoke(handler, paymentRequest(order.id));
    assert.equal(retry.status, 200, JSON.stringify(retry));
    assert.equal(f.db.OrderPayment.length, 1);
    assert.equal(f.db.CustomerOrder[0].paid_amount, 10000);
    assert.equal(f.db.Shift[0].cash_sales, 10000);
    assert.equal(f.db.Shift[0].expected_cash, 10000);
    assert.equal(f.db.Shift[0].order_count, 1);
    assert.equal(f.calls.some((call) => call[1] === 'delete'), false);
  }
});

test('payment retry repairs a saved ledger/order whose shift write did not save', async () => {
  const f = fixture(); const order = await create(f);
  const original = f.entities.Shift.updateMany;
  f.entities.Shift.updateMany = async (query, update) => {
    if (update.$inc) throw new Error('shift temporarily unavailable');
    return original(query, update);
  };
  const failed = await f.invoke(handler, paymentRequest(order.id));
  assert.equal(failed.status, 503); assert.equal(failed.data.operation_pending, true);
  assert.equal(f.db.OrderPayment.length, 1); assert.equal(f.db.CustomerOrder[0].paid_amount, 10000);
  f.entities.Shift.updateMany = original;
  const retry = await f.invoke(handler, paymentRequest(order.id));
  assert.equal(retry.status, 200, JSON.stringify(retry));
  assert.equal(f.db.OrderPayment.length, 1); assert.equal(f.db.CustomerOrder[0].paid_amount, 10000);
  assert.equal(f.db.Shift[0].expected_cash, 10000);
});

test('unknown ledger-create outcome is held for review rather than calling create again', async () => {
  const f = fixture(); const order = await create(f); let attempts = 0;
  f.entities.OrderPayment.create = async () => { attempts++; throw new Error('unknown create'); };
  const first = await f.invoke(handler, paymentRequest(order.id));
  const second = await f.invoke(handler, paymentRequest(order.id));
  assert.equal(first.status, 503); assert.equal(second.status, 503);
  assert.equal(attempts, 1); assert.equal(f.db.CustomerOrder[0].paid_amount, 0); assert.equal(f.db.Shift[0].expected_cash, 0);
});

test('lost reconciliation metadata or lock-release replies are repaired without reposting payments', async () => {
  for (const stage of ['payment_metadata', 'order_unlock']) {
    const f = fixture(); const order = await create(f);
    loseReply(stage === 'payment_metadata' ? f.entities.OrderPayment : f.entities.CustomerOrder, 'updateMany',
      (_q, op) => stage === 'payment_metadata' ? op.$set?.reconciliation_state === 'completed' : op.$set?.payment_operation_key === '');
    const failed = await f.invoke(handler, paymentRequest(order.id));
    assert.equal(failed.status, 500);
    const retry = await f.invoke(handler, paymentRequest(order.id));
    assert.equal(retry.status, 200, JSON.stringify(retry));
    assert.equal(f.db.OrderPayment.length, 1); assert.equal(f.db.CustomerOrder[0].paid_amount, 10000);
    assert.equal(f.db.Shift[0].expected_cash, 10000); assert.equal(f.db.CustomerOrder[0].payment_operation_key, '');
  }
});

test('definitely rejected validation releases editable forms while ambiguous results retain the same request', async () => {
  const f = fixture(); f.db.Shift[0].status = 'closed';
  const rejectedOrder = await f.invoke(handler, createRequest({ advance_payment: { method: 'cash', amount: 10000 } }));
  assert.equal(rejectedOrder.status, 409); assert.equal(rejectedOrder.data.request_not_started, true);
  assert.equal(orderRequestDefinitelyRejected({ data: rejectedOrder.data }), true);
  const order = await create(f);
  const rejectedPayment = await f.invoke(handler, paymentRequest(order.id));
  assert.equal(rejectedPayment.status, 409); assert.equal(rejectedPayment.data.request_not_started, true);
  assert.equal(orderRequestDefinitelyRejected({ data: rejectedPayment.data }), true);
  f.db.Shift[0].status = 'open';
  f.entities.OrderPayment.create = async () => { throw new Error('unknown'); };
  const ambiguous = await f.invoke(handler, paymentRequest(order.id));
  assert.equal(ambiguous.status, 503);
  assert.equal(orderRequestDefinitelyRejected({ data: ambiguous.data, status: ambiguous.status }), false);
  assert.equal(orderRequestDefinitelyRejected({ response: { status: 400, data: { error: 'late metadata rejected' } } }), false);
});

test('HTTP 400 after financial writes remains pending and never releases the request key', async () => {
  for (const entity of ['CustomerOrder', 'OrderPayment']) {
    const f = fixture(); const original = f.entities[entity].updateMany;
    f.entities[entity].updateMany = async (query, update) => {
      const saved = await original(query, update);
      if (update.$set?.creation_state === 'completed' || update.$set?.reconciliation_state === 'completed') {
        throw Object.assign(new Error('late metadata reply rejected'), { status: 400 });
      }
      return saved;
    };
    const req = createRequest({ advance_payment: { method: 'cash', amount: 10000 } });
    const result = await f.invoke(handler, req);
    assert.equal(result.status, 400, JSON.stringify(result)); assert.equal(result.data.operation_pending, true);
    assert.equal(orderRequestDefinitelyRejected({ status: result.status, data: result.data }), false);
    f.entities[entity].updateMany = original;
    assert.equal((await f.invoke(handler, req)).status, 200);
    assert.equal(f.db.CustomerOrder.length, 1); assert.equal(f.db.OrderPayment.length, 1);
    assert.equal(f.db.CustomerOrder[0].paid_amount, 10000); assert.equal(f.db.Shift[0].expected_cash, 10000);
  }
});

test('concurrent duplicate payments share one ledger and one set of atomic totals', async () => {
  const f = fixture(); const order = await create(f);
  const results = await Promise.all([f.invoke(handler, paymentRequest(order.id)), f.invoke(handler, paymentRequest(order.id))]);
  assert.ok(results.some((res) => res.status === 200), JSON.stringify(results));
  assert.equal((await f.invoke(handler, paymentRequest(order.id))).status, 200);
  assert.equal(f.db.OrderPayment.length, 1); assert.equal(f.db.CustomerOrder[0].paid_amount, 10000);
  assert.equal(f.db.Shift[0].expected_cash, 10000); assert.equal(f.db.Shift[0].order_count, 1);
});

test('payment key conflicts cannot return another order, actor or shop payment', async () => {
  const f = fixture(); const order = await create(f);
  assert.equal((await f.invoke(handler, paymentRequest(order.id))).status, 200);
  assert.equal((await f.invoke(handler, paymentRequest(order.id, { amount: 5000 }))).status, 409);
  const other = await create(f, { idempotency_key: 'other-order' });
  assert.equal((await f.invoke(handler, paymentRequest(other.id))).status, 409);
  f.db.User[0].id = 'other-staff';
  assert.equal((await f.invoke(handler, paymentRequest(order.id))).status, 409);
  f.db.User[0].shop_id = 'other-shop';
  assert.equal((await f.invoke(handler, paymentRequest(order.id))).status, 403);
});

test('two different orders cannot concurrently reuse one payment request key', async () => {
  const f = fixture(); const first = await create(f); const second = await create(f, { idempotency_key: 'second-order' });
  const results = await Promise.all([f.invoke(handler, paymentRequest(first.id)), f.invoke(handler, paymentRequest(second.id))]);
  assert.equal(results.filter((res) => res.status === 200).length, 1, JSON.stringify(results));
  assert.equal(f.db.OrderPayment.length, 1); assert.equal(f.db.Shift[0].expected_cash, 10000);
  assert.equal(f.db.CustomerOrder.reduce((sum, order) => sum + order.paid_amount, 0), 10000);
});

test('valid legacy payment snapshots are returned without changing historical amounts', async () => {
  const f = fixture(); const order = await create(f);
  f.db.CustomerOrder[0].paid_amount = 10000; f.db.CustomerOrder[0].remaining_balance = 10000;
  f.db.OrderPayment.push({ id: 'legacy', order_id: order.id, shop_id: 'shop', employee_id: 'staff', payment_method: 'cash',
    payment_kind: 'balance', amount: 10000, idempotency_key: 'new-payment', status: 'completed' });
  f.db.Shift[0].expected_cash = 10000;
  const result = await f.invoke(handler, paymentRequest(order.id));
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.already_exists, true);
  assert.equal(f.db.CustomerOrder[0].paid_amount, 10000); assert.equal(f.db.Shift[0].expected_cash, 10000); assert.equal(f.db.OrderPayment.length, 1);
});

test('a disabled or production actor cannot create or record financial orders', async () => {
  const f = fixture(); const order = await create(f);
  f.db.User[0].active = false;
  assert.equal((await f.invoke(handler, paymentRequest(order.id))).status, 403);
  f.db.User[0].active = true; f.db.User[0].role = 'production';
  assert.equal((await f.invoke(handler, createRequest({ idempotency_key: 'production-order' }))).status, 403);
  assert.equal((await f.invoke(handler, paymentRequest(order.id))).status, 403);
  assert.equal(f.db.OrderPayment.length, 0);
});

test('lost final completion reply preserves paid balance and exactly one stock deduction', async () => {
  const f = fixture(); const order = await create(f); f.db.CustomerOrder[0].order_status = 'tayyor';
  loseReply(f.entities.CustomerOrder, 'updateMany', (_q, ops) => ops.$set?.order_status === 'yakunlandi');
  const req = { action: 'complete_order', order_id: order.id, idempotency_key: 'handoff', method: 'cash', amount: 20000 };
  const result = await f.invoke(handler, req);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal((await f.invoke(handler, req)).status, 200);
  assert.equal(f.db.CustomerOrder[0].paid_amount, 20000); assert.equal(f.db.Shift[0].expected_cash, 20000);
  assert.equal(f.db.OrderPayment.length, 1); assert.equal(f.db.ProductStock[0].quantity, 18);
  assert.equal(f.db.StockMovement.length, 1); assert.equal(f.calls.some((call) => call[1] === 'delete'), false);
  f.db.User[0].shop_id = 'another-shop';
  assert.equal((await f.invoke(handler, req)).status, 403);
});

test('fully paid completion and concurrent handoff preserve normal stock behavior', async () => {
  const f = fixture(); const order = await create(f, { advance_payment: { method: 'cash', amount: 20000 } });
  f.db.CustomerOrder[0].order_status = 'tayyor';
  const req = { action: 'complete_order', order_id: order.id, idempotency_key: 'paid-handoff' };
  const results = await Promise.all([f.invoke(handler, req), f.invoke(handler, req)]);
  assert.ok(results.some((res) => res.status === 200), JSON.stringify(results));
  assert.equal((await f.invoke(handler, req)).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 18); assert.equal(f.db.OrderPayment.length, 1);
  assert.equal(f.db.Shift[0].order_count, 1);
});

test('session retry storage retains a frozen actor-scoped payload across remount and edits', () => {
  const storage = new Map(); storage.getItem = storage.get.bind(storage); storage.setItem = storage.set.bind(storage); storage.removeItem = storage.delete.bind(storage);
  const scope = orderRequestScope('staff', 'record_payment', 'order');
  const payload = paymentRequest('order'); retainOrderRequest(scope, payload, storage);
  payload.amount = 999999;
  assert.equal(readOrderRequest(scope, storage).amount, 10000);
  assert.equal(retainOrderRequest(scope, paymentRequest('order', { amount: 1, idempotency_key: 'new-key' }), storage).idempotency_key, 'new-payment');
  assert.equal(readOrderRequest(orderRequestScope('other-staff', 'record_payment', 'order'), storage), null);
  clearOrderRequest(scope, storage); assert.equal(readOrderRequest(scope, storage), null);
});

test('financial order entities require the privileged backend create path', () => {
  const candidate = JSON.parse(readFileSync('checkpoints/audit-permissions-pending-2026-10-15.json', 'utf8'));
  const baseline = JSON.parse(readFileSync('checkpoints/audit-fixes-before-2026-10-15.json', 'utf8'));
  for (const entity of ['CustomerOrder', 'CustomerOrderItem', 'OrderPayment']) {
    const schema = JSON.parse(readFileSync(`base44/entities/${entity}.jsonc`, 'utf8'));
    assert.equal(({ ...schema.rls, ...candidate.entities[entity] }).create, false);
    assert.deepEqual(schema.rls, baseline.entities[entity].schema.rls, 'preview preserves current live permissions');
  }
  assert.equal(candidate.applied, false, 'permission restrictions stay staged until release');
});
