// Entirely offline: real handlers, in-memory entities, no credentials or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { loadCakeBalancesWithServer, cakeStockInfo } from '../src/lib/cake-stock-shelf.js';

const manager = { id: 'manager', role: 'manager', shop_id: 'a', active: true, email: 'manager@example.test' };
const shop = { id: 'a', name: 'A', active: true, location_type: 'shop' };
const cashier = { id: 'staff', role: 'cashier', shop_id: 'a', active: true, email: 'staff@example.test' };
function fixture(actor = manager, extra = {}) {
  const f = memoryBackend({ User: [actor, cashier], Shop: [shop, { ...shop, id: 'b' }], ...extra });
  f.client.users = { inviteUser: async () => { f.calls.push(['mock-invitation', 'send']); } };
  f.denoCall = async (name, body) => {
    let handler;
    f.load(`base44/functions/${name}/entry.ts`, { Deno: { serve: fn => { handler = fn; } } });
    const response = await handler({ json: async () => body });
    return { status: response.status, data: await response.json() };
  };
  return f;
}
const inviteBody = { action: 'invite', email: cashier.email, role: 'cashier', shop_id: 'b' };

test('stock failures and malformed backend responses never become successful empty balances', async () => {
  const empty = { filter: async () => [] };
  for (const invoke of [
    async () => { throw Object.assign(new Error('request failed'), { response: { data: { error: 'backend not deployed' } } }); },
    async () => ({ status: 403, data: { error: 'assigned shop denied' } }),
    async () => ({ data: { error: 'unknown action' } }),
    async () => ({ data: {} }),
  ]) await assert.rejects(loadCakeBalancesWithServer(empty, 'a', 'product', invoke));
  await assert.rejects(loadCakeBalancesWithServer(empty, 'a', 'product', async () => {
    throw Object.assign(new Error('request failed'), { response: { data: { error: 'backend not deployed' } } });
  }), /backend not deployed/);
});

test('manager uses scoped server balances even if direct RLS returns a partial nonempty list', async () => {
  const rows = [{ id: 'one', product_id: 'cake', location_id: 'a', quantity: 7, unit: 'piece' }];
  const direct = { filter: async () => { throw new Error('manager must use server'); } };
  const loaded = await loadCakeBalancesWithServer(direct, 'a', 'product', async (name, body) => {
    assert.equal(name, 'warehouse-stock'); assert.equal(body.location_id, 'a');
    return { data: { rows } };
  }, { requireServer: true });
  assert.equal(cakeStockInfo(loaded, 'cake').quantity, 7);
  await assert.rejects(loadCakeBalancesWithServer(direct, 'a', 'product', null, { requireServer: true }));
  assert.equal(cakeStockInfo([], 'cake').status, 'missing');
});

test('warehouse read-only action enforces stored manager scope, including nested account fields', async () => {
  for (const actor of [manager, { id: 'manager', role: 'user', data: { role: 'manager', shop_id: 'a', active: true } }]) {
    const f = fixture(actor, { ProductStock: [{ id: 's', location_id: 'a', product_id: 'cake', quantity: 9 }, { id: 'foreign', location_id: 'b', quantity: 99 }] });
    const result = await f.invoke('base44/functions/warehouse-stock/entry.ts', { action: 'list_balances', location_id: 'a', item_kind: 'product' });
    assert.equal(result.status, 200); assert.equal(result.data.rows.length, 1); assert.equal(result.data.rows[0].quantity, 9);
    assert.equal(result.data.stock_source, 'ProductStock'); assert.equal(result.data.location_id, 'a');
    assert.equal(result.data.reader_version, '2026-10-25-manager-stock-1');
    assert.equal((await f.invoke('base44/functions/warehouse-stock/entry.ts', { action: 'list_balances', location_id: 'b', item_kind: 'product' })).status, 403);
    assert.deepEqual(f.calls, []);
  }
});

test('inactive, unassigned and production-assigned managers cannot read or mutate warehouse stock', async () => {
  for (const [actor, shops] of [[{ ...manager, active: false }, [shop]], [{ ...manager, shop_id: '' }, [shop]], [manager, [{ ...shop, location_type: 'production' }]]]) {
    const f = fixture(actor, { Shop: shops });
    for (const action of ['list_balances', 'adjust_stock']) {
      assert.equal((await f.invoke('base44/functions/warehouse-stock/entry.ts', { action, location_id: 'a', item_kind: 'product' })).status, 403);
    }
    assert.deepEqual(f.calls, []);
  }
});

