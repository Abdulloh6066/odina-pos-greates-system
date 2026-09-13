import React, { useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock, Edit3, Loader2, PackageCheck, Send, Truck, XOctagon, Warehouse,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { demandStatus, displayDate, remainingForItem, unitLabel } from '@/lib/shop-demand';
import { formatNum } from '@/lib/pos';
import { formatUzbekistanDateTime, uzbekistanDateKey } from '@/lib/uzbekistan-time';
import ShopDemandSendDialog from '@/components/shop-demand/ShopDemandSendDialog';

function urgencyBadge(request) {
  if (!request?.required_date) return null;
  const req = String(request.required_date).replace(/-/g, '');
  const today = uzbekistanDateKey().replace(/-/g, '');
  if (req < today) {
    return <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700 bg-rose-100 border border-rose-200 rounded-full px-2 py-0.5"><AlertTriangle className="w-3 h-3" /> Muddati o'tgan</span>;
  }
  const reqMs = new Date(`${request.required_date}T00:00:00+05:00`).getTime();
  if (Number.isFinite(reqMs) && (reqMs - Date.now()) / 3600000 <= 24) {
    return <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5"><Clock className="w-3 h-3" /> Shoshilinch</span>;
  }
  return null;
}

export default function ShopDemandCard({ request, user, actions }) {
  const items = request.items || [];
  const role = user?.role;
  const shopId = user?.shop_id || user?.data?.shop_id;
  const [sendOpen, setSendOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = demandStatus(request.status);
  const canEditNow = request.status === 'yangi' && (role === 'admin' || request.shop_id === shopId);
  const canAccept = (role === 'admin' || role === 'production') && request.status === 'yangi';
  const canProgress = (role === 'admin' || role === 'production')
    && ['qabul_qilindi', 'tayyorlanmoqda'].includes(request.status);
  const canSendNow = role === 'admin' && ['qabul_qilindi', 'tayyorlanmoqda', 'tayyor'].includes(request.status);
  const hasRemaining = items.some((it) => remainingForItem(it) > 0);

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <article className="odina-panel rounded-2xl border border-border bg-card premium-shadow overflow-hidden">
      <div className="p-4 sm:p-5 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display text-base sm:text-lg font-semibold">{request.request_number}</span>
              <span className="inline-flex items-center gap-1 text-xs font-medium bg-secondary text-muted-foreground rounded-full px-2 py-0.5">
                <Warehouse className="w-3 h-3" /> {request.shop_name_snapshot || '—'}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="w-4 h-4 text-brand-olive shrink-0" />
              <span className="font-medium text-foreground">{displayDate(request.required_date)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {urgencyBadge(request)}
            <span className={`inline-flex flex-col items-end text-xs font-medium rounded-full px-2.5 py-1 border ${status.tone}`}>
              <span>{status.label}</span>
              {status.subtitle && <span className="text-[10px] opacity-80 -mt-0.5">{status.subtitle}</span>}
            </span>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-5 pb-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground text-left">
              <th className="font-semibold py-1.5 pr-2">Mahsulot</th>
              <th className="font-semibold py-1.5 px-2 text-right">Talab</th>
              <th className="font-semibold py-1.5 px-2 text-right">Yuborildi</th>
              <th className="font-semibold py-1.5 px-2 text-right">Qoldi</th>
              <th className="font-semibold py-1.5 pl-2 text-right">Qabul</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {items.map((it) => {
              const rem = remainingForItem(it);
              return (
                <tr key={it.id}>
                  <td className="py-2 pr-2">
                    <div className="font-medium truncate max-w-[180px]">{it.product_name_snapshot}</div>
                    {it.category_name_snapshot && <div className="text-[11px] text-muted-foreground truncate">{it.category_name_snapshot}</div>}
                  </td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">{formatNum(it.requested_quantity)} {unitLabel(it.unit)}</td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">{formatNum(it.sent_quantity)} {unitLabel(it.unit)}</td>
                  <td className={`py-2 px-2 text-right whitespace-nowrap font-semibold ${rem > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{formatNum(rem)} {unitLabel(it.unit)}</td>
                  <td className="py-2 pl-2 text-right whitespace-nowrap text-muted-foreground">{formatNum(it.received_quantity)} dona</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {request.notes && (
        <div className="mx-4 sm:mx-5 mb-3 rounded-xl bg-secondary/50 border border-border p-2.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Izoh</div>
          <div className="text-sm leading-snug whitespace-pre-wrap">{request.notes}</div>
        </div>
      )}

      <div className="px-4 sm:px-5 pb-3 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
        <span>Yaratdi: {request.creator_name || '—'}</span>
        {request.accepted_by_name && <span>Qabul: {request.accepted_by_name}</span>}
        {request.sent_at && <span>Yuborildi: {formatUzbekistanDateTime(request.sent_at)}</span>}
      </div>

      <div className="border-t border-border bg-secondary/20 px-4 sm:px-5 py-3 flex flex-wrap gap-2">
        {canAccept && (
          <Button size="sm" onClick={() => run(() => actions.accept(request.id))} disabled={busy} className="min-h-10 rounded-xl bg-blue-600 text-white hover:bg-blue-700 touch-manipulation">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Qabul qilish
          </Button>
        )}
        {canProgress && request.status === 'qabul_qilindi' && (
          <>
            <Button size="sm" variant="outline" onClick={() => run(() => actions.progress(request.id, 'tayyorlanmoqda'))} disabled={busy} className="min-h-10 rounded-xl touch-manipulation">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />} Tayyorlanmoqda
            </Button>
            <Button size="sm" variant="outline" onClick={() => run(() => actions.progress(request.id, 'tayyor'))} disabled={busy} className="min-h-10 rounded-xl touch-manipulation">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Tayyor
            </Button>
          </>
        )}
        {canProgress && request.status === 'tayyorlanmoqda' && (
          <Button size="sm" variant="outline" onClick={() => run(() => actions.progress(request.id, 'tayyor'))} disabled={busy} className="min-h-10 rounded-xl touch-manipulation">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Tayyor
          </Button>
        )}
        {canSendNow && (
          <Button size="sm" onClick={() => setSendOpen(true)} disabled={busy || !hasRemaining} className="min-h-10 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            <Send className="w-4 h-4" /> {hasRemaining ? 'Yuborish' : 'To\'liq yuborilgan'}
          </Button>
        )}
        {canEditNow && (
          <>
            <Button size="sm" variant="outline" onClick={() => actions.onEdit(request)} disabled={busy} className="min-h-10 rounded-xl touch-manipulation">
              <Edit3 className="w-4 h-4" /> Tahrirlash
            </Button>
            <Button size="sm" variant="outline" onClick={() => run(() => actions.cancel(request.id))} disabled={busy} className="min-h-10 rounded-xl text-rose-700 hover:bg-rose-50 touch-manipulation">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <XOctagon className="w-4 h-4" />} Bekor qilish
            </Button>
          </>
        )}
        {request.status === 'yuborildi' && (
          <span className="inline-flex items-center gap-1 text-xs text-indigo-700 px-1"><Truck className="w-4 h-4" /> Do'kon qabul qilishini kutilmoqda</span>
        )}
        {request.status === 'qabul_qilingan' && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 px-1"><PackageCheck className="w-4 h-4" /> Do'kon qabul qildi</span>
        )}
      </div>

      {canSendNow && (
        <ShopDemandSendDialog
          open={sendOpen}
          onClose={() => setSendOpen(false)}
          request={request}
          onSend={actions.send}
        />
      )}
    </article>
  );
}