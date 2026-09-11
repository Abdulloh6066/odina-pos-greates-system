// Offline regression tests for "Ombor sanog'i" decision logic (pure, no live records).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

function loadLogic() {
  const url = new URL('../../base44/shared/stock-count-logic.ts', import.meta.url);
  const src = readFileSync(url, 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
  const mod = { exports: {} };
  const ctx = { module: mod, exports: mod.exports, console };
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  return mod.exports;
}
const L = loadLogic();

test('senariy 1: tizim 12, amalda 10 -> farq -2, qo\'llanadi', () => {
  const item = { was_counted: true, system_quantity: 12, system_version: 'v1', counted_quantity: 10, difference: -2, applied: false, stale: false };
  const stock = { quantity: 12, updated_date: 'v1' };
  const c = L.classifyItem(item, stock);
  assert.equal(c.stale, false);
  assert.equal(c.before, 12);
  assert.equal(c.after, 10);
  assert.equal(c.change, -2);
  const s = L.summarizeCount([item]);
  assert.equal(s.counted_items, 1);
  assert.equal(s.difference_items, 1);
  assert.equal(s.net_difference, -2);
  assert.equal(L.pendingItems([item]).length, 1);
});

test('senariy 2: bo\'sh maydon nol emas — sanalmagan, o\'tkazib yuboriladi', () => {
  const items = [{ was_counted: false, system_quantity: 12, counted_quantity: 0, difference: 0, applied: false, stale: false }];
  const s = L.summarizeCount(items);
  assert.equal(s.counted_items, 0, 'sanalmagan qator hisobga olinmaydi');
  assert.equal(s.difference_items, 0);
  assert.equal(L.pendingItems(items).length, 0);
  assert.equal(L.isApprovalComplete(items), true);
});

test('senariy 3: o\'zgarmagan miqdor (12==12) -> farq 0, harakat yo\'q', () => {
  const items = [{ was_counted: true, system_quantity: 12, counted_quantity: 12, difference: 0, applied: false, stale: false }];
  assert.equal(L.summarizeCount(items).difference_items, 0);
  assert.equal(L.pendingItems(items).length, 0, 'nol farq uchun harakat kerak emas');
  assert.equal(L.isApprovalComplete(items), true);
});

test('senariy 4: sanog\'dan keyin qoldiq o\'zgargan -> eskirgan (stale), qo\'llanmaydi', () => {
  const item = { was_counted: true, system_quantity: 12, system_version: 'v1', counted_quantity: 10, difference: -2, applied: false, stale: false };
  assert.equal(L.classifyItem(item, { quantity: 12, updated_date: 'v2' }).stale, true, 'versiya o\'zgargan -> stale');
  assert.equal(L.classifyItem(item, { quantity: 8, updated_date: 'v1' }).stale, true, 'miqdor o\'zgargan -> stale');
  assert.equal(L.classifyItem(item, { quantity: 12, updated_date: 'v1' }).stale, false, 'o\'zgarmagan -> stale emas');
  const withStale = [{ ...item, stale: true }];
  assert.equal(L.isApprovalComplete(withStale), false, 'stale bo\'lsa to\'liq emas');
});

test('senariy 5: ruxsatsiz tasdiqlash — faqat egasi (admin)', () => {
  assert.equal(L.canApprove('admin'), true);
  assert.equal(L.canApprove('manager'), false);
  assert.equal(L.canApprove('cashier'), false);
  assert.equal(L.canApprove('accountant'), false);
});

test('senariy 6: takroriy yuborish — qo\'llangan qator qayta qo\'llanmaydi', () => {
  let items = [{ was_counted: true, system_quantity: 12, system_version: 'v1', counted_quantity: 10, difference: -2, applied: false, stale: false }];
  assert.equal(L.pendingItems(items).length, 1);
  items = items.map((i) => (i.difference !== 0 ? { ...i, applied: true } : i));
  assert.equal(L.pendingItems(items).length, 0, 'qo\'llanganidan keyin pending yo\'q');
  assert.equal(L.isApprovalComplete(items), true);
  // ikkinchi urinish — hech narsa qilmaydi
  assert.equal(L.pendingItems(items).length, 0);
});

test('qismiy qo\'llash: barcha qo\'llanmasa to\'liq emas', () => {
  const items = [
    { was_counted: true, system_quantity: 5, counted_quantity: 4, difference: -1, applied: true, stale: false },
    { was_counted: true, system_quantity: 10, counted_quantity: 7, difference: -3, applied: false, stale: false },
  ];
  assert.equal(L.isApprovalComplete(items), false);
  assert.equal(L.pendingItems(items).length, 1);
});