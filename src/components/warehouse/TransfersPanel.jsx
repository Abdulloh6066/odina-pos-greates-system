import React, { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, PackageCheck, RefreshCw, Search, Send, Truck } from 'lucide-react';
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
  const canSend = user?.role === 'admin' && location?.location_type === 'production';
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

  const canReceive = (transfer) => user?.role !== 'manager'
    && transfer.status === 'pending'
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
        <div className="flex flex-col sm:flex-row gap-2">
          <Button type="button" variant="outline" onClick={onReload} className="min-h-11 rounded-xl touch-manipulation">
            <RefreshCw className="w-4 h-4 mr-1.5" /> Yangilash
          </Button>
          {canSend && (
            <Button onClick={() => setSendOpen(true)} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
              <Send className="w-4 h-4 mr-1.5" /> Yangi transfer
            </Button>
          )}
        </div>
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
  const [categoryId, setCategoryId] = useState('all');
  const [productSearch, setProductSearch] = useState('');
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
  const categories = Array.from(new Map(
    availableProducts
      .filter((product) => product.category_id || product.category_name)
      .map((product) => [
        product.category_id || product.category_name,
        product.category_name || 'Kategoriyasiz',
      ]),
  ).entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'uz'));
  const normalizedProductSearch = productSearch.toLowerCase().trim();
  const filteredProducts = availableProducts.filter((product) => {
    const productCategoryId = product.category_id || product.category_name;
    const categoryMatches = categoryId === 'all' || productCategoryId === categoryId;
    const searchMatches = !normalizedProductSearch
      || [product.name, product.category_name].filter(Boolean).join(' ').toLowerCase().includes(normalizedProductSearch);
    return categoryMatches && searchMatches;
  });
  const available = Number(stockByProduct[productId] || 0);
  const transferAmount = Number(quantity);
  const quantityValid = Number.isInteger(transferAmount) && transferAmount > 0 && transferAmount <= available;

  const resetAndClose = () => {
    if (saving) return;
    setDestinationId('');
    setCategoryId('all');
    setProductSearch('');
    setProductId('');
    setQuantity('');
    setNotes('');
    onClose();
  };

  const send = async () => {
    if (!destinationId || !productId || !quantityValid) return;
    setSaving(true);
    try {
      const result = await base44.functions.invoke('stock-transfer', {
        action: 'create_transfer',
        source_location_id: source.id,
        destination_location_id: destinationId,
        product_id: productId,
        quantity: transferAmount,
        notes: notes.trim(),
      });
      const payload = result?.data || result;
      if (!payload?.transfer) throw new Error(payload?.error || 'Transferni yaratib bo‘lmadi.');
      setDestinationId('');
      setCategoryId('all');
      setProductSearch('');
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
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">Kategoriya</Label>
              <select
                value={categoryId}
                onChange={(event) => {
                  setCategoryId(event.target.value);
                  setProductId('');
                  setQuantity('');
                }}
                className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm"
              >
                <option value="all">Barcha kategoriyalar</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Mahsulot qidirish</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  value={productSearch}
                  onChange={(event) => {
                    setProductSearch(event.target.value);
                    setProductId('');
                    setQuantity('');
                  }}
                  placeholder="Masalan: Almond"
                  className="h-11 pl-9"
                />
              </div>
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Mahsulot</Label>
            <select value={productId} onChange={(event) => { setProductId(event.target.value); setQuantity(''); }} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
              <option value="">Mahsulotni tanlang</option>
              {filteredProducts.map((product) => (
                <option key={product.id} value={product.id}>{product.name} · {formatNum(stockByProduct[product.id])} dona mavjud</option>
              ))}
            </select>
            {filteredProducts.length === 0 && (
              <p className="text-xs text-destructive mt-1.5">Bu kategoriya yoki qidiruv bo‘yicha qoldiqli mahsulot topilmadi.</p>
            )}
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Jo‘natiladigan miqdor (dona)</Label>
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              max={available || undefined}
              step="1"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder={productId ? `1 dan ${formatNum(available)} gacha` : 'Avval mahsulotni tanlang'}
              disabled={!productId}
              className="h-11 rounded-xl"
            />
            {productId && (
              <p className="text-xs text-muted-foreground mt-1.5">
                Markazda mavjud: {formatNum(available)} dona. Transfer yaratish uchun 1–{formatNum(available)} oralig‘idagi butun sonni kiriting.
              </p>
            )}
            {quantity && !quantityValid && (
              <p className="text-xs text-destructive mt-1.5">
                Miqdor 1 dan {formatNum(available)} gacha bo‘lgan butun son bo‘lishi kerak.
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Masalan: ertalabki yetkazib berish" rows={2} />
          </div>
          {productId && quantityValid && (
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
          <Button onClick={send} disabled={saving || !destinationId || !productId || !quantityValid} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
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
