import { POS_THUMBNAILS } from './pos-thumbnail-manifest.js';

/**
 * POS-only image lookup, shared by Central and Branch.
 * Priority: matching manifest thumbnail -> product's own optimized thumbnail
 * (only when it was made from the current image_url) -> original image.
 * A changed Product.image_url must never keep showing an older thumbnail.
 */
export function posThumbnailFor(product) {
  if (!product?.id) return null;
  const imageUrl = String(product.image_url || '').trim();
  if (!imageUrl) return null;

  const entry = POS_THUMBNAILS[product.id];
  if (entry && entry.source === imageUrl) return entry.thumbnail;

  const ownThumbnail = String(product.pos_thumbnail_url || '').trim();
  const ownSource = String(product.pos_thumbnail_source || '').trim();
  if (ownThumbnail && ownSource && ownSource === imageUrl) return ownThumbnail;

  return null;
}