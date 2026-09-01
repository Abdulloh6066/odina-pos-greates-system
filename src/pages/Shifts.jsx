import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Clock, CheckCircle2, PlayCircle } from 'lucide-react';
import { formatUZS, formatNum, canAccess } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';

export default function Shifts() {
  const { user } = useOutletContext();
  const role = user?.role || 'cashier';
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const all = await base44.entities.Shift.list('-opened_at', 200);
    setShifts(all || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    if (role === 'cashier') return shifts.filter((s) => s.user_id === user?.id);
    return shifts;
  }, [shifts, role, user]);

  const open = visible.filter((s) => s.status === 'open');
  const closed = visible.filter((s) => s.status === 'closed');

  return (
    <div className="p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader title="Shifts" subtitle={role === 'cashier' ? 'Your shift history' : 'All shop shifts'} icon={Clock} />

      {loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-44 rounded-2xl bg-secondary animate-pulse" />)}
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5"><PlayCircle className="w-4 h-4 text-emerald-600" /> Open now</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {open.map((s) => <ShiftCard key={s.id} shift={s} />)}
              </div>
            </div>
          )}
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Closed</h2>
          {closed.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center">No closed shifts yet.</p>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {closed.map((s) => <ShiftCard key={s.id} shift={s} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ShiftCard({ shift }) {
  const opened = new Date(shift.opened_at || shift.created_date);
  const diff = shift.difference || 0;
  return (
    <div className="rounded-2xl bg-card border border-border premium-shadow p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">{shift.shop_name}</div>
          <div className="text-xs text-muted-foreground">{shift.user_name}</div>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${shift.status === 'open' ? 'bg-emerald-50 text-emerald-700' : 'bg-secondary text-muted-foreground'}`}>
          {shift.status === 'open' ? 'Open' : 'Closed'}
        </span>
      </div>
      <div className="text-xs text-muted-foreground mb-3">
        {opened.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        {shift.closed_at && ` → ${new Date(shift.closed_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Cell label="Total" value={formatUZS(shift.total_sales)} bold />
        <Cell label="Orders" value={formatNum(shift.order_count)} />
        <Cell label="Cash" value={formatUZS(shift.cash_sales)} />
        <Cell label="Online" value={formatUZS(shift.online_sales)} />
        <Cell label="Uzcard" value={formatUZS(shift.uzcard_sales)} />
        <Cell label="Humo" value={formatUZS(shift.humo_sales)} />
      </div>
      {shift.status === 'closed' && (
        <div className={`mt-3 text-sm font-medium px-3 py-2 rounded-xl ${diff === 0 ? 'bg-emerald-50 text-emerald-700' : diff > 0 ? 'bg-primary/10 text-primary-strong' : 'bg-red-50 text-destructive'}`}>
          Cash diff: {diff > 0 ? '+' : ''}{formatUZS(diff)}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value, bold }) {
  return (
    <div className="flex items-center justify-between bg-secondary/50 rounded-lg px-2.5 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold' : 'font-medium'}>{value}</span>
    </div>
  );
}