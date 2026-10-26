export function preparationPreview(recipe, value, factor = 1) {
  const input = Number(String(value).replace(',', '.'));
  const quantity = Math.round(input * factor * 1000) / 1000;
  if (!recipe || String(value).trim() === '' || !Number.isFinite(input) || input <= 0
    || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9
    || Math.abs(input * factor - quantity) > 1e-8
    || (recipe.output_unit === 'piece' && !Number.isSafeInteger(quantity))) {
    return { error: 'Musbat miqdorni aniq kiriting.', items: [] };
  }
  const items = recipe.items.map(item => {
    const raw = item.quantity * quantity / recipe.output_quantity;
    const required = Math.round(raw * 1000) / 1000;
    const after = Math.round((item.stock_quantity - required) * 1000) / 1000;
    return { ...item, required, after, shortage: after < 0,
      invalid: required <= 0 || !Number.isFinite(required)
        || (item.unit === 'piece' && Math.abs(raw - Math.round(raw)) > 1e-8) };
  });
  return { quantity, items, error: items.some(item => item.invalid)
    ? 'Bu miqdor uchun masalliqlarni aniq hisoblab bo‘lmaydi.'
    : items.some(item => item.shortage) ? 'Ayrim masalliqlar yetarli emas.' : '' };
}
