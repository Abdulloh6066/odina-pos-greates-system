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

  // Keep the loaded page window and current controls visible during realtime refresh.
  const refresh = useCallback(async () => {
    if (state.current.busy || state.current.key !== key) return;
    const generation = ++state.current.generation;
    const target = Math.max(100, state.current.skip);
    const freshQuery = { $and: [JSON.parse(key), { created_date: { $lte: new Date().toISOString() } }] };
    state.current.busy = true;
    try {
      let skip = 0;
      let more = false;
      const fresh = new Map();
      do {
        const page = await readEntityPage(entityRef.current, freshQuery, sort, skip);
        if (generation !== state.current.generation || state.current.key !== key) return;
        const before = fresh.size;
        page.rows.forEach((row) => fresh.set(row.id, row));
        if (page.hasMore && fresh.size === before) throw new Error('Tarix sahifasini yuklab bo‘lmadi.');
        skip = page.nextSkip;
        more = page.hasMore;
      } while (more && skip < target);
      state.current.query = freshQuery;
      state.current.skip = skip;
      setRows([...fresh.values()]);
      setHasMore(more);
      setError('');
    } catch (failure) {
      if (generation === state.current.generation) setError(failure?.response?.data?.error || failure?.message || 'Buyurtmalar yangilanmadi.');
    } finally {
      if (generation === state.current.generation) state.current.busy = false;
    }
  }, [key, sort]);

  return { rows, loading, loadingMore, error, hasMore, reload: () => load(), refresh, loadMore: () => load(true) };
}
