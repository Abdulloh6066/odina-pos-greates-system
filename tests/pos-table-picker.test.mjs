// Offline-only regression tests for the dedicated Stollar page and fast Kassa reset.
// Never contact Base44 or create live orders, sales, shifts or stock movements.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const pos = read('src/pages/POS.jsx');
const floorplan = read('src/components/tables/TableFloorplan.jsx');
const backend = read('base44/functions/restaurant-tables/entry.ts');
const checkout = read('base44/functions/complete-sale/entry.ts');

test('Kassa opens the dedicated Stollar page instead of a large modal on desktop and touch devices', () => {
  const page = read('src/pages/RestaurantTables.jsx');
  const app = read('src/App.jsx');
  assert.match(app, /path="\/tables" element=\{<RoleRoute pageKey="tables">/);
  assert.match(pos, /Stollar sahifasini ochish/);
  assert.match(pos, /const goToTables = async \(\) =>/);
  assert.match(pos, /navigate\('\/tables'\)/);
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
  assert.match(pos, /if \(selectedTable && !lastSale\?\.offline_pending\) \{\s*navigate\('\/tables'\)/);
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
  assert.match(cart, /tableDirty \? 'Stolga saqlash → Yangi buyurtma' : 'Yangi buyurtmaga o‘tish'/);
  assert.match(cart, /disabled=\{locked \|\| \(!tableDirty && !tableSaved\)/);
  assert.match(pos, /role="status"[^>]*className="mx-3[^>]*>/);
  assert.match(pos, /To‘lov olinmadi\. Kassa yangi buyurtmaga tayyor/);
  assert.match(backend, /if \(!updated\?\.success \|\| Number\(updated.updated \|\| 0\) !== 1\)/);
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
