import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { ordersHistoryQuery, salesHistoryQuery, shiftsHistoryQuery, readEntityPage, readAllEntityPages,
  FINISHED_ORDER_STATUSES } from '../src/lib/history-pagination.js';

test('old sales beyond 500 are searchable without eagerly loading unrelated history', async () => {
  const sales = Array.from({ length: 750 }, (_, index) => ({ id: `sale-${index}`, user_name: index === 0 ? 'Old Kassir' : 'New Kassir',
    user_id: 'cashier', total: index, created_date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString() }));
  const f = memoryBackend({ Sale: sales });
  const page = await readEntityPage(f.entities.Sale, salesHistoryQuery({ search: 'Old Kassir' }), '-created_date');
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].id, 'sale-0');
  assert.equal(page.hasMore, false);
});

test('sales dates include stored business dates and legacy Tashkent midnight boundaries', async () => {
  const f = memoryBackend({ Sale: [
    { id: 'stored', business_date: '2026-10-01', sold_at: '2026-10-02T10:00:00Z', created_date: '2026-10-02T10:00:00Z' },
    { id: 'legacy-sold', sold_at: '2026-09-30T19:00:00Z', created_date: '2026-10-03T10:00:00Z' },
    { id: 'legacy-created', created_date: '2026-10-01T18:59:59Z' },
    { id: 'next-day', created_date: '2026-10-01T19:00:00Z' },
  ] });
  const result = await readEntityPage(f.entities.Sale, salesHistoryQuery({ date: '2026-10-01' }), 'id');
  assert.deepEqual(result.rows.map(row => row.id).sort(), ['legacy-created', 'legacy-sold', 'stored']);
});

test('cashier history query always limits results to their own records', async () => {
  const f = memoryBackend({ Sale: [{ id: 'mine', user_id: 'cashier' }, { id: 'other', user_id: 'other' }] });
  const result = await readEntityPage(f.entities.Sale, salesHistoryQuery({ user: { id: 'cashier', role: 'cashier' } }), 'id');
  assert.deepEqual(result.rows.map(row => row.id), ['mine']);
});

test('shift history beyond 200 respects complete server search, shop, date and status filters', async () => {
  const shifts = Array.from({ length: 700 }, (_, index) => ({ id: `shift-${index}`, status: 'closed', shop_id: 'shop',
    shop_name: 'Do‘kon', user_name: index === 0 ? 'Tarixiy Kassir' : 'Kassir', opened_at: '2026-10-01T06:00:00Z' }));
  const f = memoryBackend({ Shift: shifts });
  const query = shiftsHistoryQuery({ query: 'Tarixiy', shop_id: 'shop', date: '2026-10-01', status: 'closed' });
  assert.equal((await readEntityPage(f.entities.Shift, query, '-opened_at')).rows[0].id, 'shift-0');
});

test('each page is bounded and all old records remain reachable on demand', async () => {
  const f = memoryBackend({ Sale: Array.from({ length: 735 }, (_, index) => ({ id: String(index).padStart(4, '0') })) });
  let skip = 0, hasMore = true;
  const collected = [];
  while (hasMore) {
    const page = await readEntityPage(f.entities.Sale, {}, 'id', skip);
    assert.ok(page.rows.length <= 100);
    collected.push(...page.rows);
    skip = page.nextSkip; hasMore = page.hasMore;
  }
  assert.equal(collected.length, 735);
  assert.equal(new Set(collected.map(row => row.id)).size, 735);
});

test('unfinished orders load independently of more than 500 newer completed orders', async () => {
  const rows = Array.from({ length: 800 }, (_, index) => ({ id: `done-${index}`, order_status: 'yakunlandi', required_date: '2026-10-01' }));
  rows.push({ id: 'unfinished-old', order_status: 'tayyorlanmoqda', required_date: '2026-10-15', customer_name: 'Eski mijoz' });
  const f = memoryBackend({ CustomerOrder: rows });
  const active = await readAllEntityPages(f.entities.CustomerOrder, { order_status: { $nin: FINISHED_ORDER_STATUSES } });
  assert.deepEqual(active.map(row => row.id), ['unfinished-old']);
  const historyQuery = ordersHistoryQuery({ view: 'history', query: 'Eski mijoz' });
  assert.equal((await readEntityPage(f.entities.CustomerOrder, historyQuery, '-required_date')).rows.length, 0);
  const searchQuery = ordersHistoryQuery({ view: 'all', query: 'Eski mijoz' });
  assert.equal((await readEntityPage(f.entities.CustomerOrder, searchQuery, 'required_date')).rows[0].id, 'unfinished-old');
});

test('unfinished orders and selected shift details have no 500-row ceiling', async () => {
  const f = memoryBackend({ SaleItem: Array.from({ length: 625 }, (_, index) => ({ id: String(index).padStart(4, '0'), shift_id: 'selected' })) });
  const rows = await readAllEntityPages(f.entities.SaleItem, { shift_id: 'selected' });
  assert.equal(rows.length, 625);
});

test('pagination errors reject the entire detail read rather than pretending a partial total is complete', async () => {
  const f = memoryBackend({ SaleItem: Array.from({ length: 250 }, (_, index) => ({ id: String(index).padStart(4, '0') })) });
  const filter = f.entities.SaleItem.filter;
  f.entities.SaleItem.filter = async (query, sort, limit, skip) => {
    if (skip >= 100) throw new Error('Offline read failure');
    return filter(query, sort, limit, skip);
  };
  await assert.rejects(() => readAllEntityPages(f.entities.SaleItem, {}), /Offline read failure/);
});

test('canceled detail reads stop paging and never return an obsolete result', async () => {
  const f = memoryBackend({ SaleItem: Array.from({ length: 250 }, (_, index) => ({ id: String(index).padStart(4, '0') })) });
  let current = true, requests = 0;
  const filter = f.entities.SaleItem.filter;
  f.entities.SaleItem.filter = async (...args) => { requests++; const result = await filter(...args); current = false; return result; };
  assert.deepEqual(await readAllEntityPages(f.entities.SaleItem, {}, 'id', () => current), []);
  assert.equal(requests, 1);
});

test('search punctuation is literal and cannot expand the server search', async () => {
  const f = memoryBackend({ CustomerOrder: [{ id: 'literal', customer_name: 'Mijoz (1)' }, { id: 'other', customer_name: 'Mijoz 1' }] });
  const page = await readEntityPage(f.entities.CustomerOrder, ordersHistoryQuery({ view: 'all', query: '(1)' }), 'id');
  assert.deepEqual(page.rows.map(row => row.id), ['literal']);
});

test('the visible permanent order number can be searched even when its technical number differs', async () => {
  const f = memoryBackend({ CustomerOrder: [{ id: 'permanent', order_sequence: 657, order_number: 'OD-TECH-ABC' }] });
  const page = await readEntityPage(f.entities.CustomerOrder, ordersHistoryQuery({ view: 'all', query: '657' }), 'id');
  assert.deepEqual(page.rows.map(row => row.id), ['permanent']);
});
