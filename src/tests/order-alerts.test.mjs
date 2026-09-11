// Offline regression tests for the in-app order alert logic (pure math, Asia/Tashkent).
import assert from 'node:assert/strict';
import test from 'node:test';

const mod = await import(new URL('../lib/order-alerts.js', import.meta.url));
const {
  ALERT_ACTIVE_STATUSES,
  ALERT_EXCLUDED_STATUSES,
  handoverMs,
  deadlineState,
  hasUnpaidBalance,
  buildOrderAlerts,
  countOrderAlerts,
} = mod;

test('ALERT_ACTIVE_STATUSES excludes cancelled/delivered/completed', () => {
  for (const s of ['yuborildi_olib_ketildi', 'yakunlandi', 'bekor_qilindi']) {
    assert.ok(!ALERT_ACTIVE_STATUSES.includes(s), s);
    assert.ok(ALERT_EXCLUDED_STATUSES.includes(s), s);
  }
});

test('handoverMs converts Tashkent local to UTC ms (UTC+5, no DST)', () => {
  const ms = handoverMs('2026-09-12', '14:30');
  const d = new Date(ms);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 8);
  assert.equal(d.getUTCDate(), 12);
  assert.equal(d.getUTCHours(), 9);
  assert.equal(d.getUTCMinutes(), 30);
});

test('handoverMs accepts single-digit hour and returns null for invalid', () => {
  assert.equal(handoverMs('2026-09-12', '9:05').getHours?.(), undefined);
  const d = new Date(handoverMs('2026-09-12', '9:05'));
  assert.equal(d.getUTCHours(), 4);
  assert.equal(d.getUTCMinutes(), 5);
  assert.equal(handoverMs('', '14:30'), null);
  assert.equal(handoverMs('2026-09-12', ''), null);
  assert.equal(handoverMs('bad', '14:30'), null);
  assert.equal(handoverMs('2026-09-12', 'bad'), null);
});

const HANDOVER = handoverMs('2026-09-12', '14:30');
const NOW_UNDER_60 = HANDOVER - 30 * 60 * 1000; // 30 min before handover
const NOW_OVERDUE = HANDOVER + 10 * 60 * 1000; // 10 min after handover
const NOW_FAR = HANDOVER - 3 * 60 * 60 * 1000; // 3h before handover (>60 min)

test('deadlineState: due_soon within 60 minutes', () => {
  const o = { order_status: 'qabul_qilindi', required_date: '2026-09-12', required_time: '14:30' };
  const s = deadlineState(o, NOW_UNDER_60);
  assert.equal(s.kind, 'due_soon');
  assert.ok(s.minutesLeft >= 0 && s.minutesLeft <= 60);
});

test('deadlineState: overdue when handover passed', () => {
  const o = { order_status: 'tayyorlanmoqda', required_date: '2026-09-12', required_time: '14:30' };
  const s = deadlineState(o, NOW_OVERDUE);
  assert.equal(s.kind, 'overdue');
  assert.ok(s.minutesLeft > 0);
});

test('deadlineState: null when more than 60 minutes away', () => {
  const o = { order_status: 'qabul_qilindi', required_date: '2026-09-12', required_time: '14:30' };
  assert.equal(deadlineState(o, NOW_FAR).kind, null);
});

test('deadlineState: excluded statuses never alert even if overdue', () => {
  for (const st of ['yuborildi_olib_ketildi', 'yakunlandi', 'bekor_qilindi']) {
    const o = { order_status: st, required_date: '2026-09-12', required_time: '14:30' };
    assert.equal(deadlineState(o, NOW_OVERDUE).kind, null, st);
  }
});

test('hasUnpaidBalance: true when balance > 0 and not paid', () => {
  assert.equal(hasUnpaidBalance({ remaining_balance: 5000, payment_status: 'partial' }), true);
  assert.equal(hasUnpaidBalance({ remaining_balance: 5000, payment_status: 'unpaid' }), true);
});

