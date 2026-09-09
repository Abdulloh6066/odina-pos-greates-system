import React, { useEffect, useMemo, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import {
  AlertTriangle, Camera, CheckCircle2, Clock3, Image as ImageIcon, Loader2,
  PackageX, Plus, RefreshCw, RotateCcw, Trash2,
} from 'lucide-react';
import { formatNum, formatUZS } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

const REASONS = [
  { value: 'expired', label: '3 kundan oshgan' },
  { value: 'damaged', label: 'Shikastlangan' },
  { value: 'quality', label: 'Sifati buzilgan' },
  { value: 'other', label: 'Boshqa sabab' },
];

const emptyContext = {
  shops: [],
  stock_items: [],
  expired_items: [],
  waste_records: [],
  summary: {},
};

const payloadOf = (result) => result?.data || result || {};
const errorText = (error, fallback) => (
  error?.response?.data?.error || error?.data?.error || error?.message || fallback
);

const dateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uz-UZ', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

export default function Waste() {
  const { user } = useOutletContext();
  const role = user?.role || 'cashier';
  const canCancel = role === 'admin' || role === 'manager';
  const [context, setContext] = useState(emptyContext);
  const [locationId, setLocationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [prefill, setPrefill] = useState(null);
  const [cancellingId, setCancellingId] = useState('');

  const load = async ({ quiet = false } = {}) => {
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      const result = await base44.functions.invoke('waste-ledger', { action: 'get_context' });
      const next = payloadOf(result);
      if (next?.error) throw new Error(next.error);
      setContext({ ...emptyContext, ...next });
      setLocationId((current) => {
        if (current && next.shops?.some((shop) => shop.id === current)) return current;
        return next.shops?.[0]?.id || '';
      });
    } catch (error) {
      alert(errorText(error, 'Chiqit ma’lumotlarini yuklab bo‘lmadi.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { if (user) load(); }, [user?.id]);

  const locationStock = useMemo(() => (
    context.stock_items.filter((item) => item.location_id === locationId)
      .sort((a, b) => String(a.product_name).localeCompare(String(b.product_name)))
  ), [context.stock_items, locationId]);

  const locationExpired = useMemo(() => (
    context.expired_items.filter((item) => item.location_id === locationId)
  ), [context.expired_items, locationId]);

  const locationRecords = useMemo(() => (
    context.waste_records.filter((record) => record.location_id === locationId)
  ), [context.waste_records, locationId]);

  const locationSummary = useMemo(() => ({
    expiredTypes: locationExpired.length,
    expiredQuantity: locationExpired.reduce((sum, item) => sum + Number(item.expired_quantity || 0), 0),
    wasteQuantity: locationRecords
      .filter((record) => record.status === 'recorded')
      .reduce((sum, record) => sum + Number(record.quantity || 0), 0),
    wasteValue: locationRecords
      .filter((record) => record.status === 'recorded')
      .reduce((sum, record) => sum + Number(record.total_retail_value || 0), 0),
  }), [locationExpired, locationRecords]);

  const openWaste = (item = null) => {
    if (!item && locationStock.length === 0) {
      alert('Bu do‘konda chiqitga chiqarish uchun mahsulot qoldig‘i yo‘q.');
      return;
    }
    setPrefill(item ? {
      location_id: item.location_id,
      product_id: item.product_id,
      quantity: String(Math.max(1, Number(item.expired_quantity || 1))),
      reason_code: 'expired',
    } : {
      location_id: locationId,
      product_id: locationStock[0]?.product_id || '',
      quantity: '1',
      reason_code: 'damaged',
    });
    setDialogOpen(true);
  };

  const cancelWaste = async (record) => {
    const accepted = window.confirm(
      `${record.product_name_snapshot} — ${formatNum(record.quantity)} dona chiqit yozuvini bekor qilasizmi?\n\nMahsulot do‘kon qoldig‘iga qaytariladi va bekor qilish tarixi saqlanadi.`,
    );
    if (!accepted) return;
    setCancellingId(record.id);
    try {
      const result = await base44.functions.invoke('waste-ledger', {
        action: 'cancel_waste',
        waste_id: record.id,
      });
      const payload = payloadOf(result);
      if (payload?.error) throw new Error(payload.error);
      await load({ quiet: true });
    } catch (error) {
      alert(errorText(error, 'Chiqitni bekor qilib bo‘lmadi.'));
    } finally {
      setCancellingId('');
    }
  };

  return (
    <div className="odina-page p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader
        title="Chiqitlar"
        subtitle="Do‘kondagi tayyor mahsulotlar va 3 kunlik nazorat"
        icon={Trash2}
        actions={(
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => load({ quiet: true })} disabled={refreshing} className="min-h-11 rounded-xl touch-manipulation">
              <RefreshCw className={`w-4 h-4 sm:mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Yangilash</span>
            </Button>
            <Button onClick={() => openWaste()} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
              <Plus className="w-4 h-4 mr-1.5" /> Chiqit kiritish
            </Button>
          </div>
        )}
      />

      <div className="odina-panel rounded-2xl border border-brand-sand/45 bg-brand-sand/15 p-4 sm:p-5 premium-shadow mb-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/25 text-brand-ink flex items-center justify-center shrink-0">
            <Clock3 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-semibold">3 kunlik mahsulot nazorati</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Transfer do‘konda qabul qilinganidan 72 soat o‘tgach qolgan mahsulot bu yerda ogohlantirish sifatida chiqadi.
              Masalliqlar va markaziy ombordagi mahsulotlar avtomatik chiqit hisoblanmaydi.
            </p>
          </div>
        </div>
      </div>

      {context.shops.length > 1 && (
        <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 mb-5">
          <Label htmlFor="waste-location" className="text-xs mb-1.5 block">Do‘kon</Label>
          <OdinaSelect
            id="waste-location"
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            className="w-full sm:max-w-sm h-11 rounded-xl border border-input bg-background px-3 text-sm font-medium"
          >
            {context.shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
          </OdinaSelect>
        </div>
      )}

      {loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <Metric icon={AlertTriangle} label="3 kundan oshgan turlar" value={`${formatNum(locationSummary.expiredTypes)} ta`} danger={locationSummary.expiredTypes > 0} />
            <Metric icon={PackageX} label="3 kundan oshgan mahsulot" value={`${formatNum(locationSummary.expiredQuantity)} dona`} danger={locationSummary.expiredQuantity > 0} />
            <Metric icon={Trash2} label="Jami faol chiqit" value={`${formatNum(locationSummary.wasteQuantity)} dona`} />
            <Metric icon={ImageIcon} label="Sotuv narxidagi qiymat" value={formatUZS(locationSummary.wasteValue)} />
          </div>

          <section className="mt-7">
            <div className="flex items-end justify-between gap-3 mb-3">
              <div>
                <p className="odina-page-eyebrow">NAZORAT</p>
                <h2 className="font-display text-xl sm:text-2xl font-bold">3 kundan oshganlar</h2>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${locationExpired.length ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
                {locationExpired.length ? `${locationExpired.length} tur` : 'Hammasi joyida'}
              </span>
            </div>

            {locationExpired.length === 0 ? (
              <div className="odina-panel rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6 text-center">
                <CheckCircle2 className="w-9 h-9 text-emerald-600 mx-auto mb-2" />
                <p className="font-semibold text-emerald-800">3 kundan oshgan qoldiq yo‘q</p>
                <p className="text-sm text-emerald-700/75 mt-1">Yangi transferlar qabul qilingan vaqt bo‘yicha avtomatik tekshiriladi.</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {locationExpired.map((item) => (
                  <div key={`${item.location_id}:${item.product_id}`} className="odina-panel overflow-hidden rounded-2xl border border-red-200 bg-card premium-shadow">
                    <div className="flex gap-3 p-4">
                      <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary shrink-0">
                        {item.image_url
                          ? <img src={item.image_url} alt={item.product_name} className="w-full h-full object-cover" />
                          : <div className="w-full h-full flex items-center justify-center text-red-400"><PackageX className="w-6 h-6" /></div>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-semibold truncate">{item.product_name}</h3>
                        <p className="text-sm text-red-700 font-semibold mt-1">{formatNum(item.expired_quantity)} dona · {item.age_days} kun</p>
                        <p className="text-xs text-muted-foreground mt-1">Qabul: {dateTime(item.oldest_expired_at)}</p>
                      </div>
                    </div>
                    <div className="px-4 pb-4">
                      <Button onClick={() => openWaste(item)} className="w-full min-h-11 rounded-xl bg-red-600 text-white hover:bg-red-700 touch-manipulation">
                        <Trash2 className="w-4 h-4 mr-1.5" /> Chiqitga chiqarish
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-8">
            <div className="mb-3">
              <p className="odina-page-eyebrow">TARIX</p>
              <h2 className="font-display text-xl sm:text-2xl font-bold">Chiqit yozuvlari</h2>
            </div>
            {locationRecords.length === 0 ? (
              <div className="odina-panel rounded-2xl border border-dashed border-border bg-card p-10 text-center text-muted-foreground">
                <Trash2 className="w-9 h-9 mx-auto mb-2 opacity-35" />
                <p className="text-sm">Hali chiqit yozuvi yo‘q.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {locationRecords.map((record) => (
                  <WasteRow
                    key={record.id}
                    record={record}
                    canCancel={canCancel}
                    cancelling={cancellingId === record.id}
                    onCancel={() => cancelWaste(record)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <WasteDialog
        open={dialogOpen}
        initial={prefill}
        shops={context.shops}
        stockItems={context.stock_items}
        role={role}
        onClose={() => setDialogOpen(false)}
        onSaved={async () => {
          setDialogOpen(false);
          await load({ quiet: true });
        }}
      />
    </div>
  );
}

function Metric({ icon: Icon, label, value, danger = false }) {
  return (
    <div className={`odina-panel rounded-2xl border p-4 sm:p-5 premium-shadow ${danger ? 'border-red-200 bg-red-50/60' : 'border-border bg-card'}`}>
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${danger ? 'bg-red-100 text-red-700' : 'bg-primary/15 text-brand-ink'}`}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <div className="text-[11px] sm:text-xs uppercase tracking-wide text-muted-foreground mb-1">{label}</div>
      <div className={`font-display text-lg sm:text-xl font-bold leading-tight ${danger ? 'text-red-800' : ''}`}>{value}</div>
    </div>
  );
}

function WasteRow({ record, canCancel, cancelling, onCancel }) {
  const cancelled = record.status === 'cancelled';
  return (
    <div className={`odina-panel rounded-2xl border bg-card premium-shadow p-4 ${cancelled ? 'border-border opacity-70' : 'border-border'}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary shrink-0">
          {record.photo_url
            ? <img src={record.photo_url} alt="Chiqit rasmi" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-muted-foreground/35"><Camera className="w-6 h-6" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{record.product_name_snapshot}</h3>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${cancelled ? 'bg-secondary text-muted-foreground' : 'bg-red-50 text-red-700'}`}>
              {cancelled ? 'Bekor qilingan' : `${formatNum(record.quantity)} dona`}
            </span>
          </div>
          <p className="text-sm text-foreground/75 mt-1">{record.reason_label}</p>
          {record.notes && <p className="text-sm text-muted-foreground mt-1 break-words">{record.notes}</p>}
          <p className="text-xs text-muted-foreground mt-2">
            {record.recorded_by_name} · {dateTime(record.recorded_at)} · {record.waste_number}
          </p>
          {cancelled && (
            <p className="text-xs text-muted-foreground mt-1">
              {record.cancelled_by_name} tomonidan {dateTime(record.cancelled_at)} da qoldiqqa qaytarilgan
            </p>
          )}
        </div>
        <div className="sm:text-right shrink-0">
          <div className="font-semibold">{formatUZS(record.total_retail_value)}</div>
          <div className="text-xs text-muted-foreground">sotuv narxida</div>
          {canCancel && !cancelled && (
            <Button variant="outline" onClick={onCancel} disabled={cancelling} className="mt-3 min-h-10 rounded-xl text-sm touch-manipulation">
              {cancelling ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1.5" />}
              Xato yozuvni bekor qilish
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function WasteDialog({ open, initial, shops, stockItems, role, onClose, onSaved }) {
  const [locationId, setLocationId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reasonCode, setReasonCode] = useState('damaged');
  const [notes, setNotes] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLocationId(initial?.location_id || shops[0]?.id || '');
    setProductId(initial?.product_id || '');
    setQuantity(initial?.quantity || '1');
    setReasonCode(initial?.reason_code || 'damaged');
    setNotes('');
    setPhotoUrl('');
  }, [open, initial, shops]);

  const items = useMemo(() => (
    stockItems.filter((item) => item.location_id === locationId)
      .sort((a, b) => String(a.product_name).localeCompare(String(b.product_name)))
  ), [stockItems, locationId]);

  useEffect(() => {
    if (!open || (productId && items.some((item) => item.product_id === productId))) return;
    setProductId(items[0]?.product_id || '');
  }, [open, locationId, items, productId]);

  const selected = items.find((item) => item.product_id === productId);

  useEffect(() => {
    if (!selected) return;
    if (reasonCode === 'expired' && !selected.expired_quantity) setReasonCode('damaged');
    if (Number(quantity) > Number(selected.quantity || 0)) setQuantity('1');
  }, [selected?.product_id, selected?.quantity, selected?.expired_quantity, reasonCode, quantity]);

  const uploadPhoto = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setPhotoUrl(file_url || '');
    } catch (error) {
      alert(errorText(error, 'Rasmni yuklab bo‘lmadi.'));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const save = async () => {
    if (!locationId || !productId || !Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
      alert('Do‘kon, mahsulot va musbat butun dona sonini kiriting.');
      return;
    }
    setSaving(true);
    try {
      const result = await base44.functions.invoke('waste-ledger', {
        action: 'create_waste',
        location_id: locationId,
        product_id: productId,
        quantity: Number(quantity),
        reason_code: reasonCode,
        notes: notes.trim() || undefined,
        photo_url: photoUrl || undefined,
      });
      const payload = payloadOf(result);
      if (!payload?.waste) throw new Error(payload?.error || 'Chiqitni saqlab bo‘lmadi.');
      await onSaved();
    } catch (error) {
      alert(errorText(error, 'Chiqitni saqlab bo‘lmadi.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Chiqit kiritish</DialogTitle>
          <DialogDescription>
            Faqat do‘kondagi tayyor mahsulot qoldig‘i kamayadi. Owner PIN kerak emas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {role !== 'cashier' && shops.length > 1 && (
            <div>
              <Label className="text-xs mb-1.5 block">Do‘kon</Label>
              <OdinaSelect
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                className="w-full h-11 rounded-xl border border-input bg-background px-3 text-sm"
              >
                {shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
              </OdinaSelect>
            </div>
          )}

          <div>
            <Label className="text-xs mb-1.5 block">Mahsulot</Label>
            <OdinaSelect
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              className="w-full h-11 rounded-xl border border-input bg-background px-3 text-sm"
            >
              {items.length === 0 && <option value="">Qoldiq mavjud emas</option>}
              {items.map((item) => (
                <option key={item.product_id} value={item.product_id}>
                  {item.product_name} · {formatNum(item.quantity)} dona
                </option>
              ))}
            </OdinaSelect>
            {selected && (
              <p className="text-xs text-muted-foreground mt-1.5">
                Mavjud: {formatNum(selected.quantity)} dona
                {selected.expired_quantity > 0 ? ` · 3 kundan oshgan: ${formatNum(selected.expired_quantity)} dona` : ''}
              </p>
            )}
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs mb-1.5 block">Miqdor (dona)</Label>
              <Input type="number" min="1" step="1" max={selected?.quantity || undefined} value={quantity} onChange={(event) => setQuantity(event.target.value)} className="h-11" />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Sabab</Label>
              <OdinaSelect value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-background px-3 text-sm">
                {REASONS.map((reason) => (
                  <option key={reason.value} value={reason.value} disabled={reason.value === 'expired' && !selected?.expired_quantity}>
                    {reason.label}
                  </option>
                ))}
              </OdinaSelect>
            </div>
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} placeholder="Masalan: qadoqlash vaqtida shikastlandi" className="min-h-24" />
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Rasm (ixtiyoriy)</Label>
            <div className="flex flex-col sm:flex-row gap-3">
              <label className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-medium cursor-pointer hover:bg-secondary transition-colors touch-manipulation">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                {uploading ? 'Yuklanmoqda…' : photoUrl ? 'Boshqa rasm' : 'Rasm yuklash'}
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={uploadPhoto} disabled={uploading || saving} />
              </label>
              {photoUrl && (
                <div className="flex items-center gap-3 min-w-0 rounded-xl bg-secondary/70 p-2">
                  <img src={photoUrl} alt="Chiqit rasmi" className="w-12 h-12 rounded-lg object-cover" />
                  <span className="text-xs text-emerald-700 font-medium">Rasm tayyor</span>
                  <button type="button" onClick={() => setPhotoUrl('')} className="ml-auto min-h-10 px-3 text-xs text-muted-foreground hover:text-foreground">Olib tashlash</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving || uploading}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving || uploading || !selected} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Trash2 className="w-4 h-4 mr-1.5" />}
            {saving ? 'Saqlanmoqda…' : 'Chiqitga chiqarish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
