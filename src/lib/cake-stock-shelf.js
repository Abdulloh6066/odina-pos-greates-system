export const CAKE_STOCK_PAGE_SIZE = 48;

export function inventoryUnits(item) {
  if (item?.stock_kind !== 'ingredient') return { base: 'piece', unit: 'piece', label: 'dona', factor: 1, step: 1 };
  const base = item.base_unit;
  const unit = (base === 'g' && item.purchase_unit === 'kg') ? 'kg'
    : (base === 'ml' && item.purchase_unit === 'l') ? 'l' : base;
  return { base, unit, label: unit === 'piece' ? 'dona' : unit === 'l' ? 'litr' : unit,
    factor: unit === 'kg' || unit === 'l' ? 1000 : 1, step: base === 'piece' ? 1 : 0.001 };
}

export function formatStockQuantity(quantity, item) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: inventoryUnits(item).factor === 1000 ? 6 : 3 })
    .format(Number(quantity) / inventoryUnits(item).factor).replaceAll(',', ' ');
}

export const INGREDIENT_SHELF_CATEGORIES = [
  { id: 'ingredient-milk', name: 'Sut va qaymoq', sort_order: 1 },
  { id: 'ingredient-coffee', name: 'Kofe va choy', sort_order: 2 },
  { id: 'ingredient-syrup', name: 'Sirop va pyurelar', sort_order: 3 },
  { id: 'ingredient-food', name: 'Boshqa masalliqlar', sort_order: 4 },
  { id: 'ingredient-packaging', name: 'Qadoqlar', sort_order: 5 },
  { id: 'ingredient-household', name: 'Xo‘jalik', sort_order: 6 },
];

export function shelfIngredients(ingredients) {
  return (ingredients || []).filter(item => item.active !== false && item.is_cake_layer !== true).map(item => {
    const category = item.category === 'packaging' ? 'packaging' : item.category === 'household' ? 'household'
      : /sut|slivka|qaymoq|milk/i.test(item.name) ? 'milk'
      : /qahva|kofe|coffee|choy|matcha|kakao/i.test(item.name) ? 'coffee'
      : /sirop|pyure|bazasi|fresh/i.test(item.name) ? 'syrup' : 'food';
    return { ...item, stock_kind: 'ingredient', category_id: 'ingredient-' + category,
      category_name: INGREDIENT_SHELF_CATEGORIES.find(group => group.id === 'ingredient-' + category)?.name };
  }).sort((a, b) => a.name.localeCompare(b.name, 'uz', { numeric: true }));
}

export function allStockProducts(products, categories, shopId) {
  if (!shopId) return [];
  const hidden = new Set((categories || []).filter(c => c.hidden_shop_ids?.includes(shopId)).map(c => c.id));
  return (products || []).filter(p => p.archived !== true && p.track_stock !== false && p.sale_unit !== 'gram'
    && (!p.available_shop_ids?.length || p.available_shop_ids.includes(shopId))
    && !hidden.has(p.shop_category_ids?.[shopId] || p.category_id));
}

export function inventoryStockInfo(rows, item, ready = true) {
  if (item?.stock_kind !== 'ingredient') return cakeStockInfo(rows, item.id, ready);
  const { base } = inventoryUnits(item);
  if (!ready) return { status: 'loading', quantity: null, unit: base, label: 'Yuklanmoqda' };
  if (!['g', 'ml', 'piece'].includes(base)) return { status: 'invalid', quantity: null, unit: base, label: 'Birlikni tekshiring' };
  const matches = (rows || []).filter(row => row.ingredient_id === item.id);
  if (!matches.length) return { status: 'missing', quantity: null, unit: base, label: 'Sanoq kiritilmagan' };
  const row = matches[0], quantity = Number(row.quantity);
  if (matches.length !== 1 || row.quantity == null || !Number.isFinite(quantity)
    || Math.abs(quantity) > Number.MAX_SAFE_INTEGER / 1000 || row.unit !== base
    || (base === 'piece' && !Number.isSafeInteger(quantity))) {
    return { status: 'invalid', quantity: null, unit: base, label: 'Birlik yoki qoldiq xatosi' };
  }
  return { row, quantity, unit: base, status: quantity < 0 ? 'negative' : quantity === 0 ? 'zero' : 'positive',
    label: quantity < 0 ? 'Sanoq kerak' : quantity === 0 ? 'Qoldiq yo‘q' : 'Mavjud' };
}

