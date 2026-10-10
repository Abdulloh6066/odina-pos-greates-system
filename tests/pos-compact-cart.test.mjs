// Memory-only regression for the actual POS cart markup. No Base44 requests,
// live orders, sales, payments, discounts or stock writes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { saleLineKey } from '../base44/shared/burger-fries.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

const source = readFileSync('src/components/pos/Cart.jsx', 'utf8');
const css = readFileSync('src/styles/odina-retail.css', 'utf8');
const start = source.indexOf('export default function Cart(');
assert.ok(start >= 0);
const componentSource = source.slice(start).replace('export default function Cart(', 'function Cart(').replace(/export function /g, 'function ');
const transformed = transformSync(`${componentSource}\nglobalThis.TestCart = Cart; globalThis.TestDiscountRow = DiscountRow;`, {
  loader: 'jsx', jsx: 'transform',
}).code;
const Icon = () => React.createElement('span', { 'aria-hidden': true });
const Button = ({ children, disabled, type, onClick, className, ...rest }) =>
  React.createElement('button', { disabled, type, onClick, className, ...rest }, children);
const context = {
  saleLineKey, React, useState: React.useState, formatUZS: (value) => `${value.toLocaleString('en-US')} UZS`,
  Minus: Icon, Plus: Icon, Trash2: Icon, Ticket: Icon, X: Icon,
  ShoppingBag: Icon, ReceiptText: Icon, ArrowUpRight: Icon,
  Button, Input: ({ 'aria-label': ariaLabel, placeholder }) =>
    React.createElement('input', { 'aria-label': ariaLabel, placeholder }),
};
vm.runInNewContext(transformed, context);

const items = Array.from({ length: 6 }, (_, index) => ({
  product_id: `p${index + 1}`, product_name: `Mahsulot ${index + 1}`,
  price: 5000, quantity: index + 1, subtotal: 5000 * (index + 1), image_url: '',
}));
const noop = () => {};
function render(overrides = {}) {
  return renderToStaticMarkup(React.createElement(context.TestCart, {
    cart: items, onInc: noop, onDec: noop, onRemove: noop, onClear: noop,
    subtotal: 105000, discount: 0, couponDiscount: 0, discountCode: '',
    onApplyDiscount: noop, onRemoveDiscount: noop, discountError: '',
    roundingTarget: null, adjustmentMode: null, roundingError: '',
    onApplyRounding: noop, onApplyManualDiscount: noop, onRemoveRounding: noop,
    total: 105000, onCheckout: noop, disabled: false, ...overrides,
  }));
}

test('six products render as compact receipt-like rows with prices, totals, image/fallback and separators', () => {
  const html = render();
  assert.equal((html.match(/odina-cart-line /g) || []).length, 6);
  assert.equal((html.match(/border-b border-dashed/g) || []).length, 6);
  assert.match(html, /Mahsulot 1/);
  assert.match(html, /Mahsulot 6/);
  assert.match(html, /5,000 UZS/);
  assert.match(html, /30,000 UZS/);
  assert.match(html, /105,000 UZS/);
  assert.match(html, /w-9 h-9/);
  assert.doesNotMatch(html, /odina-cart-line[^\"]*rounded-2xl/);
  assert.match(css, /\.odina-cart-line \{ background:transparent;[^}]*border-radius:0;/);
});

test('compact quantity and touch-friendly removal controls retain names and callback wiring', () => {
  const html = render();
  assert.match(html, /Mahsulot 1 miqdorini kamaytirish/);
  assert.match(html, /Mahsulot 1 miqdorini oshirish/);
  assert.match(html, /Mahsulot 1ni buyurtmadan olib tashlash/);
  assert.match(html, /w-9 h-9 rounded-l-lg/);
  assert.match(html, /w-9 h-9 rounded-r-lg/);
  assert.match(html, /h-11 w-11/);
  assert.match(source, /onClick=\{\(\) => onDec\(item\)\}/);
  assert.match(source, /onClick=\{\(\) => onInc\(item\)\}/);
  assert.match(source, /onClick=\{\(\) => onRemove\(item\)\}/);
});

test('locked cart still disables editing; table-save, discount and checkout actions remain present', () => {
  const locked = render({ locked: true, tableMode: true, tableDirty: true,
    onSaveTable: noop, onCancelTable: noop });
  assert.match(locked, /Stolga saqlash/);
  assert.match(locked, /Hisobni yopish · To‘lov/);
  // Discount controls now render in the payment modal, not the compact cart.
  const discount = renderToStaticMarkup(React.createElement(context.TestDiscountRow, {
    discountCode: '', discount: 0, onApplyDiscount: noop, onRemoveDiscount: noop,
  }));
  assert.match(discount, /Chegirma kodi/);
  assert.match(locked, /disabled=""/);
  assert.match(source, /disabled=\{disabled \|\| locked \|\| cart\.length === 0\}/);
  const empty = render({ cart: [], subtotal: 0, total: 0 });
  assert.match(empty, /Yangi buyurtma kutmoqda/);
  assert.equal((empty.match(/odina-cart-line /g) || []).length, 0);
});
