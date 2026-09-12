import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, LayoutDashboard, ShoppingBag, Receipt, TrendingUp, Star, Users as UsersIcon, ArrowRight } from 'lucide-react';
import { formatUZS, formatNum, saleBusinessDate, tashkentDateKey, canAccess } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';

export default function Dashboard() {
  const { user } = useOutletContext();
  const navigate = useNavigate();
  const role = user?.role || 'cashier';
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [expiredItems, setExpiredItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (role === 'cashier') { navigate('/pos', { replace: true }); return; }
    let active = true;
    (async () => {
      try {
        const [s, p, wasteResult] = await Promise.all([
          base44.entities.Sale.list('-created_date', 500),
          base44.entities.Product.list(),
          (role === 'admin' || role === 'manager')
            ? base44.functions.invoke('waste-ledger', { action: 'get_alerts' }).catch(() => ({ data: { expired_items: [] } }))
            : Promise.resolve({ data: { expired_items: [] } }),
        ]);
        if (!active) return;
        setSales(s || []);
        setProducts(p || []);
        setExpiredItems((wasteResult?.data || wasteResult)?.expired_items || []);
      } catch (e) {} finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [role]);

  const today = useMemo(() => sales.filter((s) => s.status !== 'refunded' && saleBusinessDate(s) === tashkentDateKey()), [sales]);
  const todayTotal = today.reduce((sum, s) => sum + s.total, 0);
  const todayOrders = today.length;
  const avgOrder = todayOrders ? todayTotal / todayOrders : 0;

  const bestSellers = useMemo(() => {
    const map = {};
    today.forEach((s) => s.items?.forEach((it) => {
      map[it.product_name] = (map[it.product_name] || 0) + it.quantity;
    }));
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [today]);

  const topEmployees = useMemo(() => {
    const map = {};
    today.forEach((s) => { map[s.user_name] = (map[s.user_name] || 0) + s.total; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [today]);

  if (role === 'cashier') return null;

  return (
    <div className="odina-page p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader title="Bosh sahifa" subtitle={new Date().toLocaleDateString('uz-UZ', { weekday: 'long', day: 'numeric', month: 'long' })} icon={LayoutDashboard} />

      {expiredItems.length > 0 && (
        <button
          type="button"
          onClick={() => navigate('/waste')}
          className="w-full mb-5 flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3.5 text-left text-red-900 hover:bg-red-100 transition-colors premium-shadow touch-manipulation"
        >
          <span className="w-10 h-10 rounded-xl bg-red-100 text-red-700 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{expiredItems.length} tur mahsulot 3 kundan oshgan</span>
            <span className="block text-sm text-red-700/80 mt-0.5">Do‘konlar bo‘yicha ko‘rish va chiqitga chiqarish uchun bosing.</span>
          </span>
          <ArrowRight className="w-5 h-5 shrink-0" />
        </button>
      )}

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard icon={TrendingUp} label="Bugungi savdo" value={formatUZS(todayTotal)} accent />
            <StatCard icon={Receipt} label="Bugungi buyurtmalar" value={formatNum(todayOrders)} />
            <StatCard icon={ShoppingBag} label="O‘rtacha buyurtma" value={formatUZS(avgOrder)} />
            <StatCard icon={Star} label="Mahsulotlar" value={formatNum(products.filter((product) => product.archived !== true).length)} />
          </div>

          <div className="grid lg:grid-cols-2 gap-5 mt-6">
            <Panel title="Bugungi eng ko‘p sotilganlar" icon={Star}>
              {bestSellers.length === 0 ? <Empty text="Bugun hali savdo yo‘q" /> : (
                <div className="space-y-2.5">
                  {bestSellers.map(([name, qty], i) => (
                    <div key={name} className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-lg bg-primary/15 text-brand-ink flex items-center justify-center text-xs font-bold">{i + 1}</div>
                      <span className="flex-1 text-sm font-medium truncate">{name}</span>
                      <span className="text-sm font-semibold text-muted-foreground">{qty} ta sotildi</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Bugungi eng faol xodimlar" icon={UsersIcon}>
              {topEmployees.length === 0 ? <Empty text="Bugun hali savdo yo‘q" /> : (
                <div className="space-y-2.5">
                  {topEmployees.map(([name, amt], i) => (
                    <div key={name} className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-lg bg-primary/15 text-brand-ink flex items-center justify-center text-xs font-bold">{i + 1}</div>
                      <span className="flex-1 text-sm font-medium truncate">{name}</span>
                      <span className="text-sm font-semibold">{formatUZS(amt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {canAccess(role, 'pos') && (
            <button onClick={() => navigate('/pos')} className="mt-6 w-full min-h-14 flex items-center justify-center gap-2 py-4 rounded-2xl bg-primary text-primary-foreground font-semibold premium-shadow hover:bg-primary-strong active:scale-[0.99] transition-all touch-manipulation">
              Kassani ochish <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div className={`odina-panel odina-metric rounded-2xl p-4 sm:p-5 border transition-all hover:-translate-y-0.5 ${accent ? 'odina-metric-accent bg-primary text-primary-foreground border-transparent premium-shadow' : 'bg-card border-border premium-shadow'}`}>
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${accent ? 'bg-primary-foreground/15' : 'bg-primary/15 text-brand-ink'}`}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <div className="text-xs uppercase tracking-wide opacity-70 mb-1">{label}</div>
      <div className="font-display text-xl sm:text-2xl font-bold leading-tight">{value}</div>
    </div>
  );
}

function Panel({ title, icon: Icon, children }) {
  return (
    <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4.5 h-4.5 text-brand-ink" />
        <h3 className="font-display text-lg font-bold">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <div className="text-sm text-muted-foreground py-6 text-center">{text}</div>;
}