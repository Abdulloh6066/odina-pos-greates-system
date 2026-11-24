import { CAKE_CATEGORY_ID } from './sale-options.js';
export { CAKE_CATEGORY_ID };

// Keep one shared product; shops may place it in a different POS category.
export function categoryForShop(product, shopId) {
  const category = shopId ? product?.shop_category_ids?.[shopId] : undefined;
  return typeof category === 'string' && category.trim() ? category : product?.category_id;
}

const offeredAtShop = (product, shopId) => !product.available_shop_ids?.length || product.available_shop_ids.includes(shopId);
const hiddenAtShop = (category, shopId) => Boolean(shopId && category.hidden_shop_ids?.includes(shopId));

export function isBirthdayOrderCake(product, shopId, category) {
  return Boolean(shopId && category?.id === CAKE_CATEGORY_ID && category.active && !hiddenAtShop(category, shopId)
    && product?.active && product.archived !== true && offeredAtShop(product, shopId)
    && categoryForShop(product, shopId) === category.id);
}

// Apply category visibility before All, Favorites, search or reorder filters.
// Grouped category tabs also hide the IDs they represent.
export function catalogForShop(products, categories, shopId) {
  const hidden = new Set();
  const visible = categories.filter(category => {
    const excluded = hiddenAtShop(category, shopId);
    if (excluded) for (const id of category.sourceCategoryIds || [category.id]) hidden.add(id);
    return !excluded;
  });
  return {
    categories: visible,
    products: products.filter(product => offeredAtShop(product, shopId) && !hidden.has(categoryForShop(product, shopId))),
  };
}
