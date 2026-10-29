export async function prepareOfflineRestart() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return false;
  try {
    await navigator.serviceWorker.register('/odina-sw.js', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    window.dispatchEvent(new Event('odina:offline-ready'));
    return true;
  } catch { window.dispatchEvent(new Event('odina:offline-unavailable')); return false; }
}