export function priceForShop(product: any, shopId: string): number {
  const override = shopId && product?.shop_prices?.[shopId];
  return Number(override === undefined || override === null ? product?.price : override);
}
