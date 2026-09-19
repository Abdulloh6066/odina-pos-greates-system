// Offline-only regression tests for the dedicated Stollar page and fast Kassa reset.
// Never contact Base44 or create live orders, sales, shifts or stock movements.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const read = (path) => readFileSync(path, 'utf8');
const pos = read('src/pages/POS.jsx');
const floorplan = read('src/components/tables/TableFloorplan.jsx');
const backend = read('base44/functions/restaurant-tables/entry.ts');
const checkout = read('base44/functions/complete-sale/entry.ts');

// Vite's production build can accept an icon that was accidentally removed
// from imports, while the Kassa crashes at runtime when the status banner
// renders. Execute the real JSX banner with icons available ONLY if imported.
test('Kassa renders offline and sync-status banners without missing icon runtime errors', () => {
  const lucideImport = pos.match(/import \{([^}]+)\} from 'lucide-react';/);
  assert.ok(lucideImport, 'POS must import its visible status icons');
  const icons = Object.fromEntries(lucideImport[1].split(',').map((name) => name.trim())
    .filter(Boolean).map((name) => [name, () => null]));
  const start = pos.indexOf('function OfflineSalesBanner(');
  const end = pos.indexOf('\nfunction CatTab(', start);
  assert.ok(start >= 0 && end > start, 'Expected the real POS status banner');
  const code = transformSync(`${pos.slice(start, end)}\nglobalThis.renderBanner = OfflineSalesBanner;`,
    { loader: 'jsx', jsx: 'transform' }).code;
  const context = {
    ...icons,
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    Button: () => null,
  };
  vm.runInNewContext(code, context);
  const cases = [
    { isOnline: false, records: [], syncing: false },
    { isOnline: true, records: [{ status: 'pending' }], syncing: true },
    { isOnline: true, records: [{ status: 'pending' }], syncing: false },
    { isOnline: true, records: [], syncing: false, storageError: 'Mock storage error' },
  ];
  for (const state of cases) {
    assert.equal(context.renderBanner({ ...state, onRetry: () => {} })?.type, 'div');
  }
});

