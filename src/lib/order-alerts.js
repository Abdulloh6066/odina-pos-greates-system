// Pure logic for in-app order deadline + payment alerts.
// Self-contained (no imports) so it can be unit-tested offline.
//
// All handover times are interpreted in Asia/Tashkent (permanently UTC+5, no DST).
// Deadline alerts only apply to active, unfulfilled orders:
//   qabul_qilindi / tayyorlanmoqda / tayyor
// Cancelled, delivered (yuborildi_olib_ketildi) and completed (yakunlandi)
// orders are excluded from these alerts.

export const ALERT_ACTIVE_STATUSES = ['qabul_qilindi', 'tayyorlanmoqda', 'tayyor'];
export const ALERT_EXCLUDED_STATUSES = ['yuborildi_olib_ketildi', 'yakunlandi', 'bekor_qilindi'];

const TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // Asia/Tashkent = UTC+5, no DST
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const SOON_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

// UTC ms of the handover instant (local Tashkent Y-M-D HH:MM).
export function handoverMs(requiredDate, requiredTime) {
  if (!requiredDate || !requiredTime) return null;
  const dm = DATE_RE.exec(String(requiredDate));
  const tm = TIME_RE.exec(String(requiredTime));
  if (!dm || !tm) return null;
  const utc = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
  return utc - TZ_OFFSET_MS;
}

// { kind: 'overdue' | 'due_soon' | null, minutesLeft }
export function deadlineState(order, nowMs = Date.now()) {
  if (!order || !ALERT_ACTIVE_STATUSES.includes(order.order_status)) {
    return { kind: null };
  }
  const ms = handoverMs(order.required_date, order.required_time);
  if (ms == null) return { kind: null };
  const diff = ms - nowMs;
  if (diff < 0) return { kind: 'overdue', minutesLeft: Math.round(-diff / 60000) };
  if (diff <= SOON_WINDOW_MS) return { kind: 'due_soon', minutesLeft: Math.round(diff / 60000) };
  return { kind: null };
}

export function hasUnpaidBalance(order) {
  if (!order) return false;
  return Number(order.remaining_balance || 0) > 0 && order.payment_status !== 'paid';
}

function rank(a) {
  if (a.deadline.kind === 'overdue') return 0;
  if (a.deadline.kind === 'due_soon') return 1;
  return 2;
}

// Sorted: overdue first, then upcoming deadlines (soonest), then unpaid-only.
export function buildOrderAlerts(orders, nowMs = Date.now()) {
  if (!Array.isArray(orders)) return [];
  const out = [];
  for (const o of orders) {
    if (!o || !ALERT_ACTIVE_STATUSES.includes(o.order_status)) continue;
    const deadline = deadlineState(o, nowMs);
    const unpaid = hasUnpaidBalance(o);
    if (!deadline.kind && !unpaid) continue;
    out.push({ order: o, deadline, unpaid });
  }
  out.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const am = handoverMs(a.order.required_date, a.order.required_time) ?? Infinity;
    const bm = handoverMs(b.order.required_date, b.order.required_time) ?? Infinity;
    return am - bm;
  });
  return out;
}

export function countOrderAlerts(orders, nowMs = Date.now()) {
  const alerts = buildOrderAlerts(orders, nowMs);
  return {
    overdue: alerts.filter((a) => a.deadline.kind === 'overdue').length,
    due_soon: alerts.filter((a) => a.deadline.kind === 'due_soon').length,
    unpaid: alerts.filter((a) => a.unpaid).length,
    total: alerts.length,
  };
}