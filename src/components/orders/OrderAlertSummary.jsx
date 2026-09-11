import React from 'react';
import { AlertTriangle, Clock, Wallet, ChevronRight } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

function Chip({ icon: Icon, label, value, cls }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-full border px-2.5 py-1 ${cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {label}
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

function AlertRow({ alert, onOpen }) {
  const { order, deadline, unpaid } = alert;
  return (
    <button
      type="button"
      onClick={() => onOpen(order)}
      className="w-full text-left rounded-xl border border-border bg-card p-3 hover:bg-secondary/40 hover:border-brand-olive/40 transition-colors touch-manipulation flex items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm truncate">{order.order_number}</span>
          <span className="text-xs text-muted-foreground truncate">{order.customer_name}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {order.required_date} · {order.required_time}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0 max-w-[60%]">
        {deadline.kind === 'overdue' && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-100 border border-rose-200 rounded-full px-2 py-0.5">
            <AlertTriangle className="w-3 h-3" /> Kechikdi
          </span>
        )}
        {deadline.kind === 'due_soon' && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
            <Clock className="w-3 h-3" /> 1 soatdan kam qoldi
          </span>
        )}
        {unpaid && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-ink bg-brand-olive/15 border border-brand-olive/30 rounded-full px-2 py-0.5">
            <Wallet className="w-3 h-3" /> Qolgan to‘lov: {formatUZS(order.remaining_balance)}
          </span>
        )}
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </div>
    </button>
  );
}

// Compact alert summary with counts. Clicking an alert opens the existing order
// detail dialog (via onOpen). Alerts never mutate order status, payments or
// stock — they are read-only.
export default function OrderAlertSummary({ alerts, counts, onOpen, loading }) {
  if (loading && !counts.total) return null;
  if (!counts.total) return null;
  return (
    <div className="rounded-2xl border border-border bg-card premium-shadow p-4 mb-5 animate-fade-in">
      <div className="flex items-start gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-1.5 shrink-0">
          <AlertTriangle className="w-4 h-4 text-brand-olive" />
          <h3 className="text-sm font-semibold">Buyurtma ogohlantirishlari</h3>
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          <Chip icon={AlertTriangle} label="Kechikdi" value={counts.overdue} cls="bg-rose-100 text-rose-700 border-rose-200" />
          <Chip icon={Clock} label="1 soatdan kam" value={counts.due_soon} cls="bg-amber-100 text-amber-700 border-amber-200" />
          <Chip icon={Wallet} label="Qolgan to‘lov" value={counts.unpaid} cls="bg-brand-olive/15 text-brand-ink border-brand-olive/30" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-[420px] overflow-y-auto scrollbar-thin pr-1">
        {alerts.map((a) => (
          <AlertRow key={a.order.id} alert={a} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}