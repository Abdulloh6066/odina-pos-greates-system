// Offline-only: execute actual POS callbacks with memory stubs; no live requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/pages/POS.jsx', 'utf8');
const action = source.slice(source.indexOf('  const cancelLastTableItem = async () => {'),
  source.indexOf('  const inc = (item) =>'));
const mutations = source.slice(source.indexOf('  const dec = (item) =>'),
  source.indexOf('  const resetCart ='));
function harness({ confirmed = true, fails = false, online = true, quantity = 1, otherItem = false } = {}) {
  const cart = [{ product_id: 'coffee', quantity, price: 20000, subtotal: quantity * 20000 }];
  if (otherItem) cart.push({ product_id: 'tea', quantity: 1, price: 10000, subtotal: 10000 });
  const events = [];
  const context = {
    selectedTable: { shopId: 'shop', number: 2 }, tableKey: 'shop:2',
    priorTableKey: { current: 'shop:2' }, tableLocked: false, paying: false, payOpen: false,
    stockChecking: false, savingTableRef: { current: false },
    tableOrder: { id: 'order-1', revision: 3 }, shift: { id: 'shift', shop_id: 'shop' },
    isOnline: online, navigator: { onLine: online }, cart,
    lastSavedOrderRef: { current: {} }, checkoutRequestKeyRef: { current: 'old-key' },
    checkoutRecordedAtRef: { current: 'old-time' },
    setSavingTable: (value) => events.push(['busy', value]),
    setTableSaveError: (message) => events.push(['error', message]),
    odinaConfirm: async () => { events.push(['confirm']); return confirmed; },
    odinaAlert: (message) => events.push(['alert', message]),
    base44: { functions: { invoke: async (name, body) => {
      events.push(['request', name, body]); if (fails) throw new Error('Mock network error');
      return { data: { ok: true, cancelled: true } };
    } } },
    resetCart: () => { events.push(['reset']); context.cart = []; },
    setCart: (updater) => { context.cart = updater(context.cart); },
    setTableOrder: (value) => events.push(['order', value]),
    setMobileCartOpen: (value) => events.push(['mobile', value]),
    navigate: (path) => events.push(['navigate', path]), posHomePath: '/pos?screen=1',
    openWeight: () => events.push(['weight']),
  };
  vm.runInNewContext(action + mutations + '\nglobalThis.api = { cancelLastTableItem, dec, removeItem };', context);
  return { context, events, api: context.api, flush: () => new Promise((resolve) => setImmediate(resolve)) };
}
test('No keeps the final table item with no server write', async () => {
  const f = harness({ confirmed: false });
  f.api.dec(f.context.cart[0]); await f.flush();
  assert.equal(f.context.cart.length, 1);
  assert.equal(f.context.cart[0].quantity, 1);
  assert.equal(f.events.filter(([type]) => type === 'confirm').length, 1);
  assert.equal(f.events.filter(([type]) => type === 'request').length, 0);
});
test('Yes clears the cart only after cancellation acknowledgement and keeps screen mode', async () => {
  const f = harness();
  await f.api.cancelLastTableItem();
  const requestIndex = f.events.findIndex(([type]) => type === 'request');
  assert.ok(requestIndex >= 0 && requestIndex < f.events.findIndex(([type]) => type === 'reset'));
  assert.equal(f.events[requestIndex][2].action, 'cancel_table_order');
  assert.equal(f.events[requestIndex][2].table_order_id, 'order-1');
  assert.equal(f.events[requestIndex][2].expected_revision, 3);
  assert.equal(f.context.cart.length, 0);
  assert.deepEqual(f.events.find(([type]) => type === 'navigate'), ['navigate', '/pos?screen=1']);
  assert.equal(f.context.checkoutRequestKeyRef.current, '');
});
test('network failure and offline mode preserve the final item', async () => {
  for (const options of [{ fails: true }, { online: false }]) {
    const f = harness(options); await f.api.cancelLastTableItem();
    assert.equal(f.context.cart.length, 1);
    assert.equal(f.events.filter(([type]) => type === 'reset').length, 0);
    assert.equal(f.context.savingTableRef.current, false);
  }
});
test('trash and repeated minus taps trigger only one confirmation for the final line', async () => {
  const f = harness({ confirmed: false });
  f.api.removeItem(f.context.cart[0]); f.api.dec(f.context.cart[0]); await f.flush();
  assert.equal(f.events.filter(([type]) => type === 'confirm').length, 1);
  assert.equal(f.context.cart.length, 1);
});
test('ordinary decrement and replacing a product leave the remaining order editable', async () => {
  const f = harness({ quantity: 2 });
  f.api.dec(f.context.cart[0]); assert.equal(f.context.cart[0].quantity, 1);
  assert.equal(f.events.length, 0);
  const g = harness({ otherItem: true });
  g.api.removeItem(g.context.cart[0]);
  assert.equal(g.context.cart.length, 1);
  assert.equal(g.context.cart[0].product_id, 'tea');
  assert.equal(g.events.length, 0);
});
