// Restaurant tables phase 1: memory-only backend tests. No live entities or sales.
import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import * as lucideIcons from 'lucide-react';
import * as floorGeometry from '../src/lib/table-floorplan.js';
import { buildTableLayout, entranceFromPoint, normalizeEntrance, normalizeOutdoorPolygon, nudgeEntrance, pointInOutdoorPolygon, tablesOverlap, validOutdoorPolygon, validateTableLayout } from '../src/lib/table-floorplan.js';

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
      { id: 'cashier-3', role: 'cashier', email: 'cashier3@example.test', shop_id: 'second-shop', active: true },
      { id: 'manager', role: 'manager', active: true },
      { id: 'disabled', role: 'admin', active: false },
      { id: 'unassigned', role: 'cashier', active: true },
    ],
    Shift: [
      { id: 'shift-main', user_id: 'cashier-1', shop_id: 'central-shop', status: 'open' },
      { id: 'shift-second', user_id: 'cashier-2', shop_id: 'second-shop', status: 'open' },
      { id: 'shift-other', user_id: 'cashier-3', shop_id: 'second-shop', status: 'open' },
    ],
    Product: [
      { id: 'cake', name: 'Tort', price: 45000, active: true, image_url: 'cake.png', track_stock: true },
      { id: 'coffee', name: 'Kofe', price: 20000, active: true, track_stock: false },
    ],
    Sale: [],
    ActionHistory: [],
  }; 
  let currentId = 'owner';
  let writes = 0;
  const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
      if ('$in' in expected) return expected.$in.includes(actual ?? null);
      if ('$ne' in expected) return actual !== expected.$ne;
    }
    return actual === expected;
  };
  const matches = (row, query) => (!query.$or || query.$or.some((branch) => matches(row, branch)))
    && Object.entries(query).filter(([key]) => key !== '$or')
      .every(([key, expected]) => matchesValue(row[key], expected));
  const entities = {
    User: { get: async (id) => clone(db.User.find((user) => user.id === id) || null) },
    Shift: {
      get: async (id) => clone(db.Shift.find((shift) => shift.id === id) || null),
      filter: async (query) => clone(db.Shift.filter((shift) => matches(shift, query))),
    },
    Product: { get: async (id) => clone(db.Product.find((product) => product.id === id) || null) },
    Sale: { filter: async (query) => clone(db.Sale.filter((sale) => Object.entries(query).every(([key, value]) => sale[key] === value))) },
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
        if (!shop || !matches(shop, query)) return { success: true, updated: 0 };
        writes++;
        Object.assign(shop, clone(update.$set || {}));
        for (const [field, amount] of Object.entries(update.$inc || {})) {
          shop[field] = Number(shop[field] || 0) + Number(amount);
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
  const helperSource = read('base44/shared/shift-close-helpers.ts')
    .slice(read('base44/shared/shift-close-helpers.ts').indexOf('const serviceTicketVersion = '),
      read('base44/shared/shift-close-helpers.ts').indexOf('export const money = '))
    .replace(/export /g, '');
  const code = ts.transpileModule(helperSource + '\n' + source,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(code, {
    Deno: { serve: (callback) => { handler = callback; } },
    createClientFromRequest: () => client,
    resolveStoredAppUser: async (service, auth) => service.entities.User.get(auth.id),
    userRole: (user) => user?.role || '',
    userShopId: (user) => user?.shop_id || '',
    userLabel: (user) => user?.email || 'Xodim',
    Response, console, Date, Set, Number, String, crypto: webcrypto,
    httpError: (message, status) => Object.assign(new Error(message), { status }),
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
  assert.equal(tablesOverlap({ number: 1, x: 250, y: 300, size: 140 }, { number: 2, x: 250, y: 490, size: 100 }), true);
  assert.equal(validateTableLayout(1, [{ number: 1, x: 60, y: 70, size: 80 }]), true);
  assert.equal(validateTableLayout(1, [{ number: 1, x: 200, y: 98, size: 140 }]), false);
  assert.equal(validateTableLayout(1, [{ number: 1, x: 200, y: 126, size: 140 }]), true);
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

test('unpaid orders survive navigation, preserve prices, and stay in their authenticated shop', async () => {
  const f = fixture();
  f.as('cashier-2');
  const first = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 2,
    shift_id: 'shift-second', expected_revision: 0,
    items: [{ product_id: 'cake', quantity: 2, price: 1 }, { product_id: 'coffee', quantity: 1 }] });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.data.order.total, 110000);
  assert.equal(first.data.order.revision, 1);
  assert.equal(first.data.order.ticket_number, 1);
  assert.equal(first.data.order.items[0].price, 45000);
  assert.equal((await f.run({ action: 'status' })).data.shops[0].orders[0].state, 'occupied');
  assert.equal((await f.run({ action: 'get_table_order', shop_id: 'second-shop', table_number: 2 })).data.order.items.length, 2);
  assert.equal(f.db.Sale.length, 0); // Saving an order must never create a sale.
  f.db.Product[0].price = 60000;
  const savedAgain = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 2,
    shift_id: 'shift-second', expected_revision: 1,
    items: [{ product_id: 'cake', quantity: 3 }, { product_id: 'coffee', quantity: 1 }] });
  assert.equal(savedAgain.status, 200, JSON.stringify(savedAgain));
  assert.equal(savedAgain.data.order.items[0].price, 45000);
  assert.equal(savedAgain.data.order.total, 155000);
  assert.equal(savedAgain.data.order.ticket_number, 1, 'Editing a table must keep its original service ticket number');
  f.as('cashier-3');
  assert.equal((await f.run({ action: 'get_table_order', shop_id: 'second-shop', table_number: 2 })).data.order.revision, 2);
  const stale = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 2,
    shift_id: 'shift-other', expected_revision: 1, items: [{ product_id: 'cake', quantity: 1 }] });
  assert.equal(stale.status, 409);
  f.as('cashier-1');
  assert.equal((await f.run({ action: 'get_table_order', shop_id: 'second-shop', table_number: 2 })).status, 403);
  assert.equal((await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 2,
    shift_id: 'shift-main', expected_revision: 2, items: [{ product_id: 'cake', quantity: 1 }] })).status, 403);
  f.as('owner');
  assert.equal((await f.run({ action: 'set_table_count', shop_id: 'second-shop', table_count: 1 })).status, 409);
  assert.equal(f.db.Shop[1].restaurant_table_orders.length, 1);
  assert.equal(f.db.Sale.length, 0);
});

