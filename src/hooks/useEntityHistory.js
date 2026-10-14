import { useCallback, useEffect, useRef, useState } from 'react';
import { readEntityPage } from '@/lib/history-pagination';

export function useEntityHistory(entity, query, sort) {
  const key = JSON.stringify(query);
  const entityRef = useRef(entity);
  entityRef.current = entity;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const state = useRef({ generation: 0, skip: 0, busy: false, key: '' });

  const load = useCallback(async (more = false) => {
    if (more && state.current.busy) return;
    const generation = more ? state.current.generation : ++state.current.generation;
    const requestQuery = JSON.parse(key);
    if (!more) {
      // Freeze the read window so new records cannot shift subsequent page offsets.
      state.current.query = { $and: [requestQuery, { created_date: { $lte: new Date().toISOString() } }] };
      state.current.skip = 0;
      setRows([]);
      setHasMore(false);
    }
    state.current.key = key;
    state.current.busy = true;
    more ? setLoadingMore(true) : setLoading(true);
    setError('');
    try {
      const page = await readEntityPage(entityRef.current, state.current.query, sort, more ? state.current.skip : 0);
      if (generation !== state.current.generation || state.current.key !== key) return;
      setRows((previous) => more
        ? [...new Map([...previous, ...page.rows].map((row) => [row.id, row])).values()]
        : page.rows);
      state.current.skip = page.nextSkip;
      setHasMore(page.hasMore);
    } catch (failure) {
      if (generation === state.current.generation) {
        setError(failure?.response?.data?.error || failure?.message || 'Tarixni yuklab bo‘lmadi.');
      }
    } finally {
      if (generation === state.current.generation) {
        state.current.busy = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [key, sort]);

  useEffect(() => {
    // Debounce filter edits and invalidate old replies immediately.
    state.current.generation += 1;
    setLoading(true);
    setError('');
    const timer = setTimeout(() => { void load(); }, 200);
    return () => { clearTimeout(timer); state.current.generation += 1; };
  }, [load]);

  return { rows, loading, loadingMore, error, hasMore, reload: () => load(), loadMore: () => load(true) };
}
