import { canChooseTeaServing, teaServingPrice } from '../../base44/shared/tea-options.js';
export * from '../../base44/shared/tea-options.js';

// Unsaved preview carts adopt the shift's catalogue price. Saved orders retain their snapshots.
export function repriceTeaCartForShop(rows, products, shopId) {
  if (!shopId) return rows;
  let changed = false;
  const next = rows.map((row) => {
    if (!canChooseTeaServing(row.product_id)) return row;
    const product = products.find((item) => item.id === row.product_id);
    if (!product) return row;
    const price = teaServingPrice(product.shop_prices?.[shopId] ?? product.price, row.tea_option);
    if (!Number.isSafeInteger(price) || price < 0 || row.price === price) return row;
    changed = true;
    return { ...row, price, subtotal: price * row.quantity };
  });
  return changed ? next : rows;
}
