import { shiftDateKey } from './uzbekistan-time.js';

export const HISTORY_PAGE_SIZE = 100;
export const FINISHED_ORDER_STATUSES = ['yakunlandi', 'bekor_qilindi'];
const and = (parts) => parts.length ? { $and: parts } : {};
const absent = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: '' }, { [field]: null }] });
const textSearch = (fields, value) => {
  const query = String(value || '').trim();
  if (!query) return null;
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $or: fields.map((field) => ({ [field]: { $regex: literal, $options: 'i' } })) };
};
const dayRange = (date) => ({
  $gte: new Date(`${date}T00:00:00+05:00`).toISOString(),
  $lt: new Date(`${shiftDateKey(date, 1)}T00:00:00+05:00`).toISOString(),
});

// Include legacy records that predate stored business dates and occurrence times.
export function salesHistoryQuery({ user, date, search, shop_id = '' } = {}) {
  const parts = [];
  if (user?.role === 'cashier') parts.push({ user_id: user.id });
  if (user?.role === 'admin' && shop_id && shop_id !== 'all') parts.push({ shop_id });
  if (date) parts.push({ $or: [
    { business_date: date },
    { $and: [absent('business_date'), { sold_at: dayRange(date) }] },
    { $and: [absent('business_date'), absent('sold_at'), { created_date: dayRange(date) }] },
  ] });
  const query = textSearch(['user_name', 'payment_methods_summary'], search);
  if (query) parts.push(query);
  return and(parts);
}

export function shiftsHistoryQuery({ user, query, date, shop_id = 'all', status = 'all' } = {}) {
  const parts = [];
  if (user?.role === 'cashier') parts.push({ user_id: user.id });
  if (shop_id !== 'all') parts.push({ shop_id });
  if (status === 'closed') parts.push({ status: 'closed' });
  if (status === 'open') parts.push({ status: { $ne: 'closed' } });
  if (date) parts.push({ $or: [
    { opened_at: dayRange(date) },
    { $and: [absent('opened_at'), { created_date: dayRange(date) }] },
  ] });
  const search = textSearch(['user_name', 'shop_name'], query);
  if (search) parts.push(search);
  return and(parts);
}

export function ordersHistoryQuery({ view, today, tomorrow, query, shop, type, status, pay, date } = {}) {
  const parts = [];
  if (['today', 'tomorrow', 'other'].includes(view)) parts.push({ order_status: { $nin: FINISHED_ORDER_STATUSES } });
  if (view === 'today') parts.push({ required_date: today });
  if (view === 'tomorrow') parts.push({ required_date: tomorrow });
  if (view === 'other') parts.push({ required_date: { $nin: [today, tomorrow] } });
  if (view === 'history') parts.push({ order_status: { $in: FINISHED_ORDER_STATUSES } });
  if (view === 'date' && date) parts.push({ required_date: date });
  if (shop) parts.push({ shop_id: shop });
  if (type) parts.push({ order_type: type });
  if (status) parts.push({ order_status: status });
  if (pay) parts.push({ payment_status: pay });
  // The display number may omit the established order prefix.
  const search = textSearch(['order_number', 'customer_name', 'customer_phone'], query);
  if (search && /^\d+$/.test(String(query).trim()) && Number.isSafeInteger(Number(query))) {
    search.$or.push({ order_sequence: Number(query) });
  }
  if (search) parts.push(search);
  return and(parts);
}

export async function readEntityPage(entity, query, sort, skip = 0, pageSize = HISTORY_PAGE_SIZE) {
  const rows = await entity.filter(query, sort, pageSize, skip);
  if (!Array.isArray(rows)) throw new Error('Ma’lumotlarni to‘liq yuklab bo‘lmadi.');
  return { rows, nextSkip: skip + rows.length, hasMore: rows.length === pageSize };
}

// Used only for a selected shift or unfinished orders, never the entire history.
export async function readAllEntityPages(entity, query, sort = 'id', isCurrent = () => true) {
  const rows = new Map();
  let skip = 0;
  while (isCurrent()) {
    const page = await readEntityPage(entity, query, sort, skip);
    if (!isCurrent()) return [];
    const newRows = page.rows.filter((row) => !rows.has(row.id));
    for (const row of page.rows) rows.set(row.id, row);
    if (!page.hasMore) return [...rows.values()];
    if (!newRows.length) {
      throw new Error('Tarix sahifasini yuklab bo‘lmadi.');
    }
    skip = page.nextSkip;
  }
  return [];
}
