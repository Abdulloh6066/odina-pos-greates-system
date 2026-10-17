const PRODUCT_PHOTO_FALLBACKS = Object.freeze({
  '6ad3599745b7d8066e5d871d': '/images/products/bardak-chay-white-v1.webp',
  '6ad3599745b7d8066e5d871e': '/images/products/sansebastian-choco-white-v1.webp',
  '6ad3599745b7d8066e5d871f': '/images/products/bardak-stakan-white-v1.webp',
  '6ac28d5c985a100cf107bf54': '/images/products/choco-banan-white-v1.webp',
});

// Display-only photos: callers keep the saved image URL and business records intact.
export function productPhotoFallbackFor(productId) {
  return Object.hasOwn(PRODUCT_PHOTO_FALLBACKS, productId) ? PRODUCT_PHOTO_FALLBACKS[productId] : null;
}
