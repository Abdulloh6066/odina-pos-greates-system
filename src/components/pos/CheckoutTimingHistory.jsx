import React, { useState } from 'react';
import { Clock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import OdinaSelect from '@/components/ui/odina-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import useCheckoutTimingHistory, { checkoutTimingRecordKey } from '@/hooks/useCheckoutTimingHistory';

const OUTCOMES = {
  confirmed: { label: 'Savdo tasdiqlandi', className: 'bg-emerald-50 text-emerald-800' },
  rechecked: { label: 'Qayta tekshirib tasdiqlandi', className: 'bg-emerald-50 text-emerald-800' },
  queued: { label: 'Qurilmaga saqlash qaydi', className: 'bg-amber-50 text-amber-900' },
  unconfirmed: { label: 'Yakunlash tasdiqlanmadi', className: 'bg-red-50 text-red-800' },
};
const seconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? `${(value / 1000).toFixed(1).replace('.', ',')} soniya` : 'O‘lchov mavjud emas';
const eventTime = (record) => record.received_at || record.client_completed_at;

function TimingResult({ record }) {
  const result = OUTCOMES[record.outcome] || { label: 'Natija noma’lum', className: 'bg-secondary text-muted-foreground' };
  return <span className={`inline-flex rounded-lg px-2 py-1 text-xs font-medium ${result.className}`}>{result.label}</span>;
}

function TimingDuration({ record }) {
  if (!['confirmed', 'rechecked'].includes(record.outcome)) {
    return <p className="text-xs text-muted-foreground">Bu qaydda server tasdig‘i vaqti o‘lchanmagan</p>;
  }
  return <div>
    <p className="font-semibold tabular-nums whitespace-nowrap">{seconds(record.total_ms)}</p>
    {typeof record.api_round_trip_ms === 'number' && Number.isFinite(record.api_round_trip_ms) && record.api_round_trip_ms >= 0
      && <p className="text-xs text-muted-foreground mt-1">So‘rov va javob: {seconds(record.api_round_trip_ms)}</p>}
  </div>;
}

export default function CheckoutTimingHistory({ open, onOpenChange, userRole, shops = [], adminShopScope }) {
  const shopScope = userRole === 'admin' && adminShopScope?.isAdmin ? adminShopScope : null;
  const [localShopId, setShopId] = useState('');
  const shopId = shopScope ? shopScope.specificShopId : localShopId;
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const history = useCheckoutTimingHistory({ open, userRole, shopId, fromDate, toDate });
  if (userRole !== 'admin' && userRole !== 'manager') return null;
  const availableShops = [...new Map((shopScope?.shops || shops || []).filter((shop) => shop?.id)
    .map((shop) => [shop.id, shop])).values()];

  return <Dialog open={open === true} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-4xl max-h-[92dvh]">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Clock className="h-5 w-5 text-brand-ink" /> Xodimlarning yakunlash vaqti</DialogTitle>
        <DialogDescription>Server tasdig‘igacha ketgan vaqt internet va navbatdagi kutishni ham o‘z ichiga oladi. Qurilmaga saqlash server tasdig‘i hisoblanmaydi.</DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl border border-border bg-secondary/30 p-3">
        <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
          <span className="block">Do‘kon</span>
          <OdinaSelect aria-label="Vaqtlar tarixidagi do‘kon" value={shopId} disabled={Boolean(shopScope)} onChange={(event) => shopScope ? shopScope.selectShop(event.target.value || 'all') : setShopId(event.target.value)}>
            <option value="">Barcha do‘konlar</option>
            {shopId && !availableShops.some((shop) => shop.id === shopId) && <option value={shopId}>Tanlangan do‘kon</option>}
            {availableShops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
          </OdinaSelect>
        </label>
        <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
          <span className="block">Qabul sanasi — dan</span>
          <Input aria-label="Qabul sanasi boshlanishi" type="date" value={fromDate} max={toDate || undefined}
            onChange={(event) => setFromDate(event.target.value)} className="min-h-11 rounded-xl bg-card" />
        </label>
        <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
          <span className="block">Qabul sanasi — gacha</span>
          <Input aria-label="Qabul sanasi tugashi" type="date" value={toDate} min={fromDate || undefined}
            onChange={(event) => setToDate(event.target.value)} className="min-h-11 rounded-xl bg-card" />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {history.loading ? 'Vaqtlar tarixi yuklanmoqda…' : `Ko‘rsatilgan: ${history.records.length} ta${history.hasMore ? ' · yana yozuvlar bor' : ''}`}
        </p>
        <Button type="button" variant="outline" className="min-h-11 rounded-xl" disabled={history.loading || history.loadingMore} onClick={history.refresh}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${history.loading ? 'animate-spin' : ''}`} /> Yangilash
        </Button>
      </div>

      {history.error && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{history.error}</p>
        <Button type="button" variant="outline" className="min-h-11 rounded-xl mt-2" onClick={history.retry} disabled={history.loading || history.loadingMore}>Qayta urinish</Button>
      </div>}
      {history.loading ? <div role="status" className="space-y-2 py-2" aria-label="Vaqtlar tarixi yuklanmoqda">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-20 rounded-xl bg-secondary animate-pulse" />)}
      </div> : !history.error && history.records.length === 0 ? <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Tanlangan davrda yuborilgan o‘lchov topilmadi.
      </div> : history.records.length > 0 && <>
        <div className="hidden md:block overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[660px] text-sm">
            <thead className="bg-secondary/60 text-xs text-muted-foreground"><tr>
              <th className="px-3 py-3 text-left font-medium">Xodim va do‘kon</th>
              <th className="px-3 py-3 text-left font-medium">Server tasdig‘igacha</th>
              <th className="px-3 py-3 text-left font-medium">Natija</th>
              <th className="px-3 py-3 text-left font-medium">Qabul vaqti</th>
            </tr></thead>
            <tbody className="divide-y divide-border">{history.records.map((record) => <tr key={checkoutTimingRecordKey(record)}>
              <td className="px-3 py-3"><p className="font-medium break-words">{record.actor_name || 'Xodim nomi yo‘q'}</p><p className="text-xs text-muted-foreground mt-1 break-words">{record.shop_name || 'Do‘kon nomi yo‘q'}</p></td>
              <td className="px-3 py-3"><TimingDuration record={record} /></td>
              <td className="px-3 py-3"><TimingResult record={record} /></td>
              <td className="px-3 py-3 text-xs text-muted-foreground"><time dateTime={eventTime(record)}>{formatUzbekistanDateTime(eventTime(record), { second: '2-digit' })}</time></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="md:hidden space-y-3">{history.records.map((record) => <article key={checkoutTimingRecordKey(record)} className="rounded-xl border border-border p-3.5 space-y-3">
          <div className="min-w-0"><p className="font-semibold break-words">{record.actor_name || 'Xodim nomi yo‘q'}</p><p className="text-xs text-muted-foreground mt-1 break-words">{record.shop_name || 'Do‘kon nomi yo‘q'}</p></div>
          <div className="flex flex-wrap items-start justify-between gap-3"><TimingDuration record={record} /><TimingResult record={record} /></div>
          <p className="text-xs text-muted-foreground">Qabul vaqti: <time dateTime={eventTime(record)}>{formatUzbekistanDateTime(eventTime(record), { second: '2-digit' })}</time></p>
        </article>)}</div>
      </>}
      {history.hasMore && !history.loading && <Button type="button" variant="outline" className="min-h-11 rounded-xl w-full" disabled={history.loadingMore} onClick={history.loadMore}>
        {history.loadingMore ? 'Yuklanmoqda…' : 'Yana yozuvlarni ko‘rsatish'}
      </Button>}
    </DialogContent>
  </Dialog>;
}
