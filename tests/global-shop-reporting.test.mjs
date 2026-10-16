import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';
import * as reporting from '../src/lib/admin-shop-reporting.js';

const day = '2026-10-17';
const shops = [{ id: 'branch', name: 'Branch', active: true }, { id: 'central', name: 'Central', active: true }, { id: 'factory', name: 'Ishlab chiqarish', active: true }];
const scope = (shopId = 'all', extra = {}) => ({ isAdmin: true, shopId, specificShopId: shopId === 'all' ? '' : shopId, ready: true, shops, ...extra });
const metrics = (value) => ({ revenue: value, cost: value / 2, profit: value / 2, sales: value / 10, refunds: 1,
  orderPayments: 3, collections: value + 3, expenses: 2, netProfit: value / 2 - 2, unknownCostCount: 1,
  cash: value + 3, uzcard: 0, humo: 0, online: 0, bank_transfer: 0 });
const range = { date_from: day, date_to: day, notice: 'Original notice',
  shops: shops.slice(0, 2).map((shop, index) => ({ shop_id: shop.id, shop_name: shop.name, totals: metrics((index + 1) * 100), days: [{ date: day, ...metrics((index + 1) * 100) }] })),
  byDay: [{ date: day, ...metrics(300) }], dates: [day], grand: metrics(300) };
const time = {
  uzbekistanDateKey: (value) => value ? (typeof value === 'string' ? value : value.toISOString()).slice(0, 10) : day,
  uzbekistanMonthKey: () => day.slice(0, 7), uzbekistanMonthStartKey: () => day.slice(0, 7) + '-01',
  uzbekistanDateParts: () => ({ day: '17', month: '10', year: '2026' }),
  shiftDateKey: (date, delta) => new Date(Date.parse(date + 'T12:00:00Z') + delta * 86400000).toISOString().slice(0, 10),
  formatUzbekistanDate: (value) => String(value), formatUzbekistan: (value) => String(value), formatUzbekistanDateTime: (value) => String(value),
};
const wrapper = (tag) => ({ children, ...props }) => React.createElement(tag, props, children);
const text = (node) => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';

function compile(path, require, extra = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  }, reportDiagnostics: true });
  assert.equal(code.diagnostics?.length || 0, 0, path + ' must parse');
  vm.runInNewContext(code.outputText, { exports, require, console, setTimeout, clearTimeout, Date, ...extra }, { filename: path });
  return exports;
}
const history = compile('src/lib/history-pagination.js', () => time);
const shiftHelpers = compile('src/lib/shift-history.js', () => time);

