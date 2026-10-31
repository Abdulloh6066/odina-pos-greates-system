import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import WholesaleBuyerFields from '@/components/wholesale/WholesaleBuyerFields';
import { wholesaleCall } from '@/hooks/useWholesalePage';
import { formatUZS } from '@/lib/pos';

export default function WholesaleSaleDialog({ selection, sourceId, branches, onClose, onSaved }) {
  const [sale, setSale] = useState(selection.sale || null);
  const [form, setForm] = useState({ buyer_type: 'branch', buyer_id: '', buyer_name: '', quantity: '1', payment_method: 'cash' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const act = async action => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await wholesaleCall(action === 'prepare'
        ? { action, source_id: sourceId, product_id: selection.product.id, ...form }
        : { action, sale_id: sale.id });
      if (action === 'prepare') { setSale(result.sale); onSaved(); }
      else { onSaved(); onClose(); }
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      const status = e?.response?.status || e?.status;
      if (action === 'prepare' && (!status || status >= 500)) setUncertain(true);
      if (action === 'confirm') setSale(current => ({ ...current, status: 'processing' }));
    }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{sale?.product_name || selection.product?.name} · list savdosi</DialogTitle></DialogHeader>
    {sale ? <div className="space-y-2">
      <p className="font-semibold">{sale.buyer_name}</p><p>{sale.quantity} list × {formatUZS(sale.unit_price)}</p>
      <p className="text-xl font-bold">Jami: {formatUZS(sale.total)}</p>
      <p>To‘lov: {sale.payment_method === 'cash' ? 'Naqd pul' : 'Bank o‘tkazmasi'}</p>
      <p className="text-sm text-muted-foreground">Faqat pul qabul qilingach tasdiqlang. Qoldiq ishlab chiqarish omboridan ayriladi.{sale.buyer_type === 'branch' ? ' Filial mahsulotni Transferlar orqali qabul qiladi.' : ''}</p>
    </div> : <fieldset disabled={busy || uncertain}><WholesaleBuyerFields form={form} setForm={setForm} branches={branches} /></fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {uncertain && <p className="text-sm">Natija noaniq. Oynani yoping va savdolar tarixidan tayyorlangan hujjatni tekshiring; yangi savdo boshlamang.</p>}
    <div className="flex flex-wrap justify-end gap-2">
      {sale?.status === 'draft' && <Button variant="outline" disabled={busy} onClick={() => act('cancel')}>Hujjatni bekor qilish</Button>}
      <Button variant="outline" disabled={busy} onClick={onClose}>Yopish</Button>
      <Button disabled={busy || uncertain} onClick={() => act(sale ? 'confirm' : 'prepare')}>
        {busy ? 'Kutilmoqda…' : sale ? (sale.status === 'processing' ? 'Natijani tekshirish' : 'Sotuvni tasdiqlash') : 'Hisoblash'}
      </Button>
    </div>
  </DialogContent></Dialog>;
}