import { priceForShop } from './shop-pricing.js';
import { categoryForShop } from './shop-category.js';
import { productOrderBaseline, sortByShopOrder } from './pos-product-order.js';

// Reprice only when the source catalogue or selected shop changes. Every view
// below retains these objects so unchanged ProductCards can stay memoized.
export function pricePosProducts(products, shopId) {
  return products.map(product => ({ ...product, price: priceForShop(product, shopId) }));
}

export function preparePosCatalog(products, categories, shopId, productOrder) {
  const orderRows = (rows, byPrice = false) => {
    let ordered = productOrderBaseline(rows);
    if (byPrice) ordered.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    return sortByShopOrder(ordered, productOrder);
  };
  const byCategory = new Map();
  for (const category of categories) {
    if (byCategory.has(category.id)) continue;
    const sourceIds = category.sourceCategoryIds || [category.id];
    const rows = products.filter(product => sourceIds.includes(categoryForShop(product, shopId)));
    const byPrice = category.name?.trim().toLowerCase() === 'tortlar';
    byCategory.set(category.id, { rows, byPrice, ordered: orderRows(rows, byPrice) });
  }
  const favorites = products.filter(product => product.is_favorite || (shopId && product.favorite_shop_ids?.includes(shopId)));
  return {
    shopId, products, byCategory, orderRows,
    all: { rows: products, ordered: orderRows(products), byPrice: false },
    favorites: { rows: favorites, ordered: orderRows(favorites), byPrice: false },
    favoritesByPrice: { rows: favorites, ordered: orderRows(favorites, true), byPrice: true },
    names: new Map(products.map(product => [product, product.name.toLowerCase()])),
  };
}

export function selectPosProducts(catalog, { activeCat = 'all', showFav = false, search = '' } = {}) {
  const category = catalog.byCategory.get(activeCat);
  let view;
  if (showFav) view = category?.byPrice ? catalog.favoritesByPrice : catalog.favorites;
  else if (activeCat === 'all') view = catalog.all;
  else if (category) view = category;
  else {
    const rows = catalog.products.filter(product => categoryForShop(product, catalog.shopId) === activeCat);
    view = { rows, ordered: catalog.orderRows(rows), byPrice: false };
  }
  if (!search.trim()) return view.ordered;
  const query = search.toLowerCase();
  // Search must precede variant placement: when its target is filtered out,
  // a variant keeps its original slot, just as in the existing POS.
  return catalog.orderRows(view.rows.filter(product => catalog.names.get(product).includes(query)), view.byPrice);
}
