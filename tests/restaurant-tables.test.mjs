// Restaurant tables phase 1: memory-only backend tests. No live entities or sales.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(path, 'utf8');
const clone = (value) => value == null ? value : structuredClone(value);

function fixture() {
  const db = {
    Shop: [
      { id: 'central-shop', name: 'Odina Main', location_type: 'shop', active: true, allows_pos: true },
      { id: 'second-shop', name: 'Odina Second', location_type: 'shop', active: true, allows_pos: true, restaurant_table_count: 8 },
      { id: 'warehouse', name: 'Production', location_type: 'production', active: true, restaurant_table_count: 7 },
      { id: 'closed', name: 'Closed shop', location_type: 'shop', active: false },
    ],
    User: [
      { id: 'owner', role: 'admin', email: 'owner@example.test', active: true },
      { id: 'cashier-1', role: 'cashier', email: 'cashier@example.test', shop_id: 'central-shop', active: true },
      { id: 'cashier-2', role: 'cashier', email: 'cashier2@example.test', shop_id: 'second-shop', active: true },
      { id: 'manager', role: 'manager', active: true },
      { id: 'disabled', role: 'admin', active: false },
      { id: 'unassigned', role: 'cashier', active: true },
    ],
    ActionHistory: [],
  };
  let currentId = 'owner';
  let writes = 0;
  const entities = {
    User: { get: async (id) => clone(db.User.find((user) => user.id === id) || null) },
    Shop: {
      list: async () => clone(db.Shop),
      get: async (id) => clone(db.Shop.find((shop) => shop.id === id) || null),
      update: async (id, changes) => {
        const shop = db.Shop.find((row) => row.id === id);
        if (!shop) throw new Error('Shop not found');
        writes++;
        Object.assign(shop, clone(changes));
        return clone(shop);
      },
    },
    ActionHistory: { create: async (record) => { db.ActionHistory.push(clone(record)); return clone(record); } },
  };
  const client = {
    auth: { me: async () => {
      const user = db.User.find((row) => row.id === currentId);
      return user ? { id: user.id, email: user.email } : null;
    } },
    asServiceRole: { entities },
  };
  let handler;
  const source = read('base44/functions/restaurant-tables/entry.ts')
    .replace(/^import .*;\s*$/gm, '');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(code, {
    Deno: { serve: (callback) => { handler = callback; } },
    createClientFromRequest: () => client,
    resolveStoredAppUser: async (service, auth) => service.entities.User.get(auth.id),
    userRole: (user) => user?.role || '',
    userShopId: (user) => user?.shop_id || '',
    userLabel: (user) => user?.email || 'Xodim',
    Response, console, Date, Set, Number, String,
  });
  assert.equal(typeof handler, 'function');
  return {
    db,
    as: (id) => { currentId = id; },
    get writes() { return writes; },
    run: async (body) => {
      const response = await handler({ json: async () => body });
      return { status: response.status, data: await response.json() };
    },
  };
}

test('admin sees only active POS shops; no tables are created or implied when count is unset', async () => {
  const f = fixture();
  const { status, data } = await f.run({ action: 'status' });
  assert.equal(status, 200);
  assert.equal(data.can_manage, true);
  assert.equal(data.shops.length, 2);
  assert.equal(data.shops.find((shop) => shop.id === 'central-shop').table_count, 0);
  assert.equal(data.shops.find((shop) => shop.id === 'second-shop').table_count, 8);
  assert.equal(data.shops.find((shop) => shop.id === 'warehouse'), undefined);
  assert.equal(f.writes, 0);
});

