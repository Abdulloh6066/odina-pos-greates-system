// Offline CacheStorage/fetch doubles only; no app API or live product writes.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { cachePosImages, posImageCachePlan, POS_IMAGE_CACHE } from '../src/lib/pos-image-cache.js';

const origin = 'https://odinatort.uz';
const oldPublicImage = 'https://base44.app/api/apps/6a96eb22a9fd2b34081eb2dd/files/mp/public/6a96eb22a9fd2b34081eb2dd/cake.png';

test('public legacy product images are cached by the worker while private/API requests stay out', async () => {
  const listeners = {}, saved = new Map(); let fetches = 0;
  const key = value => typeof value === 'string' ? value : value.url;
  const cache = { match: async request => saved.get(key(request)), put: async (request, response) => saved.set(key(request), response),
    keys: async () => [...saved.keys()], delete: async request => saved.delete(key(request)) };
  vm.runInNewContext(readFileSync('src/offline/service-worker.js', 'utf8'), {
    self: { location: { origin }, addEventListener: (name, callback) => { listeners[name] = callback; } },
    caches: { open: async () => cache }, URL,
    fetch: async () => { fetches++; return { ok: true, clone() { return this; } }; },
  });
  const request = url => {
    let response;
    listeners.fetch({ request: { method: 'GET', destination: 'image', url }, respondWith: next => { response = next; } });
    return response;
  };
  const first = request(oldPublicImage);
  assert.ok(first, 'old public image URLs need the same persistent cache as modern image URLs');
  await first;
  await request(oldPublicImage);
  assert.equal(fetches, 1);
  for (const url of [
    'https://base44.app/api/apps/6a96eb22a9fd2b34081eb2dd/entities/Sale',
    'https://base44.app/api/apps/6a96eb22a9fd2b34081eb2dd/files/private/cake.png',
    'https://base44.app/api/apps/6a96eb22a9fd2b34081eb2dd/files/mp/public/another-app/cake.png',
  ]) assert.equal(request(url), undefined, url);
});

const imageResponse = () => new Response('image bytes', { headers: { 'content-type': 'image/webp' } });
function memoryStorage(rows = []) {
  const saved = new Map(rows);
  const cache = { match: async url => saved.get(url), put: async (url, response) => saved.set(url, response),
    keys: async () => [...saved.keys()], delete: async url => saved.delete(url) };
  return { saved, cache, open: async name => { assert.equal(name, POS_IMAGE_CACHE); return cache; } };
}
const product = (id, path = '/images/' + id + '.webp') => ({ id, image_url: path });

test('plan deduplicates public display URLs, includes responsive densities and ignores private sources', () => {
  const plan = posImageCachePlan([
    product('a'), product('duplicate', '/images/a.webp'), product('legacy', oldPublicImage),
    product('responsive', 'https://media.base44.com/images/public/cake.jpg'),
    product('private', 'https://base44.app/api/apps/private-files/cake.png'),
    product('embedded', 'data:image/png;base64,AAAA'),
  ], { origin, width: 100, height: 80 });
  assert.equal(plan.skipped, 1);
  assert.equal(plan.urls.length, 5);
  assert.equal(plan.urls.filter(url => url === origin + '/images/a.webp').length, 1);
  assert.ok(plan.urls.includes(oldPublicImage));
  for (const size of ['w_100,h_80', 'w_200,h_160', 'w_300,h_240']) {
    assert.ok(plan.urls.some(url => url.includes(size + ',al_c,q_90')));
  }
});

test('cached images survive reopening and a second warmup makes no additional requests', async () => {
  const storage = memoryStorage([[origin + '/images/a.webp', imageResponse()]]);
  const requests = [];
  const products = [product('a'), product('b'), product('duplicate', '/images/b.webp')];
  const options = { origin, storage, fetchImpl: async (url, init) => {
    requests.push(url); assert.equal(init.credentials, 'omit'); return imageResponse();
  } };
  const first = await cachePosImages(products, options);
  assert.deepEqual({ total: first.total, cached: first.cached, downloaded: first.downloaded, failed: first.failed.length },
    { total: 2, cached: 1, downloaded: 1, failed: 0 });
  const second = await cachePosImages(products, { ...options });
  assert.equal(second.cached, 2); assert.equal(second.downloaded, 0);
  assert.deepEqual(requests, [origin + '/images/b.webp']);
});