test('all cashiers at one shop share service order numbering while another shop starts independently', async () => {
  const f = fixture();
  f.as('cashier-2');
  const first = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 1,
    shift_id: 'shift-second', expected_revision: 0, items: [{ product_id: 'cake', quantity: 1 }] });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.data.order.ticket_number, 1);
  f.as('cashier-3');
  const second = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 2,
    shift_id: 'shift-other', expected_revision: 0, items: [{ product_id: 'coffee', quantity: 1 }] });
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.equal(second.data.order.ticket_number, 2);
  assert.equal(first.data.order.number, 1);
  assert.equal(second.data.order.number, 2);
  assert.equal(f.db.Shop[1].service_ticket_counter, 2);
  f.as('owner');
  const enabled = await f.run({ action: 'set_table_count', shop_id: 'central-shop', table_count: 3 });
  assert.equal(enabled.status, 200);
  f.as('cashier-1');
  const central = await f.run({ action: 'save_table_order', shop_id: 'central-shop', table_number: 1,
    shift_id: 'shift-main', expected_revision: 0, items: [{ product_id: 'cake', quantity: 1 }] });
  assert.equal(central.status, 200, JSON.stringify(central));
  assert.equal(central.data.order.ticket_number, 1);
  assert.equal(f.db.Shop[0].service_ticket_counter, 1);
  assert.equal(f.db.Sale.length, 0, 'Kitchen tickets do not create sales before payment');
});

