// Offline regression: execute the real POS loading effect with delayed responses.
// No live orders, sales, shifts or API requests are created.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const pos = fs.readFileSync('src/pages/POS.jsx', 'utf8');
const start = pos.indexOf('  useEffect(() => {', pos.indexOf('// The server owns every open order.'));
const end = pos.indexOf('  }, [tableKey, tableReload]);', start);
assert.ok(start >= 0 && end > start);
const effectSource = pos.slice(start, end + '  }, [tableKey, tableReload]);'.length);
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function harness() {
  const state = {}, requests = [];
  let cleanup;
  function open(number = 2) {
    cleanup?.();
    const ctx = {
      selectedTable: { shopId: 'branch', number }, tableKey: 'branch:' + number, tableReload: 0,
      base44: { functions: { invoke: (_name, args) => {
        const request = { args, ...deferred() };
        requests.push(request);
        return request.promise;
      } } },
      useEffect: callback => { cleanup = callback(); },
    };
    for (const field of ['TableOrder', 'TableOrderLoading', 'TableOrderError', 'TableSaveError',
      'VerifiedTableShop', 'Cart', 'DiscountCode', 'DiscountPct', 'DiscountOwnerPin',
      'RoundingTarget', 'AdjustmentMode']) ctx['set' + field] = value => { state[field] = value; };
    vm.runInNewContext(effectSource, ctx);
  }
  return { state, requests, open, close: () => cleanup?.() };
}
const shop = { id: 'branch', name: 'Odina Branch', restaurant_table_count: 7 };
const response = number => ({ data: { ok: true, shop, order: { id: 'order-' + number, items: [{ product_id: 'cake', quantity: number }] } } });

test('delayed initial load and repeated refresh restore verified shop and exact order', async () => {
  const h = harness();
  for (let n = 0; n < 3; n++) {
    h.open();
    assert.equal(h.state.TableOrderLoading, true);
    h.requests.at(-1).resolve(response(2));
    await flush();
    assert.equal(h.state.TableOrderLoading, false);
    assert.equal(h.state.TableOrderError, '');
    assert.equal(h.state.VerifiedTableShop.key, 'branch:2');
    assert.equal(h.state.VerifiedTableShop.shop.name, 'Odina Branch');
    assert.equal(h.state.Cart[0].quantity, 2);
  }
});
test('late response from previous table cannot replace current table or its cart', async () => {
  const h = harness();
  h.open(2); h.open(3);
  h.requests[1].resolve(response(3));
  await flush();
  h.requests[0].resolve(response(2));
  await flush();
  assert.equal(h.state.VerifiedTableShop.key, 'branch:3');
  assert.equal(h.state.TableOrder.id, 'order-3');
  assert.equal(h.state.Cart[0].quantity, 3);
});
test('older backend response obtains metadata through authorized status fallback', async () => {
  const h = harness(); h.open();
  const old = response(2); delete old.data.shop;
  h.requests[0].resolve(old); await flush();
  assert.equal(h.requests[1].args.action, 'status');
  assert.equal(h.state.TableOrderLoading, true);
  h.requests[1].resolve({ data: { ok: true, shops: [{ id: 'branch', name: 'Odina Branch', table_count: 7 }] } });
  await flush();
  assert.equal(h.state.VerifiedTableShop.shop.restaurant_table_count, 7);
  assert.equal(h.state.TableOrder.id, 'order-2');
  assert.equal(h.state.TableOrderError, '');
});
test('late fallback after table switch cannot overwrite a newer order', async () => {
  const h = harness(); h.open(2);
  const old = response(2); delete old.data.shop;
  h.requests[0].resolve(old); await flush();
  h.open(3);
  h.requests[2].resolve(response(3)); await flush();
  h.requests[1].resolve({ shops: [{ id: 'branch', name: 'Old name', table_count: 7 }] });
  await flush();
  assert.equal(h.state.VerifiedTableShop.key, 'branch:3');
  assert.equal(h.state.VerifiedTableShop.shop.name, 'Odina Branch');
  assert.equal(h.state.TableOrder.id, 'order-3');
});
test('network failure remains an explicit load error and retry recovers', async () => {
  const h = harness(); h.open();
  h.requests[0].reject(new Error('Internet xatosi')); await flush();
  assert.equal(h.state.TableOrderError, 'Internet xatosi');
  assert.equal(h.state.TableOrderLoading, false);
  assert.equal(h.state.Cart, undefined);
  h.open(); h.requests[1].resolve(response(2)); await flush();
  assert.equal(h.state.TableOrderError, '');
  assert.equal(h.state.TableOrder.id, 'order-2');
});
test('unverified or wrong-shop metadata never loads the returned cart', async () => {
  const h = harness(); h.open();
  const wrong = response(2); wrong.data.shop = { ...shop, id: 'central' };
  h.requests[0].resolve(wrong); await flush();
  assert.match(h.state.TableOrderError, /tekshirib bo‘lmadi/);
  assert.equal(h.state.Cart, undefined);
  assert.equal(h.state.VerifiedTableShop, undefined);
});
