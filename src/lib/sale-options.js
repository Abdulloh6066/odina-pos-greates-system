export * from '../../base44/shared/sale-options.js';
import { canChooseCakeExtra, cakeExtraSurcharge } from '../../base44/shared/sale-options.js';

export function repriceCakeCartForShop(rows, products, shopId) {
  if (!shopId || !rows.some(row => row.cake_extra === true)) return rows;
  const byId = new Map(products.map(product => [product.id, product]));
  let changed = false;
  const next = rows.map(row => {
    const product = byId.get(row.product_id);
    if (row.cake_extra !== true || !canChooseCakeExtra(product, shopId)) return row;
    const price = Number(product.shop_prices?.[shopId] ?? product.price) + cakeExtraSurcharge(row);
    if (!Number.isSafeInteger(price) || price < 0 || price === row.price) return row;
    changed = true;
    return { ...row, price, subtotal: row.quantity * price };
  });
  return changed ? next : rows;
}
