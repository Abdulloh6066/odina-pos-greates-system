// Keep one shared product; shops may place it in a different POS category.
export function categoryForShop(product, shopId) {
  const category = shopId ? product?.shop_category_ids?.[shopId] : undefined;
  return typeof category === 'string' && category.trim() ? category : product?.category_id;
}
