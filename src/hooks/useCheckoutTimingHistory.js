import { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';

const PAGE_SIZE = 50;
const OUTCOMES = new Set(['confirmed', 'rechecked', 'queued', 'unconfirmed']);
export const checkoutTimingRecordKey = (record) => JSON.stringify([record.actor_id, record.event_id]);
const empty = (version = 0) => ({ version, records: [], loading: false, loadingMore: false, error: '', hasMore: false });
const errorText = (error) => error?.response?.data?.error || error?.data?.error || error?.message || 'Vaqtlar tarixini yuklab bo‘lmadi.';

export default function useCheckoutTimingHistory({ open, userRole, shopId = '', fromDate = '', toDate = '' }) {
  const enabled = open === true && userRole === 'admin';
  const filterKey = JSON.stringify([shopId, fromDate, toDate]);
  const scope = `${enabled ? 'open' : 'closed'}:${filterKey}`;
  const control = useRef({ scope: '', version: 0, serial: 0, busy: false, skip: 0, retryAppend: false, allowed: false, hasMore: false });
  // Invalidate old records/replies during render, before an effect can run.
  if (control.current.scope !== scope) {
    control.current.scope = scope;
    control.current.version += 1;
    control.current.busy = false;
    control.current.skip = 0;
    control.current.retryAppend = false;
    control.current.hasMore = false;
    control.current.allowed = enabled;
  }
  const version = control.current.version;
  const [state, setState] = useState(() => empty());

  const load = useCallback(async (append = false) => {
    const current = control.current;
    if (!enabled || !current.allowed || current.scope !== scope || (append && (current.busy || !current.hasMore))) return;
    const requestVersion = current.version;
    const serial = ++current.serial;
    const skip = append ? current.skip : 0;
    const isCurrent = () => control.current.scope === scope
      && control.current.allowed && control.current.version === requestVersion && control.current.serial === serial;
    current.busy = true;
    current.retryAppend = append;
    if (!append) { current.skip = 0; current.hasMore = false; }
    setState((previous) => append && previous.version === requestVersion
      ? { ...previous, loadingMore: true, error: '' }
      : { ...empty(requestVersion), loading: true });

    try {
      if (fromDate && toDate && fromDate > toDate) throw new Error('Boshlanish sanasi tugash sanasidan keyin bo‘lishi mumkin emas.');
      const result = await base44.functions.invoke('checkout-timing', {
        action: 'list', limit: PAGE_SIZE, skip,
        ...(shopId ? { shop_id: shopId } : {}),
        ...(fromDate ? { from_date: fromDate } : {}),
        ...(toDate ? { to_date: toDate } : {}),
      });
      if (!isCurrent()) return;
      const payload = result?.data || result;
      if (!Array.isArray(payload?.records) || payload.records.length > PAGE_SIZE
        || typeof payload.has_more !== 'boolean'
        || payload.records.some((row) => !row || typeof row.event_id !== 'string' || !row.event_id
          || typeof row.actor_id !== 'string' || !row.actor_id || !OUTCOMES.has(row.outcome)
          || typeof row.total_ms !== 'number' || !Number.isFinite(row.total_ms) || row.total_ms < 0
          || (row.api_round_trip_ms != null && (typeof row.api_round_trip_ms !== 'number'
            || !Number.isFinite(row.api_round_trip_ms) || row.api_round_trip_ms < 0)))) {
        throw new Error(payload?.error || 'Vaqtlar tarixi javobi to‘liq emas. Qayta urinib ko‘ring.');
      }
      if (payload.has_more && (!payload.records.length || !Number.isSafeInteger(payload.next_skip) || payload.next_skip <= skip)) {
        throw new Error('Keyingi sahifa ma’lumoti noto‘g‘ri. Tarixni yangilang.');
      }
      current.skip = payload.has_more ? payload.next_skip : skip + payload.records.length;
      current.hasMore = payload.has_more;
      current.retryAppend = false;
      setState((previous) => ({
        ...empty(requestVersion),
        records: [...new Map([
          ...(append && previous.version === requestVersion ? previous.records : []),
          ...payload.records,
        ].map((row) => [checkoutTimingRecordKey(row), row])).values()],
        hasMore: payload.has_more,
      }));
    } catch (error) {
      const denied = [401, 403].includes(Number(error?.response?.status || error?.status || 0));
      if (isCurrent() && denied) {
        current.hasMore = false;
        current.retryAppend = false;
        current.skip = 0;
      }
      if (isCurrent()) setState((previous) => ({
        ...(append && !denied && previous.version === requestVersion ? previous : empty(requestVersion)),
        loading: false, loadingMore: false, error: errorText(error),
      }));
    } finally {
      if (isCurrent()) current.busy = false;
    }
  }, [enabled, scope, shopId, fromDate, toDate]);

  useEffect(() => {
    const activeVersion = control.current.version;
    control.current.allowed = enabled;
    if (enabled) void load();
    else setState(empty(activeVersion));
    return () => {
      if (control.current.version === activeVersion) {
        control.current.version += 1;
        control.current.busy = false;
        control.current.allowed = false;
      }
    };
  }, [enabled, load]);

  const matching = enabled && state.version === version;
  return {
    records: matching ? state.records : [],
    loading: enabled && (!matching || state.loading),
    loadingMore: matching && state.loadingMore,
    error: matching ? state.error : '',
    hasMore: matching && state.hasMore,
    refresh: () => load(),
    loadMore: () => load(true),
    retry: () => load(control.current.retryAppend),
  };
}
