// Run the real POS add/choice callbacks in memory; no shift, sale, stock or network writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as helpers from '../src/lib/burger-fries.js';

const source = readFileSync('src/pages/POS.jsx', 'utf8');
const callbacks = source.slice(source.indexOf('  const addToCart = (product) => {'),
  source.indexOf('  useEffect(() => { setBurgerProduct(null);'));
const [classicId, miniId] = helpers.BURGER_PRODUCT_IDS;
function harness(shift = null) {
  const ctx = { ...helpers, shift, user: { role: 'admin' }, cart: [], burgerProduct: null,
    tableLocked: false, paying: false, payOpen: false, stockChecking: false,
    openWeight: () => { throw new Error('Unexpected weight prompt'); },
    setCart: update => { ctx.cart = update(ctx.cart); },
    setBurgerProduct: value => { ctx.burgerProduct = value; },
    setKeyboardProductId: value => { ctx.selectedKey = value; },
  };
  vm.runInNewContext(callbacks + '\nglobalThis.api = { addToCart, saveBurgerChoice };', ctx);
  return ctx;
}

test('unassigned owner sees the burger choice before a shift; choosing fries adds the extra 5000', () => {
  const ctx = harness();
  ctx.api.addToCart({ id: classicId, name: 'Burger classic', price: 42000 });
  assert.equal(ctx.burgerProduct.id, classicId);
  assert.equal(ctx.cart.length, 0, 'wait for a deliberate choice');
  ctx.api.saveBurgerChoice('with');
  assert.equal(ctx.cart.length, 1);
  assert.equal(ctx.cart[0].price, 47000);
  assert.equal(ctx.cart[0].fries_option, 'with');
  assert.equal(ctx.cart[0].quantity, 1);
  assert.match(ctx.cart[0].product_name, /Fri bilan/);
  assert.equal(ctx.burgerProduct, null);
});

test('mini burger is one portion, and cancelling the choice adds nothing', () => {
  const ctx = harness();
  ctx.api.addToCart({ id: miniId, name: 'Burger mini (3 ta)', price: 55000 });
  ctx.setBurgerProduct(null);
  ctx.api.saveBurgerChoice('with');
  assert.equal(ctx.cart.length, 0);
  ctx.api.addToCart({ id: miniId, name: 'Burger mini (3 ta)', price: 55000 });
  ctx.api.saveBurgerChoice('without');
  assert.equal(ctx.cart[0].quantity, 1);
  assert.equal(ctx.cart[0].price, 55000);
  assert.match(ctx.cart[0].product_name, /Frisiz/);
});

test('active Branch still offers the choice and uses its shop-specific price', () => {
  const ctx = harness({ shop_id: helpers.BURGER_FRIES_SHOP_ID });
  ctx.api.addToCart({ id: classicId, name: 'Burger classic', price: 37000 });
  assert.ok(ctx.burgerProduct);
  ctx.api.saveBurgerChoice('with');
  assert.equal(ctx.cart[0].price, 42000);
});

test('ordinary products keep their immediate-add behavior', () => {
  const ctx = harness();
  ctx.api.addToCart({ id: 'cake', name: 'Tort', price: 25000 });
  assert.equal(ctx.burgerProduct, null);
  assert.equal(ctx.cart[0].product_id, 'cake');
  assert.equal(ctx.cart[0].quantity, 1);
});

test('opening Branch applies its prices to an unsaved preview cart without mutating old rows', () => {
  const original = [{ product_id: classicId, fries_option: 'without', quantity: 1, price: 42000, subtotal: 42000 },
    { product_id: classicId, fries_option: 'with', quantity: 2, price: 47000, subtotal: 94000 },
    { product_id: 'cake', quantity: 1, price: 25000, subtotal: 25000 }];
  const product = { id: classicId, price: 42000, shop_prices: { [helpers.BURGER_FRIES_SHOP_ID]: 37000 } };
  const adjusted = helpers.repriceBurgerCartForShop(original, [product], helpers.BURGER_FRIES_SHOP_ID);
  assert.equal(adjusted[0].price, 37000);
  assert.equal(adjusted[1].price, 42000);
  assert.equal(adjusted[1].subtotal, 84000);
  assert.equal(adjusted[2], original[2]);
  assert.equal(original[1].subtotal, 94000);
  assert.equal(helpers.repriceBurgerCartForShop(adjusted, [product], helpers.BURGER_FRIES_SHOP_ID), adjusted);
});

test('preview access cannot authorize a sale without a real Branch shop', () => {
  assert.equal(helpers.canPreviewBurgerFries(classicId, undefined), true);
  assert.equal(helpers.canPreviewBurgerFries(classicId, 'other-shop'), false);
  assert.throws(() => helpers.validateFriesOption({ product_id: classicId, fries_option: 'with' }, undefined),
    error => error.status === 400);
});