test('temporary table groups share one order, reject two occupied tables and clear after payment', async () => {
  const f = fixture();
  f.as('cashier-2');

  const saved = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 2,
    shift_id: 'shift-second', expected_revision: 0, items: [{ product_id: 'cake', quantity: 1 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved));

  const grouped = await f.run({ action: 'group_tables', shop_id: 'second-shop',
    primary_table_number: 1, secondary_table_number: 2 });
  assert.equal(grouped.status, 200, JSON.stringify(grouped));
  assert.deepEqual(grouped.data.group.numbers, [1, 2]);
  assert.equal(f.db.Shop[1].restaurant_table_orders[0].number, 1);
  assert.equal(f.db.Shop[1].restaurant_table_orders[0].revision, 2);

  const openedFromSecond = await f.run({ action: 'get_table_order', shop_id: 'second-shop', table_number: 2 });
  assert.equal(openedFromSecond.status, 200);
  assert.equal(openedFromSecond.data.order.number, 1);
  assert.equal(openedFromSecond.data.primary_table_number, 1);
  assert.deepEqual(openedFromSecond.data.group.numbers, [1, 2]);

  const status = await f.run({ action: 'status' });
  assert.deepEqual(status.data.shops[0].orders.map((order) => order.number), [1, 2]);
  assert.equal((await f.run({ action: 'ungroup_tables', shop_id: 'second-shop',
    primary_table_number: 2 })).status, 409);

  const other = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 3,
    shift_id: 'shift-second', expected_revision: 0, items: [{ product_id: 'coffee', quantity: 1 }] });
  assert.equal(other.status, 200);
  assert.equal((await f.run({ action: 'group_tables', shop_id: 'second-shop',
    primary_table_number: 1, secondary_table_number: 3 })).status, 409);

  f.db.Shop[1].restaurant_table_orders = f.db.Shop[1].restaurant_table_orders.filter((order) => order.number !== 3);
  const order = f.db.Shop[1].restaurant_table_orders[0];
  order.state = 'paying';
  order.checkout_key = 'group-checkout-123456789';
  f.db.Sale.push({ id: 'group-sale', table_order_id_snapshot: order.id,
    idempotency_key: order.checkout_key, status: 'completed',
    shop_id: 'second-shop', table_number_snapshot: 1 });

  const reconciled = await f.run({ action: 'reconcile_table_payment',
    shop_id: 'second-shop', table_number: 2 });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
  assert.equal(f.db.Shop[1].restaurant_table_orders.length, 0);
  assert.equal(f.db.Shop[1].restaurant_table_groups.length, 0);
});

test('simultaneous saves on the same table cannot silently overwrite one another', async () => {
  const f = fixture();
  f.as('cashier-2');
  const request = (product_id) => ({ action: 'save_table_order', shop_id: 'second-shop',
    table_number: 3, shift_id: 'shift-second', expected_revision: 0,
    items: [{ product_id, quantity: 1 }] });
  const results = await Promise.all([f.run(request('cake')), f.run(request('coffee'))]);
  assert.deepEqual(results.map((row) => row.status).sort(), [200, 409]);
  assert.equal(f.db.Shop[1].restaurant_table_orders.length, 1);
  assert.equal(f.db.Shop[1].restaurant_table_orders[0].revision, 1);
  assert.equal(f.db.Sale.length, 0);
});

test('uncertain payment is locked and never freed without a matching completed sale', async () => {
  const f = fixture();
  f.as('cashier-2');
  const saved = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 4,
    shift_id: 'shift-second', expected_revision: 0, items: [{ product_id: 'cake', quantity: 1 }] });
  assert.equal(saved.status, 200);
  const order = f.db.Shop[1].restaurant_table_orders[0];
  order.state = 'paying';
  order.checkout_key = 'secure-checkout-123456789';
  assert.equal((await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 4,
    shift_id: 'shift-second', expected_revision: 1, items: [{ product_id: 'cake', quantity: 2 }] })).status, 409);
  assert.equal((await f.run({ action: 'reconcile_table_payment', shop_id: 'second-shop', table_number: 4 })).status, 409);
  assert.equal(f.db.Shop[1].restaurant_table_orders.length, 1);
  f.db.Sale.push({ id: 'real-sale-mock', table_order_id_snapshot: order.id,
    idempotency_key: order.checkout_key, status: 'completed', shop_id: 'second-shop', table_number_snapshot: 4 });
  const reconciled = await f.run({ action: 'reconcile_table_payment', shop_id: 'second-shop', table_number: 4 });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
  assert.equal(f.db.Shop[1].restaurant_table_orders.length, 0);
  assert.equal((await f.run({ action: 'status' })).data.shops[0].orders.length, 0);
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
  assert.match(pos, /table_shop_id: selectedTable\.shopId, table_number: selectedTable\.number/);
  assert.match(pos, /table_order_id: tableOrder\?\.id, table_order_revision: tableOrder\?\.revision/);
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
  assert.match(floorplan, /disabled=\{!editing \|\| saving \|\| zoneMode\}/);
  assert.match(floorplan, /action: 'set_table_layout'/);
  assert.match(floorplan, /layout_version: shop\.layout_version, layout, entrance/);
  assert.match(floorplan, /if \(editing\)\s*setSelectedNumber\(point\.number\);\s*else\s*onOpen\(shop\.id, point\.number\)/);
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

