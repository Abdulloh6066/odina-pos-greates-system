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

export default function useOfflineSaleQueue(userId, onSynced, onRecovered) {
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
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const onRecoveredRef = useRef(onRecovered);
  onRecoveredRef.current = onRecovered;
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
    return () => { mountedRef.current = false; refreshGenerationRef.current++; };
  }, [userId]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    if (!userId) {
      setRecords([]);
      return [];
    }
    try {
      const next = await listPendingSales(userId);
      if (mountedRef.current && userRef.current === userId && generation === refreshGenerationRef.current) {
        setRecords(next);
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
    probingRef.current = true;
    try {
      const currentShift = await probePosConnection(base44);
      if (!mountedRef.current || userRef.current !== userId) return false;
      lastProbeErrorRef.current = null;
      onRecoveredRef.current?.(currentShift);
      reportRequestSuccess();
      return true;
    } catch (error) {
      if (mountedRef.current && userRef.current === userId) {
        lastProbeErrorRef.current = error;
        reportRequestError(error);
      }
      return false;
    } finally {
      probingRef.current = false;
    }
  }, [userId, reportRequestSuccess, reportRequestError]);

  const syncNow = useCallback(async ({ retryFailed = true } = {}) => {
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
    if (syncingRef.current || userRef.current !== userId) {
      const current = await refresh();
      return { synced: 0, skipped: true, remaining: current.length };
    }
    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await syncPendingSales({
        userId,
        retryFailed,
        send: async (request) => {
          try {
            const response = await base44.functions.invoke('complete-sale', request);
            if (mountedRef.current && userRef.current === userId) reportRequestSuccess();
            return response;
          } catch (error) {
            if (mountedRef.current && userRef.current === userId) reportRequestError(error);
            throw error;
          }
        },
      });
      await refresh();
      if (!mountedRef.current || userRef.current !== userId) return result;
      if (result?.failed) setSyncError(result.failed.message);
      else if (!result?.skipped) setSyncError('');
      if (result?.synced > 0) await onSyncedRef.current?.(result);
      return result;
    } catch (error) {
      const message = syncErrorMessage(error);
      if (mountedRef.current && userRef.current === userId) setSyncError(message);
      const current = await refresh();
      return { synced: 0, remaining: current.length,
        failed: { retryable: true, message, network: isPosNetworkError(error) } };
    } finally {
      syncingRef.current = false;
      if (mountedRef.current) setSyncing(false);
    }
  }, [refresh, userId, probeConnection, reportRequestSuccess, reportRequestError]);

  const enqueue = useCallback(async (record) => {
    try {
      await savePendingSale(record);
      await refresh();
      return record;
    } catch (error) {
      if (mountedRef.current && userRef.current === userId) setStorageError(syncErrorMessage(error));
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
    const delay = pendingSaleRetryDelay(records);
    if (delay === null) return undefined;
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
