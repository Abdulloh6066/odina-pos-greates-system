import React, { useEffect, useMemo, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import {
  AlertTriangle, Camera, CheckCircle2, Clock3, Image as ImageIcon, Loader2,
  PackageX, Plus, RefreshCw, RotateCcw, Trash2,
} from 'lucide-react';
import { formatNum, formatUZS } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import WasteBatchDialog from '@/components/waste/WasteBatchDialog';
import { wasteDateTime as dateTime } from '@/lib/waste';

const emptyContext = {
  shops: [],
  stock_items: [],
  expired_items: [],
  near_expiry_items: [],
  waste_records: [],
  summary: {},
};

const payloadOf = (result) => result?.data || result || {};
const errorText = (error, fallback) => (
  error?.response?.data?.error || error?.data?.error || error?.message || fallback
);

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
  const [expiryFilter, setExpiryFilter] = useState('expired');

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
      void odinaAlert(errorText(error, 'Chiqit ma’lumotlarini yuklab bo‘lmadi.'));
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

  const locationNearExpiry = useMemo(() => (
    context.near_expiry_items.filter((item) => item.location_id === locationId)
  ), [context.near_expiry_items, locationId]);

  const alertItems = expiryFilter === 'expired' ? locationExpired : locationNearExpiry;

  const locationRecords = useMemo(() => (
    context.waste_records.filter((record) => record.location_id === locationId)
  ), [context.waste_records, locationId]);

  const locationSummary = useMemo(() => ({
    expiredTypes: locationExpired.length,
    nearExpiryQuantity: locationNearExpiry.reduce((sum, item) => sum + Number(item.near_expiry_quantity || 0), 0),
    expiredQuantity: locationExpired.reduce((sum, item) => sum + Number(item.expired_quantity || 0), 0),
    wasteQuantity: locationRecords
      .filter((record) => record.status === 'recorded')
      .reduce((sum, record) => sum + Number(record.quantity || 0), 0),
    wasteValue: locationRecords
      .filter((record) => record.status === 'recorded')
      .reduce((sum, record) => sum + Number(record.total_retail_value || 0), 0),
  }), [locationExpired, locationNearExpiry, locationRecords]);

  const openWaste = (item = null, selectExpired = false) => {
    if (locationStock.length === 0) {
      void odinaAlert('Bu do‘konda chiqitga chiqarish uchun mahsulot qoldig‘i yo‘q.');
      return;
    }
    const selectedItems = selectExpired ? locationExpired : item ? [item] : [];
    if (selectedItems.length > 50) {
      void odinaAlert('Bir martada 50 tagacha tur tanlanadi. Chiqit kiritish oynasidan kerakli mahsulotlarni belgilang.');
      return;
    }
    setPrefill({
      location_id: locationId,
      items: selectedItems.map((entry) => ({
        product_id: entry.product_id,
        quantity: entry.expired_quantity > 0 ? entry.expired_quantity : 1,
        reason_code: entry.expired_quantity > 0 ? 'expired' : 'damaged',
      })),
    });
    setDialogOpen(true);
  };

  const cancelWaste = async (record) => {
    const accepted = await odinaConfirm(
      `${record.product_name_snapshot} — ${formatNum(record.quantity)} dona chiqit yozuvini bekor qilasizmi?`,
      {
        title: 'Chiqitni bekor qilish',
        details: 'Mahsulot do‘kon qoldig‘iga qaytariladi va bekor qilish tarixi saqlanadi.',
        tone: 'warning',
        confirmLabel: 'Qoldiqqa qaytarish',
      },
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
      void odinaAlert(errorText(error, 'Chiqitni bekor qilib bo‘lmadi.'));
    } finally {
      setCancellingId('');
    }
  };

  return (
    <div className="odina-page p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader
        title="Chiqitlar"
        subtitle="Muddat nazorati va mahsulotlarni birgalikda hisobdan chiqarish"
        icon={Trash2}
        actions={(
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => load({ quiet: true })} disabled={refreshing} className="min-h-11 rounded-xl touch-manipulation">
              <RefreshCw className={`w-4 h-4 sm:mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Yangilash</span>
            </Button>
            <Button onClick={() => openWaste()} disabled={loading || !locationStock.length} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
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
              Nazorat muddati — transfer do‘konda qabul qilinganidan 72 soat. Muddati o‘tgan va keyingi 24 soatda tugaydigan qoldiqlar ko‘rsatiladi.
              Hisobdan chiqarish siz mahsulot va miqdorlarni tasdiqlaganingizda bajariladi.
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
            <Metric icon={Clock3} label="24 soat ichida muddat" value={`${formatNum(locationSummary.nearExpiryQuantity)} dona`} />
            <Metric icon={PackageX} label="3 kundan oshgan mahsulot" value={`${formatNum(locationSummary.expiredQuantity)} dona`} danger={locationSummary.expiredQuantity > 0} />
            <Metric icon={Trash2} label="Jami faol chiqit" value={`${formatNum(locationSummary.wasteQuantity)} dona`} />
            <Metric icon={ImageIcon} label="Sotuv narxidagi qiymat" value={formatUZS(locationSummary.wasteValue)} />
          </div>

          <section className="mt-7">
            <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
              <div>
                <p className="odina-page-eyebrow">NAZORAT</p>
                <h2 className="font-display text-xl sm:text-2xl font-bold">Mahsulotlar muddati</h2>
              </div>
              {expiryFilter === 'expired' && locationExpired.length > 0 && (
                <Button variant="outline" onClick={() => openWaste(null, true)} className="min-h-11 rounded-xl">
                  <Trash2 className="w-4 h-4 mr-2" /> Birgalikda chiqarish
                </Button>
              )}
            </div>
            <div role="group" aria-label="Muddat bo‘yicha ro‘yxat" className="flex flex-wrap gap-2 mb-4">
              <Button variant={expiryFilter === 'expired' ? 'default' : 'outline'}
                aria-pressed={expiryFilter === 'expired'} onClick={() => setExpiryFilter('expired')} className="min-h-11 rounded-xl">
                <AlertTriangle className="w-4 h-4 mr-2" /> 3 kundan oshganlar · {locationExpired.length} tur
              </Button>
              <Button variant={expiryFilter === 'soon' ? 'default' : 'outline'}
                aria-pressed={expiryFilter === 'soon'} onClick={() => setExpiryFilter('soon')} className="min-h-11 rounded-xl">
                <Clock3 className="w-4 h-4 mr-2" /> Keyingi 24 soatda · {locationNearExpiry.length} tur
              </Button>
            </div>

            {alertItems.length === 0 ? (
              <div className="odina-panel rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6 text-center">
                <CheckCircle2 className="w-9 h-9 text-emerald-600 mx-auto mb-2" />
                <p className="font-semibold text-emerald-800">
                  {expiryFilter === 'expired' ? '3 kundan oshgan qoldiq yo‘q' : '24 soat ichida muddati tugaydigan qoldiq yo‘q'}
                </p>
                <p className="text-sm text-emerald-700/75 mt-1">Hisob transferning qabul qilingan vaqtiga asoslanadi.</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {alertItems.map((item) => (
                  <div key={`${item.location_id}:${item.product_id}`}
                    className={`odina-panel overflow-hidden rounded-2xl border bg-card premium-shadow ${expiryFilter === 'expired' ? 'border-red-200' : 'border-brand-sand/60'}`}>
                    <div className="flex gap-3 p-4">
                      <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary shrink-0">
                        {item.image_url
                          ? <img src={item.image_url} alt={item.product_name} className="w-full h-full object-contain" />
                          : <div className="w-full h-full flex items-center justify-center text-muted-foreground"><PackageX className="w-6 h-6" /></div>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-semibold break-words">{item.product_name}</h3>
                        <p className={`text-sm font-semibold mt-1 ${expiryFilter === 'expired' ? 'text-red-700' : 'text-brand-ink'}`}>
                          {formatNum(expiryFilter === 'expired' ? item.expired_quantity : item.near_expiry_quantity)} dona
                          {expiryFilter === 'expired' ? ` · ${item.age_days} kun` : ' · muddat yaqin'}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {expiryFilter === 'expired'
                            ? `Qabul: ${dateTime(item.oldest_expired_at)}`
                            : `Muddat: ${dateTime(item.next_expires_at)}`}
                        </p>
                      </div>
                    </div>
                    {expiryFilter === 'expired' && (
                      <div className="px-4 pb-4">
                        <Button onClick={() => openWaste(item)} className="w-full min-h-11 rounded-xl bg-red-600 text-white hover:bg-red-700 touch-manipulation">
                          <Trash2 className="w-4 h-4 mr-1.5" /> Chiqitga chiqarish
                        </Button>
                      </div>
                    )}
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

      <WasteBatchDialog
        open={dialogOpen}
        initial={prefill}
        shops={context.shops}
        stockItems={context.stock_items}
        onUpdated={() => load({ quiet: true })}
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