test('owner draws and resizes a street zone; floor plan classifies tables by its shape', () => {
  const plan = read('src/components/tables/TableFloorplan.jsx');
  const original = [
    { number: 1, x: 200, y: 300, size: 100 },
    { number: 2, x: 600, y: 750, size: 140 },
  ];
  const polygon = [{ x: 500, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 500, y: 1000 }];
  assert.deepEqual(buildTableLayout(2, original), original);
  assert.equal(validateTableLayout(2, original), true);
  assert.equal(pointInOutdoorPolygon(original[0], polygon), false);
  assert.equal(pointInOutdoorPolygon(original[1], polygon), true);
  assert.match(plan, /Ko‘cha hududini chizish/);
  assert.match(plan, /Ko‘cha hududini sozlash \/ cho‘zish/);
  assert.match(plan, /setOutdoorPolygon\(boxToPolygon\(preset\.box\)\)/);
  assert.match(plan, /startDrag\(event, 'zone-draw'\)/);
  assert.match(plan, /startDrag\(e, 'zone-corner', 'nw'\)/);
  assert.match(plan, /startDrag\(e, 'zone-move'\)/);
  assert.match(plan, /outdoor_polygon: outdoorPolygon/);
  assert.match(plan, /pointInOutdoorPolygon\(point, outdoorPolygon\)/);
  assert.match(plan, /Do‘kon ichi · \{indoorCount\} stol/);
  assert.match(plan, /Ko‘cha \/ terassa · \{outdoorCount\} stol/);
  assert.match(plan, /<polygon points=\{zonePoints\}/);
  assert.doesNotMatch(plan, /OUTDOOR_START|h-\[62%\]|h-\[38%\]|Ochiq o‘tish/);
  assert.match(plan, /if \(zoneMode\) return;\s*if \(editing\) setSelectedNumber\(point\.number\);\s*else onOpen\(shop\.id, point\.number\)/);
  assert.doesNotMatch(plan, /entities\.(Sale|Payment|Shop|ProductStock)\.(create|update|delete)/);
});

test('table pre-check is printable outside the clipped dialog without showing on screen', () => {
  const detail = read('src/components/tables/TableDetailSheet.jsx');
  const css = read('src/index.css');
  assert.match(detail, /window\.print\(\)/);
  assert.match(detail, /createPortal\(<div ref=\{printRef\} className="receipt-print table-precheck[^\"]*hidden"/);
  assert.match(detail, /<\/div>, document\.body\)\}/);
  assert.match(css, /@media print \{[\s\S]*?\.receipt-print\.table-precheck \{ display: block !important; \}/);
});

test('street geometry accepts custom shapes and excludes invalid intersections, duplicates or tiny zones', () => {
  const rightSide = [{ x: 500, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 500, y: 1000 }];
  assert.equal(validOutdoorPolygon([]), true);
  assert.deepEqual(normalizeOutdoorPolygon(undefined), []);
  assert.equal(pointInOutdoorPolygon({ x: 500, y: 520 }, []), false);
  assert.equal(validOutdoorPolygon(rightSide), true);
  assert.equal(pointInOutdoorPolygon({ x: 900, y: 400 }, rightSide), true);
  assert.equal(pointInOutdoorPolygon({ x: 200, y: 900 }, rightSide), false);
  assert.equal(pointInOutdoorPolygon({ x: 500, y: 200 }, rightSide), true, 'a table on the outline counts as outdoor');
  const concave = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 200 },
    { x: 200, y: 200 }, { x: 200, y: 800 }, { x: 0, y: 800 }];
  assert.equal(validOutdoorPolygon(concave), true);
  assert.equal(pointInOutdoorPolygon({ x: 100, y: 700 }, concave), true);
  assert.equal(pointInOutdoorPolygon({ x: 700, y: 700 }, concave), false);
  const bad = [
    [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 100 }],
    [{ x: 0, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }, { x: 1000, y: 0 }],
    [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 1000 }, { x: 0, y: 1000 }],
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    [{ x: -1, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 300 }],
    [{ x: 0.5, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 300 }],
    Array.from({ length: 13 }, (_, index) => ({ x: index * 60, y: index % 2 ? 200 : 0 })),
  ];
  for (const polygon of bad) {
    assert.equal(validOutdoorPolygon(polygon), false);
    assert.deepEqual(normalizeOutdoorPolygon(polygon), []);
  }
});