test('cashiers are server-scoped to their own stored shop despite forged browser shop_id', async () => {
  const f = fixture();
  f.as('cashier-1');
  const result = await f.run({ action: 'status', shop_id: 'second-shop' });
  assert.equal(result.status, 200);
  assert.equal(result.data.can_manage, false);
  assert.equal(result.data.shops.length, 1);
  assert.equal(result.data.shops[0].id, 'central-shop');
  assert.equal((await f.run({ action: 'set_table_count', shop_id: 'central-shop', table_count: 10 })).status, 403);
  f.as('cashier-2');
  assert.equal((await f.run({ action: 'status' })).data.shops[0].id, 'second-shop');
  f.as('unassigned');
  assert.equal((await f.run({ action: 'status' })).status, 403);
  assert.equal(f.writes, 0);
});

test('only active admin can set each shop count, with strict validation and an audit record', async () => {
  const f = fixture();
  for (const table_count of [-1, 31, 5.5, '10', null, NaN]) {
    assert.equal((await f.run({ action: 'set_table_count', shop_id: 'central-shop', table_count })).status, 400);
  }
  assert.equal((await f.run({ action: 'set_table_count', shop_id: 'warehouse', table_count: 6 })).status, 404);
  assert.equal((await f.run({ action: 'set_table_count', shop_id: 'closed', table_count: 6 })).status, 404);
  assert.equal(f.writes, 0);
  const main = await f.run({ action: 'set_table_count', shop_id: 'central-shop', table_count: 6 });
  assert.equal(main.status, 200, JSON.stringify(main));
  assert.equal(main.data.shop.table_count, 6);
  const branch = await f.run({ action: 'set_table_count', shop_id: 'second-shop', table_count: 10 });
  assert.equal(branch.status, 200, JSON.stringify(branch));
  assert.equal(branch.data.shop.table_count, 10);
  assert.equal(f.db.Shop[0].restaurant_table_count, 6);
  assert.equal(f.db.Shop[1].restaurant_table_count, 10);
  assert.equal(f.db.ActionHistory.length, 2);
  assert.equal(f.db.ActionHistory[0].action, 'restaurant_table_count_changed');
  assert.equal(f.writes, 2);
  assert.equal((await f.run({ action: 'set_table_count', shop_id: 'central-shop', table_count: 6 })).data.unchanged, true);
  assert.equal(f.writes, 2);
  f.as('manager');
  assert.equal((await f.run({ action: 'status' })).status, 403);
  f.as('disabled');
  assert.equal((await f.run({ action: 'set_table_count', shop_id: 'central-shop', table_count: 0 })).status, 403);
  assert.equal(f.writes, 2);
});

test('integration is a separate page with role guard and no pretend sales, stock or orders', () => {
  const shop = JSON.parse(read('base44/entities/Shop.jsonc'));
  const fn = JSON.parse(read('base44/functions/restaurant-tables/function.jsonc'));
  const page = read('src/pages/RestaurantTables.jsx');
  const app = read('src/App.jsx');
  const menu = read('src/lib/pos.js');
  const backend = read('base44/functions/restaurant-tables/entry.ts');
  assert.equal(fn.is_public, false);
  assert.equal(shop.properties.restaurant_table_count.default, 0);
  assert.equal(shop.properties.restaurant_table_count.maximum, 30);
  assert.match(app, /path="\/tables" element=\{<RoleRoute pageKey="tables">/);
  assert.match(menu, /admin: \[[^\n]*'tables'/);
  assert.match(menu, /cashier: \[[^\n]*'tables'/);
  assert.doesNotMatch(menu, /warehouse: \[[^\n]*'tables'/);
  assert.match(page, /functions\.invoke\('restaurant-tables'/);
  assert.doesNotMatch(page, /entities\.(Shop|Sale|Shift|ProductStock|CustomerOrder)\.(create|update|delete)/);
  assert.doesNotMatch(backend, /entities\.(Sale|SaleItem|Payment|Shift|ProductStock|IngredientStock|CustomerOrder)\.(create|update|delete)/);
  assert.match(page, /TableFloorplan/);
  assert.match(page, /to‘lanmagan buyurtma yig‘ish va vaqtli bron keyingi bosqichda/i);
});
