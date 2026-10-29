/* Build replaces the two constants; API calls and mutations are never cached. */
const BUILD = '__ODINA_BUILD__';
const ASSETS = /* __ODINA_ASSETS__ */ [];
const SHELL = `odina-shell-${BUILD}`;
const IMAGES = 'odina-public-images-v1';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(ASSETS);
    const page = await fetch('/pos', { cache: 'reload', credentials: 'same-origin' });
    if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) throw new Error('POS shell unavailable');
    await cache.put('/pos', page);
  })());
});
// No skipWaiting: a new build must not interrupt an active checkout.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('odina-shell-') && name !== SHELL) await caches.delete(name);
    await self.clients.claim();
  })());
});
async function navigation(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try { return await fetch(request, { signal: controller.signal }); }
  catch { return await (await caches.open(SHELL)).match('/pos') || Response.error(); }
  finally { clearTimeout(timer); }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin === self.location.origin && request.mode === 'navigate' && ['/', '/pos'].includes(url.pathname)) {
    event.respondWith(navigation(request)); return;
  }
  if (url.origin === self.location.origin && ASSETS.includes(url.pathname)) {
    event.respondWith((async () => (await (await caches.open(SHELL)).match(request)) || fetch(request))()); return;
  }
  const publicImage = request.destination === 'image' &&
    ((url.origin === self.location.origin && /^\/(images\/|odina-mark\.png)/.test(url.pathname)) ||
      (url.hostname === 'media.base44.com' && url.pathname.startsWith('/images/public/')) ||
      (url.hostname === 'static.wixstatic.com' && url.pathname.startsWith('/media/')));
  if (!publicImage) return;
  event.respondWith((async () => {
    const cache = await caches.open(IMAGES);
    const saved = await cache.match(request);
    if (saved) return saved;
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      await cache.put(request, response.clone()).catch(() => {});
      const keys = await cache.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - 600))) await cache.delete(key);
    }
    return response;
  })());
});