import assert from 'node:assert/strict';
import test from 'node:test';
import { pricePosProducts, preparePosCatalog, selectPosProducts } from '../src/lib/pos-catalog.js';

const ids = rows => rows.map(row => row.id);
const categories = [
  { id: 'cakes', name: 'Tortlar' },
  { id: 'pastry', name: 'Pishiriqlar', sourceCategoryIds: ['pastry', 'puff'] },
  { id: 'drinks', name: 'Ichimliklar' },
];

test('shop prices use existing overrides and zero/null rules without changing source records', () => {
  const source = Object.freeze([
    Object.freeze({ id: 'a', name: 'A', price: 75000, shop_prices: { branch: 65000 } }),
    Object.freeze({ id: 'b', name: 'B', price: 10000, shop_prices: { branch: 0, other: null } }),
  ]);
  assert.deepEqual(pricePosProducts(source, 'branch').map(row => row.price), [65000, 0]);
  assert.deepEqual(pricePosProducts(source, 'other').map(row => row.price), [75000, 10000]);
  assert.equal(source[0].price, 75000); assert.equal(source[1].price, 10000);
});

test('grouped categories and shop category overrides keep stable product objects across views', () => {
  const priced = pricePosProducts([
    { id: 'a', name: 'A', price: 10, category_id: 'pastry' },
    { id: 'b', name: 'B', price: 20, category_id: 'puff' },
    { id: 'c', name: 'C', price: 30, category_id: 'drinks', shop_category_ids: { branch: 'pastry' } },
  ], 'branch');
  const prepared = preparePosCatalog(priced, categories, 'branch', []);
  const all = selectPosProducts(prepared), pastries = selectPosProducts(prepared, { activeCat: 'pastry' });
  assert.deepEqual(ids(pastries), ['a', 'b', 'c']);
  assert.equal(selectPosProducts(prepared, { activeCat: 'drinks' }).length, 0);
  assert.strictEqual(pastries[0], all[0]);
  assert.strictEqual(selectPosProducts(prepared, { activeCat: 'pastry' }), pastries, 'a revisited category reuses its prepared list');
  assert.strictEqual(selectPosProducts(prepared, { activeCat: 'pastry', search: 'B' })[0], all[1]);
});

test('variant placement is applied after search, so a hidden target cannot move the matched variant', () => {
  const prepared = preparePosCatalog(pricePosProducts([
    { id: 'original', name: 'Vanil', price: 10, category_id: 'pastry' },
    { id: 'other', name: 'Kakao oddiy', price: 20, category_id: 'pastry' },
    { id: 'variant', name: 'Kakao variant', price: 15, category_id: 'pastry', display_before_product_id: 'original' },
  ], 'branch'), categories, 'branch', []);
  assert.deepEqual(ids(selectPosProducts(prepared)), ['variant', 'original', 'other']);
  assert.deepEqual(ids(selectPosProducts(prepared, { search: 'Kakao' })), ['other', 'variant']);
  assert.deepEqual(ids(selectPosProducts(prepared, { activeCat: 'pastry', search: 'Kakao' })), ['other', 'variant']);
  assert.equal(selectPosProducts(prepared, { search: ' Kakao' }).length, 0, 'existing leading-space search behavior is retained');
});

test('cake price order, partial custom order and favorite scope preserve the existing precedence', () => {
  const priced = pricePosProducts([
    { id: 'expensive', name: 'Expensive', price: 90000, category_id: 'cakes', is_favorite: true },
    { id: 'cheap', name: 'Cheap', price: 40000, category_id: 'cakes', favorite_shop_ids: ['branch'] },
    { id: 'middle', name: 'Middle', price: 65000, category_id: 'cakes', favorite_shop_ids: ['other'] },
  ], 'branch');
  const plain = preparePosCatalog(priced, categories, 'branch', []);
  assert.deepEqual(ids(selectPosProducts(plain, { activeCat: 'cakes' })), ['cheap', 'middle', 'expensive']);
  assert.deepEqual(ids(selectPosProducts(plain, { showFav: true })), ['expensive', 'cheap']);
  assert.deepEqual(ids(selectPosProducts(plain, { activeCat: 'cakes', showFav: true })), ['cheap', 'expensive']);
  const custom = preparePosCatalog(priced, categories, 'branch', ['expensive']);
  const ordered = selectPosProducts(custom, { activeCat: 'cakes' });
  assert.deepEqual(ids(ordered), ['expensive', 'cheap', 'middle']);
  assert.strictEqual(ordered[0], priced[0], 'a new display order does not recreate or reprice products');
});

test('a category removed during a shop change safely returns an empty view until the UI resets it', () => {
  const prepared = preparePosCatalog(pricePosProducts([{ id: 'a', name: 'A', price: 10, category_id: 'drinks' }], 'other'), categories, 'other', []);
  assert.deepEqual(selectPosProducts(prepared, { activeCat: 'removed' }), []);
});
