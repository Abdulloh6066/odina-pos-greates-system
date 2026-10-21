import { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  listPendingSales,
  pendingSaleRetryDelay,
  savePendingSale,
  subscribePendingSales,
  syncErrorMessage,
  syncPendingSales,
} from '@/lib/offline-sales';
import {
  isPosNetworkError,
  isPosAuthorizationError,
  nextPosConnectionState,
  POS_CONNECTION_RECHECK_MS,
  queueAuthorizationBlocked,
  probePosConnection,
} from '@/lib/pos-network';

export default function useOfflineSaleQueue(userId, onSynced, onRecovered, onConfirmed) {
  const [browserOnline, setBrowserOnline] = useState(() => (
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  ));
  const [connection, setConnection] = useState({ failures: 0, offline: false });
  const [authorizationError, setAuthorizationError] = useState(false);
  const [records, setRecords] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [syncError, setSyncError] = useState('');
  const connectionRef = useRef(connection);
  const mountedRef = useRef(true);
  const probingRef = useRef(false);
  const lastProbeErrorRef = useRef(null);
  const refreshGenerationRef = useRef(0);
  const syncingRef = useRef(false);
  const userRef = useRef(userId);
  userRef.current = userId;
  const sessionRef = useRef({ userId });
  if (sessionRef.current.userId !== userId) sessionRef.current = { userId };
  const renderSession = sessionRef.current;
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const onRecoveredRef = useRef(onRecovered);
  onRecoveredRef.current = onRecovered;
  const onConfirmedRef = useRef(onConfirmed);
  onConfirmedRef.current = onConfirmed;
  const confirmedKeysRef = useRef(new Set());
  const reconcilingRef = useRef(new Map());
  const isOnline = browserOnline && !connection.offline;

  const reportRequestSuccess = useCallback(() => {
    if (!mountedRef.current) return;
    const next = nextPosConnectionState(connectionRef.current);
    connectionRef.current = next;
    setConnection(next);
    setAuthorizationError(false);
  }, []);

  const reportRequestError = useCallback((error) => {
    if (!mountedRef.current) return;
    const next = nextPosConnectionState(connectionRef.current, error);
    connectionRef.current = next;
    setConnection(next);
    if (isPosAuthorizationError(error)) setAuthorizationError(true);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connectionRef.current = { failures: 0, offline: false };
    setConnection(connectionRef.current);
    setAuthorizationError(false);
    syncingRef.current = false;
    probingRef.current = false;
    setSyncing(false);
    confirmedKeysRef.current.clear();
    reconcilingRef.current.clear();
    return () => { mountedRef.current = false; refreshGenerationRef.current++; };
  }, [userId]);

  const refresh = useCallback(async () => {
    // An old user's detached save/drain must not invalidate the active user's
    // in-flight list read, even before a stale result reaches the state guard.
    if (!mountedRef.current || sessionRef.current !== renderSession || userRef.current !== userId) return [];
    const generation = ++refreshGenerationRef.current;
    if (!userId) {
      setRecords([]);
      return [];
    }
    try {
      const next = await listPendingSales(userId);
      if (mountedRef.current && userRef.current === userId && generation === refreshGenerationRef.current) {
        const merged = new Map(next.map((record) => [record.id, record]));
        for (const entry of reconcilingRef.current.values()) merged.set(entry.id, entry.record);
        setRecords([...merged.values()].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))));
        setStorageError('');
      }
      return next;
    } catch (error) {
      if (mountedRef.current && userRef.current === userId && generation === refreshGenerationRef.current) setStorageError(syncErrorMessage(error));
      return [];
    }
  }, [userId]);

  // Read-only recovery: checking connectivity must never create a test sale.
  const probeConnection = useCallback(async () => {
    if (!userId || probingRef.current || (typeof navigator !== 'undefined' && navigator.onLine === false)) return false;
    const session = sessionRef.current;
    probingRef.current = true;
    try {
      const currentShift = await probePosConnection(base44);
      if (!mountedRef.current || sessionRef.current !== session || userRef.current !== userId) return false;
      lastProbeErrorRef.current = null;
      onRecoveredRef.current?.(currentShift);
      reportRequestSuccess();
      return true;
    } catch (error) {
      if (mountedRef.current && sessionRef.current === session && userRef.current === userId) {
        lastProbeErrorRef.current = error;
        reportRequestError(error);
      }
      return false;
    } finally {
      if (sessionRef.current === session) probingRef.current = false;
    }
  }, [userId, reportRequestSuccess, reportRequestError]);

  const reconcileConfirmed = useCallback(({ id, payload, record, confirmationTiming }) => {
    const session = sessionRef.current;
    if (!mountedRef.current || userRef.current !== userId || confirmedKeysRef.current.has(id)) return;
    const previous = reconcilingRef.current.get(id);
    if (previous?.running) return;
    const entry = previous || { id, payload, confirmationTiming, record: { ...record, status: 'confirmed', last_error: '', last_error_status: 0 } };
    entry.running = true;
    entry.record = { ...entry.record, next_retry_at: new Date(Date.now() + 15000).toISOString() };
    reconcilingRef.current.set(id, entry);
    refreshGenerationRef.current++;
    setRecords((current) => [...current.filter((row) => row.id !== id), entry.record]);
    const failed = () => {
      if (!mountedRef.current || sessionRef.current !== session || userRef.current !== userId) return;
      entry.running = false;
      entry.record = { ...entry.record, next_retry_at: new Date(Date.now() + 5000).toISOString() };
      refreshGenerationRef.current++;
      setRecords((current) => [...current.filter((row) => row.id !== id), entry.record]);
    };
    try {
      void Promise.resolve(onConfirmedRef.current?.(entry.payload, id, entry.record, entry.confirmationTiming)).then(() => {
        if (!mountedRef.current || sessionRef.current !== session || userRef.current !== userId) return;
        confirmedKeysRef.current.add(id);
        reconcilingRef.current.delete(id);
        refreshGenerationRef.current++;
        setRecords((current) => current.filter((row) => row.id !== id));
      }, failed);
    } catch { failed(); }
  }, [userId]);

  const syncNow = useCallback(async ({ retryFailed = true } = {}) => {
    const session = sessionRef.current;
    if (!userId || syncingRef.current || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      const current = await refresh();
      return { synced: 0, remaining: current.length, failed: null, skipped: true };
    }
    if (connectionRef.current.offline && !(await probeConnection())) {
      const current = await refresh();
      const error = lastProbeErrorRef.current;
      return { synced: 0, remaining: current.length, skipped: true,
        failed: error ? { retryable: true, message: syncErrorMessage(error), network: isPosNetworkError(error) } : null };
    }
    // A concurrent manual retry/recovery must not start a second queue drain.
    if (syncingRef.current || sessionRef.current !== session || userRef.current !== userId) {
      const current = await refresh();
      return { synced: 0, skipped: true, remaining: current.length };
    }
    syncingRef.current = true;
    setSyncing(true);
    try {
      for (const entry of reconcilingRef.current.values()) reconcileConfirmed(entry);
      const result = await syncPendingSales({
        userId,
        retryFailed,
        onConfirmed: (event) => {
          if (sessionRef.current === session) reconcileConfirmed(event);
        },
        send: async (request) => {
          try {
            const response = await base44.functions.invoke('complete-sale', request);
            if (mountedRef.current && sessionRef.current === session && userRef.current === userId) reportRequestSuccess();
            return response;
          } catch (error) {
            if (mountedRef.current && sessionRef.current === session && userRef.current === userId) reportRequestError(error);
            throw error;
          }
        },
      });
      void refresh();
      if (!mountedRef.current || sessionRef.current !== session || userRef.current !== userId) return result;
      if (result?.failed) setSyncError(result.failed.message);
      else if (!result?.skipped) setSyncError('');
      if (result?.synced > 0) {
        // Catalog/alert refetches are recovery, not part of payment acknowledgment.
        void Promise.resolve().then(() => {
          if (sessionRef.current === session) return onSyncedRef.current?.(result);
        }).catch(() => {});
      }
      return result;
    } catch (error) {
      const message = syncErrorMessage(error);
      if (mountedRef.current && sessionRef.current === session && userRef.current === userId) setSyncError(message);
      const current = await refresh();
      return { synced: 0, remaining: current.length,
        failed: { retryable: true, message, network: isPosNetworkError(error) } };
    } finally {
      if (sessionRef.current === session) {
        syncingRef.current = false;
        if (mountedRef.current) setSyncing(false);
      }
    }
  }, [refresh, userId, probeConnection, reportRequestSuccess, reportRequestError, reconcileConfirmed]);

  const enqueue = useCallback(async (record) => {
    const session = sessionRef.current;
    try {
      await savePendingSale(record);
      if (mountedRef.current && sessionRef.current === session && userRef.current === userId) {
        refreshGenerationRef.current++;
        setRecords((current) => [...current.filter((row) => row.id !== record.id), record]
          .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))));
        setStorageError('');
      }
      // The completed IndexedDB write is the acknowledgment. A list read may
      // finish later without delaying the receipt or next cashier transaction.
      void refresh();
      return record;
    } catch (error) {
      if (mountedRef.current && sessionRef.current === session && userRef.current === userId) setStorageError(syncErrorMessage(error));
      throw error;
    }
  }, [refresh, userId]);

  useEffect(() => {
    void refresh();
    return subscribePendingSales(() => { void refresh(); });
  }, [refresh]);

  useEffect(() => {
    const handleOnline = () => {
      setBrowserOnline(true);
      if (connectionRef.current.offline) void probeConnection();
    };
    const handleOffline = () => setBrowserOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [probeConnection]);

  useEffect(() => {
    if (isOnline && userId) void syncNow({ retryFailed: false });
  }, [isOnline, syncNow, userId]);

  useEffect(() => {
    if (!browserOnline || !connection.offline || !userId) return undefined;
    let stopped = false;
    let timer;
    const retry = async () => {
      await probeConnection();
      if (!stopped && connectionRef.current.offline) timer = window.setTimeout(retry, POS_CONNECTION_RECHECK_MS);
    };
    timer = window.setTimeout(retry, POS_CONNECTION_RECHECK_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [browserOnline, connection.offline, userId, probeConnection]);

  useEffect(() => {
    if (!isOnline || !userId || syncing || storageError) return undefined;
    const queueDelay = pendingSaleRetryDelay(records.filter((row) => row.status !== 'confirmed'));
    const reconciliationDelays = records.filter((row) => row.status === 'confirmed')
      .map((row) => Math.max(1000, (Date.parse(row.next_retry_at || '') || Date.now()) - Date.now()));
    const delays = [...(queueDelay === null ? [] : [queueDelay]), ...reconciliationDelays];
    if (!delays.length) return undefined;
    const delay = Math.min(...delays);
    const timer = window.setTimeout(() => { void syncNow({ retryFailed: false }); }, delay);
    return () => window.clearTimeout(timer);
  }, [isOnline, userId, syncing, storageError, records, syncNow]);

  return {
    isOnline,
    browserOnline,
    connectionPaused: connection.offline,
    authorizationBlocked: authorizationError || queueAuthorizationBlocked(records),
    reportRequestSuccess,
    reportRequestError,
    records,
    syncing,
    storageError,
    syncError,
    enqueue,
    refresh,
    syncNow,
  };
}
