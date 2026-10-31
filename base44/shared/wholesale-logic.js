export function wholesaleError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function sheetQuote(product, quantity, buyerType) {
  const amount = Number(quantity);
  const price = Number(product?.sheet_price);
  const factor = Number(product?.pieces_per_sheet);
  if (!product || product.active === false || product.archived === true || product.track_stock === false
    || product.production_unit !== 'sheet' || product.source_type !== 'central_produced' || product.sale_unit === 'gram') {
    throw wholesaleError('Faqat ishlab chiqarishdagi list mahsulotini sotish mumkin.');
  }
  if (!Number.isFinite(amount) || amount < 0.5 || amount > 10000 || !Number.isInteger(amount * 2)) {
    throw wholesaleError('Miqdor 0.5 list qadamida, 0.5 dan 10 000 gacha bo‘lsin.');
  }
  if (!Number.isSafeInteger(price) || price <= 0) throw wholesaleError('Mahsulotning 1 list narxini avval 3D + bo‘limida belgilang.');
  if (buyerType === 'branch' && (!Number.isSafeInteger(factor) || factor < 1 || !Number.isSafeInteger(amount * factor))) {
    throw wholesaleError('Filial uchun listdan dona hisobiga o‘tish sozlamasi noto‘g‘ri.');
  }
  const total = Math.round(amount * price);
  if (!Number.isSafeInteger(total) || total <= 0) throw wholesaleError('Umumiy summa noto‘g‘ri.');
  return { quantity: amount, unit: 'sheet', unit_price: price, total, conversion_factor: Number.isSafeInteger(factor) && factor > 0 ? factor : 1 };
}