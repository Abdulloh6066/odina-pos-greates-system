import React from 'react';
import { Activity, ShieldAlert } from 'lucide-react';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';

const SENSITIVE = new Set([
  'owner_pin_updated', 'user_role_changed', 'user_active_toggled', 'staff_invite_requested',
  'sale_refunded', 'refund_issued', 'shift_closed', 'cash_out', 'settings_updated',
]);

const humanAction = (action) => String(action || '').replace(/_/g, ' ');

export default function SecurityAuditFeed({ entries }) {
  return (
    <section className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="w-5 h-5 text-brand-ink" />
        <h2 className="font-display text-lg font-bold">So'nggi xavfsizlik amallari</h2>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">Hozircha jurnal yozuvi yo'q.</p>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin pr-1">
          {entries.map((e) => {
            const sensitive = SENSITIVE.has(e.action);
            return (
              <div key={e.id} className="flex items-start gap-3 p-2.5 rounded-xl bg-secondary/40">
                <div className={'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ' + (sensitive ? 'bg-amber-50 text-amber-700' : 'brand-surface text-brand-ink')}>
                  {sensitive ? <ShieldAlert className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium capitalize">{humanAction(e.action)}</div>
                  <div className="text-[11px] text-muted-foreground">{e.user_name || '—'} · {formatUzbekistanDateTime(e.created_date)}</div>
                  {e.details && <div className="text-xs text-muted-foreground mt-0.5 break-words">{e.details}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground mt-3">To'liq eksport va filtrlash uchun "Nazorat va eksport" sahifasiga o'ting.</p>
    </section>
  );
}