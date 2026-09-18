// Offline-only go-live safeguards: mocked entity reads; never touches production.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BACKUP_ENTITIES, collectBusinessBackup } from '../src/lib/read-only-backup.js';
import { buildPendingSale } from '../src/lib/offline-sales.js';

const read = (path) => readFileSync(path, 'utf8');

function mockArchiveHandlers(overrides = {}) {
  const calls = [];
  const entities = Object.fromEntries(BACKUP_ENTITIES.map((name) => [name, {
    list: async (sort, limit, skip) => {
      calls.push({ name, sort, limit, skip });
      const records = overrides[name] || [];
      return records.slice(skip, skip + limit);
    },
  }]));
  return { entities, calls };
}

test('read-only backup includes business and finance ledgers, excludes credentials and secret-bearing entities', () => {
  for (const name of ['Product', 'ProductStock', 'IngredientStock', 'Sale', 'SaleItem', 'Payment', 'OrderPayment', 'Shift', 'StockMovement', 'BudgetTransaction', 'CustomerOrder', 'SupplierReceipt']) {
    assert.ok(BACKUP_ENTITIES.includes(name), name);
  }
  for (const name of ['User', 'SecuritySettings', 'PendingStaffInvite', 'TelegramControl', 'TelegramDelivery', 'TelegramReportAccess', 'DiscountCode']) {
    assert.ok(!BACKUP_ENTITIES.includes(name), name);
  }
  const panel = read('src/components/security/BusinessBackupPanel.jsx');
  assert.match(panel, /user\?\.role !== 'admin'/);
  assert.doesNotMatch(panel, /asServiceRole|entities\.\w+\.(create|update|delete)/);
  assert.match(read('src/pages/Security.jsx'), /<BusinessBackupPanel user=\{user\}/);
});

test('backup paginates full 500-row boundaries and never writes entities', async () => {
  const products = Array.from({ length: 503 }, (_, i) => ({ id: `product-${i}`, name: `Cake ${i}` }));
  const { entities, calls } = mockArchiveHandlers({ Product: products, Sale: [{ id: 'sale-1', total: 40000 }] });
  const result = await collectBusinessBackup(entities, { generatedAt: '2026-09-18T15:00:00.000Z' });
  assert.equal(result.records.Product.length, 503);
  assert.equal(result.counts.Sale, 1);
  assert.deepEqual(calls.filter(({ name }) => name === 'Product').map(({ skip }) => skip), [0, 500]);
  assert.deepEqual(Object.keys(result.records), [...BACKUP_ENTITIES]);
  assert.equal(result.generated_at, '2026-09-18T15:00:00.000Z');
});

test('backup fails closed when an entity fails or records repeat; no partial file is generated', async () => {
  const { entities } = mockArchiveHandlers();
  entities.Payment.list = async () => { throw new Error('Read denied'); };
  await assert.rejects(() => collectBusinessBackup(entities), /Read denied/);
  const duplicates = mockArchiveHandlers({ Product: [{ id: 'duplicate' }, { id: 'duplicate' }] });
  await assert.rejects(() => collectBusinessBackup(duplicates.entities), /takrorlandi/);
});

test('front end, offline queue and server all require exact payment totals including 1 UZS difference', () => {
  assert.match(read('src/components/pos/PaymentModal.jsx'), /if \(sum !== total\)/);
  assert.match(read('base44/functions/complete-sale/entry.ts'), /if \(paidTotal !== total\)/);
  assert.match(read('src/lib/offline-sales.js'), /paid !== total/);
  const request = {
    idempotencyKey: 'pos-offline-ready-123456789',
    shift: { id: 'shift-1', shop_id: 'shop-1' },
    user: { id: 'user-1' },
    cart: [{ product_id: 'cake', product_name: 'Cake', price: 10000, quantity: 1 }],
  };
  assert.throws(() => buildPendingSale({ ...request, payments: [{ method: 'cash', amount: 9999 }] }), /To‘lov summasi/);
  assert.throws(() => buildPendingSale({ ...request, payments: [{ method: 'cash', amount: 10001 }] }), /To‘lov summasi/);
  assert.equal(buildPendingSale({ ...request, payments: [{ method: 'cash', amount: 10000 }] }).local_sale.total, 10000);
});

test('stock counts are per shop, physical counts require owner approval before changing product stock', () => {
  const backend = read('base44/functions/stock-count/entry.ts');
  assert.match(backend, /counts = counts\.filter\(\(c: any\) => c\.location_id === shopId\)/);
  assert.match(backend, /if \(!canApprove\(role\)\)/);
  assert.match(backend, /action === "approve_count"/);
  const ui = read('src/components/warehouse/StockCountPanel.jsx');
  assert.match(ui, /Qoldiq faqat egasi tasdiqlagach o‘zgartiriladi/);
});

test('receipt remains 80mm and includes wishes and per-shop snapshotted contacts', () => {
  const css = read('src/index.css');
  const receipt = read('src/components/pos/Receipt.jsx');
  assert.match(css, /@page \{ size: 80mm auto; margin: 0; \}/);
  assert.match(receipt, /receiptWishForSale\(sale\)/);
  for (const field of ['receipt_instagram_snapshot', 'receipt_phone_snapshot', 'receipt_address_snapshot']) assert.match(receipt, new RegExp(field));
  assert.match(receipt, /window\.print\(\)/);
});