test('warehouse malformed storage response produces 502 and never a zero balance', async () => {
  const f = fixture(); f.entities.ProductStock.filter = async () => ({});
  assert.equal((await f.invoke('base44/functions/warehouse-stock/entry.ts', { action: 'list_balances', location_id: 'a', item_kind: 'product' })).status, 502);
  assert.deepEqual(f.calls, []);
});

test('manager cannot invite an existing admin, protected role, foreign or disabled staff account', async () => {
  for (const target of [{ ...cashier, role: 'admin' }, { ...cashier, role: 'manager' }, { ...cashier, role: 'accountant' }, { ...cashier, shop_id: 'b' }, { ...cashier, active: false }]) {
    const f = fixture(manager, { User: [manager, target] });
    assert.equal((await f.denoCall('staff-invite', inviteBody)).status, 403);
    assert.deepEqual(f.calls, []);
  }
});

test('manager cannot replace a pending foreign-shop or privileged invitation', async () => {
  for (const invite of [{ shop_id: 'b', desired_role: 'cashier' }, { shop_id: 'a', desired_role: 'admin' }]) {
    const f = fixture(manager, { PendingStaffInvite: [{ id: 'pending', email: cashier.email, status: 'pending', ...invite }] });
    assert.equal((await f.denoCall('staff-invite', inviteBody)).status, 403);
    assert.deepEqual(f.calls, []);
  }
});

test('permitted manager invitation forces own shop and sends only the memory mock', async () => {
  const f = fixture();
  assert.equal((await f.denoCall('staff-invite', inviteBody)).status, 200);
  assert.equal(f.db.PendingStaffInvite[0].shop_id, 'a');
  assert.equal(f.calls.filter(([name]) => name === 'mock-invitation').length, 1);
});

test('claim rejects manager scope changes, role escalation and revoked inviter before writes', async () => {
  const pending = { id: 'pending', email: cashier.email, status: 'pending', invited_by_id: manager.id, shop_id: 'a', desired_role: 'cashier' };
  for (const [target, inviter, invite] of [
    [{ ...cashier, role: 'admin' }, manager, pending],
    [{ ...cashier, shop_id: 'b' }, manager, pending],
    [cashier, { ...manager, shop_id: 'b' }, pending],
    [cashier, { ...manager, active: false }, pending],
    [cashier, manager, { ...pending, desired_role: 'manager' }],
  ]) {
    const f = fixture(target, { User: [target, inviter], PendingStaffInvite: [invite] });
    assert.equal((await f.denoCall('staff-invite', { action: 'claim' })).status, 403);
    assert.deepEqual(f.calls, []);
  }
});

test('new unassigned invitee can claim own-shop cashier invitation', async () => {
  const target = { ...cashier, role: 'user', shop_id: '' };
  const f = fixture(target, { User: [target, manager], PendingStaffInvite: [{ id: 'pending', email: target.email, status: 'pending', invited_by_id: manager.id, shop_id: 'a', desired_role: 'cashier' }] });
  assert.equal((await f.denoCall('staff-invite', { action: 'claim' })).status, 200);
  assert.equal(f.db.User[0].shop_id, 'a'); assert.equal(f.db.User[0].role, 'cashier');
});

