// Offline-only regression tests for Kassa's in-page table selector.
// Never contact Base44 or create live orders, sales, shifts or stock movements.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const pos = read('src/pages/POS.jsx');
const floorplan = read('src/components/tables/TableFloorplan.jsx');
const backend = read('base44/functions/restaurant-tables/entry.ts');
const checkout = read('base44/functions/complete-sale/entry.ts');

test('Kassa visibly opens the real shared floor plan on desktop and touch devices, not a fake list', () => {
  assert.match(pos, /import TableFloorplan from '@\/components\/tables\/TableFloorplan'/);
  assert.match(pos, /Stollar xaritasini Kassa ichida ochish/);
  assert.match(pos, /Stollar xaritasini ochish/);
  assert.match(pos, /<Sheet open=\{tablePickerOpen\}/);
  assert.match(pos, /<TableFloorplan key=\{`\$\{tablePickerShop\.id\}:\$\{tablePickerShop\.layout_version\}`\}/);
  assert.match(pos, /canManage=\{false\}/);
  assert.match(floorplan, /if \(editing\) setSelectedNumber\(point\.number\); else onOpen\(shop\.id, point\.number\)/);
  assert.doesNotMatch(pos, /entities\.Shop\.(update|create|delete)/);
});

test('table picker is server scoped, further constrained by open shift and guards unsaved cart', () => {
  assert.match(pos, /functions\.invoke\('restaurant-tables', \{ action: 'status' \}\)/);
  assert.match(pos, /result\.shops\.filter\(\(shop\) => shop\.id === shift\.shop_id\)/);
  assert.match(backend, /const assignedId = userShopId\(actor\)/);
  assert.match(backend, /shops: \[safeShop\(assignedShop\)\]/);
  assert.match(pos, /if \(shift && shift\.shop_id !== shopId\)/);
  assert.match(pos, /if \(cart\.length && !\(await odinaConfirm\(/);
  assert.match(pos, /navigate\(`\/pos\?\$\{new URLSearchParams\(\{ table_shop: shopId, table_number: String\(number\) \}\)\}`\)/);
  assert.match(pos, /const priorTableKey = useRef\(tableKey\)/);
});

test('Kassa selection stays a real authenticated completed sale with no premature inventory deduction', () => {
  assert.match(pos, /\.\.\.\(selectedTable \? \{ table_shop_id: selectedTable\.shopId, table_number: selectedTable\.number \} : \{\}\)/);
  assert.match(checkout, /requestedTableShopId !== shift\.shop_id/);
  assert.match(checkout, /requestedTableNumber > receiptShop\.restaurant_table_count/);
  assert.match(checkout, /table_number_snapshot: requestedTableNumber/);
  assert.match(pos, /Stol savdosini internet orqali tasdiqlash kerak/);
  assert.doesNotMatch(pos, /entities\.(Sale|SaleItem|Payment|StockMovement)\.create\(/);
});
