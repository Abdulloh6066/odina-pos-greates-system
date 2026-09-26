// Offline receipt markup/wiring tests. Lifecycle behavior is tested with a
// simulated browser in receipt-lifecycle-reliability.test.mjs; no live printer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const receipt = fs.readFileSync(new URL('../src/components/pos/Receipt.jsx', import.meta.url), 'utf8');
const pos = fs.readFileSync(new URL('../src/pages/POS.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('printed 80mm receipt uses saved sale items, payments and shop contacts', () => {
  assert.match(receipt, /sale\.items\?\.map/);
  assert.match(receipt, /sale\.payments\?\.map/);
  assert.match(receipt, /formatUZS\(sale\.total\)/);
  assert.match(receipt, /sale\.sale_number/);
  assert.match(receipt, /sale\.receipt_phone_snapshot/);
  assert.match(receipt, /return createPortal\(/);
  assert.match(receipt, /className="receipt-print sale-receipt hidden/);
  assert.match(css, /\.receipt-print\.sale-receipt \{ display: block !important; \}/);
  assert.match(css, /body\.odina-sale-printing > #root \{ display: none !important; \}/);
});

test('receipt delegates print lifecycle, preserves the off preference, and supplies recovery warning', () => {
  assert.match(receipt, /if \(!print \|\| !sale\) return undefined/);
  assert.match(receipt, /return startReceiptPrint\(/);
  assert.match(receipt, /onDone: \(\) => onAfterPrintRef\.current\?\.\(sale\)/);
  assert.match(receipt, /onWarning:/);
  assert.match(receipt, /if \(!sale \|\| !print\) return null/);
});

test('POS decides post-print presentation without repeating the financial transaction', () => {
  assert.match(pos, /if \(sale\?\.items\?\.length && !sale\?\.table_number_snapshot\)/);
  assert.match(pos, /onAfterPrint=\{finishSalePresentation\}/);
  const start = pos.indexOf('  const finishSalePresentation =');
  const end = pos.indexOf('  const finishQueuedSale =', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(pos.slice(start, end), /functions\.invoke|entities\./);
});
