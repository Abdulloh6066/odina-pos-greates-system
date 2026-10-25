// Offline only: actual handlers, memory entities and no network or live credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBackend, matches } from './helpers/memory-backend.mjs';
import { loadOperationalSettings, loadExportHistory } from '../src/lib/operational-config.js';

const manager = { id: 'm', role: 'manager', shop_id: 'a', active: true };
const shops = [{ id: 'a', name: 'A', active: true, location_type: 'shop' }, { id: 'b', name: 'B', active: true, location_type: 'shop' }];
const file = 'base44/functions/manager-shop/entry.ts';
const exportFile = 'base44/functions/daily-sales-export/entry.ts';
const fixture = (extra = {}, actor = manager) => memoryBackend({ User: [actor], Shop: shops, ...extra });
const settings = { id: 'global', shop_name: 'Odina', receipt_footer: 'Footer', thank_you_message: 'Rahmat', currency: 'UZS', allow_negative_stock: false,
  customer_order_request_keys: ['private-order'], customer_order_payment_request_fingerprints: ['private-payment'],
  budget_account_initialization_json: 'private-budget-journal', google_sheet_id: 'private-sheet', recipient_email: 'private@example.test', unknown_future_secret: 'private-secret' };
const permitted = (rule, role) => rule === true || Boolean(rule?.user_condition?.role === role) || Boolean(rule?.$or?.some(item => permitted(item, role)));

test('raw Settings and export configuration/history entity APIs deny manager reads and writes', () => {
  for (const entity of ['Settings', 'DailyExportConfig', 'DailyShopReport']) {
    const schema = JSON.parse(readFileSync(`base44/entities/${entity}.jsonc`, 'utf8'));
    for (const action of ['read', 'create', 'update', 'delete']) {
      assert.equal(permitted(schema.rls[action], 'manager'), false, `${entity}.${action}`);
      assert.equal(permitted(schema.rls[action], 'admin'), true, `${entity}.${action} admin`);
    }
  }
});

