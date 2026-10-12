import { useCallback, useLayoutEffect, useRef } from 'react';

// Stable identity for memoized children, with the latest committed state.
// In particular, an unchanged catalog callback must still respect payment locks.
export default function useStableEvent(handler) {
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; });
  return useCallback((...args) => latest.current(...args), []);
}
