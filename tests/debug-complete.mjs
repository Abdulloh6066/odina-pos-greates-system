
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

let clock = '2026-09-10T10:00:00.000Z';
function makeClock() {
  const RealDate = globalThis.Date;
  class MockDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return RealDate.parse(clock); }
  }
  return MockDate;
}

const db = {
  User: [{ id: 'u1', email: 'cashier@example.test', full_name: 'Test Cashier', role: 'admin', shop_id: '', active: true }],
  Shop: [{ id: 'shop-a', name: 'Filial A', active: true, allows_pos: true, location_type: 'shop' }],
  Product: [
    { id: 'cake-sheet', name: 'Tort varaq', category_name: 'Tortlar', production_unit: 'sheet', pieces_per_sheet: 20, sheet_price: 400000, price: 20000, active: true, archived: false, track_stock: true },
    { id: 'cake-piece', name: 'Kapykeyk', category_name: 'Pishiriqlar', production_unit: 'piece', price: 15000, active: true, archived: false, track_stock: true },
  ],
  Shift: [{ id: 'shift-a', user_id: 'u1', user_name: 'Test Cashier', shop_id: 'shop-a', shop_name: 'Filial A', status: 'open', opened_at: '2026-09-10T08:00:00.000Z', starting_cash: 0, expected_cash: 0, cash_sales: 0, uzcard_sales: 0, humo_sales: 0, online_sales: 0, bank_transfer_sales: 0, total_sales: 0, order_count: 0 }],
  ProductStock: [
    { id: 'ps-sheet', location_id: 'shop-a', product_id: 'cake-sheet', product_name: 'Tort varaq', unit: 'piece', quantity: 100 },
    { id: 'ps-piece', location_id: 'shop-a', product_id: 'cake-piece', product_name: 'Kapykeyk', unit: 'piece', quantity: 50 },
  ],
  StockMovement: [], Settings: [{ id: 's1', shop_name: 'Odina', allow_negative_stock: true }],
  CustomerOrder: [], CustomerOrderItem: [], OrderPayment: [], ActionHistory: [],
};
let seq = 0;
const clone = (v) => v == null ? v : structuredClone(v);
const matches = (row, q) => Object.entries(q||{}).every(([k,v]) => v && typeof v === 'object' && !Array.isArray(v) ? true : row[k] === v);
const entities = Object.fromEntries(Object.keys(db).map((name) => {
  const e = {
    get: async (id) => clone(db[name].find((r) => r.id === id) || null),
    list: async () => clone(db[name]),
    filter: async (q) => clone(db[name].filter((r) => matches(r, q))),
    create: async (data) => { const row = { ...clone(data), id: name + '-' + ++seq }; db[name].push(row); return clone(row); },
    updateMany: async (q, op) => { const rows = db[name].filter((r) => matches(r, q)); for (const row of rows) { Object.assign(row, clone(op.$set||{})); for (const [k,v] of Object.entries(op.$inc||{})) row[k] = Number(row[k]||0)+Number(v); } return { success: true, updated: rows.length }; },
    delete: async (id) => { db[name] = db[name].filter((r) => r.id !== id); },
  };
  e.bulkCreate = async (rows) => Promise.all(rows.map((r) => e.create(r)));
  return [name, e];
}));
const client = { asServiceRole: { entities }, auth: { me: async () => clone(db.User[0]) } };
const sharedSrc = readFileSync('base44/shared/shift-close-helpers.ts', 'utf8').replace(/export /g, '');
const sharedCode = ts.transpileModule(sharedSrc, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let source = readFileSync('base44/functions/customer-orders/entry.ts', 'utf8')
  .replace(/import { createClientFromRequest } from "npm:@base44\/sdk";/, 'const createClientFromRequest = () => client;')
  .replace(/import {[\s\S]*?} from "..\/..\/shared\/shift-close-helpers.ts";/, '')
  .replace(/export default async function\(req[^{]*{/, 'async function handler(req) {');
source = sharedCode + '\n' + source + '\nglobalThis.testHandler = handler;';
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const context = vm.createContext({ client, Response, crypto: webcrypto, console, structuredClone, Date: makeClock() });
vm.runInContext(code, context);
const call = async (body) => { const res = await context.testHandler({ json: async () => body }); return { status: res.status, data: await res.json() }; };
const createRes = await call({
  action: 'create_order', idempotency_key: 'k1',
  order_type: 'toy_va_bazmlar', customer_name: 'Vali', customer_phone: '+998901234567',
  required_date: '2026-09-15', required_time: '18:00', fulfilment_type: 'pickup', shop_id: 'shop-a',
  items: [{ product_id: 'cake-sheet', quantity: 2 }, { product_id: 'cake-piece', quantity: 10 }],
  advance_payment: { method: 'uzcard', amount: 950000 },
});
const order = db.CustomerOrder[db.CustomerOrder.length - 1];
order.order_status = 'tayyor';
await call({ action: 'complete_order', order_id: order.id, idempotency_key: 'cmp-h' });
const log = db.ActionHistory.find((a) => a.action === 'order_completed');
console.log('DETAILS:', JSON.stringify(log?.details));
console.log('INCLUDES 2026-09-10:', log?.details?.includes('2026-09-10'));
console.log('NOW value check:', new (makeClock())().toISOString());