test('hasUnpaidBalance: false when paid or zero/negative', () => {
  assert.equal(hasUnpaidBalance({ remaining_balance: 5000, payment_status: 'paid' }), false);
  assert.equal(hasUnpaidBalance({ remaining_balance: 0, payment_status: 'unpaid' }), false);
  assert.equal(hasUnpaidBalance({ remaining_balance: -1 }), false);
});

test('buildOrderAlerts: excludes cancelled/delivered/completed entirely (even with unpaid balance)', () => {
  const orders = [
    { id: 'a', order_status: 'qabul_qilindi', required_date: '2026-09-12', required_time: '14:30', remaining_balance: 0, payment_status: 'unpaid' },
    { id: 'b', order_status: 'yuborildi_olib_ketildi', required_date: '2026-09-12', required_time: '14:30', remaining_balance: 5000, payment_status: 'partial' },
    { id: 'c', order_status: 'yakunlandi', required_date: '2026-09-12', required_time: '14:30', remaining_balance: 5000, payment_status: 'partial' },
    { id: 'd', order_status: 'bekor_qilindi', required_date: '2026-09-12', required_time: '14:30', remaining_balance: 5000, payment_status: 'partial' },
  ];
  const alerts = buildOrderAlerts(orders, NOW_OVERDUE);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].order.id, 'a');
});

test('buildOrderAlerts: sorts overdue first, then due_soon, then unpaid-only', () => {
  const base = handoverMs('2026-09-12', '14:30');
  const orders = [
    { id: 'Z', order_status: 'qabul_qilindi', required_date: '2026-09-12', required_time: '17:30', remaining_balance: 5000, payment_status: 'partial' }, // 3h future -> unpaid only
    { id: 'X', order_status: 'tayyorlanmoqda', required_date: '2026-09-12', required_time: '13:30', remaining_balance: 0, payment_status: 'unpaid' }, // 1h past -> overdue
    { id: 'Y', order_status: 'qabul_qilindi', required_date: '2026-09-12', required_time: '15:00', remaining_balance: 0, payment_status: 'unpaid' }, // 30m future -> due_soon
  ];
  const alerts = buildOrderAlerts(orders, base);
  assert.deepEqual(alerts.map((a) => a.order.id), ['X', 'Y', 'Z']);
});

test('countOrderAlerts: totals by kind', () => {
  const base = handoverMs('2026-09-12', '14:30');
  const orders = [
    { id: 'X', order_status: 'tayyorlanmoqda', required_date: '2026-09-12', required_time: '13:30', remaining_balance: 0, payment_status: 'unpaid' },
    { id: 'Y', order_status: 'qabul_qilindi', required_date: '2026-09-12', required_time: '15:00', remaining_balance: 0, payment_status: 'unpaid' },
    { id: 'Z', order_status: 'qabul_qilindi', required_date: '2026-09-12', required_time: '17:30', remaining_balance: 5000, payment_status: 'partial' },
  ];
  const c = countOrderAlerts(orders, base);
  assert.equal(c.overdue, 1);
  assert.equal(c.due_soon, 1);
  assert.equal(c.unpaid, 1);
  assert.equal(c.total, 3);
});

test('buildOrderAlerts: active order far in future with no balance is not alerted', () => {
  const base = handoverMs('2026-09-12', '14:30');
  const orders = [
    { id: 'ok', order_status: 'qabul_qilindi', required_date: '2026-09-20', required_time: '14:30', remaining_balance: 0, payment_status: 'paid' },
  ];
  assert.equal(buildOrderAlerts(orders, base).length, 0);
  assert.equal(countOrderAlerts(orders, base).total, 0);
});

test('buildOrderAlerts handles non-array / null safely', () => {
  assert.deepEqual(buildOrderAlerts(null), []);
  assert.deepEqual(buildOrderAlerts(undefined), []);
});