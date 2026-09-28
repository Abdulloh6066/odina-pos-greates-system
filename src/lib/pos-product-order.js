export function sortByShopOrder(products, ids = []) {
  const ranks = new Map(ids.map((id, index) => [id, index]));
  return [...products].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}

// Retain the legacy placement until a shop explicitly saves a custom order.
export function productOrderBaseline(products) {
  let list = [...products];
  for (const product of [...list]) {
    if (!product.display_before_product_id || product.display_before_product_id === product.id) continue;
    if (!list.some(row => row.id === product.display_before_product_id)) continue;
    list = list.filter(row => row.id !== product.id);
    list.splice(list.findIndex(row => row.id === product.display_before_product_id), 0, product);
  }
  return list;
}

// Reordering a category/search result preserves every hidden product's slot.
export function moveVisibleProduct(order, visibleIds, from, to) {
  if (from === to || from < 0 || to < 0 || from >= visibleIds.length || to >= visibleIds.length) return order;
  const moved = [...visibleIds];
  moved.splice(to, 0, moved.splice(from, 1)[0]);
  const visible = new Set(visibleIds);
  let next = 0;
  return order.map(id => visible.has(id) ? moved[next++] : id);
}