export function inventoryStockChange(mode, value, current, item) {
  if (item?.stock_kind !== 'ingredient') return stockChange(mode, value, current);
  const { base, factor, step, label } = inventoryUnits(item);
  const input = Number(value), scaled = input * 1000;
  if (!['g', 'ml', 'piece'].includes(base) || String(value).trim() === '' || !Number.isFinite(input)
    || input < (mode === 'count' ? 0 : step) || !Number.isSafeInteger(Math.round(scaled))
    || Math.abs(scaled - Math.round(scaled)) > 0.000001 || (base === 'piece' && !Number.isSafeInteger(input))) {
    return { error: base === 'piece' ? 'Butun dona kiriting.' : 'Miqdorni ' + label + 'da, ko‘pi bilan 3 kasr xonasi bilan kiriting.' };
  }
  const round = n => Math.round(n * 1000) / 1000;
  const quantity = round(input * factor), before = current == null ? 0 : Number(current);
  const after = mode === 'count' ? quantity : round(before + (mode === 'out' ? -quantity : quantity));
  if (!Number.isFinite(before) || !Number.isSafeInteger(Math.round(after * 1000)) || after < 0) {
    return { error: 'Qoldiq manfiy bo‘la olmaydi. Haqiqiy sanoqni kiriting.' };
  }
  return { quantity, before, after, delta: round(after - before) };
}

export async function loadAllInventoryItems(entity, sort = 'name') {
  const rows = [];
  for (let skip = 0; skip < 10000; skip += 500) {
    const page = await entity.list(sort, 500, skip);
    if (!Array.isArray(page)) throw new Error('Mahsulotlar javobi noto‘g‘ri.');
    rows.push(...page);
    if (page.length < 500) return rows;
  }
  throw new Error('Mahsulotlar to‘liq yuklanmadi. Qayta yuklang.');
}

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
  const listed = (shops || []).filter((shop) => shop.active !== false && shop.location_type !== 'production'
    && (user?.role === 'admin' || shop.id === assignedStockShop(user)));
  if (listed.length || user?.role === 'admin' || user?.role === 'production') return listed;
  // The Shop read rule can hide a worker's own shop from the browser list. Fall back to the shop
  // already assigned on the account; the warehouse-stock backend still validates every read and write.
  const assigned = assignedStockShop(user);
  const known = (shops || []).find((shop) => shop.id === assigned);
  if (!assigned || known) return listed;
  return [{ id: assigned, name: user?.shop_name || user?.data?.shop_name || 'Do‘kon', active: true, location_type: 'shop' }];
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

export function mergeCakeStockEvent(rows, event, shopId, itemIdField = 'product_id') {
  const data = event?.data;
  if (!data?.id) return null;
  if (event.type === 'delete') return rows.filter((row) => row.id !== data.id);
  if (data.location_id && data.location_id !== shopId) return rows.filter((row) => row.id !== data.id);
  const previous = rows.find((row) => row.id === data.id);
  if (!previous && (data.location_id !== shopId || !data[itemIdField] || data.quantity == null)) return null;
  if (previous?.updated_at && data.updated_at && new Date(data.updated_at).getTime() < new Date(previous.updated_at).getTime()) return rows;
  const next = { ...previous, ...data };
  return previous ? rows.map((row) => row.id === data.id ? next : row) : [...rows, next];
}
