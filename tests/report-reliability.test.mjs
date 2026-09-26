// All entities, email and Sheets calls below are memory-only fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const file = 'base44/functions/daily-sales-export/entry.ts';
const sale = { id: 'sale', shop_id: 'shop', business_date: '2026-09-27', status: 'completed', total: 100000,
  sale_items_count: 1, payments: [{ method: 'cash', amount: 100000 }] };
const item = { id: 'item', sale_id: 'sale', total_cost_at_sale: 40000, cost_is_estimate: false };
const fixture = (extra = {}, now = '2026-09-27T18:15:00.000Z') => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true }],
  Shop: [{ id: 'shop', name: 'Test shop', active: true, location_type: 'shop', allows_pos: true }],
  Sale: [sale], SaleItem: [item], Refund: [], OrderPayment: [], CashMovement: [], Shift: [],
  DailyExportConfig: [{ id: 'config', key: 'daily-export', auto_send_enabled: true,
    google_sheet_id: 'mock-sheet', google_sheet_url: 'mock-sheet-url', recipient_email: 'owner@example.test' }],
  DailyShopReport: [], ...extra,
}, { now });
function fakeSheets({ fail = 0, loseReply = false } = {}) {
  const rows = []; let writes = 0; let failures = fail; let lost = false;
  const fetch = async (url, opts = {}) => {
    if (!url.includes('sheets.googleapis.com/')) throw new Error('Unexpected external call');
    if (!opts.method || opts.method === 'GET') return { ok: true, json: async () => ({ values: structuredClone(rows) }) };
    assert.ok(url.endsWith('/values:batchUpdate'));
    if (failures-- > 0) return { ok: false, status: 500, json: async () => ({ error: { message: 'Mock Sheets rejection' } }) };
    const body = JSON.parse(opts.body); assert.equal(body.valueInputOption, 'RAW');
    for (const write of body.data) {
      const match = /!A(\d+):T\d+$/.exec(write.range); assert.ok(match);
      rows[Number(match[1]) - 1] = write.values[0];
    }
    writes++;
    if (loseReply && !lost) { lost = true; throw new Error('Mock reply lost AFTER applying rows'); }
    return { ok: true, json: async () => ({ totalUpdatedRows: body.data.length }) };
  };
  return { rows, fetch, writes: () => writes };
}

