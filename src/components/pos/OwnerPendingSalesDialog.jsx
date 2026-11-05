import React, { useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button as ButtonPrimitive } from '@/components/ui/button';
import { Input as InputPrimitive } from '@/components/ui/input';
import { Textarea as TextareaPrimitive } from '@/components/ui/textarea';
import { Dialog, DialogContent as DialogContentPrimitive, DialogHeader, DialogTitle as DialogTitlePrimitive, DialogDescription as DialogDescriptionPrimitive } from '@/components/ui/dialog';
import { listPendingSales, subscribePendingSales, cancelPendingSale, syncErrorMessage } from '@/lib/offline-sales';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';

// These shared JS forwardRef primitives omit their props from inferred types.
const Button = /** @type {React.ComponentType<Record<string, any>>} */ (ButtonPrimitive);
const Input = /** @type {React.ComponentType<Record<string, any>>} */ (InputPrimitive);
const Textarea = /** @type {React.ComponentType<Record<string, any>>} */ (TextareaPrimitive);
const DialogContent = /** @type {React.ComponentType<Record<string, any>>} */ (DialogContentPrimitive);
const DialogTitle = /** @type {React.ComponentType<Record<string, any>>} */ (DialogTitlePrimitive);
const DialogDescription = /** @type {React.ComponentType<Record<string, any>>} */ (DialogDescriptionPrimitive);

// The server independently verifies the stored actor, shop and admin approval code.
export default function OwnerPendingSalesDialog({ user, isOnline, syncing, onCancelled }) {
  const isOwner = user?.role === 'admin' && (user?.is_owner === true || user?.data?.is_owner === true);
  const shopId = user?.shop_id || user?.data?.shop_id || '';
  const isCashier = user?.role === 'cashier' && Boolean(shopId);
  if ((!isOwner && !isCashier) || !user?.id || user.active === false || user.data?.active === false) return null;
  return <PendingQueue key={JSON.stringify([user.id, user.role, shopId, isOwner])}
    actorId={user.id} isOwner={isOwner} shopId={shopId} isOnline={isOnline} syncing={syncing} onCancelled={onCancelled} />;
}

function PendingQueue({ actorId, isOwner, shopId, isOnline, syncing, onCancelled }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="mx-3 sm:mx-5 mt-3 shrink-0">
      <Button type="button" variant="outline" className="min-h-11" onClick={() => setOpen(true)}>Navbatdagi savdolar</Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      {open && <PendingSalesContent actorId={actorId} isOwner={isOwner} shopId={shopId} isOnline={isOnline} syncing={syncing} onCancelled={onCancelled} />}
    </Dialog>
  </>;
}

