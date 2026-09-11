// Offline regression tests for the "Do'kon talabi" pure logic (no IO / no SDK).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

function loadLogic() {
  const url = new URL('../../base44/shared/shop-demand-logic.ts', import.meta.url);
  const src = readFileSync(url, 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
  const moduleObj = { exports: {} };
  const ctx = { module: moduleObj, exports: moduleObj.exports, console };
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  return moduleObj.exports;
}
const L = loadLogic();

const nowParts = { year: 2026, month: 9, day: 11, hour: 20, minute: 0 };

test('normalizeRequestItems: faol emas / arxivlangan mahsulot rad etiladi', () => {
  const products = {
    p1: { id: 'p1', name: 'Medovik', active: true, archived: false, track_stock: true, production_unit: 'piece', pieces_per_sheet: 20 },
    p2: { id: 'p2', name: 'Eski', active: false, archived: false, track_stock: true },
    p3: { id: 'p3', name: 'Arxiv', active: true, archived: true, track_stock: true },
  };
  const ok = L.normalizeRequestItems([{ product_id: 'p1', quantity: 5 }], products);
  assert.equal(ok.error, null);
  assert.equal(ok.items.length, 1);
  assert.equal(ok.items[0].requested_quantity, 5);

  const badActive = L.normalizeRequestItems([{ product_id: 'p2', quantity: 1 }], products);
  assert.ok(badActive.error);
  const badArchived = L.normalizeRequestItems([{ product_id: 'p3', quantity: 1 }], products);
  assert.ok(badArchived.error);
});

test('normalizeRequestItems: takroriy mahsulot va noto\'g\'ri miqdor rad etiladi', () => {
  const products = { p1: { id: 'p1', name: 'Medovik', active: true, track_stock: true, production_unit: 'piece' } };
  assert.ok(L.normalizeRequestItems([{ product_id: 'p1', quantity: 1 }, { product_id: 'p1', quantity: 2 }], products).error, 'takroriy rad');
  assert.ok(L.normalizeRequestItems([{ product_id: 'p1', quantity: 0 }], products).error, 'nol miqdor rad');
  assert.ok(L.normalizeRequestItems([{ product_id: 'p1', quantity: 1.5 }], products).error, 'kasr miqdor rad');
  assert.equal(L.normalizeRequestItems([], products).error, 'kamida bitta');
});

test('case 1: cashier faqat o\'z do\'koni talabini tahrirlay oladi (canEdit)', () => {
  const myReq = { status: 'yangi', shop_id: 'shop-A' };
  assert.equal(L.canEdit(myReq, 'cashier', 'shop-A'), true, 'o\'z do\'koni - ruxsat');
  assert.equal(L.canEdit(myReq, 'cashier', 'shop-B'), false, 'boshqa do\'kon - taqiqli');
  assert.equal(L.canEdit({ status: 'qabul_qilindi', shop_id: 'shop-A' }, 'cashier', 'shop-A'), false, 'qabul qilingan - tahrir yo\'q');
  assert.equal(L.canEdit(myReq, 'admin', 'shop-B'), true, 'admin - barchasi');
});

test('case 7: boshqa do\'kon talabiga ruxsat yo\'q (canEdit false)', () => {
  const req = { status: 'yangi', shop_id: 'shop-B' };
  assert.equal(L.canEdit(req, 'cashier', 'shop-A'), false);
  assert.equal(L.canCancel(req, 'cashier', 'shop-A'), false);
});

test('case 5: qisman yetkazib berishda qoldiq to\'g\'ri chiqadi', () => {
  const it = { requested_quantity: 12, sent_quantity: 7, unit: 'piece', pieces_per_sheet_snapshot: 20 };
  assert.equal(L.remainingForItem(it), 5, 'qoldi = 12 - 7');
  // sheet: 2 list yuborildi, 1 list = 20 dona -> 40 dona qabul
  const itSheet = { requested_quantity: 3, sent_quantity: 2, unit: 'sheet', pieces_per_sheet_snapshot: 20 };
  assert.equal(L.remainingForItem(itSheet), 1, 'qoldi 1 list');
  assert.equal(L.sentPiecesForItem(itSheet), 40, '40 dona yuborildi');
});

test('receivedPiecesFromTransfers: faqat qabul qilingan transferlar hisoblanadi va mahsulot bo\'yicha ajratiladi', () => {
  const it = { product_id: 'p1', unit: 'piece' };
  const transfers = [
    { product_id: 'p1', unit: 'piece', quantity: 5, status: 'received' },
    { product_id: 'p1', unit: 'piece', quantity: 3, status: 'pending' }, // hali qabul qilinmagan
    { product_id: 'p2', unit: 'piece', quantity: 9, status: 'received' }, // boshqa mahsulot
  ];
  assert.equal(L.receivedPiecesFromTransfers(it, transfers), 5, 'faqat p1 received = 5');
});

test('isFullyReceived: qisman qabul -> false, to\'liq -> true', () => {
  const items = [{ product_id: 'p1', requested_quantity: 10, sent_quantity: 10, unit: 'piece', pieces_per_sheet_snapshot: 0 }];
  // 5 dona qabul qilingan
  assert.equal(L.isFullyReceived(items, [{ product_id: 'p1', unit: 'piece', quantity: 10, status: 'received', received_quantity: 5 }]), false, 'qisman qabul - to\'liq emas');
  // to'liq qabul (piece: received = quantity)
  assert.equal(L.isFullyReceived(items, [{ product_id: 'p1', unit: 'piece', quantity: 10, status: 'received', received_quantity: 10 }]), true, 'to\'liq qabul');
  // hali to'liq yuborilmagan
  const partialSent = [{ product_id: 'p1', requested_quantity: 10, sent_quantity: 6, unit: 'piece', pieces_per_sheet_snapshot: 0 }];
  assert.equal(L.isFullyReceived(partialSent, [{ product_id: 'p1', unit: 'piece', quantity: 6, status: 'received', received_quantity: 6 }]), false, 'hali to\'liq yuborilmagan');
});

test('case 6: takroriy yuborish dedup (findExistingByKey + hasSendKey)', () => {
  const existing = [{ id: 'r1', idempotency_key: 'key-1' }];
  assert.equal(L.findExistingByKey(existing, 'key-1')?.id, 'r1', 'mavjud kalit topildi');
  assert.equal(L.findExistingByKey(existing, 'key-2'), null, 'yangi kalit - null');
  const req = { send_log: ['send-1'] };
  assert.equal(L.hasSendKey(req, 'send-1'), true, 'send kalit takrori - true');
  assert.equal(L.hasSendKey(req, 'send-2'), false, 'yangi send kalit - false');
});

test('sortRequests: muddati o\'tgan va shoshilinch birinchi', () => {
  const requests = [
    { request_number: 'A', required_date: '2026-09-15', shop_id: 's1' }, // kelajak
    { request_number: 'B', required_date: '2026-09-10', shop_id: 's1' }, // muddati o'tgan (09-10 < 09-11)
    { request_number: 'C', required_date: '2026-09-11', shop_id: 's1' }, // bugun -> shoshilinch (<=24h)
  ];
  const sorted = L.sortRequests(requests, nowParts).map((r) => r.request_number);
  assert.deepEqual(sorted, ['B', 'C', 'A']);
});

test('aggregateByProduct: mahsulot bo\'yicha jami va do\'kon bo\'yicha taqsimot', () => {
  const requests = [
    { id: 'r1', shop_id: 'main', shop_name_snapshot: 'Odina Main', required_date: '2026-09-12' },
    { id: 'r2', shop_id: 'second', shop_name_snapshot: 'Odina Second', required_date: '2026-09-12' },
  ];
  const itemsByRequest = {
    r1: [{ product_id: 'p1', product_name_snapshot: 'Medovik', unit: 'piece', requested_quantity: 7, sent_quantity: 0 }],
    r2: [{ product_id: 'p1', product_name_snapshot: 'Medovik', unit: 'piece', requested_quantity: 5, sent_quantity: 0 }],
  };
  const agg = L.aggregateByProduct(requests, itemsByRequest);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].total, 12, 'jami 12 dona');
  assert.equal(agg[0].byShop.main.requested, 7, 'Odina Main 7 dona');
  assert.equal(agg[0].byShop.second.requested, 5, 'Odina Second 5 dona');
});

