import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkoutTimingScope, readCheckoutTiming, saveCheckoutTiming } from '@/lib/checkout-timing';

// A later Kassa mount owns this user's last metric. A request finishing after
// navigation may persist, but cannot replace a newer page's measurement.
const latestOwners = new Map();

export default function useCheckoutTiming(userId, shopId, shiftId) {
  const scope = useMemo(() => checkoutTimingScope(userId, shopId, shiftId), [userId, shopId, shiftId]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const owner = useRef({});
  const mounted = useRef(true);
  const [saved, setSaved] = useState(() => readCheckoutTiming(scope));
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    mounted.current = true;
    if (scope) latestOwners.set(scope.userId, owner.current);
    return () => { mounted.current = false; };
  }, [scope]);

  useEffect(() => {
    savedRef.current = readCheckoutTiming(scope);
    setSaved(savedRef.current);
  }, [scope]);

  const recordTiming = useCallback(measurement => {
    // A request may finish after the cashier changes user/shop/shift or leaves.
    // Its old callback must not overwrite the new scope's local last result.
    if (!scope || activeScope.current !== scope || latestOwners.get(scope.userId) !== owner.current) return null;
    const current = savedRef.current;
    // Late confirmation updates its own attempt, never the next customer's.
    if (measurement?.onlyIfCurrent && current?.requestKey !== measurement.requestKey) return null;
    if (measurement?.requestKey && current?.requestKey === measurement.requestKey
      && ['confirmed', 'rechecked'].includes(current.outcome)
      && !['confirmed', 'rechecked'].includes(measurement.outcome)) return current;
    const next = saveCheckoutTiming(scope, measurement);
    if (next) savedRef.current = next;
    if (next && mounted.current && activeScope.current === scope) setSaved(next);
    return next;
  }, [scope]);

  const timing = scope && saved?.userId === scope.userId && saved?.shopId === scope.shopId
    && saved?.shiftId === scope.shiftId ? saved : null;
  return { timing, recordTiming };
}
