// Delivery marker: memory-only financial and rendered UI tests. Never touches live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';
import * as fries from '../src/lib/burger-fries.js';
import { staffTicketFromSale } from '../src/lib/staff-order-ticket.js';
import { buildPendingSale, syncPendingSales } from '../src/lib/offline-sales.js';
import { memoryBackend } from './helpers/memory-backend.mjs';

const shopId = '6a96f0a4ecc85c2fc57f3174';
const tick = () => new Promise(resolve => setImmediate(resolve));
const formatUZS = value => String(value || 0) + ' so‘m';
function backend() {
  const f = memoryBackend({
    User: [{ id: 'cashier', email: 'cashier@example.test', role: 'cashier', active: true, shop_id: shopId }],
    Shop: [{ id: shopId, name: 'Odina Branch', active: true, location_type: 'shop', allows_pos: true, restaurant_table_count: 4 }],
    Shift: [{ id: 'shift', user_id: 'cashier', shop_id: shopId, shop_name: 'Odina Branch', status: 'open',
      opened_at: '2026-10-15T04:00:00Z', expected_cash: 0, total_sales: 0, order_count: 0, sale_request_keys: [] }],
    Product: [{ id: 'coffee', name: 'Kapuchino', price: 28000, active: true, track_stock: false, source_type: 'resale' }],
    Settings: [{ allow_negative_stock: false }], Sale: [], SaleItem: [], Payment: [], StockMovement: [], ActionHistory: [],
  }, { now: '2026-10-15T10:00:00Z' });
  const handlers = new Map();
  async function call(file, body) {
    if (!handlers.has(file)) {
      let registered;
      const mod = f.load(file, { Deno: { serve: handler => { registered = handler; }, env: { get: () => undefined } }, setTimeout, clearTimeout, performance });
      handlers.set(file, mod.default || registered);
    }
    assert.equal(typeof handlers.get(file), 'function');
    const response = await handlers.get(file)({ json: async () => structuredClone(body) });
    return { status: response.status, data: await response.json() };
  }
  return { ...f, sale: body => call('base44/functions/complete-sale/entry.ts', body),
    order: body => call('base44/functions/restaurant-tables/entry.ts', body) };
}
function saleRequest(extra = {}) {
  return { action: 'complete_sale', shift_id: 'shift', idempotency_key: 'pos-delivery-check-0001',
    recorded_at: '2026-10-15T09:00:00Z', items: [{ product_id: 'coffee', quantity: 2 }],
    payments: [{ method: 'cash', amount: 56000 }], ...extra };
}
test('delivery and ordinary checkout have identical prices, payment amounts and stock behavior', async () => {
  for (const is_delivery of [undefined, false, true]) {
    const f = backend(), request = saleRequest(is_delivery === undefined ? {} : { is_delivery });
    const reply = await f.sale(request);
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    assert.equal(reply.data.sale.is_delivery, is_delivery === true);
    assert.equal(reply.data.sale.total, 56000);
    assert.equal(f.db.Payment[0].amount, 56000);
    assert.equal(f.db.SaleItem[0].quantity, 2);
    assert.equal(f.db.StockMovement.length, 0);
    assert.equal(f.db.Sale.length, 1);
  }
});
test('invalid delivery values and a table marked as delivery never create financial records', async () => {
  for (const extra of [{ is_delivery: 'true' }, { is_delivery: 1 }, { is_delivery: null },
    { is_delivery: true, table_number: 1, table_shop_id: shopId }]) {
    const f = backend(), reply = await f.sale(saleRequest(extra));
    assert.equal(reply.status, 400, JSON.stringify(reply.data));
    assert.equal(f.db.Sale.length, 0); assert.equal(f.db.Payment.length, 0);
    assert.equal(f.db.Shift[0].total_sales, 0);
  }
});
test('a lost delivery-sale response safely replays the same receipt; its marker cannot change on retry', async () => {
  const f = backend(), request = saleRequest({ is_delivery: true });
  const first = await f.sale(request), again = await f.sale(request);
  assert.equal(first.status, 200); assert.equal(again.status, 200);
  assert.equal(again.data.sale.id, first.data.sale.id);
  assert.equal(again.data.sale.is_delivery, true);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.Shift[0].order_count, 1);
  const changed = await f.sale({ ...request, is_delivery: false });
  assert.equal(changed.status, 409); assert.equal(f.db.Sale[0].is_delivery, true);
  const legacy = backend();
  const ordinary = await legacy.sale(saleRequest());
  assert.equal(ordinary.status, 200);
  assert.equal((await legacy.sale(saleRequest({ is_delivery: false }))).status, 200, 'legacy absent/false marker preserves the fingerprint');
});
test('an offline delivery receipt keeps its marker through storage, server sync and lost acknowledgment', async () => {
  const f = backend();
  const row = buildPendingSale({ idempotencyKey: 'pos-delivery-offline-0001', recordedAt: '2026-10-15T09:00:00Z',
    shift: f.db.Shift[0], user: f.db.User[0], isDelivery: true,
    cart: [{ product_id: 'coffee', product_name: 'Kapuchino', price: 28000, quantity: 2 }],
    payments: [{ method: 'cash', amount: 56000 }] });
  let rows = [JSON.parse(JSON.stringify(row))], loseReply = true;
  assert.equal(rows[0].local_sale.is_delivery, true);
  const storage = { list: async () => structuredClone(rows),
    update: async (id, patch) => Object.assign(rows.find(row => row.id === id), patch),
    remove: async id => { rows = rows.filter(row => row.id !== id); } };
  const send = async request => {
    assert.equal(request.is_delivery, true);
    const result = await f.sale(request); assert.equal(result.status, 200, JSON.stringify(result.data));
    if (loseReply) { loseReply = false; throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }); }
    return result.data;
  };
  const sync = extra => syncPendingSales({ userId: 'cashier', storage, send, lock: run => run(), ...extra });
  await sync(); assert.equal(rows.length, 1);
  const result = await sync({ retryFailed: true });
  assert.equal(result.synced, 1); assert.equal(rows.length, 0);
  assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
  assert.equal(f.db.Sale[0].is_delivery, true);
});
test('saved unpaid delivery survives reopening and retry, requires matching checkout and does not create revenue early', async () => {
  const f = backend();
  const request = { action: 'save_takeaway_order', shop_id: shopId, shift_id: 'shift',
    order_id: 'delivery-order-0001', expected_revision: 0, is_delivery: true,
    items: [{ product_id: 'coffee', quantity: 2 }] };
  const saved = await f.order(request); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.order.is_delivery, true); assert.equal(f.db.Sale.length, 0);
  const retry = await f.order(request);
  assert.equal(retry.data.order.revision, 1); assert.equal(retry.data.unchanged, true);
  const changedRetry = await f.order({ ...request, is_delivery: false });
  assert.equal(changedRetry.status, 409);
  const reopened = await f.order({ action: 'get_takeaway_order', shop_id: shopId, order_id: request.order_id });
  assert.equal(reopened.data.order.is_delivery, true);
  const checkout = saleRequest({ takeaway_order_id: request.order_id, takeaway_order_revision: 1 });
  assert.equal((await f.sale(checkout)).status, 409, 'an omitted delivery flag cannot silently relabel a saved order');
  assert.equal(f.db.Sale.length, 0);
  const paid = await f.sale({ ...checkout, is_delivery: true });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.is_delivery, true);
});
test('saved-order edits can change only the marker and older clients preserve it', async () => {
  const f = backend();
  const request = { action: 'save_takeaway_order', shop_id: shopId, shift_id: 'shift',
    order_id: 'delivery-order-0002', expected_revision: 0, is_delivery: true,
    items: [{ product_id: 'coffee', quantity: 1 }] };
  assert.equal((await f.order(request)).status, 200);
  const { is_delivery: ignored, ...oldClient } = request;
  const preserved = await f.order({ ...oldClient, expected_revision: 1 });
  assert.equal(preserved.data.order.is_delivery, true);
  const changed = await f.order({ ...request, expected_revision: 2, is_delivery: false });
  assert.equal(changed.status, 200); assert.equal(changed.data.order.is_delivery, false);
  assert.equal(f.db.Sale.length, 0); assert.equal(f.db.Payment.length, 0);
});

