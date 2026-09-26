// One catalog record is shared by all shops; only the selling price can differ.
export function priceForShop(product, shopId) {
  const override = shopId && product?.shop_prices?.[shopId];
  return override === undefined || override === null ? Number(product?.price) : Number(override);
}