test('canAccept / canProgress / canSend: rollar bo\'yicha ruxsat', () => {
  const yangi = { status: 'yangi', shop_id: 's1' };
  assert.equal(L.canAccept(yangi, 'production'), true);
  assert.equal(L.canAccept(yangi, 'cashier'), false, 'cashier qabul qila olmaydi');
  assert.equal(L.canProgress({ status: 'qabul_qilindi', shop_id: 's1' }, 'production'), true);
  assert.equal(L.canProgress({ status: 'yuborildi', shop_id: 's1' }, 'production'), false, 'yuborilgan - progress yo\'q');
  assert.equal(L.canSend({ status: 'tayyor', shop_id: 's1' }, 'admin'), true);
  assert.equal(L.canSend({ status: 'tayyor', shop_id: 's1' }, 'production'), false, 'production yubora olmaydi (transfer admin-only)');
});

test('computeTotals: jami / yuborilgan / qoldi', () => {
  const items = [
    { requested_quantity: 10, sent_quantity: 4 },
    { requested_quantity: 5, sent_quantity: 5 },
  ];
  const t = L.computeTotals(items);
  assert.equal(t.total_requested, 15);
  assert.equal(t.total_sent, 9);
  assert.equal(t.total_remaining, 6);
});

test('groupRequestsByDateAndShop: sana va do\'kon bo\'yicha guruhlash', () => {
  const requests = [
    { id: 'r1', required_date: '2026-09-12', shop_id: 'main', shop_name_snapshot: 'Main' },
    { id: 'r2', required_date: '2026-09-12', shop_id: 'main', shop_name_snapshot: 'Main' },
    { id: 'r3', required_date: '2026-09-13', shop_id: 'second', shop_name_snapshot: 'Second' },
  ];
  const groups = L.groupByDateAndShop(requests, {});
  assert.equal(groups.length, 2);
  assert.equal(groups[0].requests.length, 2);
  assert.equal(groups[1].shop_name, 'Second');
});