test('missing files, non-image responses and storage failures stay retryable without losing good images', async () => {
  const storage = memoryStorage();
  const put = storage.cache.put;
  storage.cache.put = (url, response) => {
    if (url.endsWith('/quota.webp')) throw new Error('Quota exceeded');
    return put(url, response);
  };
  const result = await cachePosImages(['good', 'missing', 'json', 'quota'].map(id => product(id)), {
    origin, storage, fetchImpl: async url => url.endsWith('/missing.webp') ? new Response('', { status: 404 })
      : url.endsWith('/json.webp') ? new Response('{}', { headers: { 'content-type': 'application/json' } }) : imageResponse(),
  });
  assert.equal(result.downloaded, 1); assert.equal(result.failed.length, 3);
  assert.deepEqual([...storage.saved.keys()], [origin + '/images/good.webp']);
  const retry = await cachePosImages(['good', 'missing', 'json', 'quota'].map(id => product(id)), {
    origin, storage: { ...storage, cache: null, open: async () => ({ ...storage.cache, put }) }, fetchImpl: async () => imageResponse(),
  });
  assert.equal(retry.cached, 1); assert.equal(retry.downloaded, 3); assert.equal(retry.failed.length, 0);
});

test('warmup uses at most two concurrent downloads and reports progress', async () => {
  let running = 0, peak = 0; const progress = [];
  const result = await cachePosImages(Array.from({ length: 8 }, (_, i) => product(String(i))), {
    origin, storage: memoryStorage(), onProgress: next => progress.push(next), fetchImpl: async () => {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 1)); running--; return imageResponse();
    },
  });
  assert.equal(peak, 2); assert.equal(result.downloaded, 8);
  assert.equal(progress[0].total, 8); assert.equal(progress.at(-1).downloaded, 8);
});

test('cancel stops remaining work and retains files that were already stored', async () => {
  const controller = new AbortController(), storage = memoryStorage();
  const result = await cachePosImages([product('a'), product('b'), product('c')], {
    origin, storage, signal: controller.signal,
    onProgress: next => { if (next.downloaded === 1) controller.abort(); },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/a.webp')) return imageResponse();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    },
  });
  assert.equal(result.cancelled, true); assert.equal(result.downloaded, 1);
  assert.equal(storage.saved.size, 1);
});

test('cache cleanup preserves current images even when they are the oldest entries', async () => {
  const storage = memoryStorage([[origin + '/images/current.webp', imageResponse()], ...Array.from({ length: 599 }, (_, i) =>
    [origin + '/images/old-' + i + '.webp', imageResponse()])]);
  await cachePosImages([product('current'), product('new')], { origin, storage, fetchImpl: async () => imageResponse() });
  assert.equal(storage.saved.size, 600);
  assert.ok(storage.saved.has(origin + '/images/current.webp'));
  assert.ok(storage.saved.has(origin + '/images/new.webp'));
});

test('cancelled old-scope cleanup cannot erase an image just downloaded by the new scope', async () => {
  const products = Array.from({ length: 600 }, (_, i) => product('old-' + i));
  const storage = memoryStorage(products.map(row => [origin + row.image_url, imageResponse()]));
  let keysStarted, releaseOldKeys;
  const started = new Promise(resolve => { keysStarted = resolve; });
  const oldKeysGate = new Promise(resolve => { releaseOldKeys = resolve; });
  const originalPut = storage.cache.put;
  storage.cache.put = async (url, response) => { await originalPut(url, response); releaseOldKeys(); };
  let oldRun, keysCalls = 0;
  storage.cache.keys = async () => {
    if (++keysCalls === 1) { keysStarted(); await oldKeysGate; return [...storage.saved.keys()]; }
    await oldRun;
    return [...storage.saved.keys()];
  };
  const controller = new AbortController();
  oldRun = cachePosImages(products, { origin, storage, signal: controller.signal });
  await started;
  controller.abort();
  const next = await cachePosImages([product('new-scope')], { origin, storage, fetchImpl: async () => imageResponse() });
  assert.equal((await oldRun).cancelled, true);
  assert.equal(next.downloaded, 1);
  assert.equal(storage.saved.has(origin + '/images/new-scope.webp'), true);
});

test('plans beyond storage capacity report excess entries instead of claiming all were saved', async () => {
  const storage = memoryStorage();
  const result = await cachePosImages(Array.from({ length: 601 }, (_, i) => product('large-' + i)), {
    origin, storage, fetchImpl: async () => imageResponse(),
  });
  assert.equal(result.total, 600); assert.equal(result.downloaded, 600);
  assert.equal(result.skipped, 1); assert.equal(storage.saved.size, 600);
});