test('actual floor plan renders safely with a custom street on first load and with no saved street', () => {
  // Render the real JSX offline; catches missing icon and symbol errors that
  // Vite production build alone may not detect (the prior blank Kassa issue).
  const source = read('src/components/tables/TableFloorplan.jsx');
  const start = source.indexOf('const WALLS = ');
  assert.ok(start > 0);
  const body = source.slice(start).replace('export default function TableFloorplan', 'function TableFloorplan');
  const transpiled = transformSync(`${body}\nglobalThis.TestFloorplan = TableFloorplan;`,
    { loader: 'jsx', jsx: 'transform' }).code;
  const context = {
    React, useEffect: React.useEffect, useMemo: React.useMemo, useRef: React.useRef,
    useState: React.useState, ...lucideIcons, ...floorGeometry,
    base44: {}, Button: ({ children }) => React.createElement('button', { type: 'button' }, children),
  };
  vm.runInNewContext(transpiled, context);
  const sharedShop = {
    id: 'mock', name: 'Odina Test', table_count: 2, layout_version: 0,
    layout: [{ number: 1, x: 200, y: 300, size: 100 }, { number: 2, x: 800, y: 700, size: 100 }],
    orders: [], entrance: { side: 'top', offset: 500 },
  };
  const make = (shop) => renderToStaticMarkup(React.createElement(context.TestFloorplan,
    { shop, canManage: true, onSaved: () => {}, onOpen: () => {} }));
  const plain = make(sharedShop);
  assert.match(plain, /Odina Test/);
  assert.match(plain, /2-stol/);
  assert.doesNotMatch(plain, /<polygon points=/);
  const custom = make({ ...sharedShop, outdoor_polygon: [
    { x: 600, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 600, y: 1000 },
  ] });
  assert.match(custom, /<polygon points="600,0 1000,0 1000,1000 600,1000"/);
  assert.match(custom, /Ko‘cha \/ terassa/);
  assert.doesNotMatch(custom, /Ochiq o‘tish/);
});

test('server saves each shop street polygon with CAS and owner permission, preserving old clients and open orders', async () => {
  const f = fixture();
  const original = (await f.run({ action: 'status' })).data.shops.find((shop) => shop.id === 'second-shop');
  assert.deepEqual(original.outdoor_polygon, []);
  const layout = buildTableLayout(8);
  const outdoor_polygon = [{ x: 0, y: 450 }, { x: 950, y: 450 }, { x: 950, y: 1000 }, { x: 0, y: 1000 }];
  const payload = { action: 'set_table_layout', shop_id: 'second-shop', layout_version: 0,
    layout, entrance: { side: 'top', offset: 500 }, outdoor_polygon };
  const invalid = [
    { ...payload, outdoor_polygon: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
    { ...payload, outdoor_polygon: [{ x: 0, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }, { x: 1000, y: 0 }] },
    { ...payload, outdoor_polygon: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 1000 }, { x: 0, y: 1000 }] },
    { ...payload, outdoor_polygon: [{ x: -5, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 400 }] },
    { ...payload, outdoor_polygon: 'forged' },
  ];
  for (const request of invalid) assert.equal((await f.run(request)).status, 400);
  assert.equal(f.writes, 0);
  // Mock an actual occupied table before the owner redraws the street. The
  // layout edit must not overwrite its unpaid order or its checkout version.
  f.as('cashier-2');
  const unpaid = await f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 2,
    shift_id: 'shift-second', expected_revision: 0, items: [{ product_id: 'cake', quantity: 2 }] });
  assert.equal(unpaid.status, 200, JSON.stringify(unpaid));
  f.as('owner');
  const openOrder = clone(f.db.Shop[1].restaurant_table_orders);
  const orderVersion = f.db.Shop[1].restaurant_table_orders_version;
  const saved = await f.run(payload);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.deepEqual(saved.data.shop.outdoor_polygon, outdoor_polygon);
  assert.deepEqual(f.db.Shop[1].restaurant_outdoor_polygon, outdoor_polygon);
  assert.deepEqual(f.db.Shop[1].restaurant_table_layout, layout);
  assert.equal(f.db.Sale.length, 0);
  assert.deepEqual(f.db.Shop[1].restaurant_table_orders, openOrder);
  assert.equal(f.db.Shop[1].restaurant_table_orders_version, orderVersion);
  const writes = f.writes;
  assert.equal((await f.run(payload)).status, 409);
  assert.equal(f.writes, writes);
  f.as('cashier-2');
  assert.deepEqual((await f.run({ action: 'status' })).data.shops[0].outdoor_polygon, outdoor_polygon);
  assert.equal((await f.run({ ...payload, layout_version: 1 })).status, 403);
  f.as('cashier-1');
  assert.equal((await f.run({ action: 'status' })).data.shops[0].outdoor_polygon.length, 0);
  f.as('owner');
  const oldClient = await f.run({ action: 'set_table_layout', shop_id: 'second-shop', layout_version: 1, layout });
  assert.equal(oldClient.status, 200, JSON.stringify(oldClient));
  assert.deepEqual(oldClient.data.shop.outdoor_polygon, outdoor_polygon);
  assert.equal((await f.run({ action: 'set_table_count', shop_id: 'second-shop', table_count: 7 })).status, 200);
  assert.deepEqual((await f.run({ action: 'status' })).data.shops.find((shop) => shop.id === 'second-shop').outdoor_polygon, outdoor_polygon);
  assert.deepEqual(f.db.Shop[1].restaurant_table_orders, openOrder);
  assert.equal(f.db.Shop[1].restaurant_table_orders_version, orderVersion);
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
  assert.match(page, /mahsulotlar stolda to‘lovgacha saqlanadi/i);
  assert.match(page, /Bron qilish hali qo‘shilmagan/i);
});

