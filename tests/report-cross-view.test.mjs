// Read-only report consistency tests with memory-only entities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const sale = { id: 'sale', shop_id: 'shop', business_date: '2026-09-27', status: 'completed', total: 100000,
  sale_items_count: 1, payments: [{ method: 'cash', amount: 100000 }] };
const item = { id: 'item', sale_id: 'sale', product_id: 'cake', product_name_snapshot: 'Test cake', quantity: 1,
  unit_price: 100000, line_total: 100000, unit_cost_at_sale: 40000, total_cost_at_sale: 40000, cost_is_estimate: false };
const fixture = extra => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true }],
  Shop: [{ id: 'shop', name: 'Test shop', active: true, location_type: 'shop', allows_pos: true }],
  Sale: [sale], SaleItem: [item], Refund: [], OrderPayment: [], CashMovement: [], ...extra,
});
const query = { action: 'report', date_from: '2026-09-27', date_to: '2026-09-27' };
const file = 'base44/functions/profit-report/entry.ts';

test('profit report preserves immutable costs and reports order cash flow separately', async () => {
  const f = fixture({ OrderPayment: [{ id: 'advance', shop_id: 'shop', amount: 200000,
    status: 'completed', payment_method: 'cash', paid_at: '2026-09-27T08:00:00.000Z' }] });
  const result = await f.invoke(file, query);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.summary.net_revenue, 100000);
  assert.equal(result.data.summary.cost_of_goods, 40000);
  assert.equal(result.data.summary.gross_profit, 60000);
  assert.equal(result.data.summary.order_payment_total, 200000);
  assert.equal(result.data.summary.collections_total, 300000);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.db.SaleItem[0], item);
});
test('same-day refund is net zero in profit and daily reports', async () => {
  const f = fixture({ Sale: [{ ...sale, status: 'refunded', refund_id: 'refund' }],
    Refund: [{ id: 'refund', shop_id: 'shop', sale_id: 'sale', amount: 100000,
      payments: sale.payments, created_at: '2026-09-27T09:00:00.000Z' }] });
  const profit = await f.invoke(file, query);
  const daily = await f.invoke('base44/functions/daily-sales-export/entry.ts', { action: 'preview', business_date: '2026-09-27' });
  assert.equal(profit.data.summary.net_revenue, 0); assert.equal(profit.data.summary.cost_of_goods, 0);
  assert.equal(profit.data.summary.gross_profit, daily.data.reports[0].real_profit);
  assert.equal(f.db.SaleItem[0].quantity, 1); assert.equal(f.db.SaleItem[0].line_total, 100000);
});
test('later refund day reverses only that day in profit report', async () => {
  const f = fixture({ Sale: [{ ...sale, status: 'refunded', refund_id: 'refund' }],
    Refund: [{ id: 'refund', shop_id: 'shop', sale_id: 'sale', amount: 100000,
      payments: sale.payments, created_at: '2026-09-28T09:00:00.000Z' }] });
  const before = await f.invoke(file, query);
  const after = await f.invoke(file, { ...query, date_from: '2026-09-28', date_to: '2026-09-28' });
  assert.equal(before.data.summary.gross_profit, 60000);
  assert.equal(after.data.summary.gross_profit, -60000);
  assert.equal(after.data.summary.net_revenue, -100000);
});
test('gram products with unknown costs never multiply a per-piece cost by grams', async () => {
  const f = fixture({ SaleItem: [{ ...item, sale_unit: 'gram', quantity: 500, cost_is_estimate: true, unit_cost_at_sale: 0, total_cost_at_sale: 0 }] });
  const result = await f.invoke(file, query);
  assert.equal(result.status, 200); assert.equal(result.data.summary.cost_of_goods, 0);
  assert.equal(result.data.summary.unknown_count, 1);
});
test('missing item detail is explicit while total money remains visible', async () => {
  const f = fixture({ SaleItem: [] }); const result = await f.invoke(file, query);
  assert.equal(result.data.summary.net_revenue, 100000);
  assert.equal(result.data.summary.incomplete_sale_count, 1); assert.ok(result.data.summary.unknown_count > 0);
});
test('report loader reads beyond one page without losing totals', async () => {
  const sales = Array.from({ length: 501 }, (_, i) => ({ ...sale, id: `sale-${i}`, total: 1000 }));
  const items = sales.map(s => ({ ...item, id: `item-${s.id}`, sale_id: s.id, line_total: 1000, unit_cost_at_sale: 400, total_cost_at_sale: 400 }));
  const f = fixture({ Sale: sales, SaleItem: items });
  const result = await f.invoke(file, query);
  assert.equal(result.data.summary.net_revenue, 501000);
  assert.equal(result.data.summary.cost_of_goods, 200400);
});
test('private report uses the same dated refund and order-payment calculations', async () => {
  const f = fixture({ Sale: [{ ...sale, business_date: '2026-09-26', status: 'refunded', refund_id: 'refund' }],
    Refund: [{ id: 'refund', shop_id: 'shop', sale_id: 'sale', amount: 100000, payments: sale.payments, created_at: '2026-09-27T08:00:00.000Z' }],
    OrderPayment: [{ id: 'advance', shop_id: 'shop', amount: 200000, status: 'completed', payment_method: 'cash', paid_at: '2026-09-27T08:00:00.000Z' }] });
  const stage = f.load('base44/shared/private-telegram-webhook-stage.ts');
  const reply = await stage.preparePrivateTelegramReply({ callback_query: { id: 'callback', data: 'pr:p:shop:today',
    from: { id: '123456789' }, message: { chat: { id: '123456789', type: 'private' } } } }, {
    ownerId: '123456789', service: f.service, now: Date.parse('2026-09-27T10:00:00Z'),
  });
  assert.equal(reply.kind, 'message'); assert.match(reply.text, /Tushum: 100,000 so‘m/);
  assert.match(reply.text, /Kassa sof savdo: -100,000 so‘m/);
  assert.match(reply.text, /Buyurtma to‘lovlari: 200,000 so‘m/);
  assert.equal(f.calls.length, 0);
});
test('duplicate report paging fails explicitly instead of silently undercounting', async () => {
  const f = fixture(); const { readReportRows } = f.load('base44/shared/report-activity.ts');
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}` }));
  await assert.rejects(() => readReportRows({ filter: async () => rows }), /takrorlandi/);
});
