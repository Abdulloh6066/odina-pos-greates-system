// Finished-product stock is measured in whole or half dona/list.
// Ingredient units and whole cake-layer rules are handled separately.
export const PRODUCT_STOCK_STEP = 0.5;

export function isProductStockQuantity(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && Number.isSafeInteger(value * 2);
}