test('Kassa opens the dedicated Stollar page instead of a large modal on desktop and touch devices', () => {
  const page = read('src/pages/RestaurantTables.jsx');
  const app = read('src/App.jsx');
  assert.match(app, /path="\/tables" element=\{<RoleRoute pageKey="tables">/);
  assert.match(pos, /Stollar sahifasini ochish/);
  assert.match(pos, /const goToTables = async \(\) =>/);
  assert.match(pos, /navigate\('\/tables', \{ state: \{ shopId:/);
  assert.doesNotMatch(pos, /tablePickerOpen|<TableFloorplan|Kassa · Stollar xaritasi/);
  assert.match(page, /<TableFloorplan/);
  assert.match(page, /Yangi buyurtma · Kassa/);
  assert.match(page, /onOpen=\{openTable\}/);
  assert.match(floorplan, /if \(editing\) setSelectedNumber\(point\.number\); else onOpen\(shop\.id, point\.number\)/);
  assert.doesNotMatch(pos, /entities\.Shop\.(update|create|delete)/);
});

test('dedicated map retains backend shop scoping, and navigation protects unsaved table and ordinary carts', () => {
  const page = read('src/pages/RestaurantTables.jsx');
  assert.match(page, /functions\.invoke\('restaurant-tables', \{ action: 'status' \}\)/);
  assert.match(backend, /const assignedId = userShopId\(actor\)/);
  assert.match(backend, /shops: \[safeShop\(assignedShop\)\]/);
  assert.match(pos, /selectedTable && tableCartDirty && !\(await saveTableOrder\(\)\)/);
  assert.match(pos, /!selectedTable && cart\.length && !\(await odinaConfirm\(/);
  assert.match(page, /navigate\(`\/pos\?\$\{new URLSearchParams\(\{ table_shop: shopId, table_number: String\(number\) \}\)\}`\)/);
  assert.match(pos, /const priorTableKey = useRef\(tableKey\)/);
  assert.match(pos, /if \(selectedTable && !lastSale\?\.offline_pending\) \{\s*navigate\('\/tables', \{ state: \{ shopId:/);
  assert.match(page, /available\.some\(\(shop\) => shop\.id === location\.state\?\.shopId\)/);
});

test('saving an unpaid table returns to clean POS only after server confirmation; failure preserves the cart', () => {
  const cart = read('src/components/pos/Cart.jsx');
  const action = pos.slice(pos.indexOf('const saveAndStartNextOrder = async () => {'), pos.indexOf('const tableShop = selectedTable'));
  assert.match(action, /if \(tableCartDirty && !\(await saveTableOrder\(\)\)\) return/);
  assert.match(action, /if \(!tableCartDirty && !tableOrder\?\.id\) return/);
  assert.match(action, /resetCart\(\)/);
  assert.match(action, /setTableOrder\(null\)/);
  assert.match(action, /setMobileCartOpen\(false\)/);
  assert.match(action, /navigate\('\/pos', \{ replace: true, state: \{ savedTableNumber: savedNumber \} \}\)/);
  assert.ok(action.indexOf('await saveTableOrder()') < action.indexOf('resetCart()'));
  assert.match(cart, /tableDirty \? 'Buyurtmani stolga saqlash →' : 'Yangi buyurtmaga o‘tish'/);
  assert.match(cart, /disabled=\{locked \|\| \(!tableDirty && !tableSaved\)/);
  assert.match(pos, /role="status"[^>]*className="mx-3[^>]*>/);
  assert.match(pos, /To‘lov olinmadi\. Kassa yangi buyurtmaga tayyor/);
  assert.match(backend, /if \(!updated\?\.success \|\| Number\(updated.updated \|\| 0\) !== 1\)/);
});

// Exercise the actual UI action with injected in-memory callbacks. This does
// not mount the app or invoke any live backend endpoint.
const fastSaveAction = pos.slice(pos.indexOf('const saveAndStartNextOrder = async () => {'), pos.indexOf('const tableShop = selectedTable')).trim();
const exerciseFastSave = async ({ dirty = true, order = { id: 'mock-order', state: 'occupied' },
  succeeds = true, error = '', busy = false } = {}) => {
  const events = [];
  const context = {
    selectedTable: { number: 3 }, tableOrderLoading: busy,
    savingTableRef: { current: false }, paying: false, payOpen: false,
    stockChecking: false, tableOrderError: error, tableOrder: order,
    tableCartDirty: dirty,
    saveTableOrder: async () => { events.push('server-save'); return succeeds; },
    resetCart: () => events.push('reset-cart'),
    setTableOrder: (next) => events.push(next === null ? 'clear-table-selection' : 'wrong-selection'),
    setTableSaveError: () => events.push('clear-error'),
    setActiveCat: () => events.push('reset-category'),
    setShowFav: () => events.push('reset-favorites'),
    setSearch: () => events.push('reset-search'),
    setMobileCartOpen: () => events.push('close-mobile-sheet'),
    navigate: (path, options) => events.push(`navigate:${path}:${options?.state?.savedTableNumber}`),
  };
  assert.ok(fastSaveAction.startsWith('const saveAndStartNextOrder = async () => {'));
  vm.runInNewContext(`${fastSaveAction}\nglobalThis.runFastSave = saveAndStartNextOrder;`, context);
  await context.runFastSave();
  return events;
};

test('confirmed server save resets Kassa and navigates only after success', async () => {
  const events = await exerciseFastSave();
  assert.equal(events[0], 'server-save');
  assert.equal(events[1], 'reset-cart');
  assert.equal(events.at(-1), 'navigate:/pos:3');
  assert.ok(events.includes('close-mobile-sheet'));
});

test('failed server save, existing saved order and pending load never silently lose the basket', async () => {
  assert.deepEqual(await exerciseFastSave({ succeeds: false }), ['server-save']);
  assert.deepEqual(await exerciseFastSave({ error: 'Network error' }), []);
  assert.deepEqual(await exerciseFastSave({ busy: true }), []);
  assert.deepEqual(await exerciseFastSave({ dirty: false, order: null }), []);
  const existing = await exerciseFastSave({ dirty: false });
  assert.equal(existing[0], 'reset-cart');
  assert.equal(existing.at(-1), 'navigate:/pos:3');
});

test('Kassa selection stays a real authenticated completed sale with no premature inventory deduction', () => {
  assert.match(pos, /table_shop_id: selectedTable\.shopId, table_number: selectedTable\.number/);
  assert.match(pos, /table_order_id: tableOrder\?\.id, table_order_revision: tableOrder\?\.revision/);
  assert.match(pos, /action: 'save_table_order'/);
  assert.match(read('src/components/pos/Cart.jsx'), /Hisobni yopish · To‘lov/);
  assert.match(checkout, /requestedTableShopId !== shift\.shop_id/);
  assert.match(checkout, /requestedTableNumber > receiptShop\.restaurant_table_count/);
  assert.match(checkout, /table_number_snapshot: requestedTableNumber/);
  assert.match(pos, /Stol savdosini internet orqali tasdiqlash kerak/);
  assert.doesNotMatch(pos, /entities\.(Sale|SaleItem|Payment|StockMovement)\.create\(/);
});
