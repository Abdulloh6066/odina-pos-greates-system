import '@/styles/operations-workbench.css';
import React, { useState, useMemo } from 'react';
import { useOutletContext, Navigate } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, BarChart, Bar } from 'recharts';
import { formatUZS, formatNum } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import RealProfitDashboard from '@/components/reports/RealProfitDashboard';

const PAY_COLORS = { cash: 'hsl(var(--primary))', bank_card: 'hsl(var(--brand-olive))', online: 'hsl(var(--brand-sand))', uzcard: 'hsl(var(--brand-olive))', humo: '#86895a', click: 'hsl(var(--brand-sand))', payme: '#b58b52', bank_transfer: '#676653', other: 'hsl(0 0% 60%)' };
const PAY_LABELS = { cash: 'Naqd pul', bank_card: 'Bank card', online: 'Online', uzcard: 'Uzcard', humo: 'Humo', click: 'Click', payme: 'Payme', bank_transfer: 'Bank o‘tkazmasi', other: 'Boshqa' };

export default function Reports() {
  const { user } = useOutletContext();
  const role = user?.role;

  // All charts share the same filtered result as the summary above them.
  // No separate latest-1,000-sale download or contradictory date scope.
  const [reportData, setReportData] = useState(null);
  const [loading, setLoading] = useState(true);
  const acceptReport = (data) => { setReportData(data); setLoading(false); };
  const last7 = useMemo(() => (reportData?.byDay || []).map(row => ({
    date: row.date, total: row.collections ?? row.revenue, orders: row.sales,
  })), [reportData]);
  const allMethods = useMemo(() => ['cash', 'uzcard', 'humo', 'online', 'bank_transfer'].map(name => ({
    name, value: Number(reportData?.grand?.[name] || 0),
  })), [reportData]);
  const byMethod = allMethods.filter(row => row.value > 0);
  const byShop = useMemo(() => (reportData?.shops || []).map(shop => ({
    name: shop.shop_name, total: shop.totals.collections ?? shop.totals.revenue,
  })), [reportData]);
  const totalRev = reportData?.grand?.collections ?? reportData?.grand?.revenue ?? 0;

  if (role === 'cashier') return <Navigate to="/pos" replace />;

  return (
    <div className="odina-page odina-workbench odina-operations odina-reports p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader title="Hisobotlar" eyebrow="BIZNES TAHLILI" subtitle={reportData ? `${reportData.date_from} — ${reportData.date_to} · ${formatNum(reportData.grand?.sales || 0)} ta Kassa savdosi · olingan pul ${formatUZS(totalRev)}` : 'Davr bo‘yicha pul tushumi va Kassa foydasi'} icon={BarChart3} />

      <div className="odina-report-summary"><RealProfitDashboard onData={acceptReport} /></div>
      <div className="odina-operations-section-heading"><div><p className="odina-page-eyebrow">TUSHUM TAQSIMOTI</p><h2>Davr natijalari</h2></div><p>Tanlangan davr bo‘yicha kunlar, to‘lov usullari va do‘konlar.</p></div>

      {loading ? (
        <div className="grid lg:grid-cols-2 gap-5">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-64 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : !reportData || last7.length === 0 ? (
        <div className="odina-operations-empty text-center py-20"><BarChart3 aria-hidden="true" className="w-9 h-9 mx-auto mb-3 text-muted-foreground" /><p className="text-sm text-muted-foreground">Hali savdo ma’lumotlari yo‘q.</p></div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-5">
          <Panel title="Olingan pul — tanlangan davr">
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

          <Panel title="To‘lov usuli bo‘yicha olingan pul">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={byMethod} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85} innerRadius={45}>
                  {byMethod.map((m) => <Cell key={m.name} fill={PAY_COLORS[m.name] || 'hsl(0 0% 60%)'} />)}
                </Pie>
                <Tooltip formatter={(v) => formatUZS(v)} contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))' }} />
              </PieChart>
            </ResponsiveContainer>
            {allMethods.some(row => row.value < 0) && <p className="text-xs text-muted-foreground">Qaytarish sababli manfiy usullar doirada ko‘rsatilmaydi: {allMethods.filter(row => row.value < 0).map(row => `${PAY_LABELS[row.name]} ${formatUZS(row.value)}`).join(', ')}.</p>}
            <div className="flex flex-wrap gap-3 justify-center mt-2">
              {byMethod.map((m) => (
                <div key={m.name} className="odina-chart-legend-item flex items-center gap-1.5 text-xs"><span className="w-3 h-3 rounded-full" style={{ background: PAY_COLORS[m.name] || 'hsl(0 0% 60%)' }} /><span>{PAY_LABELS[m.name] || m.name}</span><strong className="tabular-nums">{formatUZS(m.value)}</strong></div>
              ))}
            </div>
          </Panel>

          <Panel title="Do‘konlar bo‘yicha olingan pul" className="lg:col-span-2">
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
    <div className={`odina-chart-panel odina-panel rounded-2xl bg-card border border-border p-4 sm:p-5 ${className || ''}`}>
      <h3 className="font-display text-lg font-bold mb-4">{title}</h3>
      {children}
    </div>
  );
}
