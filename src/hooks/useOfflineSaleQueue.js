import { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  listPendingSales,
  savePendingSale,
  subscribePendingSales,
  syncErrorMessage,
  syncPendingSales,
} from '@/lib/offline-sales';

export default function useOfflineSaleQueue(userId, onSynced) {
  const [isOnline, setIsOnline] = useState(() => (
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  ));
  const [records, setRecords] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [syncError, setSyncError] = useState('');
  const syncingRef = useRef(false);
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;

  const refresh = useCallback(async () => {
    if (!userId) {
      setRecords([]);
      return [];
    }
    try {
      const next = await listPendingSales(userId);
      setRecords(next);
      setStorageError('');
      return next;
    } catch (error) {
      setStorageError(syncErrorMessage(error));
      return [];
    }
  }, [userId]);

  const syncNow = useCallback(async () => {
    if (!userId || syncingRef.current || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      const current = await refresh();
      return { synced: 0, remaining: current.length, failed: null, skipped: true };
    }

    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await syncPendingSales({
        userId,
        send: (request) => base44.functions.invoke('complete-sale', request),
      });
      await refresh();
      if (result?.failed) setSyncError(result.failed.message);
      else if (!result?.skipped) setSyncError('');
      if (result?.synced > 0) await onSyncedRef.current?.(result);
      return result;
    } catch (error) {
      const message = syncErrorMessage(error);
      setSyncError(message);
      const current = await refresh();
      return {
        synced: 0,
        remaining: current.length,
        failed: { retryable: true, message },
      };
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [refresh, userId]);

  const enqueue = useCallback(async (record) => {
    await savePendingSale(record);
    await refresh();
    return record;
  }, [refresh]);

  useEffect(() => {
    void refresh();
    return subscribePendingSales(() => { void refresh(); });
  }, [refresh]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (isOnline && userId) void syncNow();
  }, [isOnline, syncNow, userId]);

  return {
    isOnline,
    records,
    syncing,
    storageError,
    syncError,
    enqueue,
    refresh,
    syncNow,
  };
}
