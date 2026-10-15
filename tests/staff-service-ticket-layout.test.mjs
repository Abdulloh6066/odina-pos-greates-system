// Offline-only regression checks for the real POS kitchen/service receipt UI.
// No live Base44 calls, sales, payments, stock changes or print invocations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { Printer, AlertCircle, Loader2, UtensilsCrossed, X } from 'lucide-react';
import { isStaffTicketEnabled } from '../src/lib/staff-order-ticket.js';

const source = readFileSync('src/components/tables/StaffOrderTicketModal.jsx', 'utf8');
const start = source.indexOf('function getTicketPrintCount(');
assert.ok(start > -1, 'Expected the existing shared staff receipt component');
const body = source.slice(start).replace('export default function StaffOrderTicketModal', 'function StaffOrderTicketModal');
const transformed = transformSync(`${body}\nglobalThis.TestTicket = StaffOrderTicketModal;`,
  { loader: 'jsx', jsx: 'transform' }).code;
const Wrapper = ({ children }) => React.createElement('div', null, children);
const context = {
  React, useEffect: React.useEffect, useState: React.useState,
  useRef: React.useRef, useCallback: React.useCallback,
  Printer, AlertCircle, Loader2, UtensilsCrossed, X,
  isStaffTicketEnabled, base44: {}, createPortal: () => null,
  formatUzbekistanDateTime: () => '2026-09-20 00:54',
  Dialog: Wrapper, DialogContent: Wrapper, DialogTitle: Wrapper,
  DialogDescription: Wrapper, Button: Wrapper,
  staffTicketFromSale: (sale) => sale,
  staffTicketFromCustomerOrder: (order) => order,
};
vm.runInNewContext(transformed, context);
const render = (order, extra = {}) => renderToStaticMarkup(React.createElement(context.TestTicket, {
  open: true, onClose: () => {}, shop: { id: 'shop-1', name: 'Odina Central' },
  order, mode: 'table', tableNumber: order.table_number, ...extra,
}));

const example = {
  id: 'mock-staff-order', number: 3, table_number: 3, revision: 1,
  started_at: '2026-09-19T19:54:00.000Z', opened_by_name: 'Abdulloh Rajabov',
  items: [{ product_name: 'ХУРАСАН КИЧИК', quantity: 1 },
    { product_name: 'ХУРАСАН КАТТА', quantity: 2 }],
};

test('real ticket component renders reference hierarchy with authentic order/table and quantity', () => {
  const html = render(example);
  const header = html.indexOf('BUYURTMA № #3');
  const table = html.indexOf('3-stol', header);
  const time = html.indexOf('VAQT', table);
  const taker = html.indexOf('BUYURTMA OLUVCHI', time);
  const first = html.indexOf('ХУРАСАН КИЧИК', taker);
  const second = html.indexOf('ХУРАСАН КАТТА', first);
  assert.ok(header > -1 && table > header && time > table && taker > time && first > taker && second > first);
  assert.match(html, /2026-09-20 00:54/);
  assert.match(html, /Abdulloh Rajabov/);
  assert.match(html, /border-dashed/);
  assert.match(html, /max-w-\[440px\]/);
  assert.doesNotMatch(html, /QAYTA CHOP ETILDI|REPRINT|to‘lov hujjati|formatUZS/);
  assert.ok(html.indexOf('ХУРАСАН КАТТА') < html.lastIndexOf('2'), 'Real item quantity is not replaced with sample data');
});

test('one shop-wide ticket number is printed independently of table number and full sale ID', () => {
  const table = render({ ...example, ticket_number: 110 });
  assert.match(table, /BUYURTMA № #110/);
  assert.match(table, /3-stol/);
  assert.doesNotMatch(table, /BUYURTMA № #3/);
  const sale = render({ ...example, table_number: null, number: 111 },
    { tableNumber: undefined, mode: 'sale' });
  assert.match(sale, /BUYURTMA № #111/);
  assert.match(sale, /Olib ketish/);
});

test('ordinary sale does not falsely show a table, and reprints have only a discreet footer', () => {
  const ordinary = render({ ...example, table_number: null, number: 'OD-20260920-REAL' }, { tableNumber: undefined, mode: 'sale' });
  assert.match(ordinary, /BUYURTMA № #OD-20260920-REAL/);
  assert.match(ordinary, /Olib ketish/);
  assert.doesNotMatch(ordinary, /Oddiy buyurtma/);
  assert.doesNotMatch(ordinary, /1-stol/);
  const reprint = render({ ...example, revision: 2 });
  assert.match(reprint, /Qayta chop · 2-tahrir/);
  assert.doesNotMatch(reprint, /QAYTA CHOP ETILDI|REPRINT/);
});

test('delivery service ticket uses the saved marker and respects the paused Central shop', () => {
  const delivery = render({ ...example, table_number: null, number: 112, is_delivery: true }, { tableNumber: undefined, mode: 'sale' });
  assert.match(delivery, /Dostavka/);
  assert.doesNotMatch(delivery, /Olib ketish/);
  assert.equal(render(example, { shop: { id: '6a96f0a4ecc85c2fc57f3173' } }), '');
});

test('screen and 80mm printer share one ticket template; printed paper fits the printer width', () => {
  assert.match(source, /renderTicketContent\(false\)/);
  assert.match(source, /renderTicketContent\(true\)/);
  assert.doesNotMatch(source, /max-w-\[340px\]/);
  assert.doesNotMatch(source, /ticketOrder\?\.number \|\| displayTableNumber \|\| '1'/);
  const css = readFileSync('src/index.css', 'utf8');
  assert.match(css, /@page \{ size: 80mm auto; margin: 0; \}/);
  assert.match(css, /\.receipt-print\.staff-order-ticket \{[^}]*box-sizing: border-box/);
  assert.match(css, /\.receipt-print \{[^}]*width: 80mm;[^}]*padding: 4mm/s);
  assert.doesNotMatch(source, /entities\.(Sale|Payment|Shop|ProductStock)\.(create|update|delete)/);
});