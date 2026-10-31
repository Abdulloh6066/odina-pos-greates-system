import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
export async function wholesaleCall(payload) {
  const response = await base44.functions.invoke('wholesaleSales', payload);
  return response.data;
}
export default function useWholesalePage(sourceId, search, revision) {
  const [catalog, setCatalog] = useState({ items: [], has_more: false });
  const [history, setHistory] = useState({ items: [], has_more: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [catalogCursor, setCatalogCursor] = useState(null);
  const [historyCursor, setHistoryCursor] = useState(null);
  useEffect(() => { setCatalogCursor(null); setHistoryCursor(null); }, [sourceId, search, revision]);
  useEffect(() => {
    let live = true;
    setCatalog({ items: [], has_more: false }); setHistory({ items: [], has_more: false }); setError('');
    if (!sourceId) return undefined;
    setLoading(true);
    const timer = setTimeout(() => Promise.all([
      wholesaleCall({ action: 'catalog', source_id: sourceId, search }),
      wholesaleCall({ action: 'history', source_id: sourceId }),
    ]).then(([products, sales]) => { if (live) { setCatalog(products); setHistory(sales); } })
      .catch(e => { if (live) setError(e?.response?.data?.error || e.message); })
      .finally(() => { if (live) setLoading(false); }), 200);
    return () => { live = false; clearTimeout(timer); };
  }, [sourceId, search, revision]);
  useEffect(() => {
    let live = true;
    if (!catalogCursor && !historyCursor) return undefined;
    const isCatalog = Boolean(catalogCursor), cursor = catalogCursor || historyCursor;
    setLoading(true);
    wholesaleCall({ action: isCatalog ? 'catalog' : 'history', source_id: sourceId, search, cursor })
      .then(page => { if (live) (isCatalog ? setCatalog : setHistory)(old => ({ ...page, items: [...old.items, ...page.items] })); })
      .catch(e => { if (live) setError(e?.response?.data?.error || e.message); })
      .finally(() => { if (live) { setLoading(false); setCatalogCursor(null); setHistoryCursor(null); } });
    return () => { live = false; };
  }, [catalogCursor, historyCursor, sourceId, search, revision]);
  return { catalog, history, loading, error, moreProducts: () => setCatalogCursor(catalog.next_cursor), moreHistory: () => setHistoryCursor(history.next_cursor) };
}