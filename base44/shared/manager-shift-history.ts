// Read-only history projection. The stored manager shop is the only authority.
const fail = (message: string, status = 400) => { throw Object.assign(new Error(message), { status }); };
const pick = (row: any, fields: string[]) => Object.fromEntries(fields.filter(key => row?.[key] !== undefined).map(key => [key, row[key]]));
const SHIFT_FIELDS = ['id', 'user_id', 'user_name', 'shop_id', 'shop_name', 'status', 'opened_at', 'closed_at', 'created_date',
  'starting_cash', 'expected_cash', 'actual_cash', 'difference', 'cash_sales', 'uzcard_sales', 'humo_sales', 'online_sales',
  'bank_transfer_sales', 'total_sales', 'order_count', 'cash_removed', 'refunds_total', 'stock_count_completed',
  'stock_snapshot_count', 'stock_difference_quantity', 'stock_difference_product_count'];
const ITEM_FIELDS = ['id', 'sale_id', 'product_id', 'product_name_snapshot', 'product_name', 'quantity', 'line_total', 'subtotal', 'unit_price', 'price', 'sale_unit'];
const SALE_FIELDS = ['id', 'shift_id', 'shop_id', 'user_id', 'user_name', 'sale_number', 'created_date', 'created_at', 'sold_at', 'status', 'total', 'discount_amount', 'discount_code', 'payment_methods_summary'];
const specs = [
  ['sales', 'Sale', SALE_FIELDS],
  ['saleItems', 'SaleItem', ITEM_FIELDS],
  ['movements', 'CashMovement', ['id', 'amount', 'created_at', 'created_date', 'employee_name', 'expense_category', 'reason', 'recipient_name_snapshot']],
  ['refunds', 'Refund', ['id', 'amount', 'created_at', 'created_date', 'reason', 'refund_number', 'sale_number']],
  ['stockSnapshots', 'ShiftProductSnapshot', ['id', 'product_id', 'product_name_snapshot', 'opening_quantity', 'received_quantity', 'sold_quantity', 'waste_quantity', 'expected_quantity', 'returned_quantity', 'other_change_quantity']],
] as const;
const saleProjection = (row: any) => ({ ...pick(row, SALE_FIELDS),
  items: Array.isArray(row.items) ? row.items.map((item: any) => pick(item, ITEM_FIELDS)) : [],
  payments: Array.isArray(row.payments) ? row.payments.map((payment: any) => pick(payment, ['method', 'amount'])) : [],
});
const pageNumber = (value: unknown, fallback: number, max: number) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) fail('Tarix sahifasi noto‘g‘ri.');
  return n;
};

export async function readManagerShiftHistory(service: any, user: any, body: any) {
  if (user.role !== 'manager' || !user.shop_id) fail('Boshqaruvchi ruxsati kerak.', 403);
  if (body.shop_id && body.shop_id !== user.shop_id) fail('Boshqa do‘konga ruxsat yo‘q.', 403);
  if (body.action === 'list_shift_history') {
    const filters = body.filters === undefined ? {} : body.filters;
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)
      || Object.keys(filters).some(key => !['query', 'date', 'status', 'shop_id'].includes(key))) fail('Tarix filtri noto‘g‘ri.');
    if (filters.shop_id && filters.shop_id !== 'all' && filters.shop_id !== user.shop_id) fail('Boshqa do‘konga ruxsat yo‘q.', 403);
    const parts: any[] = [{ shop_id: user.shop_id }];
    const status = String(filters.status || 'all');
    if (!['all', 'open', 'closed'].includes(status)) fail('Smena holati noto‘g‘ri.');
    if (status !== 'all') parts.push({ status: status === 'open' ? { $ne: 'closed' } : 'closed' });
    const date = String(filters.date || '');
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail('Sana noto‘g‘ri.');
      const start = new Date(`${date}T00:00:00+05:00`);
      const range = { $gte: start.toISOString(), $lt: new Date(start.getTime() + 86400000).toISOString() };
      parts.push({ $or: [{ opened_at: range }, { $and: [
        { $or: [{ opened_at: { $exists: false } }, { opened_at: '' }, { opened_at: null }] }, { created_date: range },
      ] }] });
    }
    const query = String(filters.query || '').trim();
    if (query.length > 200) fail('Qidiruv matni juda uzun.');
    if (query) {
      const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      parts.push({ $or: ['user_name', 'shop_name'].map(field => ({ [field]: { $regex: literal, $options: 'i' } })) });
    }
    if (body.created_before) {
      if (typeof body.created_before !== 'string' || !Number.isFinite(Date.parse(body.created_before))) fail('Tarix vaqti noto‘g‘ri.');
      parts.push({ created_date: { $lte: new Date(body.created_before).toISOString() } });
    }
    const limit = pageNumber(body.limit, 100, 100);
    if (!limit) fail('Tarix sahifasi noto‘g‘ri.');
    const skip = pageNumber(body.skip, 0, 100000);
    const rows = await service.entities.Shift.filter({ $and: parts }, '-opened_at', limit, skip);
    if (!Array.isArray(rows) || rows.some(row => row?.shop_id !== user.shop_id)) fail('Smena tarixi javobi noto‘g‘ri.', 502);
    return { rows: rows.map(row => pick(row, SHIFT_FIELDS)), shop_id: user.shop_id, reader_version: '2026-10-25-manager-shifts-1' };
  }
  const shift = await service.entities.Shift.get(String(body.shift_id || ''));
  if (!shift) fail('Smena topilmadi.', 404);
  if (shift.shop_id !== user.shop_id) fail('Boshqa do‘konga ruxsat yo‘q.', 403);
  const load = async (entity: string, fields: readonly string[]) => {
    const rows: any[] = [];
    for (let skip = 0; skip < 10000; skip += 100) {
      const page = await service.entities[entity].filter({ shift_id: shift.id }, 'id', 100, skip);
      if (!Array.isArray(page) || page.some(row => row?.shift_id !== shift.id || (row.shop_id && row.shop_id !== user.shop_id))) fail('Smena tafsilotlari javobi noto‘g‘ri.', 502);
      rows.push(...page.map(row => entity === 'Sale' ? saleProjection(row) : pick(row, [...fields])));
      if (page.length < 100) return rows;
    }
    fail('Smena tafsilotlari chegaradan oshdi. Filtrni toraytiring.', 502);
  };
  const results = await Promise.allSettled(specs.map(([, entity, fields]) => load(entity, fields)));
  if (results[0].status === 'rejected') throw results[0].reason;
  const detail: any = { canViewMovements: true, partial: results.some(result => result.status === 'rejected') };
  results.forEach((result, index) => { detail[specs[index][0]] = result.status === 'fulfilled' ? result.value : []; });
  return { shift: pick(shift, SHIFT_FIELDS), detail, shop_id: user.shop_id, reader_version: '2026-10-25-manager-shifts-1' };
}
