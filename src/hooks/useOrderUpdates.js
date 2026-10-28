import { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';

// Realtime first; visible polling and reconnects recover missed messages.
export function useOrderUpdates(refresh, scopeKey) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    let stopped = false;
    let running = false;
    let queued = false;
    let timer;
    const run = async () => {
      if (stopped || document.visibilityState === 'hidden' || navigator.onLine === false) return;
      if (running) { queued = true; return; }
      running = true;
      try {
        do {
          queued = false;
          await latest.current();
        } while (queued && !stopped);
      } catch { /* Page reads expose their own errors and preserve the last successful data. */ }
      finally { running = false; }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
    const unsubscribers = ['CustomerOrder', 'CustomerOrderItem', 'OrderPayment'].map((name) => {
      try { return base44.entities[name]?.subscribe?.(schedule); } catch { return null; }
    });
    const interval = setInterval(run, 15000);
    window.addEventListener('focus', run);
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', run);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('focus', run);
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', run);
      unsubscribers.forEach((unsubscribe) => { if (typeof unsubscribe === 'function') unsubscribe(); });
    };
  }, [scopeKey]);
}
