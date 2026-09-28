// Keep one shared product; shops may place it in a different POS category.
export function categoryForShop(product, shopId) {
  const category = shopId ? product?.shop_category_ids?.[shopId] : undefined;
  return typeof category === 'string' && category.trim() ? category : product?.category_id;
}


// Apply category visibility before All, Favorites, search or reorder filters.
// Grouped category tabs also hide the IDs they represent.
export function catalogForShop(products, categories, shopId) {
  const hidden = new Set();
  const visible = categories.filter(category => {
    const excluded = Boolean(shopId && category.hidden_shop_ids?.includes(shopId));
    if (excluded) for (const id of category.sourceCategoryIds || [category.id]) hidden.add(id);
    return !excluded;
  });
  return {
    categories: visible,
    products: products.filter(product =>
      (!product.available_shop_ids?.length || product.available_shop_ids.includes(shopId)) &&
      !hidden.has(categoryForShop(product, shopId))),
  };
}