async function fixture(page, { role = 'admin', initial = 'branch', pending = false } = {}) {
  const calls = [], queries = [], selections = [], guards = new Set(), deferred = [];
  let current = { user: { id: 'me', role, shop_id: 'branch' }, adminShopScope: scope(initial) };
  const rows = shops.slice(0, 2).map((shop, index) => ({ id: shop.id + '-sale', shop_id: shop.id, shop_name: shop.name,
    user_id: index ? 'other' : 'me', user_name: shop.name + ' kassiri', business_date: day, created_date: day,
    opened_at: day + 'T10:00:00Z', total: (index + 1) * 100, status: 'closed', items: [],
    amount: (index + 1) * 100, reason: shop.name + ' xarajat', created_at: day + 'T10:00:00Z' }));
  const wasteContext = { shops: shops.slice(0, 2), stock_items: [], expired_items: [], near_expiry_items: [], waste_records: [] };
  for (const [index, shop] of shops.slice(0, 2).entries()) {
    const item = { location_id: shop.id, product_id: shop.id + '-cake', product_name: shop.name + ' tort', quantity: index + 1, expired_quantity: index + 1, age_days: 4 };
    wasteContext.stock_items.push(item); wasteContext.expired_items.push(item);
    wasteContext.waste_records.push({ id: shop.id, location_id: shop.id, product_name_snapshot: shop.name + ' chiqit', status: 'recorded', quantity: index + 1, total_retail_value: 10, waste_number: shop.id });
  }
  const functions = { invoke: async (name, payload) => {
    calls.push({ name, payload: structuredClone(payload) });
    if (name === 'waste-ledger' && payload.action === 'get_context') return { data: wasteContext };
    if (name === 'daily-sales-export') {
      if (payload.action === 'range') return { data: range };
      if (payload.action === 'getConfig') return { data: { config: {} } };
      if (payload.action === 'preview') return { data: { reports: shops.slice(0, 2).map((shop, index) => ({ shop_id: shop.id, shop_name: shop.name, total_revenue: (index + 1) * 100 })) } };
    }
    if (name === 'profit-report' || name === 'audit-report') {
      const data = name === 'profit-report' ? { summary: { net_revenue: payload.shop_id === 'branch' ? 111 : 222 }, products: [] }
        : { rows: [], total: 0, summary: { sales_total: payload.shop_id === 'branch' ? 111 : 222 }, shops, users: [] };
      if (pending) return new Promise((resolve) => deferred.push({ shop: payload.shop_id, resolve: () => resolve({ data }) }));
      return { data };
    }
    throw new Error('Unexpected live write or function: ' + name + '/' + payload.action);
  } };
  const entities = new Proxy({}, { get: (_target, entity) => ({
    list: async () => entity === 'Shop' ? shops : entity === 'CashMovement' ? rows : entity === 'DailyShopReport' ? shops.slice(0, 2).map((shop) => ({ id: shop.id, shop_id: shop.id, shop_name: shop.name, business_date: day })) : [],
  }) });
  const timers = new Map(); let timer = 0;
  const audit = {
    defaultAuditFilters: () => ({ date_from: day, date_to: day, shop_id: 'all', user_id: 'all', category: 'all', query: '' }),
    auditRequestFilters: (filters) => ({ ...filters, shop_id: filters.shop_id === 'all' ? '' : filters.shop_id }),
    AUDIT_CATEGORY_OPTIONS: [], AUDIT_CATEGORY_STYLES: {}, AUDIT_ROLE_LABELS: {},
    auditSourceLabel: () => '', auditStatusLabel: () => '', formatAuditDateTime: () => '', downloadAuditCsv: () => '',
  };
  const require = (specifier) => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === 'react-router-dom') return { useOutletContext: () => current, Navigate: wrapper('navigate') };
    if (specifier === '@/lib/AuthContext') return { useAuth: () => current };
    if (specifier === '@/api/base44Client') return { base44: { entities, functions } };
    if (specifier === '@/lib/admin-shop-reporting') return reporting;
    if (specifier === '@/lib/history-pagination') return { ...history, readAllEntityPages: async () => shops };
    if (specifier === '@/lib/shift-history') return shiftHelpers;
    if (specifier === '@/lib/uzbekistan-time') return time;
    if (specifier === '@/lib/audit-export') return audit;
    if (specifier === '@/hooks/useEntityHistory') return { useEntityHistory: (_entity, query) => {
      queries.push(query);
      return { rows, loading: false, loadingMore: false, error: '', hasMore: false, reload: async () => {}, loadMore: async () => {} };
    } };
    if (specifier === '@/lib/pos') return { formatUZS: (value) => '$' + (value || 0), formatNum: (value) => String(value || 0),
      saleOccurredAt: (sale) => sale.created_date, saleBusinessDate: (sale) => sale.business_date, tashkentDateKey: () => day };
    if (specifier === '@/lib/waste') return { wasteDateTime: () => day };
    if (specifier === '@/lib/odina-dialog') return { odinaAlert: async () => {}, odinaConfirm: async () => false };
    if (specifier === '@/lib/staff-order-ticket') return { isStaffTicketEnabled: () => false };
    if (specifier.endsWith('/use-toast')) return { useToast: () => ({ toast: () => {} }) };
    if (specifier === '@/components/PageHeader') return { default: ({ title, subtitle, actions }) => React.createElement('header', {}, title, subtitle, actions) };
    if (specifier === '@/components/waste/WasteBatchDialog') return { default: wrapper('waste-dialog') };
    if (specifier.endsWith('/dialog')) return { Dialog: ({ open, children }) => open ? React.createElement('dialog', {}, children) : null,
      DialogContent: wrapper('div'), DialogHeader: wrapper('header'), DialogTitle: wrapper('h2') };
    if (specifier.endsWith('/odina-select')) return { default: wrapper('select') };
    if (specifier.endsWith('.css')) return {};
    if (specifier.includes('daily-report-logic')) return { reportsToCsv: () => '' };
    if (specifier.startsWith('@/components/profit/') || specifier.startsWith('@/components/tables/') || specifier.endsWith('/Receipt')) return { default: () => null };
    if (specifier === '@/components/pos/KassaActionDialogs') return { RefundDialog: () => null };
    if (specifier.startsWith('@/components/ui/') || specifier === 'lucide-react' || specifier === 'recharts') return new Proxy({}, { get: (_target, key) => wrapper(String(key).toLowerCase()) });
    throw new Error('Unexpected dependency: ' + specifier);
  };
  const component = compile(page, require, { window: { setTimeout: (fn) => { const id = ++timer; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id) } }).default;
  const makeScope = (id, extra = {}) => scope(id, { selectShop: (next) => { selections.push(next); return true; }, registerGuard: (fn) => { guards.add(fn); return () => guards.delete(fn); }, ...extra });
  current.adminShopScope = makeScope(initial);
  let tree;
  const props = () => page.includes('RealProfitDashboard') ? { adminShopScope: role === 'admin' ? current.adminShopScope : null } : {};
  await act(async () => { tree = create(React.createElement(component, props())); });
  return { tree, calls, queries, selections, guards, deferred,
    string: () => text(tree.toJSON()),
    setScope: async (id, extra = {}) => { current = { ...current, adminShopScope: makeScope(id, extra) }; await act(async () => tree.update(React.createElement(component, props()))); },
    flushTimers: async () => { await act(async () => { const pendingTimers = [...timers.values()]; timers.clear(); for (const fn of pendingTimers) await fn(); }); },
    close: async () => { await act(async () => tree.unmount()); },
  };
}

