// Restaurant tables phase 1: memory-only backend tests. No live entities or sales.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { buildTableLayout, entranceFromPoint, normalizeEntrance, nudgeEntrance, tablesOverlap, validateTableLayout } from '../src/lib/table-floorplan.js';

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
      updateMany: async (query, update) => {
        const shop = db.Shop.find((row) => row.id === query.id);
        if (!shop) return { success: true, updated: 0 };
        const expectedCount = query.restaurant_table_count;
        if (expectedCount !== undefined && shop.restaurant_table_count !== expectedCount) return { success: true, updated: 0 };
        const version = Number(shop.restaurant_table_layout_version || 0);
        const versionMatches = query.restaurant_table_layout_version !== undefined
          ? version === query.restaurant_table_layout_version
          : Array.isArray(query.$or) && query.$or.some((condition) => (
            condition.restaurant_table_layout_version === version
            || (condition.restaurant_table_layout_version?.$exists === false && shop.restaurant_table_layout_version === undefined)
          ));
        if (!versionMatches) return { success: true, updated: 0 };
        writes++;
        Object.assign(shop, clone(update.$set || {}));
        if (update.$inc?.restaurant_table_layout_version) {
          shop.restaurant_table_layout_version = version + Number(update.$inc.restaurant_table_layout_version);
        }
        return { success: true, updated: 1 };
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
  assert.deepEqual(data.shops.find((shop) => shop.id === 'second-shop').entrance, { side: 'top', offset: 500 });
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

test('admin can save a non-overlapping floor plan; stale versions and overlaps are rejected without overwrite', async () => {
  const f = fixture();
  const countResult = await f.run({ action: 'set_table_count', shop_id: 'central-shop', table_count: 4 });
  assert.equal(countResult.status, 200);
  assert.equal(countResult.data.shop.layout_version, 1);
  const layout = [
    { number: 1, x: 150, y: 200 },
    { number: 2, x: 350, y: 200 },
    { number: 3, x: 150, y: 500 },
    { number: 4, x: 350, y: 500 },
  ];
  const saved = await f.run({ action: 'set_table_layout', shop_id: 'central-shop', layout_version: 1, layout });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(saved.data.shop.layout_version, 2);
  assert.deepEqual(saved.data.shop.layout, layout.map((point) => ({ ...point, size: 100 })));
  const writesAfterSave = f.writes;
  const stale = await f.run({ action: 'set_table_layout', shop_id: 'central-shop', layout_version: 1, layout });
  assert.equal(stale.status, 409);
  assert.equal(f.writes, writesAfterSave);
  const overlap = layout.map((point) => ({ ...point }));
  overlap[1] = { number: 2, x: 200, y: 240 };
  const rejected = await f.run({ action: 'set_table_layout', shop_id: 'central-shop', layout_version: 2, layout: overlap });
  assert.equal(rejected.status, 400);
  assert.equal(f.writes, writesAfterSave);
  f.as('cashier-1');
  assert.equal((await f.run({ action: 'set_table_layout', shop_id: 'central-shop', layout_version: 2, layout })).status, 403);
  assert.equal(f.writes, writesAfterSave);
});

test('each table has its own size, old layouts remain 100%, and larger tables require more space', () => {
  const legacy = [
    { number: 1, x: 250, y: 300 },
    { number: 2, x: 385, y: 300 },
  ];
  assert.deepEqual(buildTableLayout(2, legacy), legacy.map((point) => ({ ...point, size: 100 })));
  assert.equal(validateTableLayout(2, legacy), true);
  assert.equal(tablesOverlap(legacy[0], legacy[1]), false);
  const bigger = [{ ...legacy[0], size: 140 }, { ...legacy[1], size: 100 }];
  assert.equal(tablesOverlap(bigger[0], bigger[1]), true);
  assert.equal(validateTableLayout(2, bigger), false);
  assert.equal(validateTableLayout(2, [{ ...bigger[0], x: 84 }, { ...bigger[1], x: 385 }]), true);
  assert.equal(validateTableLayout(2, [{ ...bigger[0], x: 60 }, bigger[1]]), false);
  assert.equal(validateTableLayout(2, [{ ...legacy[0], size: 150 }, legacy[1]]), false);
  assert.equal(validateTableLayout(2, [{ ...legacy[0], size: 95 }, legacy[1]]), false);
});

test('only admin can save independent sizes, old clients preserve sizes, and bad sizes never write', async () => {
  const f = fixture();
  const legacy = [
    { number: 1, x: 200, y: 250 }, { number: 2, x: 450, y: 250 },
    { number: 3, x: 700, y: 250 }, { number: 4, x: 200, y: 600 },
    { number: 5, x: 450, y: 600 }, { number: 6, x: 700, y: 600 },
    { number: 7, x: 200, y: 820 }, { number: 8, x: 700, y: 820 },
  ];
  const invalidSizes = [70, 95, 150, 100.5, '120', null];
  for (const size of invalidSizes) {
    const response = await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0,
      layout: [{ ...legacy[0], size }, ...legacy.slice(1)] });
    assert.equal(response.status, 400);
  }
  assert.equal(f.writes, 0);
  const sized = legacy.map((point, index) => ({ ...point, size: index === 0 ? 140 : index === 1 ? 80 : 100 }));
  const saved = await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0, layout: sized });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(saved.data.shop.layout[0].size, 140);
  assert.equal(saved.data.shop.layout[1].size, 80);
  assert.equal(saved.data.shop.layout[2].size, 100);
  const originalWrites = f.writes;
  assert.equal((await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0, layout: sized })).status, 409);
  f.as('cashier-2');
  assert.equal((await f.run({ action: 'status' })).data.shops[0].layout[0].size, 140);
  assert.equal((await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 1, layout: sized })).status, 403);
  assert.equal(f.writes, originalWrites);
  f.as('owner');
  const oldClient = await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 1, layout: legacy });
  assert.equal(oldClient.status, 200, JSON.stringify(oldClient));
  assert.equal(oldClient.data.shop.layout[0].size, 140);
  assert.equal(oldClient.data.shop.layout[1].size, 80);
  assert.equal((await f.run({ action: 'status' })).data.shops.find((shop) => shop.id === 'central-shop').table_count, 0);
  assert.equal(f.db.ActionHistory.filter((row) => row.action === 'restaurant_table_layout_changed').length, 2);
});

