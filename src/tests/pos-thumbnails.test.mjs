import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { POS_THUMBNAILS } from '../lib/pos-thumbnail-manifest.js';
import { posThumbnailFor } from '../lib/pos-thumbnails.js';

const root = new URL('../../', import.meta.url);
const entries = Object.entries(POS_THUMBNAILS);
const sourcePrefix = 'https://base44.app/api/apps/6a96eb22a9fd2b34081eb2dd/files/mp/public/6a96eb22a9fd2b34081eb2dd/';
const sources = JSON.parse(readFileSync(new URL('scripts/pos-image-sources.json', root), 'utf8'));

test('POS thumbnails have valid WebP assets and match the original source snapshot', () => {
  assert.ok(entries.length > 0);
  const paths = new Set();
  for (const [id, entry] of entries) {
    assert.match(entry.thumbnail, /^\/images\/pos-v2\/[a-f0-9]+-[a-f0-9]{12}\.webp$/);
    assert.ok(!paths.has(entry.thumbnail), 'Each product has its own image path');
    paths.add(entry.thumbnail);
    const filename = sources[id];
    assert.equal(entry.source, filename.startsWith('/images/') ? filename : sourcePrefix + filename);
    const bytes = readFileSync(new URL(`public${entry.thumbnail}`, root));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    assert.ok(bytes.length > 32);
  }
});

test('previously approved Central thumbnails remain byte-for-byte unchanged', () => {
  let retained = 0;
  for (const [id, entry] of entries) {
    const oldAsset = new URL(`public/images/pos-15-v1/${id}.webp`, root);
    if (!existsSync(oldAsset)) continue;
    assert.deepEqual(readFileSync(new URL(`public${entry.thumbnail}`, root)), readFileSync(oldAsset));
    retained += 1;
  }
  assert.equal(retained, 8);
});

test('matching image thumbnails work for Central, Branch and other POS shops', () => {
  for (const [id, entry] of entries) {
    const product = { id, image_url: entry.source };
    for (const shopId of ['6a96f0a4ecc85c2fc57f3173', 'branch-shop', undefined]) {
      assert.equal(posThumbnailFor(product, shopId), entry.thumbnail);
    }
  }
});

test('changing a product image never returns a stale thumbnail', () => {
  for (const [id, entry] of entries) {
    assert.equal(posThumbnailFor({ id, image_url: entry.source + '?new-photo' }), null);
    assert.equal(posThumbnailFor({ id, image_url: '/images/replaced-photo.png' }), null);
    assert.equal(posThumbnailFor({ id, image_url: '' }), null);
  }
});

test('new products and missing images safely retain the existing original-image behavior', () => {
  assert.equal(posThumbnailFor(undefined), null);
  assert.equal(posThumbnailFor(null), null);
  assert.equal(posThumbnailFor({}), null);
  assert.equal(posThumbnailFor({ id: 'new-product', image_url: '/new.jpg' }), null);
});

test('product-level optimized thumbnail is used only for its own source image', () => {
  const imageUrl = 'https://cdn.example.com/photos/hot-dog.png';
  const product = {
    id: 'optimized-product',
    image_url: imageUrl,
    pos_thumbnail_url: 'https://cdn.example.com/photos/hot-dog-512.webp',
    pos_thumbnail_source: imageUrl,
  };
  assert.equal(posThumbnailFor(product), 'https://cdn.example.com/photos/hot-dog-512.webp');
  // Rasm almashtirilsa eski kichik nusxa ishlatilmaydi.
  assert.equal(posThumbnailFor({ ...product, image_url: imageUrl + '?v=2' }), null);
  // Manba ko‘rsatilmagan yoki mos kelmagan kichik rasm ishonchsiz.
  assert.equal(posThumbnailFor({ id: 'p2', image_url: imageUrl, pos_thumbnail_url: 'https://cdn.example.com/x.webp' }), null);
  assert.equal(posThumbnailFor({ id: 'p3', image_url: imageUrl, pos_thumbnail_url: 'https://cdn.example.com/x.webp', pos_thumbnail_source: imageUrl + '?other' }), null);
});

test('an existing manifest thumbnail keeps priority over the product thumbnail', () => {
  const [id, entry] = entries[0];
  const product = {
    id,
    image_url: entry.source,
    pos_thumbnail_url: 'https://cdn.example.com/own.webp',
    pos_thumbnail_source: entry.source,
  };
  assert.equal(posThumbnailFor(product), entry.thumbnail);
});

test('POS images decode asynchronously, prioritize only the first eight and retain error fallback', () => {
  const card = readFileSync(new URL('src/components/pos/ProductCard.jsx', root), 'utf8');
  const grid = readFileSync(new URL('src/components/pos/ProductGrid.jsx', root), 'utf8');
  assert.match(card, /loading=\{priority \? 'eager' : 'lazy'\}/);
  assert.match(card, /decoding="async"/);
  assert.match(card, /const imageSrc = useThumbnail \? thumbnail : product\.image_url/);
  assert.match(card, /onError=\{useThumbnail \? \(\) => setFailedThumbnail\(thumbnail\) : undefined\}/);
  assert.match(grid, /priority=\{index < 8\}/);
});