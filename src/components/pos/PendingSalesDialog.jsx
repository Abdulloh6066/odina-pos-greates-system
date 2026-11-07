import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileClock, Loader2, Pencil, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { syncErrorMessage } from '@/lib/offline-sales';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const statusLabel = record => record.status === 'confirmed' ? 'Serverda saqlangan'
  : record.status === 'failed' ? 'Tekshirish kerak' : record.status === 'syncing' ? 'Yuborilmoqda' : 'Navbatda';
const methodLabels = { cash: 'Naqd', bank_card: 'Bank card', humo: 'HUMO', uzcard: 'UZCARD', online: 'Online', bank_transfer: 'Bank o‘tkazmasi' };

export default function PendingSalesDialog({ records, online, syncing, onRetry, onResolve, onResolveAll, onClose }) {
  const [selectedId, setSelectedId] = useState('');
  const [inspection, setInspection] = useState({ loading: false, data: null, error: '' });
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState('');
  const [batchIds, setBatchIds] = useState([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const flight = useRef(false);
  const active = records.filter(record => record.status !== 'confirmed');
  const selected = active.find(record => record.id === selectedId) || active[0] || null;
  const selectedRequest = selected ? JSON.stringify(selected.request) : '';
  useEffect(() => {
    setMode(''); setPin(''); setReason(''); setError('');
    setAmount(String(selected?.local_sale?.total ?? ''));
  }, [selected?.id]);
  useEffect(() => {
    let disposed = false;
    if (!selected || !online) { setInspection({ loading: false, data: null, error: '' }); return undefined; }
    setInspection({ loading: true, data: null, error: '' });
    base44.functions.invoke('complete-sale', { action: 'inspect_pending_sale', original_request: JSON.parse(selectedRequest) })
      .then(response => {
        const data = response?.data || response;
        if (data?.error || !data?.state) throw new Error(data?.error || 'Server holati olinmadi.');
        if (!disposed) setInspection({ loading: false, data, error: '' });
      }).catch(problem => { if (!disposed) setInspection({ loading: false, data: null, error: syncErrorMessage(problem) }); });
    return () => { disposed = true; };
  }, [selected?.id, selectedRequest, online, refresh]);
  const data = inspection.data;
  const closed = data?.shift_status && data.shift_status !== 'open';
  const resolved = ['confirmed', 'cancelled', 'edited'].includes(data?.state);
  const blocked = busy || syncing || !online;
  const editable = data?.state === 'pending' && !closed && !data.pricing_error && Number(data.subtotal) > 0;
  const cancellable = data?.state === 'pending' && ['open', 'closed'].includes(data?.shift_status);
  const run = async operation => {
    if (!selected || flight.current || blocked) return;
    flight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (operation === 'cancel_all') {
        const result = await onResolveAll(batchIds, { reason: reason.trim(), pin });
        const cancelled = result.results.filter(row => row.state === 'cancelled').length;
        const confirmed = result.results.filter(row => row.state === 'confirmed').length;
        setNotice(cancelled + ' ta savdo bekor qilindi. ' + confirmed + ' ta serverda saqlangan savdo navbatdan chiqarildi.'
          + (result.errors.length ? ' ' + result.errors.length + ' ta yozuv navbatda qoldi: '
            + result.errors.slice(0, 3).map(row => row.error).join(' · ') : ''));
        setMode('');
      } else if (operation === 'retry') {
        const result = await onRetry({ retryFailed: true, recordId: selected.id });
        if (result?.failed) throw new Error(result.failed.message);
        if (result?.skipped) throw new Error('Boshqa oynada yuborilmoqda. Bir ozdan keyin qayta tekshiring.');
        setNotice(result?.synced ? 'Savdo serverda tasdiqlandi.' : 'Holat qayta tekshirildi.');
      } else {
        const result = await onResolve(selected.id, operation === 'reconcile' ? {} : {
          operation, finalTotal: Number(amount), reason: reason.trim(), pin,
        });
        setNotice(result.state === 'edited' ? 'Tahrir saqlandi. Yangi so‘rov navbatga qo‘shildi.'
          : result.state === 'cancelled' ? 'Tasdiqlanmagan savdo bekor qilindi. Qaror tarixga yozildi.' : 'Server tasdig‘i navbatga moslandi.');
        setMode('');
      }
      setRefresh(value => value + 1);
    } catch (problem) { setError(syncErrorMessage(problem)); setRefresh(value => value + 1); }
    finally { flight.current = false; setBusy(false); setPin(''); }
  };
  const total = selected?.local_sale?.total ?? selected?.request?.payments?.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const finalAmount = Number(amount);
  const validAmount = Number.isSafeInteger(finalAmount) && finalAmount > 0 && finalAmount <= Number(data?.subtotal);
  return <Dialog open onOpenChange={open => { if (!open && !flight.current) onClose(); }}>
    <DialogContent className="sm:max-w-4xl max-h-[92dvh] overflow-y-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-2 font-display text-xl"><FileClock className="h-5 w-5" />Navbatdagi savdolar <span className="text-sm text-muted-foreground">({active.length})</span></DialogTitle>
        <p className="text-sm text-muted-foreground">Shu brauzerda joriy xodim saqlagan savdolar. Tahrirlash va bekor qilish uchun egasi PIN-kodi kerak.</p>
      </DialogHeader>
      {active.length > 0 && onResolveAll && <div className="flex justify-end"><Button type="button" variant="outline" className="min-h-11 border-destructive/30 text-destructive" disabled={blocked} onClick={() => { setBatchIds(active.map(row => row.id)); setMode('cancel_all'); setReason(''); setPin(''); setError(''); }}><Trash2 className="mr-2 h-4 w-4" />Hammasini bekor qilish ({active.length})</Button></div>}
      {notice && <p role="status" className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm"><CheckCircle2 className="h-5 w-5 shrink-0" />{notice}</p>}
      {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive break-words">{error}</p>}
      {!online && <p role="status" className="rounded-xl border border-border p-3 text-sm">Internet yo‘q. Yozuvlarni ko‘rish mumkin; yuborish va PIN tasdig‘i uchun ulaning.</p>}
      {!selected ? <div className="py-12 text-center"><CheckCircle2 className="mx-auto mb-3 h-9 w-9 text-brand-olive" /><p className="font-semibold">Navbatda savdo yo‘q</p><p className="mt-2 text-sm text-muted-foreground">Yuborilishi kutilayotgan savdolar shu yerda ko‘rinadi.</p></div>
        : <div className="grid gap-5 md:grid-cols-[240px_minmax(0,1fr)]">
          <div className="max-h-48 space-y-2 overflow-y-auto md:max-h-[60dvh]" role="group" aria-label="Saqlangan savdolar">
            {active.map(record => <button key={record.id} type="button" disabled={busy} aria-pressed={selected.id === record.id} onClick={() => { setSelectedId(record.id); setNotice(''); }} className={'w-full min-h-16 rounded-xl border p-3 text-left ' + (selected.id === record.id ? 'border-primary bg-primary/10' : 'border-border bg-card')}>
              <strong className="block text-sm break-words">{record.local_sale?.sale_number || record.id}</strong><span className="mt-1 block text-sm">{formatUZS(record.local_sale?.total || 0)} · {statusLabel(record)}</span><span className="mt-1 block text-xs text-muted-foreground">{formatUzbekistanDateTime(record.created_at)}</span>
            </button>)}
          </div>
          <div className="min-w-0 space-y-4">
            <div><h3 className="font-semibold">{selected.local_sale?.shop_name || 'Do‘kon'} · {statusLabel(selected)}</h3><p className="mt-1 text-xs text-muted-foreground break-all">Kalit: {selected.id}</p><p className="mt-1 text-sm text-muted-foreground">Urinishlar: {Number(selected.attempts || 0)}{data?.shift_status ? ' · Smena: ' + (closed ? 'yopilgan / yopilmoqda' : 'ochiq') : ''}</p></div>
            {selected.last_error && <div role="status" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="mb-1 flex items-center gap-2 font-semibold text-destructive"><AlertTriangle className="h-4 w-4" />Oxirgi xato{selected.last_error_status ? ' · ' + selected.last_error_status : ''}</p><p className="whitespace-pre-wrap break-words">{selected.last_error}</p></div>}
            <ul className="divide-y divide-border rounded-xl border border-border px-3">{(selected.local_sale?.items || selected.request.items || []).map((item, index) => <li key={index} className="flex justify-between gap-3 py-3 text-sm"><span>{item.product_name || item.product_id}<small className="mt-1 block text-muted-foreground">{item.quantity} {item.sale_unit === 'gram' ? 'g' : 'dona'}</small></span><strong>{item.subtotal != null ? formatUZS(item.subtotal) : ''}</strong></li>)}</ul>
            <div className="rounded-xl bg-primary/10 p-3 text-sm space-y-2"><div className="flex justify-between gap-3"><span>Qurilmadagi yakuniy summa</span><strong>{formatUZS(total)}</strong></div><div className="flex justify-between gap-3"><span>Saqlangan chegirma</span><span>{formatUZS(selected.local_sale?.discount_amount || selected.request.manual_discount_amount || 0)}</span></div>{data?.subtotal != null && <div className="flex justify-between gap-3"><span>Serverdagi mahsulotlar jami</span><span>{formatUZS(data.subtotal)}</span></div>}{selected.request.payments?.map((payment, index) => <div key={index} className="flex justify-between gap-3"><span>{methodLabels[payment.method] || payment.method}</span><span>{formatUZS(payment.amount)}</span></div>)}</div>
            {inspection.loading ? <p role="status" className="flex gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Server holati tekshirilmoqda…</p> : inspection.error ? <p role="alert" className="text-sm text-destructive break-words">{inspection.error}</p> : data?.pricing_error ? <p role="alert" className="text-sm text-destructive">{data.pricing_error}</p> : null}
            {data?.state === 'processing' && <p role="status" className="text-sm text-muted-foreground">Savdo serverda yakunlanmoqda yoki tekshiruv talab qiladi. Hozir tahrirlash va bekor qilish yopiq.</p>}
            {closed && !resolved && <p className="rounded-xl border border-border p-3 text-sm">Smena yopilgan. Savdoni tahrirlab qayta yozish hisobotni o‘zgartiradi. Server holatini tekshiring; tasdiqlanmagan savdoni PIN bilan bekor qilish mumkin.</p>}
            {resolved ? <Button type="button" className="min-h-11 w-full" disabled={blocked} onClick={() => void run('reconcile')}>Server qarorini navbatga moslash</Button> : <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={blocked} onClick={() => setRefresh(value => value + 1)}><RefreshCw className="mr-2 h-4 w-4" />Holatini tekshirish</Button><Button type="button" className="min-h-11" disabled={blocked || inspection.loading || Boolean(mode)} onClick={() => void run('retry')}><RefreshCw className="mr-2 h-4 w-4" />Qayta yuborish</Button><Button type="button" variant="outline" className="min-h-11" disabled={blocked || !editable} onClick={() => { setMode('edit'); setPin(''); }}><Pencil className="mr-2 h-4 w-4" />Tahrirlash</Button><Button type="button" variant="outline" className="min-h-11" disabled={blocked || !cancellable} onClick={() => { setMode('cancel'); setPin(''); }}><Trash2 className="mr-2 h-4 w-4" />Bekor qilish</Button></div>}
            {mode && <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={event => { event.preventDefault(); void run(mode); }}><h4 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" />{mode === 'edit' ? 'Summani tahrirlash' : mode === 'cancel_all' ? batchIds.length + ' ta savdoni bekor qilish' : 'Navbatdagi savdoni bekor qilish'}</h4>
              {mode === 'edit' ? <><div><Label htmlFor="pending-sale-total">Yakuniy summa (UZS)</Label><Input data-money id="pending-sale-total" type="number" inputMode="numeric" min="1" step="1" value={amount} onChange={event => setAmount(event.target.value)} disabled={blocked} className="mt-1 min-h-11" required /></div><p className="text-sm text-muted-foreground">Mahsulotlar va to‘lov usullari saqlanadi. Summalar yangi jamiga moslanadi; chegirma server narxidan hisoblanadi.</p>{amount && !validAmount && <p role="alert" className="text-sm text-destructive">Summa 1 so‘mdan kam va server jamidan ko‘p bo‘lmasin.</p>}</> : <p className="text-sm text-muted-foreground">{mode === 'cancel_all' ? 'Tanlangan ' + batchIds.length + ' ta yozuv tekshiriladi. ' : ''}Faqat serverga yozilmagan savdo bekor qilinadi. Serverda saqlangan savdolar tarixi o‘chmaydi. Bu amal mijozga pul qaytarishni hisobga olmaydi. Qaror tarixda saqlanadi.</p>}
              <div><Label htmlFor="pending-sale-reason">Sabab</Label><Textarea id="pending-sale-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={blocked} className="mt-1" required /></div>
              <div><Label htmlFor="pending-sale-pin">Egasi PIN-kodi</Label><Input id="pending-sale-pin" type="password" autoComplete="one-time-code" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" inputMode="numeric" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))} disabled={blocked} className="mt-1 min-h-11" required /><p className="mt-1 text-xs text-muted-foreground">PIN saqlanmaydi. Tasdiq serverda tekshiriladi.</p></div>
              <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => { setMode(''); setPin(''); }}>Orqaga</Button><Button type="submit" className="min-h-11" disabled={blocked || !reason.trim() || !/^\d{4,8}$/.test(pin) || (mode === 'edit' && !validAmount)}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}{mode === 'edit' ? 'PIN bilan saqlash' : mode === 'cancel_all' ? 'Hammasini PIN bilan bekor qilish' : 'PIN bilan bekor qilish'}</Button></div>
            </form>}
          </div>
        </div>}
      <div className="flex justify-end border-t border-border pt-3"><Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={onClose}>Yopish</Button></div>
    </DialogContent>
  </Dialog>;
}