function PendingSalesContent({ actorId, isOwner, shopId, isOnline, syncing, onCancelled }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const active = useRef(false);
  const reload = useRef(null);
  const selected = records.find(record => record.id === selectedId);

  useEffect(() => {
    active.current = true;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        // Owners retain device-wide recovery; cashiers read only their own queue.
        const rows = isOwner ? await listPendingSales() : await listPendingSales(actorId);
        if (!active.current || current !== generation) return;
        setRecords(rows.filter(row => row.status !== 'confirmed'
          && (isOwner || (row.user_id === actorId && row.shop_id === shopId))));
        setLoadError('');
      } catch {
        if (active.current && current === generation) {
          setLoadError('Navbatni o‘qib bo‘lmadi. Qayta ochib ko‘ring.');
          setRecords([]);
        }
      } finally {
        if (active.current && current === generation) setLoading(false);
      }
    };
    reload.current = refresh;
    void refresh();
    const unsubscribe = subscribePendingSales(refresh);
    return () => { active.current = false; generation++; reload.current = null; unsubscribe(); };
  }, [actorId, isOwner, shopId]);

  useEffect(() => {
    if (selectedId && !selected) {
      setSelectedId(''); setPin(''); setReason('');
    }
  }, [selectedId, selected]);

  const choose = record => {
    if (submitting.current) return;
    setSelectedId(record.id); setPin(''); setReason(''); setError(''); setSuccess('');
  };
  const cancel = async event => {
    event.preventDefault();
    if (submitting.current || !selected || !isOnline || syncing || loadError || !pin.trim() || !reason.trim()) return;
    submitting.current = true;
    setBusy(true); setError(''); setSuccess('');
    const ownerPin = pin;
    setPin('');
    try {
      const result = await cancelPendingSale({ recordId: selected.id, actorId, isOwner, shopId, ownerPin, reason: reason.trim(),
        send: body => {
          if (!active.current) throw new Error('Hisob yoki ish joyi o‘zgardi. Savdoni qayta tanlang.');
          return base44.functions.invoke('complete-sale', body);
        } });
      if (!active.current) return;
      if (!result?.cancelled) {
        setError(result?.skipped ? 'Savdo hozir yuborilmoqda. Biroz kutib, qayta urinib ko‘ring.' : 'Bekor qilish tasdiqlanmadi.');
        return;
      }
      setSelectedId(''); setReason('');
      setSuccess('Savdo bekor qilindi.');
      onCancelled?.(result);
      await reload.current?.();
    } catch (failure) {
      if (active.current) setError(syncErrorMessage(failure).replaceAll(ownerPin, '••••'));
    } finally {
      submitting.current = false;
      if (active.current) { setBusy(false); setPin(''); }
    }
  };

  return <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto">
    <DialogHeader className="space-y-2">
      <DialogTitle>Navbatdagi savdolar</DialogTitle>
      <DialogDescription>{isOwner ? 'Shu qurilmada server tasdig‘ini kutayotgan savdolar.' : 'Shu qurilmada o‘z do‘koningizdagi server tasdig‘ini kutayotgan o‘z savdolaringiz.'} Bekor qilish uchun admin tasdiqlash kodi kerak.</DialogDescription>
    </DialogHeader>
    {!isOnline && <p role="alert" className="text-sm text-destructive">Bekor qilish uchun internet aloqasi kerak.</p>}
    {syncing && <p role="status" className="text-sm">Savdolar yuborilmoqda. Tugashini kuting.</p>}
    {loading && <p role="status">Yuklanmoqda…</p>}
    {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
    {success && <p role="status" className="text-sm">{success}</p>}
    {!loading && !loadError && !records.length && <p className="text-sm text-muted-foreground">Bu qurilmada navbatdagi savdo yo‘q.</p>}
    <div className="space-y-2">
      {records.map(record => <div key={record.id} className={`rounded-xl border p-3 space-y-2 ${selectedId === record.id ? 'border-brand-olive bg-brand-olive/10' : ''}`}>
        <p className="font-semibold break-all">{record.local_sale?.sale_number || record.id}</p>
        <p className="text-sm break-words">Do‘kon: {record.local_sale?.shop_name || record.shop_id} · Kassir: {record.local_sale?.user_name || record.user_id}</p>
        <p className="text-sm">{formatUzbekistanDateTime(record.local_sale?.sold_at || record.created_at)} · {formatUZS(record.local_sale?.total)}</p>
        <p className="text-xs text-muted-foreground break-all">Savdo ID: {record.id}</p>
        <Button type="button" variant="outline" className="min-h-11 w-full" disabled={busy || syncing || !isOnline || Boolean(loadError)} onClick={() => choose(record)}>
          Savdoni bekor qilish
        </Button>
      </div>)}
    </div>
    {selected && <form onSubmit={cancel} className="rounded-xl border border-brand-sand p-3 space-y-3">
      <p className="font-semibold break-all">{selected.local_sale?.sale_number || selected.id} savdosi bekor qilinsinmi?</p>
      <p className="text-sm">Summa: {formatUZS(selected.local_sale?.total)}. Server tasdiqlagandan keyin savdo navbatdan olinadi.</p>
      <label className="block text-sm" htmlFor="pending-sale-reason">Bekor qilish sababi</label>
      <Textarea id="pending-sale-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required disabled={busy} />
      <label className="block text-sm" htmlFor="pending-sale-pin">Admin tasdiqlash kodi</label>
      <Input id="pending-sale-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={event => setPin(event.target.value)} required disabled={busy} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="min-h-11 flex-1" disabled={busy} onClick={() => { setSelectedId(''); setPin(''); setReason(''); setError(''); }}>Yo‘q, qolsin</Button>
        <Button type="submit" className="min-h-11 flex-1" disabled={busy || syncing || !isOnline || Boolean(loadError) || !pin.trim() || !reason.trim()}>{busy ? 'Bekor qilinmoqda…' : 'Ha, bekor qilish'}</Button>
      </div>
    </form>}
    {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
  </DialogContent>;
}
