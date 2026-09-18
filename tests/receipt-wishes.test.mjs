// Pure receipt-message checks. No Base44 records, printer or network calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RECEIPT_WISHES, receiptWishForSale } from '../src/lib/receipt-wishes.js';

const requestedWishes = [
  'Bugungi kuningiz shirin lahzalarga boy bo‘lsin! ❤️',
  'Tabassumingiz hech qachon yuzingizdan arimasin!',
  'Baxt ba’zan bir bo‘lak tortdan boshlanadi. 🍰',
  'Hayotning eng shirin lahzalari hali oldinda!',
  'Bugun tabassum qilish uchun yana bir sababingiz bor. ❤️',
  'Shirinlikni bizdan, yaxshi kayfiyatni hayotdan oling!',
  'Orzularingiz siz o‘ylagandan ham yaqinroq bo‘lsin.',
];

test('receipt includes exactly the seven selected messages, once each', () => {
  assert.deepEqual([...RECEIPT_WISHES], requestedWishes);
  assert.equal(new Set(RECEIPT_WISHES).size, 7);
});

test('a sale retains its message on repeat view, reprint, and offline sync', () => {
  const number = 'OD-20260918-XYZ10001';
  const initial = receiptWishForSale({ sale_number: number });
  assert.equal(receiptWishForSale({ id: 'server-id', sale_number: number }), initial);
  assert.equal(receiptWishForSale({ id: 'offline-id', sale_number: number, offline_pending: true }), initial);
  assert.equal(receiptWishForSale({ sale_number: number }), initial);
  assert.ok(RECEIPT_WISHES.includes(initial));
});

test('many distinct sales automatically select from all seven choices', () => {
  const selected = new Set(Array.from({ length: 500 }, (_, index) =>
    receiptWishForSale({ sale_number: `OD-20260918-${String(index).padStart(8, '0')}` }),
  ));
  assert.equal(selected.size, 7);
});

test('new receipt message prints inside the receipt while original footer remains', () => {
  const receipt = readFileSync('src/components/pos/Receipt.jsx', 'utf8');
  const printStyles = readFileSync('src/index.css', 'utf8');
  assert.match(receipt, /className="receipt-print/);
  assert.match(receipt, /\{receiptWishForSale\(sale\)\}/);
  assert.match(receipt, /settings\?\.thank_you_message/);
  assert.match(receipt, /settings\?\.receipt_footer/);
  assert.match(printStyles, /\.receipt-print, \.receipt-print \* \{ visibility: visible !important; \}/);
});
