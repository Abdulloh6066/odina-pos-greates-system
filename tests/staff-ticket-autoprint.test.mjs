// Real component hooks with a tiny deterministic offline hook runner.
// No Base44 network, live records, browser dialog, or physical printer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { staffTicketFromSale, staffTicketFromCustomerOrder } from '../src/lib/staff-order-ticket.js';

const source = readFileSync('src/components/tables/StaffOrderTicketModal.jsx', 'utf8');
const hookBody = source.slice(source.indexOf('function getTicketPrintCount('), source.indexOf('  // One shared'))
  .replace('export default function StaffOrderTicketModal', 'function StaffOrderTicketModal')
  + '\n return { ticketReady, ticketOrder, error, handlePrint }; }\nglobalThis.Component = StaffOrderTicketModal;';
const order = id => ({ id, shop_id: 'shop-1', items: [{ product_name: id, quantity: 1 }], revision: 1 });

function harness(extra = {}) {
  const slots = []; let cursor = 0; let dirty = true; let pending = []; let output; let closed = 0;
  const jobs = []; const reads = []; const counts = new Map();
  let props = { open: true, mode: 'sale', order: order('sale-1'), onClose: () => { closed++; props = { ...props, open: false }; dirty = true; }, ...extra };
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const context = {
    useState(value) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value };
      return [slots[i].value, value => {
        const next = typeof value === 'function' ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; }
      }];
    },
    useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) pending.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() };
      });
    },
    window: {}, sessionStorage: { getItem: key => counts.get(key), setItem: (key, val) => counts.set(key, val) },
    base44: {
      functions: { invoke: (_name, args) => new Promise((resolve, reject) => reads.push({ args, resolve, reject })) },
      entities: { CustomerOrderItem: { filter: args => new Promise((resolve, reject) => reads.push({ args, resolve, reject })) } },
    },
    staffTicketFromSale, staffTicketFromCustomerOrder, toast: () => {},
    startReceiptPrint(options) {
      const job = { options, cancelled: false }; jobs.push(job);
      return () => { job.cancelled = true; };
    },
  };
  vm.runInNewContext(hookBody, context);
  const flush = () => {
    let guard = 0;
    while (dirty) {
      if (++guard > 30) throw new Error('Unexpected render loop');
      dirty = false; cursor = 0; output = context.Component(props);
      const effects = pending; pending = []; for (const fn of effects) fn();
    }
  };
  const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush(); } };
  flush();
  return { jobs, reads, counts, flush, settle, output: () => output, closed: () => closed,
    set: values => { props = { ...props, ...values }; dirty = true; flush(); },
  };
}

test('sale service ticket automatically starts once and closes on print completion', async () => {
  const h = harness(); await h.settle();
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].options.printClass, 'odina-staff-printing');
  assert.equal(h.output().ticketOrder.items[0].product_name, 'sale-1');
  h.set({ onClose: () => {} }); assert.equal(h.jobs.length, 1, 'parent rerender must not print twice');
  const next = harness(); await next.settle();
  next.jobs[0].options.onDone(); next.flush();
  assert.equal(next.closed(), 1);
  assert.equal(next.jobs[0].cancelled, true);
});

test('table and takeaway wait for the current saved order; errors never print stale data', async () => {
  for (const mode of ['table', 'takeaway']) {
    const h = harness({ mode, order: order('old'), shopId: 'shop-1', tableNumber: mode === 'table' ? 2 : undefined });
    await h.settle(); assert.equal(h.jobs.length, 0);
    h.reads[0].resolve({ data: { ok: true, order: order('fresh') } });
    await h.settle(); assert.equal(h.jobs.length, 1);
    assert.equal(h.output().ticketOrder.id, 'fresh');
    h.set({ order: order('next') }); assert.equal(h.jobs[0].cancelled, true);
    assert.equal(h.jobs.length, 1);
    h.reads[1].resolve({ data: { ok: true, order: null } });
    await h.settle(); assert.equal(h.jobs.length, 1);
    assert.ok(h.output().error);
  }
});

test('closing during loading ignores a late response and reopening prints the new ticket', async () => {
  const h = harness({ mode: 'takeaway', order: order('first') });
  h.set({ open: false }); h.set({ open: true, order: order('second') });
  h.reads[0].resolve({ data: { ok: true, order: order('first') } });
  await h.settle(); assert.equal(h.jobs.length, 0);
  h.reads[1].resolve({ data: { ok: true, order: order('second') } });
  await h.settle(); assert.equal(h.jobs.length, 1); assert.equal(h.output().ticketOrder.id, 'second');
});

test('customer ticket waits for saved items; explicit manual mode still works', async () => {
  const h = harness({ mode: 'customer', order: order('custom') });
  await h.settle(); assert.equal(h.jobs.length, 0);
  h.reads[0].resolve([{ product_name_snapshot: 'Cake', quantity: 2 }]);
  await h.settle(); assert.equal(h.jobs.length, 1);
  assert.equal(h.output().ticketOrder.items[0].product_name, 'Cake');
  const manual = harness({ autoPrint: false }); await manual.settle();
  assert.equal(manual.jobs.length, 0);
  manual.output().handlePrint(); manual.flush(); assert.equal(manual.jobs.length, 1);
});

test('POS queues service printing without confirmation, preserves receipt preference and avoids already-ticketed orders', () => {
  const pos = readFileSync('src/pages/POS.jsx', 'utf8');
  const body = pos.slice(pos.indexOf('  const finishSalePresentation ='), pos.indexOf('  const finishQueuedSale ='));
  let receipt; let staff; let navigated = 0;
  const ctx = { setReceiptPrintSale: value => { receipt = value; }, setStaffTicket: value => { staff = value; },
    selectedTable: null, navigate: () => { navigated++; }, posHomePath: '/POS', setTablePickerOpen: () => {},
    checkoutCancelledRef: {}, checkoutReadyRef: {} };
  vm.runInNewContext(body + '\nglobalThis.present = presentCompletedSale; globalThis.finish = finishSalePresentation;', ctx);
  const sale = order('paid');
  ctx.present(sale, true); assert.equal(receipt, sale); assert.equal(staff, undefined);
  ctx.finish(sale); assert.equal(receipt, null); assert.equal(staff.order, sale); assert.equal(staff.autoPrint, true);
  staff = undefined; ctx.present(sale, false); assert.equal(receipt, null); assert.equal(staff.order, sale);
  for (const snapshot of [{ table_number_snapshot: 2 }, { table_order_id_snapshot: 'already-ticketed' }]) {
    staff = undefined; ctx.finish({ ...sale, ...snapshot }); assert.equal(staff, undefined);
  }
  assert.equal(navigated, 0);
  assert.doesNotMatch(pos, /staffTicketPrompt|xizmat cheki kerakmi/);
});