test('manager staff status does not read owner security or global audit data', async () => {
  const f = fixture(manager, { User: [manager, cashier, { ...cashier, id: 'foreign', shop_id: 'b' }, { ...cashier, id: 'admin', role: 'admin' }] });
  f.entities.SecuritySettings.filter = async () => { throw new Error('PIN access forbidden'); };
  f.entities.ActionHistory.list = async () => { throw new Error('global audit access forbidden'); };
  const result = await f.denoCall('security-admin', { action: 'status' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.users.map(row => row.id).sort(), ['manager', 'staff']);
  assert.equal(result.data.can_manage_admins, false); assert.deepEqual(result.data.audit, []);
});

test('manager cannot promote, move or modify a protected/foreign user via direct API', async () => {
  for (const [target, fields] of [[cashier, { role: 'admin' }], [cashier, { shop_id: 'b' }], [{ ...cashier, shop_id: 'b' }, { active: false }], [{ ...cashier, role: 'admin' }, { active: false }]]) {
    const f = fixture(manager, { User: [manager, target] });
    assert.equal((await f.denoCall('security-admin', { action: 'update_user_access', target_user_id: target.id, ...fields })).status, 403);
    assert.deepEqual(f.calls, []);
  }
});

test('profit report rejects non-object JSON instead of losing the forced manager shop filter', async () => {
  for (const body of [null, false, 1, 'report', []]) {
    const f = fixture();
    assert.equal((await f.invoke('base44/functions/profit-report/entry.ts', body)).status, 400);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  const result = await f.invoke('base44/functions/profit-report/entry.ts', { shop_id: 'b', date_from: '2026-09-27', date_to: '2026-09-27' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.filters.shop_id, 'a');
  assert.deepEqual(f.calls, []);
});

test('manager audit response forces own shop despite a forged foreign shop filter', async () => {
  const f = fixture(manager, { Sale: [
    { id: 'own', shop_id: 'a', user_id: manager.id, total: 100, status: 'completed', created_date: '2026-09-27T07:00:00Z' },
    { id: 'foreign-sale', shop_id: 'b', total: 999, status: 'completed', created_date: '2026-09-27T07:00:00Z' },
  ] });
  const result = await f.invoke('base44/functions/audit-report/entry.ts', { action: 'list', shop_id: 'b' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.ok(!JSON.stringify(result.data).includes('foreign-sale'));
  assert.deepEqual(result.data.shops.map(row => row.id), ['a']);
  assert.deepEqual(f.calls, []);
});

test('Budget API rejects manager reads and writes before any business operation', async () => {
  for (const action of ['summary', 'manual_adjustment', 'pay_supplier']) {
    const f = fixture();
    const result = await f.invoke('base44/functions/budget-ledger/entry.ts', { action, amount: 1000, owner_pin: '1234' });
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.deepEqual(f.calls, []);
  }
});

test('active manager adjusts own product stock while foreign stock and history stay untouched', async () => {
  const f = fixture(manager, { Product: [{ id: 'cake', name: 'Cake', active: true, production_unit: 'piece' }],
    ProductStock: [{ id: 'own-stock', product_id: 'cake', location_id: 'a', unit: 'piece', quantity: 5 },
      { id: 'foreign-stock', product_id: 'cake', location_id: 'b', unit: 'piece', quantity: 99 }] });
  const body = { action: 'adjust_stock', location_id: 'a', item_kind: 'product', item_id: 'cake',
    movement_type: 'adjustment', reason: 'Offline manager scope check', quantity_change: 2, expected_quantity: 5 };
  assert.equal((await f.invoke('base44/functions/warehouse-stock/entry.ts', body)).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 7); assert.equal(f.db.ProductStock[1].quantity, 99);
  assert.equal(f.db.StockMovement[0].location_id, 'a');
  const before = structuredClone(f.db), callCount = f.calls.length;
  assert.equal((await f.invoke('base44/functions/warehouse-stock/entry.ts', { ...body, location_id: 'b' })).status, 403);
  assert.deepEqual(f.db, before); assert.equal(f.calls.length, callCount);
});

test('manager can change own cashier access and name without modifying foreign staff', async () => {
  for (const fields of [{ action: 'update_user_access', role: 'warehouse' }, { action: 'update_user_access', active: false }, { action: 'update_user_name', full_name: 'Own staff name' }]) {
    const target = { id: 'staff', role: 'cashier', shop_id: 'a', active: true, full_name: 'Own staff' };
    const foreign = { ...target, id: 'foreign', shop_id: 'b' };
    const f = fixture(manager, { User: [manager, target, foreign] });
    const result = await f.denoCall('security-admin', { target_user_id: target.id, ...fields });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(f.db.User[2], foreign);
    assert.equal(f.db.User[1].shop_id, 'a');
    if ('role' in fields) assert.equal(f.db.User[1].role, 'warehouse');
    if ('active' in fields) assert.equal(f.db.User[1].active, false);
    if ('full_name' in fields) assert.equal(f.db.User[1].display_name, 'Own staff name');
  }
});