test('admin preference never changes non-admin scopes, including malformed admin preference', () => {
  for (const role of ['cashier', 'manager', 'accountant']) assert.equal(reporting.adminReportingScope({ role }, scope('central')), null);
  assert.equal(reporting.adminReportingScope({ role: 'admin' }), null);
});
test('range projection uses exact server shop totals/days and preserves all-store historical aggregate', () => {
  assert.equal(reporting.scopeRangeReport(range, scope('all')), range);
  const branch = reporting.scopeRangeReport(range, scope('branch'));
  assert.deepEqual(branch.grand, range.shops[0].totals);
  assert.deepEqual(branch.byDay, range.shops[0].days);
  assert.equal(branch.grand.collections, 103);
  assert.equal(branch.grand.netProfit, 48);
  assert.equal(branch.notice, range.notice);
  assert.equal(reporting.scopeRangeReport(range, scope('missing')).grand.collections, 0);
  assert.deepEqual(reporting.scopeRangeReport(range, scope('all', { ready: false })).shops, []);
});
test('sale history query filters store before paging and preserves cashier identity', () => {
  assert.deepEqual(structuredClone(history.salesHistoryQuery({ user: { role: 'admin' }, shop_id: 'branch' })), { $and: [{ shop_id: 'branch' }] });
  assert.deepEqual(structuredClone(history.salesHistoryQuery({ user: { role: 'admin' }, shop_id: 'all' })), {});
  assert.deepEqual(structuredClone(history.salesHistoryQuery({ user: { role: 'cashier', id: 'me' }, shop_id: 'central' })), { $and: [{ user_id: 'me' }] });
});
test('SalesHistory immediately hides rows from previous scope, query follows new scope', async () => {
  const f = await fixture('src/pages/SalesHistory.jsx');
  assert.match(f.string(), /Branch kassiri/); assert.doesNotMatch(f.string(), /Central kassiri/);
  await f.setScope('central');
  assert.match(f.string(), /Central kassiri/); assert.doesNotMatch(f.string(), /Branch kassiri/);
  assert.deepEqual(structuredClone(f.queries.at(-1)), { $and: [{ shop_id: 'central' }] });
  await f.close();
});
test('Shifts uses shared scope for query and local list, clear keeps chosen store', async () => {
  const f = await fixture('src/pages/Shifts.jsx');
  assert.match(f.string(), /Branch kassiri/); assert.doesNotMatch(f.string(), /Central kassiri/);
  await f.setScope('central'); assert.match(f.string(), /Central kassiri/); assert.doesNotMatch(f.string(), /Branch kassiri/);
  assert.ok(JSON.stringify(f.queries.at(-1)).includes('central'));
  const clear = f.tree.root.findAllByType('button').find((button) => text(button.props.children).includes('Tozalash'));
  assert.ok(clear);
  await act(async () => clear.props.onClick());
  assert.ok(JSON.stringify(f.queries.at(-1)).includes('central'));
  const selector = f.tree.root.findAllByType('select').find((select) => select.props.value === 'central');
  await act(async () => selector.props.onValueChange('branch'));
  assert.deepEqual(f.selections, ['branch']);
  await f.close();
});
test('cashier sale history retains worker-only behavior despite a supplied admin preference', async () => {
  const f = await fixture('src/pages/SalesHistory.jsx', { role: 'cashier', initial: 'central' });
  assert.match(f.string(), /· Branch/); assert.doesNotMatch(f.string(), /· Central/);
  assert.deepEqual(structuredClone(f.queries.at(-1)), { $and: [{ user_id: 'me' }] });
  await f.close();
});
test('CashOutHistory applies chosen store to rows, totals and recipient options', async () => {
  const f = await fixture('src/pages/CashOutHistory.jsx');
  assert.match(f.string(), /Branch xarajat/); assert.doesNotMatch(f.string(), /Central xarajat/);
  await f.setScope('central'); assert.match(f.string(), /Central xarajat/); assert.doesNotMatch(f.string(), /Branch xarajat/);
  await f.setScope('all'); assert.match(f.string(), /Branch xarajat/); assert.match(f.string(), /Central xarajat/);
  await f.close();
});
test('ProfitReport ignores stale store responses after store changes', async () => {
  const f = await fixture('src/pages/ProfitReport.jsx', { pending: true });
  await f.setScope('central');
  await act(async () => { for (const request of f.deferred.filter((item) => item.shop === 'central')) request.resolve(); });
  assert.match(f.string(), /\$222/);
  await act(async () => { for (const request of f.deferred.filter((item) => item.shop === 'branch')) request.resolve(); });
  assert.match(f.string(), /\$222/); assert.doesNotMatch(f.string(), /\$111/);
  await f.close();
});
test('AuditExport uses chosen scope immediately and ignores stale replies', async () => {
  const f = await fixture('src/pages/AuditExport.jsx', { pending: true });
  await f.setScope('central');
  assert.equal(f.calls.at(-1).payload.shop_id, 'central');
  await act(async () => { for (const request of f.deferred.filter((item) => item.shop === 'central')) request.resolve(); });
  assert.match(f.string(), /\$222/);
  await act(async () => { for (const request of f.deferred.filter((item) => item.shop === 'branch')) request.resolve(); });
  assert.doesNotMatch(f.string(), /\$111/);
  await f.setScope('all'); assert.equal(f.calls.at(-1).payload.shop_id, '');
  await f.close();
});
test('DailyExport scopes table/history and explicitly blocks send-all from a scoped view', async () => {
  const f = await fixture('src/pages/DailyExport.jsx');
  const tableText = () => text(f.tree.root.findByProps({ className: 'odina-export-preview odina-operations-card' }).children);
  assert.match(tableText(), /Branch/); assert.doesNotMatch(tableText(), /Central/);
  const send = () => f.tree.root.findAllByType('button').find((button) => text(button.props.children).includes('Barcha do‘konlar: Sheet'));
  assert.equal(send().props.disabled, true);
  await act(async () => send().props.onClick());
  assert.equal(f.calls.some((call) => call.payload.action === 'send'), false);
  await f.setScope('all'); assert.equal(send().props.disabled, false);
  await f.close();
});
test('Waste all-store mode aggregates read-only, unsupported store never falls back, guards protect forms', async () => {
  const f = await fixture('src/pages/Waste.jsx', { initial: 'all' });
  assert.match(f.string(), /Branch tort/); assert.match(f.string(), /Central tort/);
  const add = () => f.tree.root.findAllByType('button').find((button) => text(button.props.children).includes('Chiqit kiritish'));
  assert.equal(add().props.disabled, true);
  await f.setScope('factory'); assert.doesNotMatch(f.string(), /Branch tort/); assert.doesNotMatch(f.string(), /Central tort/);
  assert.match(f.string(), /Tanlangan joy uchun/);
  await f.setScope('branch'); assert.equal(add().props.disabled, false);
  await act(async () => add().props.onClick());
  assert.ok([...f.guards].some((guard) => guard()));
  const dialog = f.tree.root.findByType('waste-dialog');
  assert.equal(dialog.props.initial.location_id, 'branch'); assert.deepEqual(dialog.props.shops.map((shop) => shop.id), ['branch']);
  assert.equal(f.calls.every((call) => call.payload.action === 'get_context'), true);
  await f.close();
});
test('RealProfitDashboard scopes every displayed metric without requesting a backend scope change', async () => {
  const f = await fixture('src/components/reports/RealProfitDashboard.jsx');
  await f.flushTimers(); assert.match(f.string(), /\$103/); assert.doesNotMatch(f.string(), /\$303/);
  await f.setScope('central'); assert.match(f.string(), /\$203/); assert.doesNotMatch(f.string(), /\$103/);
  await f.setScope('all'); assert.match(f.string(), /\$303/);
  assert.equal(f.calls.filter((call) => call.payload.action === 'range').length, 1);
  await f.close();
});