test('takeaway ticket saves without a table or sale, survives reload, and retries reuse its number', async () => {
  const f = fixture(); f.as('cashier-1');
  f.db.Product[1].shop_prices = { 'central-shop': 25000 };
  const body = { action: 'save_takeaway_order', shop_id: 'central-shop', shift_id: 'shift-main',
    order_id: 'takeaway-test-0001', expected_revision: 0, opened_by_name: 'FORGED',
    items: [{ product_id: 'coffee', quantity: 2 }] };
  const first = await f.run(body);
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.data.order.total, 50000);
  assert.equal(first.data.order.order_type, 'takeaway');
  assert.equal(first.data.order.number, undefined);
  assert.notEqual(first.data.order.opened_by_name, 'FORGED');
  const retry = await f.run(body);
  assert.equal(retry.data.order.ticket_number, first.data.order.ticket_number);
  assert.equal(retry.data.order.revision, 1);
  assert.equal(f.db.Shop[0].restaurant_table_orders.length, 1);
  assert.equal(f.db.Sale.length, 0);
  assert.equal(f.db.Shift[0].total_sales, undefined);
  const list = await f.run({ action: 'list_takeaway_orders', shop_id: 'central-shop' });
  assert.equal(list.data.orders[0].id, body.order_id);
  const restored = await f.run({ action: 'get_takeaway_order', shop_id: 'central-shop', order_id: body.order_id });
  assert.equal(restored.data.order.items[0].quantity, 2);
  assert.equal((await f.run({ action: 'status' })).data.shops[0].orders.length, 0);
  assert.equal((await f.run({ ...body, items: [{ product_id: 'coffee', quantity: 3 }] })).status, 409);
  assert.equal((await f.run({ ...body, shop_id: 'second-shop' })).status, 403);
  assert.equal((await f.run({ action: 'list_takeaway_orders', shop_id: 'second-shop' })).status, 403);
  f.db.Product[1].price = 99000;
  f.db.Product[1].shop_prices['central-shop'] = 99000;
  const edit = await f.run({ ...body, expected_revision: 1, items: [{ product_id: 'coffee', quantity: 3 }] });
  assert.equal(edit.data.order.total, 75000);
  assert.equal(edit.data.order.ticket_number, first.data.order.ticket_number);
});

test('takeaway concurrent saves do not overwrite orders, stale and paid orders cannot be resurrected', async () => {
  const f = fixture(); f.as('cashier-2');
  const body = { action: 'save_takeaway_order', shop_id: 'second-shop', shift_id: 'shift-second',
    order_id: 'takeaway-test-0002', expected_revision: 0, items: [{ product_id: 'coffee', quantity: 1 }] };
  const results = await Promise.all([f.run(body), f.run(body)]);
  assert.ok(results.some((r) => r.status === 200), JSON.stringify(results));
  assert.equal(f.db.Shop[1].restaurant_table_orders.length, 1);
  const order = f.db.Shop[1].restaurant_table_orders[0];
  order.state = 'paying'; order.checkout_key = 'checkout-test';
  assert.equal((await f.run({ ...body, expected_revision: 1 })).status, 409);
  const reconcile = { action: 'reconcile_takeaway_payment', shop_id: 'second-shop', order_id: order.id };
  assert.equal((await f.run(reconcile)).status, 409);
  f.db.Sale.push({ id: 'paid', status: 'completed', shop_id: 'second-shop',
    table_order_id_snapshot: order.id, idempotency_key: order.checkout_key });
  assert.equal((await f.run(reconcile)).data.released, true);
  assert.equal(f.db.Shop[1].restaurant_table_orders.length, 0);
  assert.equal((await f.run(body)).status, 409);
  assert.equal((await f.run({ ...body, expected_revision: 1 })).status, 409);
});



