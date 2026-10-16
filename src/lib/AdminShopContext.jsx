import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AdminShopScopeContext, useAuth } from '@/lib/AuthContext';

export const adminShopStorageKey = (userId) => 'odina-admin-shop:' + String(userId || '');
const readSelection = (userId) => {
  try { return localStorage.getItem(adminShopStorageKey(userId)) || 'all'; }
  catch { return 'all'; }
};
const saveSelection = (userId, shopId) => {
  try { localStorage.setItem(adminShopStorageKey(userId), shopId); }
  catch { /* The in-memory selection still works when browser storage is unavailable. */ }
};

export default function AdminShopProvider({ children }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const userId = String(user?.id || '');
  const [selection, setSelection] = useState(() => ({ userId, shopId: isAdmin ? readSelection(userId) : 'all' }));
  const [catalog, setCatalog] = useState({ userId: '', shops: [], ready: false, error: '' });
  const [blockedReason, setBlockedReason] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const guards = useRef(new Set());
  const shopId = isAdmin ? (selection.userId === userId ? selection.shopId : readSelection(userId)) : 'all';
  const shops = isAdmin && catalog.userId === userId ? catalog.shops : [];
  const ready = !isAdmin || (catalog.userId === userId && catalog.ready);

  useEffect(() => {
    let active = true;
    setBlockedReason('');
    if (!isAdmin || !userId) {
      setCatalog({ userId: '', shops: [], ready: false, error: '' });
      return () => { active = false; };
    }
    setSelection({ userId, shopId: readSelection(userId) });
    setCatalog({ userId, shops: [], ready: false, error: '' });
    void base44.entities.Shop.list('name', 500).then((rows) => {
      if (!active) return;
      const permitted = (rows || []).filter((shop) => shop.active !== false);
      setCatalog({ userId, shops: permitted, ready: true, error: '' });
      setSelection((current) => {
        const saved = current.userId === userId ? current.shopId : readSelection(userId);
        const next = saved === 'all' || permitted.some((shop) => shop.id === saved) ? saved : 'all';
        saveSelection(userId, next);
        return { userId, shopId: next };
      });
    }).catch(() => {
      if (active) setCatalog({ userId, shops: [], ready: false, error: 'Do‘konlarni yuklab bo‘lmadi. Qayta urinib ko‘ring.' });
    });
    return () => { active = false; };
  }, [isAdmin, userId, reloadKey]);

  const registerGuard = useCallback((guard) => {
    if (typeof guard !== 'function') return () => {};
    guards.current.add(guard);
    return () => { guards.current.delete(guard); };
  }, []);

  const selectShop = useCallback((requestedId) => {
    if (!isAdmin || !userId || !ready) return false;
    const next = String(requestedId || 'all');
    if (next !== 'all' && !shops.some((shop) => shop.id === next)) return false;
    if (next === shopId) { setBlockedReason(''); return true; }
    const fallback = 'Do‘konni almashtirishdan oldin ochiq ishni saqlang yoki yoping.';
    const modal = typeof document === 'undefined' ? null
      : document.querySelector?.('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
    if (modal?.getClientRects?.().length) { setBlockedReason(fallback); return false; }
    for (const guard of guards.current) {
      let result;
      try { result = guard(next); } catch { result = false; }
      if (typeof result === 'string' && result || result === false || result?.then) {
        setBlockedReason(typeof result === 'string' ? result : fallback);
        return false;
      }
    }
    setSelection({ userId, shopId: next });
    saveSelection(userId, next);
    setBlockedReason('');
    return true;
  }, [isAdmin, userId, ready, shops, shopId]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);
  const value = useMemo(() => ({
    isAdmin, shopId, specificShopId: isAdmin && shopId !== 'all' ? shopId : '',
    shops, ready, error: catalog.userId === userId ? catalog.error : '',
    blockedReason, selectShop, registerGuard, reload,
  }), [isAdmin, shopId, shops, ready, catalog, userId, blockedReason, selectShop, registerGuard, reload]);

  return <AdminShopScopeContext.Provider value={value}>{children}</AdminShopScopeContext.Provider>;
}
