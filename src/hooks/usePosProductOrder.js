import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

const EMPTY_ORDER = Object.freeze([]);

export default function usePosProductOrder(shopId, userId) {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    if (!shopId || !userId) return undefined;
    let stopped = false;
    let timer;
    const accept = (next) => {
      if (stopped || next?.shop_id !== shopId) return;
      setSnapshot(current => current?.shop_id === shopId && current.version > next.version ? current : next);
    };
    const reload = () => base44.functions.invoke('pos-product-order', { action: 'get', shop_id: shopId })
      .then(result => accept(result.data || result)).catch(() => {});
    void reload();
    let unsubscribe;
    try {
      unsubscribe = base44.entities.Shop.subscribe(event => {
        if ((event?.data?.id || event?.id) !== shopId) return;
        // Shop also contains table orders: ignore events that cannot change this preference.
        if (Array.isArray(event.data?.pos_product_order) && Number.isSafeInteger(event.data?.pos_product_order_version)) {
          accept({ shop_id: shopId, order: event.data.pos_product_order, version: event.data.pos_product_order_version });
        } else {
          clearTimeout(timer);
          timer = setTimeout(reload, 500);
        }
      });
    } catch { /* A focus refresh also works when realtime is unavailable. */ }
    const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
    window.addEventListener('focus', reload);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true; clearTimeout(timer); unsubscribe?.();
      window.removeEventListener('focus', reload);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [shopId, userId]);
  return {
    order: snapshot && snapshot.shop_id === shopId ? (snapshot.order || EMPTY_ORDER) : EMPTY_ORDER,
    accept: next => setSnapshot(current => current?.shop_id === next.shop_id && current.version > next.version ? current : next),
  };
}
