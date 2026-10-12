import { POS_THUMBNAILS } from './pos-thumbnail-manifest.js';

/**
 * POS-only image lookup, shared by Central and Branch.
 * A changed Product.image_url must never keep showing an older thumbnail.
 * Unmapped, unavailable or newly added images retain their original URL.
 */
export function posThumbnailFor(product) {
  if (!product?.id || !product?.image_url) return null;
  const entry = POS_THUMBNAILS[product.id];
  return entry && entry.source === product.image_url ? entry.thumbnail : null;
}
