import test from 'node:test';
import assert from 'node:assert/strict';
import { needsPosThumbnail, posThumbnailSize, posThumbnailQueue, optimizePosThumbnails } from '../lib/pos-thumbnail-tool.js';
import { posThumbnailPreloadUrls } from '../lib/pos-thumbnail-preload.js';

const IMAGE = 'https://cdn.example.com/photos/photo.png';

test('only http(s) images without a matching thumbnail need work', () => {
  assert.equal(needsPosThumbnail({ image_url: IMAGE }), true);
  assert.equal(needsPosThumbnail({ image_url: IMAGE, pos_thumbnail_url: 'https://cdn.example.com/t.webp', pos_thumbnail_source: IMAGE }), false);
  assert.equal(needsPosThumbnail({ image_url: IMAGE + '?v=2', pos_thumbnail_url: 'https://cdn.example.com/t.webp', pos_thumbnail_source: IMAGE }), true);
  assert.equal(needsPosThumbnail({ image_url: 'data:image/png;base64,AAAA' }), false);
  assert.equal(needsPosThumbnail({ image_url: '' }), false);
  assert.equal(needsPosThumbnail(null), false);
});

test('the longest side is capped at 512 px and the aspect ratio is kept', () => {
  assert.deepEqual(posThumbnailSize(1254, 1254), { width: 512, height: 512 });
  assert.deepEqual(posThumbnailSize(1000, 500), { width: 512, height: 256 });
  assert.deepEqual(posThumbnailSize(300, 150), { width: 300, height: 150 });
  assert.equal(posThumbnailSize(0, 0), null);
});

test('data: URLs are skipped and finished products are not processed again', () => {
  const { queue, skipped, ready } = posThumbnailQueue([
    { id: 'a', name: 'A', image_url: IMAGE },
    { id: 'b', name: 'B', image_url: IMAGE, pos_thumbnail_url: 'https://cdn.example.com/b.webp', pos_thumbnail_source: IMAGE },
    { id: 'c', name: 'C', image_url: 'data:image/png;base64,AAAA' },
    { id: 'd', name: 'D', image_url: '' },
    { id: 'e', name: 'E', image_url: IMAGE + '?e' },
  ]);
  assert.deepEqual(queue.map((row) => row.id), ['a', 'e']);
  assert.equal(ready, 1);
  assert.deepEqual(skipped.map((row) => row.id), ['c']);
});

test('batch runs three at a time and keeps going after a failure', async () => {
  const products = Array.from({ length: 7 }, (_, index) => ({
    id: `p${index}`, name: `Mahsulot ${index}`, image_url: `${IMAGE}?i=${index}`,
  }));
  let inFlight = 0;
  let peak = 0;
  const saved = [];

  const result = await optimizePosThumbnails(products, {
    concurrency: 3,
    fetchImpl: async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (url.endsWith('i=2')) return { ok: false, status: 403 };
      if (url.endsWith('i=4')) return { ok: true, status: 200, blob: async () => ({ type: 'text/html', size: 10 }) };
      return { ok: true, status: 200, blob: async () => ({ type: 'image/png', size: 2048 }) };
    },
    encode: async () => ({ blob: new Uint8Array([1, 2, 3]), width: 512, height: 512 }),
    uploadFile: async (file) => {
      assert.equal(file.type, 'image/webp');
      return { file_url: `https://cdn.example.com/thumb/${file.name}` };
    },
    saveThumbnail: async (payload) => { saved.push(payload); return { ok: true }; },
  });

  assert.equal(result.total, 7);
  assert.equal(result.done.length, 5);
  assert.equal(result.failed.length, 2);
  assert.deepEqual(result.failed.map((row) => row.id).sort(), ['p2', 'p4']);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  assert.equal(saved.length, 5);
  assert.ok(saved.every((row) => row.image_url.startsWith(IMAGE)));
});

test('preload keeps only small thumbnails and removes duplicates', () => {
  const urls = posThumbnailPreloadUrls([
    { id: 'x', image_url: IMAGE, pos_thumbnail_url: 'https://cdn.example.com/x.webp', pos_thumbnail_source: IMAGE },
    { id: 'y', image_url: IMAGE + '?y', pos_thumbnail_url: 'https://cdn.example.com/x.webp', pos_thumbnail_source: IMAGE + '?y' },
    { id: 'z', image_url: IMAGE + '?z' },
  ]);
  assert.deepEqual(urls, ['https://cdn.example.com/x.webp']);
});