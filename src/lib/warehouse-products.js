import { catalogForShop } from './shop-category.js';

// These are the cake and bakery categories used by the production catalogue.
// Charges, shop-prepared drinks and retail food do not belong in cake production.
const PRODUCTION_CATEGORY_NAMES = new Set([
  'tortlar', 'aralash', '15 somlik', '18 somlik', 'mini/tart', 'pishiriqlar',
]);
const normalizedCategory = value => String(value || '').trim().toLocaleLowerCase()
  .replace(/:/g, '/').replace(/\s+/g, ' ');

export function warehouseProductsForLocation(products, categories, location, search = '') {
  if (!location?.id || location.active === false) return [];
  const inventory = (products || []).filter(product => product.active !== false
    && product.archived !== true && product.track_stock !== false);
  let scoped;
  if (location.location_type === 'production') {
    const categoryMap = new Map((categories || []).map(category => [category.id, category]));
    // Retail availability describes where cakes are sold, not where they are made.
    scoped = inventory.filter(product => (product.source_type || 'central_produced') === 'central_produced'
      && product.sale_unit !== 'gram'
      && PRODUCTION_CATEGORY_NAMES.has(normalizedCategory(
        categoryMap.get(product.category_id)?.name || product.category_name)));
  } else {
    scoped = catalogForShop(inventory, categories || [], location.id).products;
  }
  const query = search.trim().toLocaleLowerCase();
  return query ? scoped.filter(product => [product.name, product.category_name, product.source_type]
    .filter(Boolean).join(' ').toLocaleLowerCase().includes(query)) : scoped;
}
