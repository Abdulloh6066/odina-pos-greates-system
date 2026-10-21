import { posThumbnailFor } from './pos-thumbnails.js';

// Bir marta yuklangan rasmlar qayta so‘ralmaydi.
const preloaded = new Set();

export function posThumbnailPreloadUrls(products) {
  const urls = [];
  for (const product of products || []) {
    const url = posThumbnailFor(product);
    if (url && !preloaded.has(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Kassa birinchi marta chizilgandan keyin, bo‘sh vaqtda va past ustuvorlikda
 * do‘kondagi kichik rasmlarni jimgina keshlaydi — kategoriya almashganda rasm
 * darhol chiqadi. Xatolar hech qachon interfeysni to‘xtatmaydi.
 */
export function preloadPosThumbnails(products) {
  if (typeof window === 'undefined' || typeof window.Image !== 'function') return () => {};
  const urls = posThumbnailPreloadUrls(products);
  if (!urls.length) return () => {};

  let cancelled = false;
  let handle = null;
  let index = 0;

  const schedule = (callback) => {
    if (typeof window.requestIdleCallback === 'function') {
      handle = { idle: true, id: window.requestIdleCallback(callback, { timeout: 2000 }) };
    } else {
      handle = { idle: false, id: window.setTimeout(callback, 120) };
    }
  };

  const loadNext = () => {
    handle = null;
    if (cancelled || index >= urls.length) return;
    const url = urls[index];
    index += 1;
    const image = new window.Image();
    image.decoding = 'async';
    image.loading = 'lazy';
    try {
      image.fetchPriority = 'low';
    } catch {
      // Brauzer fetchPriority ni qo‘llamasa, e’tiborsiz qoldiramiz.
    }
    image.onload = () => {
      preloaded.add(url);
      schedule(loadNext);
    };
    image.onerror = () => schedule(loadNext);
    image.src = url;
  };

  const start = () => {
    if (!cancelled) schedule(loadNext);
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(start);
  else start();

  return () => {
    cancelled = true;
    if (!handle) return;
    if (handle.idle) window.cancelIdleCallback?.(handle.id);
    else window.clearTimeout(handle.id);
    handle = null;
  };
}