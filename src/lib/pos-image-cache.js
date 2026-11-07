import { posThumbnailFor } from './pos-thumbnails.js';
import { productPhotoFallbackFor } from './product-photos.js';
import { parseWixMediaUrl, buildTransformUrl } from '../components/ui/image-helpers.js';

// Reuse the worker's public-image cache; never store catalogue or financial API responses here.
export const POS_IMAGE_CACHE = 'odina-public-images-v1';
const MAX_IMAGES = 600;

export function isPublicPosImage(url, origin) {
  try {
    const parsed = new URL(url, origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    if (parsed.origin === origin) return /^\/(images\/|odina-mark\.png$)/.test(parsed.pathname);
    if (parsed.protocol !== 'https:') return false;
    return (parsed.hostname === 'media.base44.com' && parsed.pathname.startsWith('/images/public/'))
      || (parsed.hostname === 'static.wixstatic.com' && parsed.pathname.startsWith('/media/'))
      || (parsed.hostname === 'base44.app' && /^\/api\/apps\/([a-f0-9]{24})\/files\/mp\/public\/\1\//.test(parsed.pathname));
  } catch { return false; }
}

export function posImageCachePlan(products, { origin, width = 512, height = width } = {}) {
  const urls = new Set(); let skipped = 0;
  for (const product of products || []) {
    const source = posThumbnailFor(product) || product.image_url || productPhotoFallbackFor(product.id);
    if (!source || String(source).startsWith('data:')) continue;
    if (!isPublicPosImage(source, origin)) { skipped++; continue; }
    const parsed = parseWixMediaUrl(source);
    // Match Image's existing 1x/2x/3x srcSet at the current card dimensions.
    const candidates = parsed ? [1, 2, 3].map(ratio => buildTransformUrl(parsed, {
      width: width * ratio, height: height * ratio, crop: true, quality: 90,
    })) : [source];
    for (const url of candidates) urls.add(new URL(url, origin).href);
  }
  return { urls: [...urls], skipped };
}

export async function cachePosImages(products, options = {}) {
  const storage = options.storage || globalThis.caches;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!storage?.open) throw new Error('Bu brauzer rasmlarni qurilmada saqlashni qo‘llamaydi.');
  const plan = posImageCachePlan(products, options);
  const urls = plan.urls.slice(0, MAX_IMAGES);
  const cache = await storage.open(POS_IMAGE_CACHE);
  const result = { total: urls.length, cached: 0, downloaded: 0, failed: [], skipped: plan.skipped + plan.urls.length - urls.length, cancelled: false };
  const snapshot = () => ({ ...result, failed: [...result.failed] });
  const notify = () => options.onProgress?.(snapshot());
  notify();
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length && !options.signal?.aborted) {
      const url = urls[cursor++];
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 20000);
      try {
        const saved = await cache.match(url);
        if (saved?.ok && saved.headers.get('content-type')?.startsWith('image/')) result.cached++;
        else {
          const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache', signal: controller.signal });
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
            throw new Error('Rasm yuklanmadi (' + response.status + ').');
          }
          await cache.put(url, response.clone());
          result.downloaded++;
        }
      } catch (error) {
        if (options.signal?.aborted) break;
        result.failed.push({ url, error: error?.message || 'Rasm saqlanmadi.' });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      }
      notify();
    }
  };
  // A manual warmup should leave bandwidth and the main thread available to the till.
  await Promise.all([worker(), worker()]);
  if (!options.signal?.aborted) {
    const keys = await cache.keys();
    const wanted = new Set(urls);
    const old = keys.filter(key => !wanted.has(typeof key === 'string' ? key : key.url));
    for (const key of old.slice(0, Math.max(0, keys.length - MAX_IMAGES))) {
      if (options.signal?.aborted) break;
      await cache.delete(key);
    }
  }
  result.cancelled = Boolean(options.signal?.aborted);
  return snapshot();
}
