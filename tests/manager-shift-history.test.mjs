// Offline: actual handler, memory entities, no live credentials or business writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { managerShiftHistoryEntity, loadManagerShiftDetail } from '../src/lib/manager-shift-history.js';

const actor = { id: 'm', role: 'manager', active: true, shop_id: 'own' };
const own = { id: 's', shop_id: 'own', user_name: 'Cashier', shop_name: 'Branch', status: 'open', opened_at: '2026-09-27T06:00:00Z', created_date: '2026-09-27T06:00:00Z', total_sales: 100,
  closing_payload_json: 'private-journal', sale_request_keys: ['private-key'], budget_settled: true, budget_cash_submitted: 500, unknown_secret: 'private-future' };
const seed = extra => ({ User: [actor], Shop: [{ id: 'own', active: true }, { id: 'other', active: true }], Shift: [own, { ...own, id: 'foreign', shop_id: 'other' }], ...extra });
const file = 'base44/functions/manager-shop/entry.ts';

test('manager history reads authoritative own-shop shifts even when the direct entity reader is empty', async () => {
  const f = memoryBackend(seed());
  f.client.entities = { Shift: { filter: async () => [] } };
  f.client.functions = { invoke: async (name, body) => {
    assert.equal(name, 'manager-shop'); const response = await f.invoke(file, body);
    assert.equal(response.status, 200); return { data: response.data };
  } };
  const reader = managerShiftHistoryEntity(f.client, { shop_id: 'all', status: 'all' });
  const rows = await reader.filter({ $and: [{}, { created_date: { $lte: '2026-09-28T00:00:00Z' } }] }, '-opened_at', 100, 0);
  assert.deepEqual(rows.map(row => row.id), ['s']);
  assert.equal(rows[0].total_sales, 100);
  assert.ok(!JSON.stringify(rows).includes('private'));
  assert.equal(rows[0].budget_settled, undefined);
  assert.deepEqual(f.calls, []);
});

test('stored nested manager identity retains own scope; caller shop and arbitrary filters cannot widen it', async () => {
  const f = memoryBackend(seed({ User: [{ id: 'm', role: 'user', data: { role: 'manager', shop_id: 'own', active: true } }] }));
  assert.equal((await f.invoke(file, { action: 'list_shift_history' })).status, 200);
  for (const body of [
    { shop_id: 'other' }, { filters: { shop_id: 'other' } }, { filters: { $or: [{}] } }, { filters: null },
    { filters: { status: 'anything' } }, { filters: { date: '2026-02-30' } }, { skip: -1 }, { limit: 101 },
  ]) assert.ok((await f.invoke(file, { action: 'list_shift_history', ...body })).status >= 400);
  assert.deepEqual(f.calls, []);
});

test('history filters use Tashkent dates, literal search, fixed ordering and bounded pagination', async () => {
  const f = memoryBackend(seed({ Shift: [
    { ...own, id: 'first', user_name: 'A.*', opened_at: '2026-09-26T20:00:00Z', created_date: '2026-09-26T20:00:00Z' },
    { ...own, id: 'second', user_name: 'Another', opened_at: '2026-09-27T20:00:00Z' },
  ] }));
  const r = await f.invoke(file, { action: 'list_shift_history', filters: { date: '2026-09-27', query: 'A.*', status: 'open' }, limit: 1, skip: 0 });
  assert.equal(r.status, 200); assert.deepEqual(r.data.rows.map(row => row.id), ['first']);
  assert.equal(r.data.reader_version, '2026-10-25-manager-shifts-1');
  const next = await f.invoke(file, { action: 'list_shift_history', limit: 1, skip: 1 });
  assert.deepEqual(next.data.rows.map(row => row.id), ['first']);
});

test('foreign shift details and inactive/unassigned/nonmanager actors are rejected before child reads', async () => {
  const f = memoryBackend(seed());
  f.entities.Sale.filter = async () => { throw Error('foreign details must not be read'); };
  assert.equal((await f.invoke(file, { action: 'get_shift_detail', shift_id: 'foreign' })).status, 403);
  for (const user of [{ ...actor, active: false }, { ...actor, shop_id: '' }, { ...actor, role: 'cashier' }, { ...actor, role: 'admin' }]) {
    const denied = memoryBackend(seed({ User: [user] }));
    assert.equal((await denied.invoke(file, { action: 'list_shift_history' })).status, 403);
    assert.deepEqual(denied.calls, []);
  }
});

test('own detail projection keeps operating snapshots and excludes nested journals and Budget fields', async () => {
  const f = memoryBackend(seed({ Sale: [{ id: 'sale', shift_id: 's', shop_id: 'own', total: 100, private: 'private-sale',
    items: [{ product_id: 'cake', quantity: 2, line_total: 100, secret: 'private-item' }],
    payments: [{ method: 'cash', amount: 100, secret: 'private-payment' }] }],
  ShiftProductSnapshot: [{ id: 'snap', shift_id: 's', shop_id: 'own', product_name_snapshot: 'Cake', expected_quantity: 9, journal: 'private-stock' }] }));
  const r = await f.invoke(file, { action: 'get_shift_detail', shift_id: 's' });
  assert.equal(r.status, 200); assert.equal(r.data.detail.sales[0].items[0].quantity, 2);
  assert.equal(r.data.detail.stockSnapshots[0].expected_quantity, 9);
  assert.equal(r.data.detail.partial, false); assert.ok(!JSON.stringify(r.data).includes('private'));
  assert.equal(r.data.shift.budget_cash_submitted, undefined); assert.deepEqual(f.calls, []);
});

test('failed primary reads are errors; failed supplemental details are explicitly partial', async () => {
  const f = memoryBackend(seed()); f.entities.Shift.filter = async () => { throw Error('storage unavailable'); };
  assert.equal((await f.invoke(file, { action: 'list_shift_history' })).status, 500);
  f.entities.Shift.filter = async () => null;
  assert.equal((await f.invoke(file, { action: 'list_shift_history' })).status, 502);
  f.entities.CashMovement.filter = async () => { throw Error('movements unavailable'); };
  const detail = await f.invoke(file, { action: 'get_shift_detail', shift_id: 's' });
  assert.equal(detail.status, 200); assert.equal(detail.data.detail.partial, true);
  f.entities.Sale.filter = async () => { throw Error('sales unavailable'); };
  assert.equal((await f.invoke(file, { action: 'get_shift_detail', shift_id: 's' })).status, 500);
});

test('frontend history helpers reject failed/invalid responses without falling back to empty entity data', async () => {
  const client = { functions: { invoke: async () => ({ data: {} }) }, entities: new Proxy({}, { get: () => { throw Error('raw fallback forbidden'); } }) };
  await assert.rejects(managerShiftHistoryEntity(client, {}).filter({}, '', 100, 0), /Smena tarixi/);
  await assert.rejects(loadManagerShiftDetail(client, 's'), /Smena tafsilotlari/);
  client.functions.invoke = async () => { throw Error('backend unavailable'); };
  await assert.rejects(managerShiftHistoryEntity(client, {}).filter({}, '', 100, 0), /backend unavailable/);
  const source = readFileSync('src/pages/Shifts.jsx', 'utf8');
  assert.match(source, /role === 'manager'[\s\S]*managerShiftHistoryEntity/);
  assert.match(source, /await loadManagerShiftDetail\(base44, shift.id\)/);
});
