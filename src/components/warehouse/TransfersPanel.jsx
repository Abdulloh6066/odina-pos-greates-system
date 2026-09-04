import React, { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, PackageCheck, Send, Truck } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatNum } from '@/lib/pos';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const STATUS = {
  pending: { label: 'Qabul kutilmoqda', className: 'bg-amber-50 text-amber-700' },
  receiving: { label: 'Qabul qilinmoqda', className: 'bg-blue-50 text-blue-700' },
  received: { label: 'Qabul qilindi', className: 'bg-emerald-50 text-emerald-700' },
};

export default function TransfersPanel({
  user, location, locations, products, productStock, transfers, search, onReload,
}) {
  const [sendOpen, setSendOpen] = useState(false);
  const [receivingId, setReceivingId] = useState('');
  const canSend = ['admin', 'production'].includes(user?.role) && location?.location_type === 'production';
  const normalizedSearch = search.toLowerCase().trim();

  const visibleTransfers = useMemo(() => transfers.filter((transfer) => {
    const belongs = transfer.source_location_id === location?.id || transfer.destination_location_id === location?.id;
    if (!belongs) return false;
    if (!normalizedSearch) return true;
    return [
      transfer.transfer_number,
      transfer.product_name_snapshot,
      transfer.source_location_name,
      transfer.destination_location_name,
      transfer.created_by_name,
      transfer.received_by_name,
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedSearch);
  }), [transfers, location?.id, normalizedSearch]);

  const pending = visibleTransfers.filter((transfer) => transfer.status !== 'received');
  const completed = visibleTransfers.filter((transfer) => transfer.status === 'received');

  const canReceive = (transfer) => transfer.status === 'pending'
    && transfer.destination_location_id === location?.id
    && (user?.role === 'admin' || user?.shop_id === transfer.destination_location_id);

  const receive = async (transfer) => {
    if (!confirm(`${transfer.product_name_snapshot} — ${formatNum(transfer.quantity)} dona qabul qilinsinmi?`)) return;
    setReceivingId(transfer.id);
    try {
      const result = await base44.functions.invoke('stock-transfer', {
        action: 'receive_transfer',
        transfer_id: transfer.id,
      });
      const payload = result?.data || result;
      if (!payload?.transfer) throw new Error(payload?.error || 'Transferni qabul qilib bo‘lmadi.');
      await onReload();
    } catch (error) {
      alert('Qabul qilish amalga oshmadi: ' + (error?.response?.data?.error || error?.data?.error || error?.message || error));
    } finally {
      setReceivingId('');
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-card premium-shadow p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-primary/15 text-primary-strong flex items-center justify-center shrink-0">
          <Truck className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <p className="font-semibold">Mahsulot transferlari</p>
          <p className="text-sm text-muted-foreground">
            Markaz jo‘natadi, do‘kon qabul qilgandan keyin uning qoldig‘iga qo‘shiladi.
          </p>
        </div>
        {canSend && (
          <Button onClick={() => setSendOpen(true)} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            <Send className="w-4 h-4 mr-1.5" /> Yangi transfer
          </Button>
        )}
      </div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-lg font-bold">Jarayondagi transferlar</h3>
          <span className="text-xs rounded-full bg-secondary px-2.5 py-1">{formatNum(pending.length)} ta</span>
        </div>
        {pending.length === 0 ? (
          <Empty text="Qabul qilinishi kutilayotgan transfer yo‘q." />
        ) : (
          <div className="grid lg:grid-cols-2 gap-3">
            {pending.map((transfer) => (
              <TransferCard
                key={transfer.id}
                transfer={transfer}
                canReceive={canReceive(transfer)}
                receiving={receivingId === transfer.id}
                onReceive={() => receive(transfer)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-lg font-bold">Qabul qilinganlar tarixi</h3>
          <span className="text-xs rounded-full bg-secondary px-2.5 py-1">{formatNum(completed.length)} ta</span>
        </div>
        {completed.length === 0 ? (
          <Empty text="Hali qabul qilingan transfer yo‘q." />
        ) : (
          <div className="space-y-3">
            {completed.map((transfer) => (
              <TransferCard key={transfer.id} transfer={transfer} />
            ))}
          </div>
        )}
      </section>

      <SendTransferDialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        source={location}
        locations={locations}
        products={products}
        productStock={productStock}
        onSaved={async () => {
          setSendOpen(false);
          await onReload();
        }}
      />
    </div>
  );
}

function TransferCard({ transfer, canReceive, receiving, onReceive }) {
  const status = STATUS[transfer.status] || STATUS.pending;
  return (
    <article className="rounded-2xl border border-border bg-card p-4 premium-shadow">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{transfer.product_name_snapshot}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{transfer.transfer_number}</p>
        </div>
        <span className={`text-xs font-medium rounded-full px-2.5 py-1 ${status.className}`}>{status.label}</span>
      </div>

      <div className="mt-4 rounded-xl bg-secondary/55 p-3 flex items-center gap-2 text-sm">
        <span className="font-medium truncate">{transfer.source_location_name}</span>
        <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="font-medium truncate">{transfer.destination_location_name}</span>
        <span className="ml-auto font-bold text-primary-strong whitespace-nowrap">{formatNum(transfer.quantity)} dona</span>
      </div>

      {transfer.notes && <p className="text-sm text-muted-foreground mt-3">{transfer.notes}</p>}

      <div className="text-xs text-muted-foreground mt-3 space-y-1">
        <p>Jo‘natdi: {transfer.created_by_name} · {new Date(transfer.sent_at || transfer.created_date).toLocaleString('uz-UZ')}</p>
        {transfer.received_at && <p>Qabul qildi: {transfer.received_by_name} · {new Date(transfer.received_at).toLocaleString('uz-UZ')}</p>}
      </div>

      {canReceive && (
        <Button onClick={onReceive} disabled={receiving} className="w-full mt-4 min-h-11 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 touch-manipulation">
          <PackageCheck className="w-4 h-4 mr-1.5" />
          {receiving ? 'Qabul qilinmoqda…' : 'Qabul qildim'}
        </Button>
      )}
      {transfer.status === 'received' && (
        <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="w-4 h-4" /> Do‘kon qoldig‘iga qo‘shilgan
        </div>
      )}
    </article>
  );
}

function SendTransferDialog({ open, onClose, source, locations, products, productStock, onSaved }) {
  const [destinationId, setDestinationId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const destinations = locations.filter((item) => item.location_type === 'shop' && item.id !== source?.id);
  const stockByProduct = Object.fromEntries(
    productStock
      .filter((stock) => stock.location_id === source?.id)
      .map((stock) => [stock.product_id, Number(stock.quantity || 0)]),
  );
  const availableProducts = products.filter((product) => Number(stockByProduct[product.id] || 0) > 0);
  const available = Number(stockByProduct[productId] || 0);

  const resetAndClose = () => {
    if (saving) return;
    setDestinationId('');
    setProductId('');
    setQuantity('');
    setNotes('');
    onClose();
  };

  const send = async () => {
    const amount = Number(quantity);
    if (!destinationId || !productId || !Number.isInteger(amount) || amount <= 0 || amount > available) return;
    setSaving(true);
    try {
      const result = await base44.functions.invoke('stock-transfer', {
        action: 'create_transfer',
        source_location_id: source.id,
        destination_location_id: destinationId,
        product_id: productId,
        quantity: amount,
        notes: notes.trim(),
      });
      const payload = result?.data || result;
      if (!payload?.transfer) throw new Error(payload?.error || 'Transferni yaratib bo‘lmadi.');
      setDestinationId('');
      setProductId('');
      setQuantity('');
      setNotes('');
      await onSaved();
    } catch (error) {
      alert('Transfer jo‘natilmadi: ' + (error?.response?.data?.error || error?.data?.error || error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && resetAndClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Yangi transfer jo‘natish</DialogTitle>
          <p className="text-sm text-muted-foreground">{source?.name} omboridan do‘konga</p>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Qabul qiluvchi do‘kon</Label>
            <select value={destinationId} onChange={(event) => setDestinationId(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
              <option value="">Do‘konni tanlang</option>
              {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Mahsulot</Label>
            <select value={productId} onChange={(event) => { setProductId(event.target.value); setQuantity(''); }} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
              <option value="">Mahsulotni tanlang</option>
              {availableProducts.map((product) => (
                <option key={product.id} value={product.id}>{product.name} · {formatNum(stockByProduct[product.id])} dona mavjud</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Jo‘natiladigan miqdor (dona)</Label>
            <Input type="number" min="1" step="1" max={available || undefined} value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="0" className="h-11 rounded-xl" />
            {productId && <p className="text-xs text-muted-foreground mt-1.5">Markazda mavjud: {formatNum(available)} dona</p>}
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Masalan: ertalabki yetkazib berish" rows={2} />
          </div>
          {productId && quantity && (
            <div className="rounded-xl bg-secondary/60 p-3 text-sm flex items-center justify-between">
              <span className="text-muted-foreground">Jo‘natilgandan keyin markazda</span>
              <span className={`font-semibold ${Number(quantity) > available ? 'text-destructive' : ''}`}>
                {formatNum(available - Number(quantity || 0))} dona
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={resetAndClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={send} disabled={saving || !destinationId || !productId || !quantity || Number(quantity) > available} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            <Send className="w-4 h-4 mr-1.5" />
            {saving ? 'Jo‘natilmoqda…' : 'Transferni jo‘natish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Empty({ text }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card py-10 text-center">
      <Truck className="w-9 h-9 mx-auto text-muted-foreground/35 mb-2" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
