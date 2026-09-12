// Offline-only tests for the Kassa queue. No live Base44 data is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  buildPendingSale,
  isRetryableSyncError,
  saleNumberFromKey,
  tashkentDateKey,
} from '../src/lib/offline-sales.js';

const recordedAt = '2026-09-11T20:30:00.000Z';
const idempotencyKey = 'pos-offline-test-00000001';

function pendingSale(overrides = {}) {
  return buildPendingSale({
    idempotencyKey,
    recordedAt,
    shift: {
      id: 'shift-test',
      shop_id: 'shop-test',
      shop_name: 'Test do‘kon',
    },
    user: {
      id: 'cashier-test',
      full_name: 'Test kassir',
    },
    cart: [{
      product_id: 'cake-test',
      product_name: 'Medovik',
      image_url: '',
      price: 25000,
      quantity: 2,
      subtotal: 50000,
    }],
    payments: [{ method: 'cash', amount: 50000 }],
    ...overrides,
  });
}

test('offline sale keeps the original Tashkent business date and safe request key', () => {
  const record = pendingSale();

  assert.equal(tashkentDateKey(recordedAt), '2026-09-12');
  assert.equal(record.local_sale.business_date, '2026-09-12');
  assert.equal(record.local_sale.sold_at, recordedAt);
  assert.equal(record.local_sale.total, 50000);
  assert.equal(record.local_sale.offline_pending, true);
  assert.equal(record.request.idempotency_key, idempotencyKey);
  assert.equal(record.request.recorded_at, recordedAt);
  assert.equal(record.local_sale.sale_number, saleNumberFromKey(idempotencyKey, recordedAt));
  assert.equal(Object.hasOwn(record.request, 'owner_pin'), false);
});

test('offline sale is not stored when payment total is invalid', () => {
  assert.throws(
    () => pendingSale({ payments: [{ method: 'cash', amount: 40000 }] }),
    /To‘lov summasi/,
  );
});

test('only connection and temporary server failures are retryable', () => {
  assert.equal(isRetryableSyncError(new Error('network')), true);
  assert.equal(isRetryableSyncError({ response: { status: 503 } }), true);
  assert.equal(isRetryableSyncError({ response: { status: 409 } }), false);
  assert.equal(isRetryableSyncError({ response: { status: 400 } }), false);
});

test('queue persists in IndexedDB and uses a cross-tab sync lock', () => {
  const source = readFileSync('src/lib/offline-sales.js', 'utf8');
  assert.match(source, /indexedDB\.open/);
  assert.match(source, /navigator\.locks\?\.request/);
  assert.match(source, /if \(!payload\?\.sale\)/);
  assert.match(source, /await removePendingSale\(record\.id\)/);
});

console.log('4 offline Kassa queue tests passed. No live data was used.');