test('floor plan and POS integration preserve server validation and immutable sale table snapshot', () => {
  const floorplan = read('src/components/tables/TableFloorplan.jsx');
  const layoutLogic = read('src/lib/table-floorplan.js');
  const pos = read('src/pages/POS.jsx');
  const saleBackend = read('base44/functions/complete-sale/entry.ts');
  const saleSchema = JSON.parse(read('base44/entities/Sale.jsonc'));
  const receipt = read('src/components/pos/Receipt.jsx');
  const history = read('src/pages/SalesHistory.jsx');
  assert.match(floorplan, /onPointerMove/);
  assert.match(floorplan, /Joylashuvni saqlash/);
  assert.match(layoutLogic, /tablesOverlap/);
  assert.match(floorplan, /Stol o‘lchami/);
  assert.match(floorplan, /resizeTable\(chosen\.number/);
  assert.match(floorplan, /width: `\$\{Math\.round\(68 \* tableSize\(point\) \/ 100\)\}px`/);
  assert.equal(JSON.parse(read('base44/entities/Shop.jsonc')).properties.restaurant_table_layout.items.properties.size.maximum, 140);
  assert.match(pos, /table_shop/);
  assert.match(pos, /table_number/);
  assert.match(pos, /selectedTable \? \{ table_shop_id: selectedTable\.shopId, table_number: selectedTable\.number \}/);
  assert.match(saleBackend, /requestedTableShopId !== shift\.shop_id/);
  assert.match(saleBackend, /requestedTableNumber > receiptShop\.restaurant_table_count/);
  assert.match(saleBackend, /table_number_snapshot: requestedTableNumber/);
  assert.equal(saleSchema.properties.table_number_snapshot.minimum, 1);
  assert.equal(saleSchema.properties.table_number_snapshot.maximum, 30);
  assert.match(receipt, /Stol:/);
  assert.match(history, /table_number_snapshot/);
});

test('entrance can snap to all four walls and be nudged without leaving the wall', () => {
  assert.deepEqual(normalizeEntrance(null), { side: 'top', offset: 500 });
  assert.deepEqual(normalizeEntrance({ side: 'left', offset: 250 }), { side: 'left', offset: 250 });
  assert.deepEqual(normalizeEntrance({ side: 'up', offset: 500 }), { side: 'top', offset: 500 });
  assert.deepEqual(entranceFromPoint(560, 12), { side: 'top', offset: 560 });
  assert.deepEqual(entranceFromPoint(995, 290), { side: 'right', offset: 290 });
  assert.deepEqual(entranceFromPoint(360, 992), { side: 'bottom', offset: 360 });
  assert.deepEqual(entranceFromPoint(9, 680), { side: 'left', offset: 680 });
  assert.deepEqual(entranceFromPoint(-30, 200), { side: 'left', offset: 200 });
  assert.deepEqual(nudgeEntrance({ side: 'top', offset: 840 }, 'ArrowRight'), { side: 'top', offset: 850 });
  assert.deepEqual(nudgeEntrance({ side: 'left', offset: 250 }, 'ArrowDown'), { side: 'left', offset: 270 });
});

test('entrance is a real draggable marker, only admin can edit, and tables still open the POS', () => {
  const floorplan = read('src/components/tables/TableFloorplan.jsx');
  const page = read('src/pages/RestaurantTables.jsx');
  assert.match(floorplan, /onPointerDown=\{\(event\) => startDrag\(event, 'entrance'\)\}/);
  assert.match(floorplan, /onPointerMove=\{\(event\) => onMove\(event, 'entrance'\)\}/);
  assert.match(floorplan, /setEntrance\(entranceFromPoint/);
  assert.match(floorplan, /id="entrance-position" type="range"/);
  assert.match(floorplan, /Eshikning devordagi joyi/);
  assert.match(floorplan, /disabled=\{!editing \|\| saving\}/);
  assert.match(floorplan, /action: 'set_table_layout'/);
  assert.match(floorplan, /layout_version: shop\.layout_version, layout, entrance/);
  assert.match(floorplan, /if \(editing\) setSelectedNumber\(point\.number\); else onOpen\(shop\.id, point\.number\)/);
  assert.ok(page.indexOf('tableCount > 0 && <TableFloorplan') < page.indexOf('tracking-wider text-brand-ink uppercase">Do‘kon stollari'));
  assert.doesNotMatch(floorplan, /pointer-events-none absolute left-1\/2 top-0/);
});

test('only admin saves entrance per shop with layout version checks and strict server validation', async () => {
  const f = fixture();
  const existing = await f.run({ action: 'status' });
  const original = existing.data.shops.find((shop) => shop.id === 'second-shop');
  const layout = [
    { number: 1, x: 200, y: 200 }, { number: 2, x: 400, y: 200 },
    { number: 3, x: 600, y: 200 }, { number: 4, x: 800, y: 200 },
    { number: 5, x: 200, y: 500 }, { number: 6, x: 400, y: 500 },
    { number: 7, x: 600, y: 500 }, { number: 8, x: 800, y: 500 },
  ];
  const denied = await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0, layout, entrance: { side: 'ceiling', offset: 500 } });
  assert.equal(denied.status, 400);
  const badFraction = await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0, layout, entrance: { side: 'top', offset: 200.5 } });
  assert.equal(badFraction.status, 400);
  const badRange = await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0, layout, entrance: { side: 'right', offset: 0 } });
  assert.equal(badRange.status, 400);
  assert.equal(f.writes, 0);
  const saved = await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0, layout, entrance: { side: 'left', offset: 340 } });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(saved.data.shop.entrance, { side: 'left', offset: 340 });
  assert.deepEqual(f.db.Shop[1].restaurant_entrance, { side: 'left', offset: 340 });
  const writeCount = f.writes;
  assert.equal((await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0, layout, entrance: { side: 'bottom', offset: 420 } })).status, 409);
  assert.equal(f.writes, writeCount);
  f.as('cashier-2');
  assert.deepEqual((await f.run({ action: 'status' })).data.shops[0].entrance, { side: 'left', offset: 340 });
  assert.equal((await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 1, layout, entrance: { side: 'bottom', offset: 420 } })).status, 403);
  assert.equal(f.writes, writeCount);
  f.as('owner');
  const changedCount = await f.run({ action: 'set_table_count', shop_id: 'second-shop', table_count: 7 });
  assert.equal(changedCount.status, 200);
  assert.deepEqual(changedCount.data.shop.entrance, { side: 'left', offset: 340 });
  assert.deepEqual(original.entrance, { side: 'top', offset: 500 });
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
