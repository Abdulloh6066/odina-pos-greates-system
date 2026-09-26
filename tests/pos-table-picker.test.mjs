// Offline-only regression tests for the Kassa table popup and fast Kassa reset.
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

test('Kassa opens a focused table map popup while the management page remains available', () => {
  const picker = read('src/components/tables/PosTablePicker.jsx');
  const page = read('src/pages/RestaurantTables.jsx');
  const app = read('src/App.jsx');
  assert.match(app, /path="\/tables" element=\{<RoleRoute pageKey="tables">/);
  assert.match(pos, /Stollar sahifasini ochish/);
  assert.match(pos, /setTablePickerOpen\(true\)/);
  assert.match(pos, /<PosTablePicker/);
  assert.match(picker, /<TableFloorplan[^>]*pickerOnly/);
  assert.match(picker, /canManage=\{false\}/);
  assert.match(picker, /<TableDetailSheet/);
  assert.match(page, /<TableFloorplan/);
  assert.match(floorplan, /if \(editing\)\s*setSelectedNumber\(point\.number\);\s*else\s*onOpen\(shop\.id, point\.number\)/);
  assert.doesNotMatch(pos, /entities\.Shop\.(update|create|delete)/);
});

test('table popup stays in the active shop and saves table edits before switching', () => {
  const picker = read('src/components/tables/PosTablePicker.jsx');
  assert.match(picker, /functions\.invoke\('restaurant-tables', \{ action: 'status' \}\)/);
  assert.match(picker, /find\(\(item\) => item\.id === activeShopId\)/);
  assert.match(pos, /activeShopId=\{shift\?\.shop_id \|\| user\?\.shop_id\}/);
  assert.match(backend, /const assignedId = userShopId\(actor\)/);
  assert.match(backend, /shops: \[safeShop\(assignedShop\)\]/);
  assert.match(pos, /selectedTable && tableCartDirty && !\(await saveTableOrder\(\)\)/);
  assert.match(pos, /const priorTableKey = useRef\(tableKey\)/);
  assert.match(pos, /screenMode \? \{ screen: '1' \} : \{\}/);
  assert.match(pos, /navigate\(posHomePath, \{ replace: true \}\);\s*setTablePickerOpen\(true\)/);
});

test('saving an unpaid table returns to clean POS only after server confirmation; failure preserves the cart', () => {
  const cart = read('src/components/pos/Cart.jsx');
  const action = pos.slice(pos.indexOf('const saveAndStartNextOrder = async () => {'), pos.indexOf('const tableShop = selectedTable'));
  assert.match(action, /if \(tableCartDirty && !\(await saveTableOrder\(\)\)\) return/);
  assert.match(action, /if \(!tableCartDirty && !tableOrder\?\.id\) return/);
  assert.match(action, /resetCart\(\)/);
  assert.match(action, /setTableOrder\(null\)/);
  assert.match(action, /setMobileCartOpen\(false\)/);
  assert.match(action, /navigate\(posHomePath, \{ replace: true, state: \{ savedTableNumber: savedNumber, savedShopId \} \}\)/);
  assert.match(action, /setStaffTicket\(\{ mode: 'table', shop: savedShop, shopId: savedShopId, tableNumber: savedNumber \}\)/);
  assert.ok(action.indexOf('await saveTableOrder()') < action.indexOf('resetCart()'));
  assert.match(cart, /tableDirty \? 'Stolga saqlash' : 'Yangi buyurtma'/);
  assert.doesNotMatch(cart, /Saqlagach Kassa avtomatik tozalanadi/);
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
    selectedTable: { number: 3, shopId: 'shop-1' }, tableShop: { id: 'shop-1', name: 'Mock shop' }, tableOrderLoading: busy,
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
    posHomePath: '/pos',
    navigate: (path, options) => events.push(`navigate:${path}:${options?.state?.savedTableNumber}`),
    setStaffTicket: (ticket) => events.push(`ticket:${ticket.mode}:${ticket.shopId}:${ticket.tableNumber}`),
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
  assert.equal(events.at(-2), 'navigate:/pos:3');
  assert.equal(events.at(-1), 'ticket:table:shop-1:3');
  assert.ok(events.includes('close-mobile-sheet'));
});

test('failed server save, existing saved order and pending load never silently lose the basket', async () => {
  assert.deepEqual(await exerciseFastSave({ succeeds: false }), ['server-save']);
  assert.deepEqual(await exerciseFastSave({ error: 'Network error' }), []);
  assert.deepEqual(await exerciseFastSave({ busy: true }), []);
  assert.deepEqual(await exerciseFastSave({ dirty: false, order: null }), []);
  const existing = await exerciseFastSave({ dirty: false });
  assert.equal(existing[0], 'reset-cart');
  assert.equal(existing.at(-2), 'navigate:/pos:3');
  assert.equal(existing.at(-1), 'ticket:table:shop-1:3');
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

const cancelAction = pos.slice(pos.indexOf('const cancelTableSelection = async () => {'), pos.indexOf('const saveAndStartNextOrder = async () => {')).trim();
const exerciseCancelTable = async ({ dirty = false, confirmed = true } = {}) => {
  const events = [];
  const context = {
    selectedTable: { number: 3, shopId: 'shop-1' },
    tableOrderLoading: false,
    savingTableRef: { current: false },
    tableCartDirty: dirty,
    odinaConfirm: async () => { events.push('confirm-prompt'); return confirmed; },
    resetCart: () => events.push('reset-cart'),
    setTableOrder: (next) => events.push(next === null ? 'clear-table-order' : 'wrong-order'),
    setTableOrderLoading: () => events.push('clear-loading'),
    setTableOrderError: () => events.push('clear-order-error'),
    setTableSaveError: () => events.push('clear-save-error'),
    setDiscountCode: () => events.push('clear-discount-code'),
    setDiscountPct: () => events.push('clear-discount-pct'),
    setDiscountOwnerPin: () => events.push('clear-discount-pin'),
    setRoundingTarget: () => events.push('clear-rounding'),
    setAdjustmentMode: () => events.push('clear-adjustment'),
    setMobileCartOpen: () => events.push('close-mobile-sheet'),
    posHomePath: '/pos',
    navigate: (path, options) => events.push(`navigate:${path}:${options?.replace ? 'replace' : 'push'}`),
  };
  assert.ok(cancelAction.startsWith('const cancelTableSelection = async () => {'));
  vm.runInNewContext(`${cancelAction}\nglobalThis.runCancel = cancelTableSelection;`, context);
  await context.runCancel();
  return events;
};

test('cashier can cancel selected table in Kassa via touch-friendly "Stolni bekor qilish" action without page reload', async () => {
  assert.match(pos, /Stolni bekor qilish/);
  assert.match(pos, /const cancelTableSelection = async \(\) =>/);
  assert.match(pos, /navigate\(posHomePath, \{ replace: true \}\)/);
  assert.match(read('src/components/pos/Cart.jsx'), /onCancelTable/);
  assert.match(read('src/components/pos/Cart.jsx'), /aria-label="Stolni bekor qilish"/);

  // When clean, immediately resets cart and table state without server mutations or prompt
  const cleanEvents = await exerciseCancelTable({ dirty: false });
  assert.ok(!cleanEvents.includes('confirm-prompt'));
  assert.ok(cleanEvents.includes('reset-cart'));
  assert.ok(cleanEvents.includes('clear-table-order'));
  assert.ok(cleanEvents.includes('navigate:/pos:replace'));

  // When dirty, prompts confirmation before clearing
  const rejectedEvents = await exerciseCancelTable({ dirty: true, confirmed: false });
  assert.deepEqual(rejectedEvents, ['confirm-prompt']);

  const confirmedEvents = await exerciseCancelTable({ dirty: true, confirmed: true });
  assert.equal(confirmedEvents[0], 'confirm-prompt');
  assert.ok(confirmedEvents.includes('reset-cart'));
  assert.ok(confirmedEvents.includes('clear-table-order'));
  assert.ok(confirmedEvents.includes('navigate:/pos:replace'));
});

test('invalid table selection is automatically cleared if active shop changes', () => {
  assert.match(pos, /activeShopId && selectedTable\.shopId !== activeShopId/);
  assert.match(pos, /navigate\(posHomePath, \{ replace: true \}\)/);
});

test('central location and branch tables remain strictly isolated in backend and Stollar page', () => {
  const tablesPage = read('src/pages/RestaurantTables.jsx');
  assert.match(backend, /is_main: Boolean\(shop\.is_main\)/);
  assert.match(backend, /invalid_records/);
  assert.match(backend, /const requestedShopId = String\(body\?\.shop_id \|\| ""\)\.trim\(\);/);
  assert.match(tablesPage, /shop\.is_main && \(\s*<span[^>]*>\s*Asosiy\s*<\/span>\s*\)/);
  assert.match(tablesPage, /available\.some\(\(shop\) => shop\.id === user\?\.shop_id\)/);
  assert.match(tablesPage, /setInspectTableNumber\(null\)/);
});

test('staff order ticket matches reference layout with table number, time, taker, no payment disclaimer, no prices', () => {
  const ticketModal = read('src/components/tables/StaffOrderTicketModal.jsx');
  const tableSheet = read('src/components/tables/TableDetailSheet.jsx');
  assert.match(ticketModal, /BUYURTMA № #\{String\(displayOrderNumber\)\.replace\(\/\^#\//);
  assert.match(ticketModal, /\{displayTableNumber\}-stol/);
  assert.match(ticketModal, /VAQT/);
  assert.match(ticketModal, /BUYURTMA OLUVCHI/);
  assert.match(ticketModal, /\{item\.product_name\}/);
  assert.match(ticketModal, /\{item\.quantity\}/);
  assert.doesNotMatch(ticketModal, /to‘lov hujjati hisoblanmaydi/i);
  assert.doesNotMatch(ticketModal, /TURI/);
  assert.doesNotMatch(ticketModal, /MAHSULOTLAR VA MIQDOR/);
  assert.doesNotMatch(ticketModal, /formatUZS/);
  assert.match(pos, /<StaffOrderTicketModal/);
  assert.match(tableSheet, /<StaffOrderTicketModal/);
  assert.match(pos, /setStaffTicket\(/);
});

