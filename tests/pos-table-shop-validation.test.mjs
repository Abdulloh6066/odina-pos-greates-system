// Offline regression for a valid table whose Shop.list entry is missing/stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const pos = fs.readFileSync('src/pages/POS.jsx', 'utf8');
const source = pos.slice(pos.indexOf('  const tableShop = selectedTable'), pos.indexOf('  const subtotal = useMemo'));
function validate(extra = {}) {
  const ctx = {
    selectedTable: { shopId: 'branch', number: 2 }, tableKey: 'branch:2',
    shops: [], verifiedTableShop: { key: 'branch:2', shop: { id: 'branch', name: 'Odina Branch', restaurant_table_count: 7 } },
    tableQuery: { invalid: false }, loadingData: false, tableOrderLoading: false, tableOrderError: '',
    shift: { shop_id: 'branch' }, ...extra,
  };
  vm.runInNewContext(source + '\nglobalThis.result = { shop: tableShop, error: tableSelectionError };', ctx);
  return ctx.result;
}
test('server-verified table remains usable when Shop.list is empty or stale', () => {
  assert.equal(validate().error, '');
  assert.equal(validate().shop.name, 'Odina Branch');
  assert.equal(validate({ shops: [{ id: 'branch', restaurant_table_count: 0 }] }).error, '');
});
test('verification for another table/shop cannot authorize the current selection', () => {
  assert.match(validate({ verifiedTableShop: { key: 'central:2', shop: { id: 'central', restaurant_table_count: 30 } } }).error, /mavjud emas/);
  assert.match(validate({ shift: { shop_id: 'central' } }).error, /boshqa do‘kon/);
  assert.match(validate({ tableQuery: { invalid: true } }).error, /havolasi noto‘g‘ri/);
});
test('loading and network failures do not falsely report a deleted table', () => {
  assert.equal(validate({ verifiedTableShop: null, tableOrderLoading: true }).error, '');
  assert.equal(validate({ verifiedTableShop: null, tableOrderError: 'Internet xatosi' }).error, '');
});
