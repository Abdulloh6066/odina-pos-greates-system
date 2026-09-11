import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';

const buildIdempotencyKey = (prefix = 'demand') =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function useShopDemand(user) {
  const [requests, setRequests] = useState([]);
  const [itemsByRequest, setItemsByRequest] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await base44.functions.invoke('shop-demand', { action: 'list_requests' });
      const p = res?.data || res;
      if (p?.error) throw new Error(p.error);
      const reqs = p?.requests || [];
      setRequests(reqs);
      const map = {};
      (p?.items || []).forEach((it) => { (map[it.request_id] = map[it.request_id] || []).push(it); });
      setItemsByRequest(map);
      try { await base44.functions.invoke('shop-demand', { action: 'reconcile_all' }); } catch {}
    } catch (e) {
      setError(e?.message || "Talablarni yuklab bo'lmadi.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (user) load(); }, [user, load]);

  const call = async (payload) => {
    setBusy(true);
    try {
      const res = await base44.functions.invoke('shop-demand', payload);
      const p = res?.data || res;
      if (p?.error) throw new Error(p.error);
      return p;
    } finally {
      setBusy(false);
    }
  };

  const create = async (data) => {
    const p = await call({ action: 'create_request', idempotency_key: buildIdempotencyKey(), ...data });
    await load();
    return p;
  };
  const update = async (data) => { const p = await call({ action: 'update_request', ...data }); await load(); return p; };
  const cancel = async (id) => {
    if (!await odinaConfirm('Talabni bekor qilasizmi?', { title: 'Bekor qilish', tone: 'warning', confirmLabel: 'Bekor qilish' })) return null;
    const p = await call({ action: 'update_request', request_id: id, cancel: true });
    await load();
    return p;
  };
  const accept = async (id) => { const p = await call({ action: 'accept_request', request_id: id }); await load(); return p; };
  const progress = async (id, status) => { const p = await call({ action: 'set_progress', request_id: id, status }); await load(); return p; };
  const send = async (id, items) => {
    const p = await call({ action: 'send_request', request_id: id, items, send_idempotency_key: buildIdempotencyKey('send') });
    await load();
    return p;
  };
  const syncReceipt = async (batchId) => {
    try { await base44.functions.invoke('shop-demand', { action: 'sync_receipt', batch_id: batchId }); await load(); } catch {}
  };

  const safe = async (fn, label) => {
    try { await fn(); }
    catch (e) { void odinaAlert((label || 'Amal') + ' amalga oshmadi: ' + (e?.message || e)); }
  };

  return { requests, itemsByRequest, loading, error, busy, reload: load, create, update, cancel, accept, progress, send, syncReceipt, safe };
}