async function takeawayCancellationFixture() {
  const f = fixture(); f.as('cashier-1');
  const saved = await f.run({ action: 'save_takeaway_order', shop_id: 'central-shop',
    shift_id: 'shift-main', order_id: 'takeaway-cancel-test', expected_revision: 0,
    items: [{ product_id: 'coffee', quantity: 1 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  return { f, order: saved.data.order };
}
const cancelTakeawayRequest = (order, extra = {}) => ({
  action: 'cancel_takeaway_order', shop_id: 'central-shop', shift_id: 'shift-main',
  order_id: order.id, expected_revision: order.revision, confirm_cancel: true, ...extra,
});

test('takeaway cancellation preserves audit, unrelated orders and groups, and creates no revenue', async () => {
  const { f, order } = await takeawayCancellationFixture();
  const groups = [{ id: 'untouched-group', numbers: [2, 3] }];
  f.db.Shop[0].restaurant_table_groups = clone(groups);
  f.db.Shop[0].restaurant_table_orders.push({ id: 'untouched', number: 2, state: 'occupied' });
  const before = clone(f.db.Shift);
  const result = await f.run(cancelTakeawayRequest(order));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.cancelled, true);
  assert.deepEqual(f.db.Shop[0].restaurant_table_groups, groups);
  assert.equal(f.db.Shop[0].restaurant_table_orders.length, 1);
  assert.equal(f.db.Shop[0].restaurant_table_orders[0].id, 'untouched');
  assert.deepEqual(f.db.Shift, before); assert.equal(f.db.Sale.length, 0);
  const audit = f.db.ActionHistory.find(row => row.action === 'restaurant_takeaway_order_cancelled');
  assert.equal(audit.user_id, 'cashier-1');
  const snapshot = JSON.parse(audit.details);
  assert.deepEqual(snapshot.order_snapshot, order);
  assert.equal(snapshot.order_type, 'takeaway');
  assert.ok(Date.parse(snapshot.cancelled_at));
  assert.equal((await f.run(cancelTakeawayRequest(order))).data.already_closed, true);
});

test('takeaway cancellation rejects wrong shop/shift, stale revision, missing confirmation and payment locks', async () => {
  const { f, order } = await takeawayCancellationFixture();
  for (const extra of [{ shop_id: 'second-shop' }, { shift_id: 'shift-second' },
    { expected_revision: 2 }, { confirm_cancel: false }, { order_id: 'bad' }]) {
    assert.notEqual((await f.run(cancelTakeawayRequest(order, extra))).status, 200);
    assert.equal(f.db.Shop[0].restaurant_table_orders[0].id, order.id);
  }
  const stored = f.db.Shop[0].restaurant_table_orders[0];
  stored.state = 'paying';
  assert.equal((await f.run(cancelTakeawayRequest(order))).status, 409);
  stored.state = 'occupied'; stored.checkout_key = 'payment-started';
  assert.equal((await f.run(cancelTakeawayRequest(order))).status, 409);
  delete stored.checkout_key;
  f.db.Shift[0].status = 'closed';
  assert.equal((await f.run(cancelTakeawayRequest(order))).status, 403);
});

test('takeaway cancellation preserves order when audit fails and serializes against edits', async () => {
  const first = await takeawayCancellationFixture();
  first.f.db.ActionHistory.push = () => { throw new Error('Mock audit unavailable'); };
  assert.equal((await first.f.run(cancelTakeawayRequest(first.order))).status, 500);
  assert.equal(first.f.db.Shop[0].restaurant_table_orders[0].id, first.order.id);
  const { f, order } = await takeawayCancellationFixture();
  const results = await Promise.all([
    f.run(cancelTakeawayRequest(order)),
    f.run({ action: 'save_takeaway_order', shop_id: 'central-shop', shift_id: 'shift-main',
      order_id: order.id, expected_revision: 1, items: [{ product_id: 'coffee', quantity: 2 }] }),
  ]);
  assert.equal(results.filter(row => row.status === 200).length, 1, JSON.stringify(results));
  assert.equal(results.filter(row => row.status === 409).length, 1, JSON.stringify(results));
});

const cancelTableRequest = (order, extra = {}) => ({ action: 'cancel_table_order',
  shop_id: 'second-shop', table_number: 2, shift_id: 'shift-second',
  table_order_id: order.id, expected_revision: order.revision, confirm_cancel: true, ...extra });

async function cancellationFixture() {
  const f = fixture(); f.as('cashier-2');
  const saved = await f.run({ action: 'save_table_order', shop_id: 'second-shop',
    table_number: 2, shift_id: 'shift-second', expected_revision: 0,
    items: [{ product_id: 'coffee', quantity: 1 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  return { f, order: saved.data.order };
}

test('confirmed cancellation frees grouped tables, archives original unpaid order and never creates revenue', async () => {
  const { f, order } = await cancellationFixture();
  f.db.Shop[1].restaurant_table_groups = [{ id: 'group-cancel', numbers: [2, 3] }];
  f.db.Shop[1].restaurant_table_orders.push({ id: 'untouched', number: 4, state: 'occupied' });
  const result = await f.run(cancelTableRequest(order));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.cancelled, true);
  assert.equal(f.db.Shop[1].restaurant_table_orders.length, 1);
  assert.equal(f.db.Shop[1].restaurant_table_orders[0].id, 'untouched');
  assert.equal(f.db.Shop[1].restaurant_table_groups.length, 0);
  assert.equal(f.db.Sale.length, 0);
  assert.equal(f.db.Shift[1].total_sales, undefined);
  const audit = f.db.ActionHistory.find((row) => row.action === 'restaurant_table_order_cancelled');
  assert.equal(audit.user_id, 'cashier-2');
  assert.equal(audit.user_name, 'cashier2@example.test');
  const snapshot = JSON.parse(audit.details);
  assert.equal(snapshot.order_snapshot.items[0].product_name, 'Kofe');
  assert.equal(snapshot.order_snapshot.total, 20000);
  assert.ok(Date.parse(snapshot.cancelled_at));
  assert.deepEqual(snapshot.table_numbers, [2, 3]);
  const retry = await f.run(cancelTableRequest(order));
  assert.equal(retry.data.already_closed, true);
  f.db.Shop[1].restaurant_table_orders.push({ id: 'new-order', number: 2, revision: 1, state: 'occupied' });
  assert.equal((await f.run(cancelTableRequest(order))).status, 409);
  assert.ok(f.db.Shop[1].restaurant_table_orders.some((row) => row.id === 'new-order'));
});

test('cancellation requires confirmation, assigned shop, own open shift and current unpaid revision', async () => {
  const { f, order } = await cancellationFixture();
  for (const extra of [
    { confirm_cancel: false }, { expected_revision: 99 }, { table_order_id: 'wrong' },
    { shift_id: 'shift-other' }, { shop_id: 'central-shop' },
  ]) {
    assert.notEqual((await f.run(cancelTableRequest(order, extra))).status, 200);
    assert.equal(f.db.Shop[1].restaurant_table_orders[0].id, order.id);
  }
  f.db.Shop[1].restaurant_table_orders[0].state = 'paying';
  assert.equal((await f.run(cancelTableRequest(order))).status, 409);
  f.db.Shop[1].restaurant_table_orders[0].state = 'occupied';
  f.db.Shift[1].status = 'closed';
  assert.equal((await f.run(cancelTableRequest(order))).status, 403);
});

test('failed audit preservation leaves the original order untouched', async () => {
  const { f, order } = await cancellationFixture();
  f.db.ActionHistory.push = () => { throw new Error('Mock history unavailable'); };
  const result = await f.run(cancelTableRequest(order));
  assert.equal(result.status, 500);
  assert.equal(f.db.Shop[1].restaurant_table_orders[0].id, order.id);
  assert.equal(f.db.Sale.length, 0);
});

test('simultaneous edit and cancellation cannot silently discard a newly saved revision', async () => {
  const { f, order } = await cancellationFixture();
  const results = await Promise.all([
    f.run(cancelTableRequest(order)),
    f.run({ action: 'save_table_order', shop_id: 'second-shop', table_number: 2,
      shift_id: 'shift-second', expected_revision: 1, items: [{ product_id: 'coffee', quantity: 2 }] }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.status === 409).length, 1, JSON.stringify(results));
});

