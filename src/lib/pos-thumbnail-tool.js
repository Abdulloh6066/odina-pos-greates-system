// Kassa rasmlari uchun kichik WebP nusxalar. Asl rasm (image_url) hech qachon
// o‘zgartirilmaydi: natija faqat pos_thumbnail_url / pos_thumbnail_source ga yoziladi.
export const POS_THUMBNAIL_MAX_SIDE = 512;
export const POS_THUMBNAIL_QUALITY = 0.88;
export const POS_THUMBNAIL_CONCURRENCY = 3;

export function isHttpImageUrl(value) {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
}

// Faqat asl rasm http(s) bo‘lsa va shu rasm uchun kichik nusxa bo‘lmasa ishlaymiz.
export function needsPosThumbnail(product) {
  const source = String(product?.image_url || '').trim();
  if (!isHttpImageUrl(source)) return false;
  return !product?.pos_thumbnail_url || String(product.pos_thumbnail_source || '').trim() !== source;
}

// data: havolalar o‘tkazib yuboriladi; allaqachon tayyor rasmlar qayta ishlanmaydi.
export function posThumbnailQueue(products) {
  const queue = [];
  const skipped = [];
  let ready = 0;
  for (const product of products || []) {
    const source = String(product?.image_url || '').trim();
    if (!source) continue;
    if (!isHttpImageUrl(source)) {
      skipped.push({ id: product.id, name: product.name || '', reason: 'data: havola o‘tkazib yuborildi' });
      continue;
    }
    if (!needsPosThumbnail(product)) {
      ready += 1;
      continue;
    }
    queue.push(product);
  }
  return { queue, skipped, ready };
}

// Eng uzun tomon 512 px dan oshmaydi, nisbat saqlanadi.
export function posThumbnailSize(width, height, maxSide = POS_THUMBNAIL_MAX_SIDE) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (!w || !h) return null;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export async function encodePosThumbnail(blob, options = {}) {
  const maxSide = Number(options.maxSide) || POS_THUMBNAIL_MAX_SIDE;
  const quality = Number(options.quality) || POS_THUMBNAIL_QUALITY;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('Bu brauzer rasmni kichraytirishni qo‘llab-quvvatlamaydi.');
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const size = posThumbnailSize(bitmap.width, bitmap.height, maxSide);
    if (!size) throw new Error('Rasm o‘lchami aniqlanmadi.');
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Rasmni qayta ishlab bo‘lmadi.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const output = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (!output || !output.size) throw new Error('WebP rasm yaratilmadi.');
    return { blob: output, width: size.width, height: size.height };
  } finally {
    bitmap.close?.();
  }
}

export async function optimizePosThumbnail(product, deps = {}) {
  const source = String(product?.image_url || '').trim();
  if (!isHttpImageUrl(source)) throw new Error('Rasm manzili http(s) emas.');

  const fetchImpl = deps.fetchImpl || fetch;
  const response = await fetchImpl(source, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
  if (!response?.ok) throw new Error(`Asl rasm yuklanmadi (${response?.status || 'xato'}).`);
  const original = await response.blob();
  if (!String(original?.type || '').startsWith('image/')) throw new Error('Fayl rasm emas.');

  const encode = deps.encode || encodePosThumbnail;
  const encoded = await encode(original, deps);
  const uploadFile = deps.uploadFile;
  if (typeof uploadFile !== 'function') throw new Error('Rasm yuklash xizmati topilmadi.');
  const file = new File([encoded.blob], `${product.id}-kassa.webp`, { type: 'image/webp' });
  const uploaded = await uploadFile(file);
  const thumbnailUrl = String(uploaded?.file_url || '').trim();
  if (!isHttpImageUrl(thumbnailUrl)) throw new Error('Kichik rasm yuklanmadi.');

  if (typeof deps.saveThumbnail !== 'function') throw new Error('Saqlash xizmati topilmadi.');
  const saved = await deps.saveThumbnail({ product_id: product.id, image_url: source, thumbnail_url: thumbnailUrl });
  const payload = saved?.data || saved;
  if (!payload?.ok) throw new Error(payload?.error || 'Kichik rasm saqlanmadi.');

  return {
    thumbnail_url: thumbnailUrl,
    source_url: source,
    bytes: encoded.blob.size,
    width: encoded.width,
    height: encoded.height,
  };
}

// 3 ta rasm bir vaqtda ishlanadi. Bitta rasm xatosi qolganlarini to‘xtatmaydi.
export async function optimizePosThumbnails(products, options = {}) {
  const { queue, skipped, ready } = posThumbnailQueue(products);
  const result = { total: queue.length, ready, done: [], skipped, failed: [] };
  const snapshot = () => ({
    ...result,
    done: [...result.done],
    skipped: [...result.skipped],
    failed: [...result.failed],
  });
  options.onProgress?.(snapshot());

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      if (options.isCancelled?.()) return;
      const product = queue[cursor];
      cursor += 1;
      try {
        const output = await optimizePosThumbnail(product, options);
        result.done.push({ id: product.id, name: product.name || '', ...output });
      } catch (error) {
        result.failed.push({ id: product.id, name: product.name || '', error: error?.message || String(error) });
      }
      if (options.isCancelled?.()) return;
      options.onProgress?.(snapshot());
    }
  };

  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || POS_THUMBNAIL_CONCURRENCY, queue.length || 1));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return snapshot();
}