// Offline tests of the actual POS cancellation handler. No live orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/pages/POS.jsx', 'utf8');
const handler = source.slice(source.indexOf('  const cancelTakeawayOrder ='), source.indexOf('  const leaveTakeaway ='));
const order = { id: 'takeaway-test', shop_id: 'shop', ticket_number: 12, revision: 3, state: 'occupied' };
function fixture({ confirm = true, result = { ok: true, cancelled: true }, online = true, selected = order, invoke } = {}) {
  let rows = [order, { id: 'other' }]; let resets = 0; let calls = 0; let prompts = 0; let error = '';
  const ctx = {
    cancellingTakeawayRef: { current: false }, takeawaySavingRef: { current: false }, savingTableRef: { current: false },
    checkoutRequestKeyRef: { current: 'key' }, checkoutRecordedAtRef: { current: 'date' },
    openOrdersLoading: false, paying: false, payOpen: false, stockChecking: false,
    shift: { id: 'shift', shop_id: 'shop' }, isOnline: online, navigator: { onLine: online }, takeawayOrder: selected,
    setCancellingTakeawayId: () => {}, setTakeawaySaving: () => {}, setOpenOrdersError: value => { error = value; },
    setOpenOrders: fn => { rows = fn(rows); }, setTakeawayOrder: value => { ctx.takeawayOrder = value; },
    resetCart: () => { resets++; },
    odinaConfirm: async () => { prompts++; return typeof confirm === 'function' ? confirm() : confirm; },
    base44: { functions: { invoke: async (_name, args) => {
      calls++; assert.equal(args.action, 'cancel_takeaway_order');
      assert.equal(args.expected_revision, 3); assert.equal(args.confirm_cancel, true);
      return invoke ? invoke(args) : { data: result };
    } } },
  };
  vm.runInNewContext(handler + '\nglobalThis.cancel = cancelTakeawayOrder;', ctx);
  return { ctx, run: () => ctx.cancel(order), state: () => ({ rows, resets, calls, prompts, error }) };
}

test('declining cancellation keeps the order and cart with no server call', async () => {
  const f = fixture({ confirm: false }); await f.run();
  assert.equal(f.state().rows.length, 2); assert.equal(f.state().resets, 0); assert.equal(f.state().calls, 0);
  assert.equal(f.ctx.cancellingTakeawayRef.current, false);
});

test('confirmed cancellation removes only its row and clears only its selected cart after acknowledgment', async () => {
  let acknowledge;
  const f = fixture({ invoke: () => new Promise(resolve => { acknowledge = resolve; }) });
  const running = f.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().rows.length, 2); assert.equal(f.state().resets, 0);
  acknowledge({ data: { ok: true, cancelled: true } }); await running;
  assert.equal(f.state().rows.length, 1); assert.equal(f.state().rows[0].id, 'other');
  assert.equal(f.state().resets, 1); assert.equal(f.ctx.checkoutRequestKeyRef.current, '');
  const other = fixture({ selected: { id: 'other' } }); await other.run();
  assert.equal(other.state().resets, 0); assert.equal(other.ctx.checkoutRequestKeyRef.current, 'key');
});

test('offline, failed or conflicted cancellation preserves both list and cart', async () => {
  for (const options of [{ online: false }, { result: { ok: false, error: 'Changed' } },
    { invoke: () => { throw new Error('Network failure'); } }]) {
    const f = fixture(options); await f.run();
    assert.equal(f.state().rows.length, 2); assert.equal(f.state().resets, 0);
    assert.ok(f.state().error); assert.equal(f.ctx.takeawaySavingRef.current, false);
  }
});

test('repeat taps ask once and orders being paid cannot be cancelled', async () => {
  let confirm;
  const f = fixture({ confirm: () => new Promise(resolve => { confirm = resolve; }) });
  const first = f.run(); await f.run();
  assert.equal(f.state().prompts, 1); confirm(true); await first;
  assert.equal(f.state().calls, 1);
  const locked = fixture(); await locked.ctx.cancel({ ...order, state: 'paying' });
  assert.equal(locked.state().prompts, 0); assert.equal(locked.state().calls, 0);
});
