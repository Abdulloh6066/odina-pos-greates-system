import React, { useMemo, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import {
  ArrowRight,
  CheckCircle2,
  Minus,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShoppingBasket,
  Trash2,
  Truck,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatNum } from '@/lib/pos';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const sourceUnitLabel = (product) => product?.production_unit === 'sheet' ? 'list' : 'dona';
const incomingQuantity = (transfer) => Number(transfer.received_quantity ?? transfer.quantity ?? 0);
const transferLabel = (transfer) => transfer.unit === 'sheet'
  ? `${formatNum(transfer.quantity)} list → ${formatNum(incomingQuantity(transfer))} bo‘lak`
  : `${formatNum(transfer.quantity)} dona`;

const STATUS = {
  archived: { label: 'Mahsulot arxivda', className: 'bg-secondary text-muted-foreground' },
  pending: { label: 'Qabul kutilmoqda', className: 'bg-amber-50 text-amber-700' },
  receiving: { label: 'Qabul qilinmoqda', className: 'bg-blue-50 text-blue-700' },
  received: { label: 'Qabul qilindi', className: 'bg-emerald-50 text-emerald-700' },
};

function groupTransferRows(rows) {
  const grouped = new Map();
  rows.forEach((transfer) => {
    const key = transfer.batch_id ? `batch:${transfer.batch_id}` : `single:${transfer.id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(transfer);
  });

  return Array.from(grouped.entries()).map(([id, rawItems]) => {
    const items = [...rawItems].sort(
      (a, b) => Number(a.line_number || 0) - Number(b.line_number || 0),
    );
    const first = items[0];
    const allReceived = items.every((item) => item.status === 'received');
    const allPending = items.every((item) => item.status === 'pending');
    return {
      id,
      batch_id: first.batch_id || '',
      batch_number: first.batch_number || first.transfer_number,
      source_location_id: first.source_location_id,
      source_location_name: first.source_location_name,
      destination_location_id: first.destination_location_id,
      destination_location_name: first.destination_location_name,
      notes: first.notes,
      created_by_name: first.created_by_name,
      sent_at: first.sent_at || first.created_date,
      received_by_name: first.received_by_name,
      received_at: first.received_at,
      status: allReceived ? 'received' : allPending ? 'pending' : 'receiving',
      items,
      total_quantity: items.reduce((sum, item) => sum + incomingQuantity(item), 0),
    };
  });
}

export default function TransfersPanel({
  user, location, locations, products, productStock, transfers, archivedProductIds = [], search, onReload,
}) {
  const [sendOpen, setSendOpen] = useState(false);
  const [receivingId, setReceivingId] = useState('');
  const canSend = user?.role === 'admin' && location?.location_type === 'production';
  const assignedShopId = user?.shop_id || user?.data?.shop_id || '';
  const effectiveLocationId = location?.id || assignedShopId;
  const normalizedSearch = search.toLowerCase().trim();

  const transferGroups = useMemo(() => groupTransferRows(
    transfers.filter((transfer) => transfer.source_location_id === effectiveLocationId
      || transfer.destination_location_id === effectiveLocationId),
  ).map((group) => group.status !== 'received' && group.items.some((item) => archivedProductIds.includes(item.product_id))
    ? { ...group, status: 'archived' } : group), [transfers, effectiveLocationId, archivedProductIds]);

  const visibleGroups = useMemo(() => transferGroups.filter((group) => {
    if (!normalizedSearch) return true;
    return [
      group.batch_number,
      group.source_location_name,
      group.destination_location_name,
      group.created_by_name,
      group.received_by_name,
      ...group.items.flatMap((item) => [item.transfer_number, item.product_name_snapshot]),
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedSearch);
  }), [transferGroups, normalizedSearch]);

  const pending = visibleGroups.filter((group) => ['pending', 'receiving'].includes(group.status));
  const completed = visibleGroups.filter((group) => ['received', 'archived'].includes(group.status));

  const canReceive = (group) => user?.role !== 'manager'
    && group.status === 'pending'
    && group.items.every((item) => item.status === 'pending')
    && group.destination_location_id === effectiveLocationId
    && (user?.role === 'admin' || assignedShopId === group.destination_location_id);

  const receive = async (group) => {
    const message = group.items.length > 1
      ? `${group.batch_number}: ${group.items.length} tur, ${formatNum(group.total_quantity)} dona/bo‘lak mahsulotning hammasi qabul qilinsinmi?`
      : `${group.items[0].product_name_snapshot} — ${transferLabel(group.items[0])} qabul qilinsinmi?`;
    if (!confirm(message)) return;

    setReceivingId(group.id);
    try {
      const request = group.batch_id
        ? { action: 'receive_transfer_batch', batch_id: group.batch_id }
        : { action: 'receive_transfer', transfer_id: group.items[0].id };
      const result = await base44.functions.invoke('stock-transfer', request);
      const payload = result?.data || result;
      if (!payload?.transfer && !payload?.transfers?.length) {
        throw new Error(payload?.error || 'Transferni qabul qilib bo‘lmadi.');
      }
      await onReload();
    } catch (error) {
      alert('Qabul qilish amalga oshmadi: ' + (error?.response?.data?.error || error?.data?.error || error?.message || error));
    } finally {
      setReceivingId('');
    }
  };

  return (
    <div className="space-y-5">
      <div className="odina-panel rounded-2xl border border-border bg-card premium-shadow p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0">
          <Truck className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <p className="font-semibold">Mahsulot transferlari</p>
          <p className="text-sm text-muted-foreground">
            Bir transferga bir nechta mahsulot qo‘shing; do‘kon ularning hammasini birga qabul qiladi.
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
          <span className="text-xs rounded-full bg-secondary px-2.5 py-1">{formatNum(pending.length)} ta hujjat</span>
        </div>
        {pending.length === 0 ? (
          <Empty text="Qabul qilinishi kutilayotgan transfer yo‘q." />
        ) : (
          <div className="grid xl:grid-cols-2 gap-3">
            {pending.map((group) => (
              <TransferGroupCard
                key={group.id}
                group={group}
                canReceive={canReceive(group)}
                receiving={receivingId === group.id}
                onReceive={() => receive(group)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-lg font-bold">Qabul qilinganlar tarixi</h3>
          <span className="text-xs rounded-full bg-secondary px-2.5 py-1">{formatNum(completed.length)} ta hujjat</span>
        </div>
        {completed.length === 0 ? (
          <Empty text="Hali qabul qilingan transfer yo‘q." />
        ) : (
          <div className="space-y-3">
            {completed.map((group) => <TransferGroupCard key={group.id} group={group} />)}
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

function TransferGroupCard({ group, canReceive, receiving, onReceive }) {
  const status = STATUS[group.status] || STATUS.pending;
  return (
    <article className="odina-panel overflow-hidden rounded-2xl border border-border bg-card premium-shadow">
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{group.batch_number}</p>
              <span className="rounded-full bg-primary/15 px-2.5 py-1 text-xs font-semibold text-brand-ink">
                {formatNum(group.items.length)} tur
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Do‘konga {formatNum(group.total_quantity)} dona/bo‘lak mahsulot
            </p>
          </div>
          <span className={`text-xs font-medium rounded-full px-2.5 py-1 ${status.className}`}>{status.label}</span>
        </div>

        <div className="mt-4 rounded-xl bg-secondary/55 p-3 flex items-center gap-2 text-sm">
          <span className="font-medium truncate">{group.source_location_name}</span>
          <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="font-medium truncate">{group.destination_location_name}</span>
        </div>

        <div className="mt-3 overflow-hidden rounded-xl border border-border/80 bg-background/70 divide-y divide-border/70">
          {group.items.map((item, index) => (
            <div key={item.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className="w-6 h-6 rounded-lg bg-primary/15 text-brand-ink flex items-center justify-center text-[11px] font-bold shrink-0">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 font-medium truncate">{item.product_name_snapshot}</span>
              <span className="font-bold text-brand-ink whitespace-nowrap">{transferLabel(item)}</span>
            </div>
          ))}
        </div>

        {group.notes && <p className="text-sm text-muted-foreground mt-3">Izoh: {group.notes}</p>}

        <div className="text-xs text-muted-foreground mt-3 space-y-1">
          <p>Jo‘natdi: {group.created_by_name} · {new Date(group.sent_at).toLocaleString('uz-UZ')}</p>
          {group.received_at && <p>Qabul qildi: {group.received_by_name} · {new Date(group.received_at).toLocaleString('uz-UZ')}</p>}
        </div>

        {canReceive && (
          <Button onClick={onReceive} disabled={receiving} className="w-full mt-4 min-h-11 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 touch-manipulation">
            <PackageCheck className="w-4 h-4 mr-1.5" />
            {receiving ? 'Qabul qilinmoqda…' : group.items.length > 1 ? 'Hammasini qabul qilish' : 'Qabul qildim'}
          </Button>
        )}
        {group.status === 'received' && (
          <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="w-4 h-4" /> Barcha mahsulotlar do‘kon qoldig‘iga qo‘shilgan
          </div>
        )}
        {group.status === 'receiving' && (
          <p className="mt-3 text-xs font-medium text-blue-700">
            Transfer qayta ishlanmoqda. Yangilash tugmasini bosib holatini tekshiring.
          </p>
        )}
      </div>
    </article>
  );
}

function SendTransferDialog({ open, onClose, source, locations, products, productStock, onSaved }) {
  const [destinationId, setDestinationId] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const [productSearch, setProductSearch] = useState('');
  const [selectedQuantities, setSelectedQuantities] = useState({});
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const destinations = locations.filter((item) => item.location_type === 'shop' && item.id !== source?.id);
  const stockByProduct = Object.fromEntries(
    productStock
      .filter((stock) => stock.location_id === source?.id)
      .map((stock) => [stock.product_id, Number(stock.quantity || 0)]),
  );
  const availableProducts = products
    .filter((product) => Number(stockByProduct[product.id] || 0) > 0)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'uz'));
  const productById = Object.fromEntries(availableProducts.map((product) => [product.id, product]));
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
  const selectedEntries = Object.entries(selectedQuantities)
    .map(([productId, rawQuantity]) => ({
      product: productById[productId],
      quantity: Number(rawQuantity),
      available: Number(stockByProduct[productId] || 0),
    }))
    .filter((item) => item.product && Number.isInteger(item.quantity) && item.quantity > 0)
    .sort((a, b) => String(a.product.name || '').localeCompare(String(b.product.name || ''), 'uz'));
  const totalQuantity = selectedEntries.reduce((sum, item) =>
    sum + item.quantity * (item.product.production_unit === 'sheet' ? Number(item.product.pieces_per_sheet || 20) : 1), 0);
  const selectionValid = selectedEntries.length > 0
    && selectedEntries.length <= 50
    && selectedEntries.every((item) => item.quantity <= item.available);

  const changeQuantity = (productId, nextValue) => {
    const available = Math.floor(Number(stockByProduct[productId] || 0));
    setSelectedQuantities((current) => {
      const next = { ...current };
      const parsed = Math.floor(Number(nextValue));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        delete next[productId];
        return next;
      }
      const selectedTypeCount = Object.values(current).filter((value) => Number(value) > 0).length;
      if (!current[productId] && selectedTypeCount >= 50) return current;
      next[productId] = Math.min(parsed, available);
      return next;
    });
  };

  const addProduct = (product) => {
    const available = Math.floor(Number(stockByProduct[product.id] || 0));
    setSelectedQuantities((current) => {
      const currentQuantity = Number(current[product.id] || 0);
      const selectedTypeCount = Object.values(current).filter((value) => Number(value) > 0).length;
      if (currentQuantity >= available || (!current[product.id] && selectedTypeCount >= 50)) {
        return current;
      }
      return { ...current, [product.id]: currentQuantity + 1 };
    });
  };

  const removeProduct = (productId) => {
    setSelectedQuantities((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
  };

  const clearForm = () => {
    setDestinationId('');
    setCategoryId('all');
    setProductSearch('');
    setSelectedQuantities({});
    setNotes('');
  };

  const resetAndClose = () => {
    if (saving) return;
    clearForm();
    onClose();
  };

  const send = async () => {
    if (!destinationId || !selectionValid) return;
    setSaving(true);
    try {
      const result = await base44.functions.invoke('stock-transfer', {
        action: 'create_transfer',
        source_location_id: source.id,
        destination_location_id: destinationId,
        items: selectedEntries.map((item) => ({
          product_id: item.product.id,
          quantity: item.quantity,
        })),
        notes: notes.trim(),
      });
      const payload = result?.data || result;
      if (!payload?.transfer && !payload?.transfers?.length) {
        throw new Error(payload?.error || 'Transferni yaratib bo‘lmadi.');
      }
      clearForm();
      await onSaved();
    } catch (error) {
      alert('Transfer jo‘natilmadi: ' + (error?.response?.data?.error || error?.data?.error || error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && resetAndClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0">
              <ShoppingBasket className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="font-display text-xl">Yangi transfer tayyorlash</DialogTitle>
              <p className="text-sm text-muted-foreground mt-0.5">{source?.name} omboridan do‘konga</p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-secondary/35 p-4">
            <Label className="text-xs mb-1.5 block">Qabul qiluvchi do‘kon</Label>
            <OdinaSelect value={destinationId} onChange={(event) => setDestinationId(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
              <option value="">Do‘konni tanlang</option>
              {destinations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </OdinaSelect>
          </div>

          <div className="grid lg:grid-cols-3 gap-4 items-start">
            <div className="odina-panel lg:col-span-2 rounded-2xl border border-border bg-card p-3 sm:p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div>
                  <p className="font-semibold">Mahsulotlarni tanlang</p>
                  <p className="text-xs text-muted-foreground">Har xil tort va mahsulotlarni bitta transferga qo‘shing.</p>
                </div>
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs whitespace-nowrap">
                  {formatNum(availableProducts.length)} ta mavjud
                </span>
              </div>

              <div className="grid sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <Label className="text-xs mb-1.5 block">Kategoriya</Label>
                  <OdinaSelect value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
                    <option value="all">Barcha kategoriyalar</option>
                    {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </OdinaSelect>
                </div>
                <div>
                  <Label className="text-xs mb-1.5 block">Mahsulot qidirish</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    <Input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Masalan: Almond" className="h-11 pl-9" />
                  </div>
                </div>
              </div>

              {filteredProducts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                  Bu kategoriya yoki qidiruv bo‘yicha qoldiqli mahsulot topilmadi.
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 gap-2 max-h-[300px] overflow-y-auto pr-1">
                  {filteredProducts.map((product) => {
                    const available = Math.floor(Number(stockByProduct[product.id] || 0));
                    const selected = Number(selectedQuantities[product.id] || 0);
                    return (
                      <div key={product.id} className={`rounded-xl border p-3 transition-colors ${selected > 0 ? 'border-primary bg-primary/5' : 'border-border bg-background'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{product.name}</p>
                            <p className="text-xs text-muted-foreground truncate">{product.category_name || 'Kategoriyasiz'}</p>
                          </div>
                          {selected > 0 && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">{formatNum(selected)} {sourceUnitLabel(product)}</span>}
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">Mavjud: <b className="text-foreground">{formatNum(available)} {sourceUnitLabel(product)}</b></span>
                          <Button type="button" size="sm" variant={selected > 0 ? 'outline' : 'secondary'} onClick={() => addProduct(product)} disabled={selected >= available} className="h-8 rounded-lg">
                            <Plus className="w-3.5 h-3.5 mr-1" /> {selected > 0 ? 'Yana' : 'Qo‘shish'}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <aside className="rounded-2xl border border-primary/25 bg-primary/5 p-3 sm:p-4 lg:sticky lg:top-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ShoppingBasket className="w-4 h-4 text-brand-ink" />
                  <p className="font-semibold">Transfer savati</p>
                </div>
                <span className="rounded-full bg-card px-2.5 py-1 text-xs font-semibold">{formatNum(selectedEntries.length)} tur</span>
              </div>

              {selectedEntries.length === 0 ? (
                <div className="py-8 text-center">
                  <ShoppingBasket className="w-8 h-8 mx-auto text-muted-foreground/35 mb-2" />
                  <p className="text-sm text-muted-foreground">Chap tomondan mahsulotlarni qo‘shing.</p>
                </div>
              ) : (
                <div className="mt-3 space-y-2 max-h-[330px] overflow-y-auto pr-1">
                  {selectedEntries.map(({ product, quantity, available }) => (
                    <div key={product.id} className="rounded-xl border border-border bg-card p-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{product.name}</p>
                          <p className="text-[11px] text-muted-foreground">Jo‘natilgach {formatNum(available - quantity)} {sourceUnitLabel(product)} qoladi</p>
                        </div>
                        <button type="button" onClick={() => removeProduct(product.id)} className="w-8 h-8 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex items-center justify-center touch-manipulation" aria-label={`${product.name}ni olib tashlash`}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <p className="mt-2 text-xs font-semibold text-brand-ink">{product.production_unit === 'sheet'
                        ? `${quantity} list → ${quantity * Number(product.pieces_per_sheet || 20)} bo‘lak qabul qilinadi`
                        : `${quantity} dona qabul qilinadi`}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <Button type="button" size="icon" variant="outline" onClick={() => changeQuantity(product.id, quantity - 1)} className="w-9 h-9 rounded-lg shrink-0">
                          <Minus className="w-3.5 h-3.5" />
                        </Button>
                        <Input type="number" inputMode="numeric" min="1" max={available} step="1" value={quantity} onChange={(event) => changeQuantity(product.id, event.target.value)} className="h-9 rounded-lg text-center px-1" />
                        <Button type="button" size="icon" variant="outline" onClick={() => changeQuantity(product.id, quantity + 1)} disabled={quantity >= available} className="w-9 h-9 rounded-lg shrink-0">
                          <Plus className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 pt-3 border-t border-primary/20 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Do‘konda jami</span>
                <span className="font-display text-lg font-bold text-brand-ink">{formatNum(totalQuantity)} dona/bo‘lak</span>
              </div>
            </aside>
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Masalan: ertalabki yetkazib berish" rows={2} />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={resetAndClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={send} disabled={saving || !destinationId || !selectionValid} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            <Send className="w-4 h-4 mr-1.5" />
            {saving
              ? 'Jo‘natilmoqda…'
              : selectedEntries.length > 0
                ? `${formatNum(selectedEntries.length)} tur · ${formatNum(totalQuantity)} dona/bo‘lak jo‘natish`
                : 'Mahsulotlarni tanlang'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Empty({ text }) {
  return (
    <div className="odina-panel rounded-2xl border border-dashed border-border bg-card py-10 text-center">
      <Truck className="w-9 h-9 mx-auto text-muted-foreground/35 mb-2" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

