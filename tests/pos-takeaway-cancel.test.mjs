// Offline tests of the actual POS cancellation handler. No live orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transformSync } from 'esbuild';

const source = fs.readFileSync('src/pages/POS.jsx', 'utf8');
const handler = source.slice(source.indexOf('  const cancelTakeawayOrder ='), source.indexOf('  const leaveTakeaway ='));
const order = { id: 'takeaway-test', shop_id: 'shop', ticket_number: 12, revision: 3, state: 'occupied' };
function fixture({ result = { ok: true, cancelled: true }, online = true, selected = order, invoke } = {}) {
  let rows = [order, { id: 'other' }]; let resets = 0; let calls = 0; let error = '';
  const ctx = {
    cancellingTakeawayRef: { current: false }, takeawaySavingRef: { current: false }, savingTableRef: { current: false },
    checkoutRequestKeyRef: { current: 'key' }, checkoutRecordedAtRef: { current: 'date' },
    openOrdersLoading: false, paying: false, payOpen: false, stockChecking: false,
    shift: { id: 'shift', shop_id: 'shop' }, isOnline: online, navigator: { onLine: online }, takeawayOrder: selected,
    setCancellingTakeawayId: () => {}, setTakeawaySaving: () => {}, setOpenOrdersError: value => { error = value; },
    setOpenOrders: fn => { rows = fn(rows); }, setTakeawayOrder: value => { ctx.takeawayOrder = value; },
    resetCart: () => { resets++; },
    odinaConfirm: () => { throw new Error('Cancellation must not open a second modal'); },
    setTakeawayCancelError: value => { error = value?.message || ''; },
    base44: { functions: { invoke: async (_name, args) => {
      calls++; assert.equal(args.action, 'cancel_takeaway_order');
      assert.equal(args.expected_revision, 3); assert.equal(args.confirm_cancel, true);
      return invoke ? invoke(args) : { data: result };
    } } },
  };
  vm.runInNewContext(handler + '\nglobalThis.cancel = cancelTakeawayOrder;', ctx);
  return { ctx, run: () => ctx.cancel(order), state: () => ({ rows, resets, calls, error }) };
}

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

test('repeat taps submit once and orders being paid cannot be cancelled', async () => {
  let acknowledge;
  const f = fixture({ invoke: () => new Promise(resolve => { acknowledge = resolve; }) });
  const first = f.run(); await f.run();
  assert.equal(f.state().calls, 1);
  acknowledge({ data: { ok: true, cancelled: true } }); await first;
  const locked = fixture(); await locked.ctx.cancel({ ...order, state: 'paying' });
  assert.equal(locked.state().calls, 0);
});

// Render the real JSX as React elements and exercise its actual button handlers.
function confirmation() {
  let confirming = false; let calls = 0;
  const code = fs.readFileSync('src/components/pos/TakeawayCancelAction.jsx', 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace('export default function', 'function');
  const ctx = { React, Button: 'button',
    useState: () => [confirming, value => { confirming = value; }] };
  vm.runInNewContext(transformSync(code + '\nglobalThis.Component = TakeawayCancelAction;', { loader: 'jsx' }).code, ctx);
  const render = (props = {}) => ctx.Component({ ticketNumber: 31, onConfirm: () => { calls++; }, ...props });
  const buttons = tree => {
    if (!tree || typeof tree !== 'object') return [];
    if (tree.type === 'button') return [tree];
    return React.Children.toArray(tree.props?.children).flatMap(buttons);
  };
  const click = (label, props) => {
    const button = buttons(render(props)).find(row => row.props.children === label);
    assert.ok(button, label);
    if (!button.props.disabled) button.props.onClick();
  };
  return { render, click, calls: () => calls };
}
test('inline confirmation: opening and No make no request; Yes submits directly without a second dialog', () => {
  const h = confirmation();
  h.click('Bekor qilish'); assert.equal(h.calls(), 0);
  h.click('Yo‘q, qolsin'); assert.equal(h.calls(), 0);
  h.click('Bekor qilish'); h.click('Ha, bekor qilish'); assert.equal(h.calls(), 1);
  assert.doesNotMatch(handler, /await odinaConfirm/);
});
test('inline confirmation disables repeated actions while pending and shows errors beside the order', () => {
  const h = confirmation(); h.click('Bekor qilish');
  h.click('Bekor qilinmoqda…', { busy: true }); assert.equal(h.calls(), 0);
  const tree = h.render({ error: 'Server xatosi' });
  const alert = React.Children.toArray(tree.props.children).find(row => row.props?.role === 'alert');
  assert.equal(alert.props.children, 'Server xatosi');
});

