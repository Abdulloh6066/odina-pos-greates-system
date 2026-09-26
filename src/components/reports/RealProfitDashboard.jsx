import React, { useEffect, useMemo, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatNum, formatUZS, tashkentDateKey } from '@/lib/pos';
import { TrendingUp, Calendar, CalendarRange, RefreshCw } from 'lucide-react';

function StatCard({ label, value, sub, tone }) {
  const toneClass = tone === 'profit' ? 'text-emerald-600' : tone === 'cost' ? 'text-destructive' : 'text-foreground';
  return (
    <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-display text-2xl font-bold mt-1 tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export default function RealProfitDashboard({ onData } = {}) {
  const today = tashkentDateKey();
  const [mode, setMode] = useState('range'); // 'day' | 'range'
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState(() => tashkentDateKey(new Date(Date.now() - 6 * 86400000)));
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const requestVersion = useRef(0);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  useEffect(() => () => { requestVersion.current += 1; }, []);

  const fetchData = async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setErr('');
    try {
      const dateFrom = mode === 'day' ? day : from;
      const dateTo = mode === 'day' ? day : to;
      const res = await base44.functions.invoke('daily-sales-export', {
        action: 'range',
        date_from: dateFrom,
        date_to: dateTo,
      });
      if (version !== requestVersion.current) return;
      setData(res.data || null);
      onDataRef.current?.(res.data || null);
    } catch (e) {
      if (version !== requestVersion.current) return;
      setErr(e?.response?.data?.error || e?.message || 'Hisobni yuklab bo‘lmadi.');
      setData(null);
      onDataRef.current?.(null);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };

  useEffect(() => {
    // A short debounce prevents a request for every intermediate date edit.
    const timer = window.setTimeout(fetchData, 250);
    return () => { window.clearTimeout(timer); requestVersion.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, day, from, to]);

  const quickRange = (days) => {
    setMode('range');
    setTo(today);
    setFrom(tashkentDateKey(new Date(Date.now() - (days - 1) * 86400000)));
  };

  const grand = data?.grand || { revenue: 0, cost: 0, profit: 0, sales: 0, refunds: 0 };
  const margin = grand.revenue > 0 ? Math.round((grand.profit / grand.revenue) * 100) : 0;

  const shopsSorted = useMemo(() => {
    const list = (data?.shops || []).slice();
    list.sort((a, b) => (b.totals.profit || 0) - (a.totals.profit || 0));
    return list;
  }, [data]);

  const byDay = data?.byDay || [];
  const showTrend = byDay.length > 1;

  return (
    <div className="space-y-5">
      <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="font-display text-lg font-bold flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-brand-olive" /> Pul tushumi va Kassa foydasi
          </h3>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-xl border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setMode('day')}
                className={`inline-flex items-center gap-1.5 px-3 h-9 text-sm font-medium transition-colors ${mode === 'day' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}
              >
                <Calendar className="w-4 h-4" /> Kunlik
              </button>
              <button
                type="button"
                onClick={() => setMode('range')}
                className={`inline-flex items-center gap-1.5 px-3 h-9 text-sm font-medium transition-colors ${mode === 'range' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}
              >
                <CalendarRange className="w-4 h-4" /> Diyapazon
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
              <RefreshCw className="w-4 h-4" /> Yangilash
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {mode === 'day' ? (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Sana</label>
              <Input type="date" max={today} value={day} onChange={(e) => setDay(e.target.value)} className="w-44 h-10" />
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Boshlanish</label>
                <Input type="date" max={today} value={from} onChange={(e) => setFrom(e.target.value)} className="w-40 h-10" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Tugash</label>
                <Input type="date" max={today} value={to} onChange={(e) => setTo(e.target.value)} className="w-40 h-10" />
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={() => quickRange(7)}>7 kun</Button>
                <Button variant="outline" size="sm" onClick={() => quickRange(30)}>30 kun</Button>
              </div>
            </>
          )}
        </div>
      </div>

      {err && (
        <div className="odina-panel rounded-2xl bg-destructive/10 border border-destructive/30 p-4 text-sm text-destructive">
          {err}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Jami olingan pul" value={formatUZS(grand.collections ?? grand.revenue)} sub="Kassa sof savdo + buyurtma to‘lovlari" />
        <StatCard label="Buyurtma to‘lovlari" value={formatUZS(grand.orderPayments || 0)} sub="Avans va qoldiq — pul olingan kuni" />
        <StatCard label="Kassa sof savdo" value={formatUZS(grand.revenue)} sub={`${grand.sales} ta savdo · ${grand.refunds} ta qaytar`} />
        <StatCard label="Kassa yalpi foyda" value={grand.unknownCostCount > 0 ? 'Taxminiy: ' + formatUZS(grand.profit) : formatUZS(grand.profit)} tone="profit" sub={`Tannarx: ${formatUZS(grand.cost)} · marja ${margin}%`} />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Buyurtma to‘lovlari foydaga qayta qo‘shilmaydi. Kassa yalpi foydasidan do‘kon xarajatlari ayrilmagan.
        {' '}Xarajatlar: {formatUZS(grand.expenses || 0)}.
        {' '}Kassa foydasi − do‘kon xarajatlari: {formatUZS(grand.netProfit ?? grand.profit)}.
        {grand.unknownCostCount > 0 && ' Ayrim tannarxlar noma’lum yoki taxminiy; ko‘rsatilgan foyda to‘liq emas.'}
      </p>

      {showTrend && (
        <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5">
          <h3 className="font-display text-lg font-bold mb-4">Kunlik Kassa savdosi, tannarxi va yalpi foydasi</h3>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={byDay} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
              <Tooltip
                formatter={(v) => formatUZS(v)}
                contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))' }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="revenue" name="Tushum" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="cost" name="Tannarx" fill="hsl(var(--brand-olive))" radius={[4, 4, 0, 0]} />
              <Line type="monotone" dataKey="profit" name="Foyda" stroke="hsl(var(--brand-ink))" strokeWidth={2.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5">
        <h3 className="font-display text-lg font-bold mb-4">Do‘konlar bo‘yicha Kassa foydasi</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-2 pr-3 font-medium">Do‘kon</th>
                <th className="py-2 pr-3 font-medium text-right">Tushum</th>
                <th className="py-2 pr-3 font-medium text-right">Tannarx</th>
                <th className="py-2 pr-3 font-medium text-right">Kassa yalpi foyda</th>
                <th className="py-2 pr-3 font-medium text-right">Marja</th>
                <th className="py-2 pr-3 font-medium text-right">Sotuv</th>
                <th className="py-2 pr-3 font-medium text-right">Buyurtma to‘lovlari</th>
                <th className="py-2 pr-3 font-medium text-right">Jami olingan pul</th>
              </tr>
            </thead>
            <tbody>
              {shopsSorted.map((s) => {
                const m = s.totals.revenue > 0 ? Math.round((s.totals.profit / s.totals.revenue) * 100) : 0;
                return (
                  <tr key={s.shop_id} className="border-b border-border/60 hover:bg-secondary/40">
                    <td className="py-2.5 pr-3 font-medium whitespace-nowrap">{s.shop_name}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{formatNum(s.totals.revenue)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-destructive">{formatNum(s.totals.cost)}</td>
                    <td className={`py-2.5 pr-3 text-right tabular-nums ${s.totals.profit < 0 ? 'text-destructive' : 'text-emerald-600'}`}>{formatNum(s.totals.profit)}</td>
                    <td className={`py-2.5 pr-3 text-right tabular-nums ${m < 0 ? 'text-destructive' : ''}`}>{m}%</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{s.totals.sales}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{formatNum(s.totals.orderPayments || 0)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{formatNum(s.totals.collections ?? s.totals.revenue)}</td>
                  </tr>
                );
              })}
              {!shopsSorted.length && !loading && (
                <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">Tanlangan davr uchun savdo topilmadi.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}