test('same-day full refund nets to zero, not minus the selling price', async () => {
  const f = fixture({ Sale: [{ ...sale, status: 'refunded', refund_id: 'refund' }],
    Refund: [{ id: 'refund', sale_id: 'sale', shop_id: 'shop', amount: 100000, created_at: '2026-09-27T10:00:00.000Z', payments: sale.payments }] });
  const r = await f.invoke(file, { action: 'preview', business_date: '2026-09-27' });
  assert.equal(r.status, 200); const m = r.data.reports[0];
  assert.equal(m.total_revenue, 0); assert.equal(m.total_cost, 0); assert.equal(m.cash_total, 0);
  assert.equal(m.sale_count, 1); assert.equal(m.refund_count, 1);
  assert.equal(f.calls.length, 0, 'preview is read-only');
});
test('later-day refunds preserve the original day and reverse money on refund day', async () => {
  const f = fixture({ Sale: [{ ...sale, status: 'refunded', refund_id: 'refund' }],
    Refund: [{ id: 'refund', sale_id: 'sale', shop_id: 'shop', amount: 100000, created_at: '2026-09-28T10:00:00.000Z', payments: sale.payments }] });
  const original = await f.invoke(file, { action: 'preview', business_date: '2026-09-27' });
  const refund = await f.invoke(file, { action: 'preview', business_date: '2026-09-28' });
  assert.equal(original.data.reports[0].total_revenue, 100000);
  assert.equal(refund.data.reports[0].total_revenue, -100000);
  assert.equal(refund.data.reports[0].total_cost, -40000);
  const range = await f.invoke(file, { action: 'range', date_from: '2026-09-27', date_to: '2026-09-28' });
  assert.equal(range.data.grand.revenue, 0); assert.equal(range.data.grand.cost, 0);
  assert.equal(range.data.byDay.length, 2);
});
test('deposits and balance payments count on payment day without becoming duplicate profit', async () => {
  const f = fixture({ OrderPayment: [
    { id: 'advance', shop_id: 'shop', order_id: 'order', amount: 200000, status: 'completed', payment_method: 'cash', paid_at: '2026-09-27T08:00:00.000Z' },
    { id: 'balance', shop_id: 'shop', order_id: 'order', amount: 300000, status: 'completed', payment_method: 'bank_card', paid_at: '2026-09-28T08:00:00.000Z' },
  ] });
  const one = (await f.invoke(file, { action: 'preview', business_date: '2026-09-27' })).data.reports[0];
  assert.equal(one.order_payment_total, 200000); assert.equal(one.collections_total, 300000);
  assert.equal(one.total_revenue, 100000); assert.equal(one.real_profit, 60000); assert.equal(one.cash_total, 300000);
  const two = (await f.invoke(file, { action: 'preview', business_date: '2026-09-28' })).data.reports[0];
  assert.equal(two.collections_total, 300000); assert.equal(two.real_profit, 0); assert.equal(two.uzcard_total, 300000);
});
test('both expense aliases are included; supplier payments and owner withdrawals are not expenses', async () => {
  const f = fixture({ CashMovement: ['other', 'other_expense', 'shop_expense', 'goods_payment', 'owner_withdrawal'].map((kind, i) => ({
    id: 'expense-' + i, shop_id: 'shop', type: 'withdrawal', expense_category: kind, amount: 1000, created_at: '2026-09-27T10:00:00.000Z',
  })) });
  const m = (await f.invoke(file, { action: 'preview', business_date: '2026-09-27' })).data.reports[0];
  assert.equal(m.expenses_total, 3000); assert.equal(m.net_profit, 57000);
});
test('missing costs are explicitly flagged rather than represented as known zero cost', async () => {
  const f = fixture({ SaleItem: [{ ...item, total_cost_at_sale: 0, cost_is_estimate: true }] });
  const m = (await f.invoke(file, { action: 'preview', business_date: '2026-09-27' })).data.reports[0];
  assert.ok(m.unknown_cost_count > 0);
});
test('repeated send reuses a sheet row and does not send a confirmed identical email twice', async () => {
  const f = fixture(); const sheets = fakeSheets();
  const first = await f.invoke(file, { action: 'send', business_date: '2026-09-27' }, { fetch: sheets.fetch });
  const repeat = await f.invoke(file, { action: 'send', business_date: '2026-09-27' }, { fetch: sheets.fetch });
  assert.equal(first.status, 200, JSON.stringify(first)); assert.equal(first.data.sent, 1);
  assert.equal(repeat.data.sent, 1); assert.equal(sheets.rows.length, 2); assert.equal(sheets.writes(), 1);
  assert.equal(f.calls.filter(([name]) => name === 'test-email').length, 1);
});
test('failed Sheets delivery is not marked sent; later retry does not repeat a successful email', async () => {
  const f = fixture(); const sheets = fakeSheets({ fail: 1 });
  const first = await f.invoke(file, { action: 'send', business_date: '2026-09-27' }, { fetch: sheets.fetch });
  assert.equal(first.data.sent, 0); assert.equal(f.db.DailyShopReport[0].sent_at, '');
  assert.equal(f.db.DailyShopReport[0].email_sent, true);
  const next = await f.invoke(file, { action: 'send', business_date: '2026-09-27' }, { fetch: sheets.fetch });
  assert.equal(next.data.sent, 1); assert.equal(f.calls.filter(([name]) => name === 'test-email').length, 1);
});
test('a lost Sheets response cannot append duplicate rows on retry', async () => {
  const f = fixture(); const sheets = fakeSheets({ loseReply: true });
  assert.equal((await f.invoke(file, { action: 'send', business_date: '2026-09-27' }, { fetch: sheets.fetch })).data.sent, 0);
  assert.equal((await f.invoke(file, { action: 'send', business_date: '2026-09-27' }, { fetch: sheets.fetch })).data.sent, 1);
  assert.equal(sheets.rows.length, 2); assert.equal(sheets.rows[1][19], 'shop');
});
test('uncertain email stays visible and is retried only after explicit confirmation', async () => {
  const f = fixture(); const sheets = fakeSheets(); let attempts = 0;
  f.service.integrations.Core.SendEmail = async () => { attempts++; if (attempts === 1) throw new Error('Mock email reply lost'); };
  const first = await f.invoke(file, { action: 'send', business_date: '2026-09-27' }, { fetch: sheets.fetch });
  assert.equal(first.data.email_uncertain, true); assert.equal(first.data.sent, 0);
  await f.invoke(file, { action: 'send', business_date: '2026-09-27' }, { fetch: sheets.fetch });
  assert.equal(attempts, 1);
  const confirmed = await f.invoke(file, { action: 'send', business_date: '2026-09-27', retry_uncertain_email: true }, { fetch: sheets.fetch });
  assert.equal(confirmed.data.sent, 1); assert.equal(attempts, 2); assert.equal(sheets.rows.length, 2);
});
test('00:15 automatic export uses the preceding Uzbekistan business date', async () => {
  const f = fixture({ Sale: [{ ...sale, business_date: '2026-09-26' }] }, '2026-09-26T19:15:00.000Z');
  const sheets = fakeSheets();
  const r = await f.invoke(file, { action: 'autoSend' }, { fetch: sheets.fetch });
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.data.targetDate, '2026-09-26'); assert.equal(r.data.sent, 1);
});
test('new-day open shift does not block the previous closed business day report', async () => {
  const f = fixture({ Sale: [{ ...sale, business_date: '2026-09-26' }],
    Shift: [{ id: 'new-shift', shop_id: 'shop', status: 'open', opened_at: '2026-09-26T19:05:00.000Z' }] }, '2026-09-26T19:15:00.000Z');
  const sheets = fakeSheets(); const r = await f.invoke(file, { action: 'autoSend' }, { fetch: sheets.fetch });
  assert.equal(r.data.sent, 1);
});
test('closing or still-open shifts from the target day block premature exports', async () => {
  const f = fixture({ Shift: [{ id: 'shift', shop_id: 'shop', status: 'closing', opened_at: '2026-09-27T07:00:00.000Z' }] });
  const r = await f.invoke(file, { action: 'autoSend' });
  assert.equal(r.data.sent, 0); assert.equal(f.db.DailyShopReport.length, 0);
});
test('old incorrect sent_at alone does not suppress a genuine failed-delivery retry', async () => {
  const f = fixture({ DailyShopReport: [{ id: 'old', business_date: '2026-09-27', shop_id: 'shop',
    sent_at: '2026-09-27T18:00:00.000Z', email_sent: false, sheet_appended: false }] });
  const sheets = fakeSheets(); const r = await f.invoke(file, { action: 'autoSend' }, { fetch: sheets.fetch });
  assert.equal(r.data.sent, 1);
});
test('cashier cannot read owner export data or send reports', async () => {
  const f = fixture({ User: [{ id: 'cashier', role: 'cashier', active: true }] });
  for (const action of ['preview', 'range', 'send']) assert.equal((await f.invoke(file, { action })).status, 403);
  assert.equal(f.calls.length, 0);
});