const Wrap = ({ children }) => React.createElement('div', null, children);
const Button = ({ children, onClick, disabled, ...props }) => React.createElement('button',
  { onClick, disabled, 'aria-label': props['aria-label'], 'aria-pressed': props['aria-pressed'], className: props.className, type: props.type }, children);
const Input = props => React.createElement('input', props);
function component(path, mocks = {}, globals = {}) {
  const mod = { exports: {} };
  const code = transformSync(readFileSync(path, 'utf8'), { loader: 'jsx', format: 'cjs', target: 'es2022' }).code;
  const defaults = { react: React, 'lucide-react': icons,
    '@/components/ui/button': { Button }, '@/components/ui/input': { Input },
    '@/lib/pos': { formatUZS, formatNum: String, saleOccurredAt: sale => sale.sold_at, saleBusinessDate: sale => sale.business_date },
    '@/lib/burger-fries': fries,
    '@/components/ui/dialog': { Dialog: ({ open, children }) => open ? React.createElement('div', null, children) : null,
      DialogContent: Wrap, DialogHeader: Wrap, DialogTitle: Wrap },
  };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console, ...globals })(
    name => { if (name.endsWith('.css')) return {};
      const result = { ...defaults, ...mocks }[name];
      if (result === undefined) throw Error('Unexpected UI test dependency: ' + name);
      return result; }, mod, mod.exports);
  return mod.exports.default;
}
function declaration(name) {
  const source = readFileSync('src/pages/POS.jsx', 'utf8');
  const ast = ts.createSourceFile('POS.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX); let found;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer.getText(ast); ts.forEachChild(node, visit); };
  visit(ast); assert.ok(found, name); return 'const ' + name + ' = ' + found + ';';
}
test('cart delivery toggle is accessible, locks during checkout and the actual new-cart reset clears it', () => {
  const Cart = component('src/components/pos/Cart.jsx');
  const base = { cart: [], subtotal: 0, total: 0, disabled: false, onCheckout: () => {} };
  function Probe({ locked = false, tableMode = false }) {
    const [isDelivery, setIsDelivery] = React.useState(false);
    return React.createElement(Cart, { ...base, locked, tableMode, isDelivery, onDeliveryChange: setIsDelivery });
  }
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
  let toggle = renderer.root.findByProps({ 'aria-label': 'Dostavka', type: 'button' });
  assert.equal(toggle.props['aria-pressed'], false);
  act(() => toggle.props.onClick());
  toggle = renderer.root.findByProps({ 'aria-label': 'Dostavka', type: 'button' });
  assert.equal(toggle.props['aria-pressed'], true);
  act(() => renderer.update(React.createElement(Probe, { locked: true })));
  assert.equal(renderer.root.findByProps({ 'aria-label': 'Dostavka', type: 'button' }).props.disabled, true);
  act(() => renderer.update(React.createElement(Probe, { tableMode: true })));
  assert.equal(renderer.root.findAllByProps({ 'aria-label': 'Dostavka' }).length, 0);
  act(() => renderer.unmount());
  const ctx = { takeawayRequestIdRef: { current: 'previous-order' }, isDelivery: true };
  for (const name of ['setCart','setDiscountCode','setDiscountPct','setDiscountError','setDiscountOwnerPin','setRoundingTarget','setAdjustmentMode','setRoundingError']) ctx[name] = () => {};
  ctx.setIsDelivery = value => { ctx.isDelivery = value; };
  vm.runInNewContext(declaration('resetCart') + '\nresetCart();', ctx);
  assert.equal(ctx.isDelivery, false); assert.equal(ctx.takeawayRequestIdRef.current, '');
});
test('service-ticket adapter preserves delivery and defaults historical sales to ordinary', () => {
  const sale = { id: 'sale', is_delivery: true, items: [{ product_name: 'Kapuchino', quantity: 2 }] };
  assert.equal(staffTicketFromSale(sale).is_delivery, true);
  assert.equal(staffTicketFromSale({ ...sale, is_delivery: undefined }).is_delivery, false);
  assert.equal(staffTicketFromSale(sale).items[0].quantity, 2);
});

test('financial receipt prints a clear delivery marker from the saved snapshot and keeps ordinary receipts unchanged', () => {
  const Receipt = component('src/components/pos/Receipt.jsx', {
    'react-dom': { createPortal: content => content },
    '@/lib/receipt-print-lifecycle': { startReceiptPrint: () => () => {} },
    '@/components/ui/use-toast': { toast: () => {} },
    '@/lib/uzbekistan-time': { formatUzbekistanDateTime: () => '15.10.2026 15:00' },
    '@/components/brand/odina-mark': 'logo.png', '@/lib/receipt-wishes': { receiptWishForSale: () => 'Rahmat' },
  }, { document: { body: {} } });
  const sale = { id: 'saved-sale', total: 56000, subtotal: 56000, items: [], payments: [], shop_name: 'Odina Branch', is_delivery: true };
  const html = renderToStaticMarkup(React.createElement(Receipt, { sale: JSON.parse(JSON.stringify(sale)), print: true }));
  assert.match(html, />DOSTAVKA</); assert.match(html, /56000/);
  for (const is_delivery of [false, undefined]) {
    const ordinary = renderToStaticMarkup(React.createElement(Receipt, { sale: { ...sale, is_delivery }, print: true }));
    assert.doesNotMatch(ordinary, />DOSTAVKA</);
  }
});
test('sales history shows/searches the delivery marker and reprints the same saved sale without creating another sale', async () => {
  const sale = { id: 'delivery-sale', is_delivery: true, total: 56000, subtotal: 56000, status: 'completed', items: [],
    payments: [], sold_at: '2026-10-15T09:00:00Z', business_date: '2026-10-15', shop_name: 'Odina Branch' };
  let receiptProps, settingsReads = 0, saleReads = 0;
  const History = component('src/pages/SalesHistory.jsx', {
    'react-router-dom': { useOutletContext: () => ({ user: { id: 'owner', role: 'admin' } }) },
    '@/api/base44Client': { base44: { entities: {
      Sale: { list: async () => { saleReads++; return [sale, { ...sale, id: 'ordinary-sale', is_delivery: false }]; } },
      Settings: { list: async () => { settingsReads++; return [{ shop_name: 'Odina Tort' }]; } },
    }, functions: { invoke: () => { throw Error('Reprinting must not write a new sale'); } } } },
    '@/lib/odina-dialog': { odinaAlert: message => { throw Error(message); } },
    '@/lib/uzbekistan-time': { formatUzbekistan: () => '15 okt', formatUzbekistanDateTime: () => '15 okt 15:00' },
    '@/components/PageHeader': Wrap, '@/components/pos/KassaActionDialogs': { RefundDialog: () => null },
    '@/components/tables/StaffOrderTicketModal': () => null,
    '@/lib/staff-order-ticket': { isStaffTicketEnabled: () => false },
    '@/components/pos/Receipt': props => { receiptProps = props; return null; },
  });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(History)); await tick(); });
  assert.equal(settingsReads, 0, 'reprint adds no startup read');
  const search = renderer.root.findAllByType('input').find(node => node.props.type !== 'date');
  act(() => search.props.onChange({ target: { value: 'dostavka' } }));
  const rows = renderer.root.findAllByType('button').filter(node => node.props.className?.includes('odina-sale-row'));
  assert.equal(rows.length, 1);
  act(() => rows[0].props.onClick());
  const printButton = () => renderer.root.findAllByType('button').find(node => node.children.some(child => typeof child === 'string' && child.includes('Chekni chiqarish')));
  await act(async () => { await printButton().props.onClick(); });
  assert.equal(settingsReads, 1); assert.equal(receiptProps.sale.id, sale.id);
  assert.equal(receiptProps.sale.is_delivery, true); assert.equal(receiptProps.print, true);
  act(() => receiptProps.onAfterPrint());
  await act(async () => { await printButton().props.onClick(); });
  assert.equal(settingsReads, 1); assert.equal(saleReads, 1); assert.equal(receiptProps.sale.is_delivery, true);
  act(() => renderer.unmount());
});
