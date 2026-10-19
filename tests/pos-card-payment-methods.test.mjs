// Actual checkout handler with memory-only records. No live sales or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { basketCheckoutFixture } from './helpers/basket-checkout.mjs';
import { buildPendingSale } from '../src/lib/offline-sales.js';

for (const store of ['Central', 'Branch']) {
  for (const method of ['humo', 'uzcard', 'cash', 'bank_card', 'online']) {
    test(`${store}: ${method} keeps its identity, credits the correct shift balance and replays safely`, async () => {
      const f = basketCheckoutFixture(store, 0, 0);
      f.request.payments = [{ method, amount: 20000 }];
      const result = await f.call();
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.deepEqual(result.data.sale.payments, [{ method, amount: 20000 }]);
      assert.equal(f.db.Payment.length, 1);
      assert.equal(f.db.Payment[0].method, method);
      assert.equal(f.db.Payment[0].amount, 20000);
      const shift = f.db.Shift[0];
      assert.equal(shift.total_sales, 20000);
      assert.equal(shift.expected_cash, method === 'cash' ? 20000 : 0);
      assert.equal(shift.cash_sales, method === 'cash' ? 20000 : 0);
      assert.equal(shift.uzcard_sales, ['uzcard', 'bank_card'].includes(method) ? 20000 : 0);
      assert.equal(shift.humo_sales, method === 'humo' ? 20000 : 0);
      assert.equal(shift.online_sales, method === 'online' ? 20000 : 0);
      const writeCount = f.calls.length;
      const replay = await f.call();
      assert.equal(replay.status, 200);
      assert.equal(replay.data.already_processed, true);
      assert.equal(f.calls.length, writeCount, 'Retry must not duplicate money or stock writes');
      assert.equal(f.db.Sale.length, 1);
      assert.equal(f.db.Payment.length, 1);
    });
  }

  test(`${store}: split cash/HUMO/UZCARD payments retain separate amounts`, async () => {
    const f = basketCheckoutFixture(store, 0, 0);
    const payments = [{ method: 'cash', amount: 5000 }, { method: 'humo', amount: 7000 }, { method: 'uzcard', amount: 8000 }];
    f.request.payments = payments;
    const result = await f.call();
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.data.sale.payments, payments);
    assert.deepEqual(f.db.Payment.map(({ method, amount }) => ({ method, amount })), payments);
    assert.equal(f.db.Shift[0].expected_cash, 5000);
    assert.equal(f.db.Shift[0].humo_sales, 7000);
    assert.equal(f.db.Shift[0].uzcard_sales, 8000);
    assert.equal(f.db.Shift[0].total_sales, 20000);
  });
}

test('offline sale payload and receipt preserve HUMO/UZCARD IDs for later synchronization', () => {
  const payments = [{ method: 'humo', amount: 8000 }, { method: 'uzcard', amount: 12000 }];
  const record = buildPendingSale({
    idempotencyKey: 'offline-card-methods-test-only',
    recordedAt: '2026-10-19T10:00:00Z',
    shift: { id: 'mock-shift', shop_id: 'mock-shop', shop_name: 'Mock shop' },
    user: { id: 'mock-cashier' },
    cart: [{ product_id: 'mock-product', product_name: 'Mock product', quantity: 1, price: 20000 }],
    payments,
  });
  assert.deepEqual(record.local_sale.payments, payments);
  assert.deepEqual(record.request.payments.map(({ method, amount }) => ({ method, amount })), payments);
  assert.equal(record.local_sale.total, 20000);
});
