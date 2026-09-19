export const PREVIEW_PRICE_UZS = 5000;

// Draft catalog prices are display-only. Never change Product records or sale prices.
export function draftPreviewProducts(products) {
  return (products || [])
    .filter((product) => product.active === false
      && product.archived !== true
      && Number(product.price) === 0)
    .map((product) => ({ ...product, price: PREVIEW_PRICE_UZS }));
}
