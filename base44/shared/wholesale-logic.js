export function wholesaleError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function wholesaleUnit(product) {
  return product?.category_id === '6ab57e00ab3a0a5019ea99db'
    || String(product?.category_name || '').trim().toLowerCase() === 'tortlar' ? 'piece' : 'sheet';
}
export function sheetQuote(product, quantity, buyerType) {
  const amount = Number(quantity);
  const unit = wholesaleUnit(product);
  const price = Number(unit === 'piece' ? product?.price : product?.sheet_price);
  const factor = unit === 'piece' ? 1 : Number(product?.pieces_per_sheet);
  if (!product || product.active === false || product.archived === true || product.track_stock === false
    || !['piece', 'sheet'].includes(product.production_unit || 'piece') || product.source_type !== 'central_produced' || product.sale_unit === 'gram') {
    throw wholesaleError('Faqat ishlab chiqarishdagi list mahsulotini sotish mumkin.');
  }
  if (!Number.isFinite(amount) || amount < (unit === 'piece' ? 1 : 0.5) || amount > 10000 || !Number.isInteger(amount * (unit === 'piece' ? 1 : 2))) {
    throw wholesaleError(unit === 'piece' ? 'Miqdor 1 dan 10 000 gacha butun dona bo‘lsin.' : 'Miqdor 0.5 list qadamida, 0.5 dan 10 000 gacha bo‘lsin.');
  }
  if (!Number.isSafeInteger(price) || price <= 0) throw wholesaleError('Mahsulotning 1 list narxini avval 3D + bo‘limida belgilang.');
  if (!Number.isSafeInteger(factor) || factor < 1 || (buyerType === 'branch' && !Number.isSafeInteger(amount * factor))) {
    throw wholesaleError('Filial uchun listdan dona hisobiga o‘tish sozlamasi noto‘g‘ri.');
  }
  const total = Math.round(amount * price);
  if (!Number.isSafeInteger(total) || total <= 0) throw wholesaleError('Umumiy summa noto‘g‘ri.');
  return { quantity: amount, unit, unit_price: price, total, conversion_factor: Number.isSafeInteger(factor) && factor > 0 ? factor : 1 };
}