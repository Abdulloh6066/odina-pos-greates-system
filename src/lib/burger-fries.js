import { BURGER_FRIES_SHOP_ID, canChooseBurgerFries, friesSurcharge } from '../../base44/shared/burger-fries.js';
export * from '../../base44/shared/burger-fries.js';

// An unassigned owner may inspect the choice before opening a real shift.
// Server validation still requires the actual Branch shop for a sale.
export const canPreviewBurgerFries = (productId, shopId) =>
  canChooseBurgerFries(productId, shopId || BURGER_FRIES_SHOP_ID);

export function repriceBurgerCartForShop(rows, products, shopId) {
  if (shopId !== BURGER_FRIES_SHOP_ID) return rows;
  let changed = false;
  const next = rows.map((row) => {
    if (!canChooseBurgerFries(row.product_id, shopId)) return row;
    const product = products.find((item) => item.id === row.product_id);
    if (!product) return row;
    const price = Number(product.shop_prices?.[shopId] ?? product.price) + friesSurcharge(row);
    if (!Number.isSafeInteger(price) || price < 0 || row.price === price) return row;
    changed = true;
    return { ...row, price, subtotal: price * row.quantity };
  });
  return changed ? next : rows;
}