test('business config exposes exactly five safe fields and retains stock policy and receipt values', async () => {
  for (const role of ['admin', 'manager', 'cashier', 'accountant', 'production']) {
    const f = fixture({ Settings: [settings] }, { ...manager, role });
    const response = await f.invoke(file, { action: 'get_operational_settings', role: 'admin', fields: ['unknown_future_secret'] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.settings, { shop_name: 'Odina', receipt_footer: 'Footer', thank_you_message: 'Rahmat', currency: 'UZS', allow_negative_stock: false });
    assert.ok(!JSON.stringify(response.data).includes('private'));
    assert.deepEqual(f.calls, []);
  }
});

test('business config requires an active authenticated account and never falls back to raw Settings', async () => {
  for (const actor of [{ ...manager, active: false }, { ...manager, shop_id: '' }, { ...manager, role: 'warehouse' }]) {
    const f = fixture({ Settings: [settings] }, actor);
    assert.equal((await f.invoke(file, { action: 'get_operational_settings' })).status, 403);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.client.auth.me = async () => null;
  assert.equal((await f.invoke(file, { action: 'get_operational_settings' })).status, 401);
  let rawReads = 0;
  const client = { entities: { Settings: { list: () => { rawReads++; } } }, functions: { invoke: async () => { throw Error('offline'); } } };
  await assert.rejects(loadOperationalSettings(client), /offline/);
  assert.equal(rawReads, 0);
});

test('missing operational settings preserve existing defaults; storage errors are reported', async () => {
  const f = fixture();
  const result = await f.invoke(file, { action: 'get_operational_settings' });
  assert.equal(result.data.settings.allow_negative_stock, true);
  assert.equal(result.data.settings.shop_name, 'Odina Shop');
  f.entities.Settings.list = async () => null;
  assert.equal((await f.invoke(file, { action: 'get_operational_settings' })).status, 502);
});

test('cashier receives safe business config but cannot perform manager catalog mutations', async () => {
  const f = fixture({}, { ...manager, role: 'cashier' });
  for (const action of ['set_product_price', 'set_category_visibility', 'set_product_category', 'saveConfig', 'set_settings']) {
    assert.equal((await f.invoke(file, { action, role: 'admin', shop_id: 'a', price: 1 })).status, 403);
  }
  assert.deepEqual(f.calls, []);
});

test('manager report history derives own shop and strips delivery configuration, addresses and locks', async () => {
  const own = { id: 'own', shop_id: 'a', business_date: '2026-10-25', total_revenue: 123, email_sent: true,
    email_recipient_snapshot: 'owner@example.test', delivery_lock_token: 'secret', delivery_error: 'private address', future_secret: 'hidden' };
  const f = fixture({ DailyShopReport: [own, { ...own, id: 'foreign', shop_id: 'b', total_revenue: 999 }] });
  const result = await f.invoke(exportFile, { action: 'history', shop_id: 'b', fields: ['email_recipient_snapshot'] });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.shop_id, 'a');
  assert.deepEqual(result.data.reports, [{ id: 'own', business_date: '2026-10-25', shop_id: 'a', total_revenue: 123, email_sent: true }]);
  assert.deepEqual(f.calls, []);
});

test('manager cannot read/write global export config, send reports or trigger reminders', async () => {
  for (const action of ['getConfig', 'saveConfig', 'send', 'autoSend', 'reminder']) {
    const f = fixture();
    f.entities.DailyExportConfig.filter = async () => { throw Error('must reject before config read'); };
    assert.equal((await f.invoke(exportFile, { action, role: 'admin', recipient_email: 'forged@example.test' })).status, 403);
    assert.deepEqual(f.calls, []);
  }
});

test('manager history client uses only the projected API and propagates failed loads', async () => {
  const calls = [];
  const client = { entities: { DailyShopReport: { list: () => { throw Error('raw report read forbidden'); } } },
    functions: { invoke: async (name, body) => { calls.push([name, body]); return { data: { reports: [{ id: 'own' }] } }; } } };
  assert.deepEqual(await loadExportHistory(client, 'manager'), [{ id: 'own' }]);
  assert.deepEqual(calls, [['daily-sales-export', { action: 'history' }]]);
  client.functions.invoke = async () => ({ data: { error: 'unavailable' } });
  await assert.rejects(loadExportHistory(client, 'manager'), /unavailable/);
  for (const page of ['POS', 'SalesHistory']) {
    const code = readFileSync(`src/pages/${page}.jsx`, 'utf8');
    assert.doesNotMatch(code, /entities\.Settings\./);
    assert.match(code, /loadOperationalSettings\(base44\)/);
  }
});

test('own-shop category visibility preserves global category and other-shop membership', async () => {
  const category = { id: 'cat', name: 'Shared category', active: true, hidden_shop_ids: ['b'] };
  const f = fixture({ Category: [category] });
  const body = { action: 'set_category_visibility', category_id: 'cat', hidden: true };
  assert.equal((await f.invoke(file, body)).status, 200);
  assert.deepEqual(f.db.Category[0].hidden_shop_ids, ['b', 'a']);
  assert.equal(f.db.Category[0].name, category.name); assert.equal(f.db.Category[0].active, true);
  assert.equal((await f.invoke(file, { ...body, hidden: false })).status, 200);
  assert.deepEqual(f.db.Category[0], category);
  const before = structuredClone(f.db);
  assert.equal((await f.invoke(file, { ...body, shop_id: 'b' })).status, 403);
  assert.equal((await f.invoke(file, { ...body, name: 'global rename' })).status, 400);
  assert.deepEqual(f.db, before);
});

test('category visibility conflict never overwrites another manager concurrent change', async () => {
  const f = fixture({ Category: [{ id: 'cat', active: true, hidden_shop_ids: ['b'] }] });
  const original = f.entities.Category.updateMany;
  f.entities.Category.updateMany = async (query, ops) => {
    f.db.Category[0].hidden_shop_ids.push('c');
    assert.equal(matches(f.db.Category[0], query), false);
    return original(query, ops);
  };
  assert.equal((await f.invoke(file, { action: 'set_category_visibility', category_id: 'cat', hidden: true })).status, 409);
  assert.deepEqual(f.db.Category[0].hidden_shop_ids, ['b', 'c']);
});

test('product category and price write only own shop keys and reject foreign-only products', async () => {
  const product = { id: 'p', active: true, price: 50, category_id: 'global', shop_category_ids: { b: 'other' }, shop_prices: { b: 99 } };
  const f = fixture({ Product: [product], Category: [{ id: 'new', active: true }] });
  const writes = [];
  f.entities.Product.updateMany = async (query, operation) => {
    writes.push(structuredClone(operation.$set));
    for (const [path, value] of Object.entries(operation.$set)) { const [field, shopId] = path.split('.'); (f.db.Product[0][field] ||= {})[shopId] = value; }
    return { success: true, updated: 1 };
  };
  assert.equal((await f.invoke(file, { action: 'set_product_category', product_id: 'p', category_id: 'new' })).status, 200);
  assert.equal((await f.invoke(file, { action: 'set_product_price', product_id: 'p', price: 80 })).status, 200);
  assert.deepEqual(writes, [{ 'shop_category_ids.a': 'new' }, { 'shop_prices.a': 80 }]);
  assert.equal(f.db.Product[0].category_id, 'global'); assert.equal(f.db.Product[0].price, 50);
  assert.equal(f.db.Product[0].shop_prices.b, 99); assert.equal(f.db.Product[0].shop_category_ids.b, 'other');
  f.db.Product[0].available_shop_ids = ['b'];
  for (const action of ['set_product_price', 'set_product_category']) {
    const fields = action === 'set_product_price' ? { price: 1 } : { category_id: 'new' };
    assert.equal((await f.invoke(file, { action, product_id: 'p', ...fields })).status, 403);
  }
  assert.equal(writes.length, 2);
});
