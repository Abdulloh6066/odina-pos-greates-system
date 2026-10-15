import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryBackend } from './helpers/memory-backend.mjs';

function fixture(closeHandler) {
  const f = memoryBackend({
    User: [{ id: 'staff', role: 'cashier', active: true, shop_id: 'shop', full_name: 'Kassir' }],
    Shop: [{ id: 'shop', name: 'Odina', active: true, location_type: 'shop', allows_pos: true }],
    Settings: [{ id: 'settings', customer_order_last_number: 0, allow_negative_stock: false }],
    Product: [{ id: 'cake', name: 'Tort', price: 20000, active: true, track_stock: false }],
    Shift: [{ id: 'shift', user_id: 'staff', shop_id: 'shop', shop_name: 'Odina', status: 'open',
      opened_at: '2026-10-15T01:00:00.000Z', expected_cash: 0, cash_sales: 0, uzcard_sales: 0, humo_sales: 0,
      online_sales: 0, bank_transfer_sales: 0, total_sales: 0, order_count: 0 }],
    CustomerOrder: [], CustomerOrderItem: [], Customer: [], OrderPayment: [], ActionHistory: [],
    BudgetBalance: [{ id: 'budget-cash', account: 'cash', balance: 0 }, { id: 'budget-card', account: 'uzcard', balance: 0 }],
    BudgetTransaction: [], ProductStock: [], StockMovement: [], ShiftProductSnapshot: [],
  }, { now: '2026-10-15T07:00:00.000Z' });
  f.createOrder = async () => {
    const result = await f.invoke('base44/functions/customer-orders/entry.ts', { action: 'create_order', idempotency_key: 'order-close-race',
      shop_id: 'shop', customer_name: 'Vali', customer_phone: '+998901234567', required_date: '2026-10-20', required_time: '18:00',
      order_type: 'tugilgan_kun_va_boshqa', fulfilment_type: 'pickup', items: [{ product_id: 'cake', quantity: 1 }] });
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data.order.id;
  };
  f.pay = (orderId, method = 'cash') => f.invoke('base44/functions/customer-orders/entry.ts', { action: 'record_payment',
    order_id: orderId, method, amount: 10000, payment_kind: 'balance', idempotency_key: 'payment-close-race' });
  f.close = (actualCash = 0) => f.invoke(`base44/functions/${closeHandler}/entry.ts`, { action: 'close_shift', shift_id: 'shift',
    actual_cash: actualCash, budget_cash_submitted: actualCash, cash_left_for_next_shift: 0 });
  return f;
}

for (const closeHandler of ['shift-close-v2', 'complete-sale']) {
  test(`${closeHandler}: order payment reserves the shift before its ledger and blocks closure until posted`, async () => {
    const f = fixture(closeHandler); const orderId = await f.createOrder();
    const create = f.entities.OrderPayment.create; let attemptedClose;
    f.entities.OrderPayment.create = async (payload) => {
      attemptedClose = await f.close(10000);
      return create(payload);
    };
    const paid = await f.pay(orderId);
    assert.equal(attemptedClose.status, 409, JSON.stringify(attemptedClose));
    assert.equal(paid.status, 200, JSON.stringify(paid));
    assert.equal(f.db.Shift[0].expected_cash, 10000);
    assert.equal((await f.close(10000)).status, 200);
    assert.equal(f.db.BudgetBalance.find((row) => row.account === 'cash').balance, 10000);
    assert.equal(f.db.OrderPayment.length, 1);
  });

  test(`${closeHandler}: a stale close claim cannot bypass a concurrently added card-payment journal`, async () => {
    const f = fixture(closeHandler); const orderId = await f.createOrder();
    const update = f.entities.Shift.updateMany; let inserted = false;
    f.entities.Shift.updateMany = async (query, operations) => {
      if (!inserted && operations.$set?.status === 'closing') {
        inserted = true;
        assert.equal((await f.pay(orderId, 'bank_card')).status, 200);
      }
      return update(query, operations);
    };
    const close = await f.close();
    assert.equal(close.status, 409, JSON.stringify(close));
    assert.equal(f.db.Shift[0].status, 'open');
    assert.equal(f.db.Shift[0].expected_cash, 0, 'card posting keeps cash unchanged; the journal predicate must prevent the stale close');
    assert.equal((await f.close()).status, 200);
    assert.equal(f.db.BudgetBalance.find((row) => row.account === 'uzcard').balance, 10000);
  });

  test(`${closeHandler}: closure winning before reservation prevents any order payment ledger or total`, async () => {
    const f = fixture(closeHandler); const orderId = await f.createOrder();
    const update = f.entities.Shift.updateMany; let closed = false;
    f.entities.Shift.updateMany = async (query, operations) => {
      if (!closed && operations.$set?.order_payment_operations_json && !operations.$inc) {
        closed = true;
        assert.equal((await f.close()).status, 200);
      }
      return update(query, operations);
    };
    const payment = await f.pay(orderId);
    assert.equal(payment.status, 503, JSON.stringify(payment));
    assert.equal(payment.data.operation_pending, true);
    assert.equal(f.db.OrderPayment.length, 0);
    assert.equal(f.db.CustomerOrder[0].paid_amount, 0);
    assert.equal(f.db.Shift[0].status, 'closed');
    assert.equal(f.db.Shift[0].expected_cash, 0);
  });

  test(`${closeHandler}: a lost payment increment reply after valid closure confirms once without changing closed snapshots`, async () => {
    const f = fixture(closeHandler); const orderId = await f.createOrder();
    const update = f.entities.Shift.updateMany; let closed = false; let closedSnapshot;
    f.entities.Shift.updateMany = async (query, operations) => {
      const result = await update(query, operations);
      if (!closed && operations.$inc?.uzcard_sales === 10000) {
        closed = true;
        assert.equal((await f.close()).status, 200);
        closedSnapshot = structuredClone(f.db.Shift[0]);
        throw new Error('payment reply lost after closure');
      }
      return result;
    };
    assert.equal((await f.pay(orderId, 'bank_card')).status, 200);
    assert.equal((await f.pay(orderId, 'bank_card')).status, 200);
    assert.deepEqual(f.db.Shift[0], closedSnapshot);
    assert.equal(f.db.OrderPayment.length, 1);
    assert.equal(f.db.BudgetTransaction.filter((row) => row.account === 'uzcard').length, 1);
    assert.equal(f.db.BudgetBalance.find((row) => row.account === 'uzcard').balance, 10000);
  });
}
