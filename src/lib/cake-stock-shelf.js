export const CAKE_STOCK_PAGE_SIZE = 48;
export const CAKE_STOCK_COLUMN_ROWS = 6;

// Products have already been scoped to the selected shop by cakeProducts.
export function cakeStockColumns(products, categories, shopId) {
  const catalog = new Map((categories || []).map((category) => [category.id, category]));
  const groups = new Map();
  for (const product of products || []) {
    const id = product.shop_category_ids?.[shopId] || product.category_id || '__uncategorized';
    const category = catalog.get(id);
    if (!groups.has(id)) groups.set(id, {
      id,
      name: category?.name || product.category_name || 'Kategoriyasiz',
      order: Number(category?.sort_order) || 0,
      products: [],
    });
    groups.get(id).products.push(product);
  }
  return [...groups.values()].sort((a, b) =>
    Number(a.id === '__uncategorized') - Number(b.id === '__uncategorized')
    || a.order - b.order || a.name.localeCompare(b.name, 'uz', { numeric: true }));
}

export const CAKE_STOCK_ROLES = new Set(['admin', 'manager', 'cashier', 'accountant', 'production']);

export function assignedStockShop(user) {
  return user?.shop_id || user?.data?.shop_id || '';
}

export function stockShops(shops, user) {
  return (shops || []).filter((shop) => shop.active !== false && shop.location_type !== 'production'
    && (user?.role === 'admin' || shop.id === assignedStockShop(user)));
}

export function cakeProducts(products, categories, shopId) {
  if (!shopId) return [];
  const hiddenCategories = new Set((categories || []).filter((c) => c.hidden_shop_ids?.includes(shopId)).map((c) => c.id));
  return (products || []).filter((p) => p.archived !== true
    && (p.source_type || 'central_produced') === 'central_produced'
    && p.sale_unit !== 'gram'
    && (!p.available_shop_ids?.length || p.available_shop_ids.includes(shopId))
    && !hiddenCategories.has(p.shop_category_ids?.[shopId] || p.category_id));
}

export function cakeStockInfo(rows, productId, ready = true) {
  if (!ready) return { status: 'loading', quantity: null, unit: 'piece', label: 'Yuklanmoqda' };
  const matches = (rows || []).filter((row) => row.product_id === productId);
  if (!matches.length) return { status: 'missing', quantity: null, unit: 'piece', label: 'Sanoq kiritilmagan' };
  if (matches.length !== 1) return { status: 'invalid', quantity: null, unit: 'piece', label: 'Qoldiqni tekshiring' };
  const row = matches[0], quantity = Number(row.quantity);
  if (row.quantity == null || !Number.isSafeInteger(quantity) || (row.unit || 'piece') !== 'piece') {
    return { status: 'invalid', quantity: null, unit: row.unit, label: 'Birlik yoki qoldiq xatosi' };
  }
  return { row, quantity, unit: 'piece', status: quantity < 0 ? 'negative' : quantity === 0 ? 'zero' : 'positive',
    label: quantity < 0 ? 'Sanoq kerak' : quantity === 0 ? 'Qoldiq yo‘q' : 'Mavjud' };
}

export function stockChange(mode, value, current) {
  const quantity = Number(value);
  if (String(value).trim() === '' || !Number.isSafeInteger(quantity) || quantity < (mode === 'count' ? 0 : 1)) {
    return { error: mode === 'count' ? '0 yoki undan katta butun dona kiriting.' : 'Musbat butun dona kiriting.' };
  }
  const before = current == null ? 0 : Number(current);
  if (!Number.isSafeInteger(before)) return { error: 'Qoldiqni avval tekshiring.' };
  const after = mode === 'count' ? quantity : before + (mode === 'out' ? -quantity : quantity);
  if (!Number.isSafeInteger(after) || after < 0) return { error: 'Qoldiq manfiy bo‘la olmaydi. Haqiqiy sanoqni kiriting.' };
  return { quantity, before, after, delta: after - before };
}

export async function loadAllCakeBalances(entity, shopId) {
  const rows = [];
  for (let skip = 0; skip < 10000; skip += 500) {
    const page = await entity.filter({ location_id: shopId }, '-updated_at', 500, skip);
    if (!Array.isArray(page)) throw new Error('Qoldiq javobi noto‘g‘ri.');
    rows.push(...page.filter((row) => row.location_id === shopId));
    if (page.length < 500) return rows;
  }
  throw new Error('Qoldiqlar to‘liq yuklanmadi. Qayta yangilang.');
}

export function mergeCakeStockEvent(rows, event, shopId) {
  const data = event?.data;
  if (!data?.id) return null;
  if (event.type === 'delete') return rows.filter((row) => row.id !== data.id);
  if (data.location_id && data.location_id !== shopId) return rows.filter((row) => row.id !== data.id);
  const previous = rows.find((row) => row.id === data.id);
  if (!previous && (data.location_id !== shopId || !data.product_id || data.quantity == null)) return null;
  if (previous?.updated_at && data.updated_at && new Date(data.updated_at).getTime() < new Date(previous.updated_at).getTime()) return rows;
  const next = { ...previous, ...data };
  return previous ? rows.map((row) => row.id === data.id ? next : row) : [...rows, next];
}
