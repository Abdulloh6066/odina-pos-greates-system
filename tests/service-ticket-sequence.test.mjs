// Offline-only tests for shop-wide, shift-cycle service ticket numbering.
// The real helper runs against in-memory entities; NEVER create real records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync('base44/shared/shift-close-helpers.ts', 'utf8').replace(/export /g, '');
const compiled = ts.transpileModule(`${source}\nglobalThis.serviceTicket = { allocateServiceTicketNumber, finishServiceTicketCycleIfLastShift };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness({ legacy = false } = {}) {
  const db = {
    Shop: [
      { id: 'main', name: 'Odina Main', location_type: 'shop', active: true,
        ...(legacy ? { restaurant_table_orders: [{ number: 2 }] } : {}) },
      { id: 'branch', name: 'Odina Branch', location_type: 'shop', active: true },
    ],
    Shift: [
      { id: 'main-a', shop_id: 'main', status: 'open', order_count: legacy ? 108 : 0,
        opened_at: '2026-09-19T18:00:00Z' },
      { id: 'main-b', shop_id: 'main', status: 'open', order_count: 0,
        opened_at: '2026-09-20T00:20:00Z' },
      { id: 'branch-a', shop_id: 'branch', status: 'open', order_count: 0 },
    ],
  };
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object') {
      if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
      if ('$in' in expected) return expected.$in.includes(actual ?? null);
    }
    return actual === expected;
  };
  const matches = (row, query) => (!query.$or || query.$or.some((part) => matches(row, part)))
    && Object.entries(query).filter(([key]) => key !== '$or')
      .every(([key, value]) => matchesValue(row[key], value));
  let writes = 0;
  const service = { entities: {
    Shop: {
      get: async (id) => clone(db.Shop.find((shop) => shop.id === id)),
      updateMany: async (query, change) => {
        const matched = db.Shop.filter((shop) => matches(shop, query));
        for (const shop of matched) {
          Object.assign(shop, clone(change.$set || {}));
          for (const [field, value] of Object.entries(change.$inc || {})) {
            shop[field] = Number(shop[field] || 0) + Number(value);
          }
          writes += 1;
        }
        return { success: true, updated: matched.length };
      },
    },
    Shift: {
      filter: async (query) => clone(db.Shift.filter((shift) => matches(shift, query))),
    },
  } };
  const sandbox = vm.createContext({ console });
  vm.runInContext(compiled, sandbox);
  return { db, service, api: sandbox.serviceTicket, get writes() { return writes; } };
}

test('legacy open-shop count is bootstrapped once; midnight and another cashier never reset numbers', async () => {
  const f = harness({ legacy: true });
  assert.equal(await f.api.allocateServiceTicketNumber(f.service, 'main'), 110);
  assert.equal(await f.api.allocateServiceTicketNumber(f.service, 'main'), 111);
  assert.equal(f.db.Shop[0].service_ticket_counter, 111);
  assert.equal(f.db.Shift[0].status, 'open');
  assert.equal(f.db.Shift[1].opened_at, '2026-09-20T00:20:00Z');
  assert.equal(await f.api.allocateServiceTicketNumber(f.service, 'branch'), 1);
  assert.equal(f.db.Shop[1].service_ticket_counter, 1);
});

test('one cashier closes while another stays open: numbers continue; only all closed starts next cycle at one', async () => {
  const f = harness();
  assert.equal(await f.api.allocateServiceTicketNumber(f.service, 'main'), 1);
  f.db.Shift[0].status = 'closed';
  assert.equal(await f.api.finishServiceTicketCycleIfLastShift(f.service, 'main'), false);
  assert.equal(await f.api.allocateServiceTicketNumber(f.service, 'main'), 2);
  f.db.Shift[1].status = 'closing';
  assert.equal(await f.api.finishServiceTicketCycleIfLastShift(f.service, 'main'), false);
  f.db.Shift[1].status = 'closed';
  assert.equal(await f.api.finishServiceTicketCycleIfLastShift(f.service, 'main'), true);
  assert.equal(f.db.Shop[0].service_ticket_cycle_active, false);
  assert.equal(f.db.Shop[0].service_ticket_counter, 2);
  f.db.Shift.push({ id: 'next-day', shop_id: 'main', status: 'open', order_count: 0 });
  assert.equal(await f.api.allocateServiceTicketNumber(f.service, 'main'), 1);
  assert.equal(await f.api.allocateServiceTicketNumber(f.service, 'branch'), 1);
  assert.equal(f.db.Shop[0].service_ticket_counter, 1);
});

test('two or more checkout devices atomically receive different numbers without duplicates', async () => {
  const f = harness();
  const numbers = await Promise.all(Array.from({ length: 45 }, () =>
    f.api.allocateServiceTicketNumber(f.service, 'main')));
  assert.deepEqual(numbers.sort((a, b) => a - b), Array.from({ length: 45 }, (_, i) => i + 1));
  assert.equal(f.db.Shop[0].service_ticket_counter, 45);
});

test('no open shift blocks allocation; failed CAS never invents an unsaved number', async () => {
  const f = harness();
  f.db.Shift[0].status = 'closed';
  f.db.Shift[1].status = 'closed';
  await assert.rejects(f.api.allocateServiceTicketNumber(f.service, 'main'), /ochiq smena/);
  assert.equal(f.writes, 0);
  f.db.Shift[0].status = 'open';
  f.service.entities.Shop.updateMany = async () => ({ success: true, updated: 0 });
  await assert.rejects(f.api.allocateServiceTicketNumber(f.service, 'main'), /Qayta urinib/);
  assert.equal(f.db.Shop[0].service_ticket_counter, undefined);
});
