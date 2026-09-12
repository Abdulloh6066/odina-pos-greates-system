import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext, Navigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { BarChart3 } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, BarChart, Bar } from 'recharts';
import { formatUZS, formatNum, saleBusinessDate, tashkentDateKey } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';

const PAY_COLORS = { cash: 'hsl(var(--primary))', uzcard: 'hsl(var(--brand-olive))', humo: 'hsl(197 37% 40%)', click: 'hsl(var(--brand-sand))', payme: 'hsl(43 74% 55%)', bank_transfer: 'hsl(215 55% 52%)', other: 'hsl(0 0% 60%)' };
const PAY_LABELS = { cash: 'Naqd pul', uzcard: 'Uzcard', humo: 'Humo', click: 'Click', payme: 'Payme', bank_transfer: 'Bank o‘tkazmasi', other: 'Boshqa' };

export default function Reports() {
  const { user } = useOutletContext();
  const role = user?.role;

  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const s = await base44.entities.Sale.list('-created_date', 1000);
        setSales(s || []);
      } catch {}
      setLoading(false);
    })();
  }, []);

  const completedSales = useMemo(() => sales.filter((sale) => sale.status !== 'refunded'), [sales]);

  const last7 = useMemo(() => {
    const days = [];
    const now = Date.now();
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now - i * 24 * 60 * 60 * 1000);
      const dateKey = tashkentDateKey(day);
      const daySales = completedSales.filter((sale) => saleBusinessDate(sale) === dateKey);
      days.push({
        date: day.toLocaleDateString('uz-UZ', { weekday: 'short', timeZone: 'Asia/Tashkent' }),
        total: daySales.reduce((sum, sale) => sum + sale.total, 0),
        orders: daySales.length,
      });
    }
    return days;
  }, [completedSales]);

  const byMethod = useMemo(() => {
    const map = {};
    completedSales.forEach((s) => s.payments?.forEach((p) => { map[p.method] = (map[p.method] || 0) + p.amount; }));
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [completedSales]);

  const byShop = useMemo(() => {
    const map = {};
    completedSales.forEach((s) => { if (s.shop_name) map[s.shop_name] = (map[s.shop_name] || 0) + s.total; });
    return Object.entries(map).map(([name, total]) => ({ name, total }));
  }, [completedSales]);

  const totalRev = completedSales.reduce((s, x) => s + x.total, 0);

  if (role === 'cashier') return <Navigate to="/pos" replace />;

  return (
    <div className="odina-page p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader title="Hisobotlar" subtitle={`${formatNum(sales.length)} ta savdo · jami ${formatUZS(totalRev)}`} icon={BarChart3} />

      {loading ? (
        <div className="grid lg:grid-cols-2 gap-5">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-64 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : sales.length === 0 ? (
        <div className="text-center py-20"><div className="text-5xl mb-3">📊</div><p className="text-sm text-muted-foreground">Hali savdo ma’lumotlari yo‘q.</p></div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-5">
          <Panel title="Savdo — oxirgi 7 kun">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={last7} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} /><stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v) => formatUZS(v)} contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))' }} />
                <Area type="monotone" dataKey="total" stroke="hsl(var(--brand-ink))" strokeWidth={2} fill="url(#g)" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="To‘lov usuli bo‘yicha savdo">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={byMethod} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85} innerRadius={45}>
                  {byMethod.map((m) => <Cell key={m.name} fill={PAY_COLORS[m.name] || 'hsl(0 0% 60%)'} />)}
                </Pie>
                <Tooltip formatter={(v) => formatUZS(v)} contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))' }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-3 justify-center mt-2">
              {byMethod.map((m) => (
                <div key={m.name} className="flex items-center gap-1.5 text-xs"><span className="w-3 h-3 rounded-full" style={{ background: PAY_COLORS[m.name] || 'hsl(0 0% 60%)' }} /><span>{PAY_LABELS[m.name] || m.name}</span></div>
              ))}
            </div>
          </Panel>

          <Panel title="Do‘konlar bo‘yicha savdo" className="lg:col-span-2">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={byShop} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v) => formatUZS(v)} contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))' }} />
                <Bar dataKey="total" fill="hsl(var(--primary))" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      )}
    </div>
  );
}

function Panel({ title, children, className }) {
  return (
    <div className={`odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5 ${className || ''}`}>
      <h3 className="font-display text-lg font-bold mb-4">{title}</h3>
      {children}
    </div>
  );
}