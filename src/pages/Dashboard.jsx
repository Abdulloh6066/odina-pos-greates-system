import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, LayoutDashboard, ShoppingBag, Receipt, TrendingUp, Star, Users as UsersIcon, ArrowRight } from 'lucide-react';
import { formatUZS, formatNum, saleBusinessDate, tashkentDateKey, canAccess } from '@/lib/pos';
import { formatUzbekistan } from '@/lib/uzbekistan-time';
import PageHeader from '@/components/PageHeader';
import OdinaSelect from '@/components/ui/odina-select';

export default function Dashboard() {
  const { user } = useOutletContext();
  const navigate = useNavigate();
  const role = user?.role || 'cashier';
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [expiredItems, setExpiredItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dailyReports, setDailyReports] = useState(null);
  const [selectedShopId, setSelectedShopId] = useState('all');
  const [reportError, setReportError] = useState('');
  const assignedShopId = user?.shop_id || user?.data?.shop_id || '';

  useEffect(() => {
    if (role === 'cashier') { navigate('/pos', { replace: true }); return; }
    let active = true;
    setLoading(true);
    setDailyReports(null);
    setReportError('');
    setSales([]);
    setProducts([]);
    setExpiredItems([]);
    setSelectedShopId('all');
    (async () => {
      try {
        const [s, p, wasteResult, dailyResult] = await Promise.all([
          base44.entities.Sale.list('-created_date', 500),
          base44.entities.Product.list(),
          (role === 'admin' || role === 'manager')
            ? base44.functions.invoke('waste-ledger', { action: 'get_alerts' }).catch(() => ({ data: { expired_items: [] } }))
            : Promise.resolve({ data: { expired_items: [] } }),
          base44.functions.invoke('daily-sales-export', { action: 'preview', business_date: tashkentDateKey() })
            .catch(error => ({ reportError: error?.response?.data?.error || error?.message || 'Kunlik hisobot yuklanmadi.' })),
        ]);
        if (!active) return;
        if (dailyResult.reportError) setReportError(dailyResult.reportError);
        else {
          setReportError('');
          const rows = (dailyResult?.data || dailyResult)?.reports || [];
          setDailyReports(rows);
        }
        setSales(s || []);
        setProducts(p || []);
        setExpiredItems((wasteResult?.data || wasteResult)?.expired_items || []);
      } catch (error) {
        if (active) setReportError(error?.response?.data?.error || error?.message || 'Bosh sahifa ma’lumotlari yuklanmadi.');
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [role, user?.id, assignedShopId, navigate]);

  // The selector uses authorized report rows; managers retain their assigned store.
  const shops = useMemo(() => (dailyReports || []).filter((row) =>
    role !== 'manager' || row.shop_id === assignedShopId
  ), [dailyReports, role, assignedShopId]);
  const shopId = role === 'manager' ? assignedShopId
    : shops.some((shop) => shop.shop_id === selectedShopId) ? selectedShopId : 'all';
  const shopName = shops.find((shop) => shop.shop_id === shopId)?.shop_name
    || (role === 'manager' ? user?.shop_name || 'Biriktirilgan do‘kon' : 'Barcha do‘konlar');
  const dailyTotals = useMemo(() => dailyReports === null ? null
    : dailyReports.filter((row) => shopId === 'all' || Boolean(shopId && row.shop_id === shopId)).reduce((totals, row) => ({
      revenue: totals.revenue + Number(row.total_revenue || 0),
      collections: totals.collections + Number(row.collections_total ?? row.total_revenue ?? 0),
      orderPayments: totals.orderPayments + Number(row.order_payment_total || 0),
      sales: totals.sales + Number(row.sale_count || 0),
    }), { revenue: 0, collections: 0, orderPayments: 0, sales: 0 }), [dailyReports, shopId]);
  const today = useMemo(() => sales.filter((s) => s.status !== 'refunded'
    && saleBusinessDate(s) === tashkentDateKey()
    && (shopId === 'all' || Boolean(shopId && s.shop_id === shopId))), [sales, shopId]);
  const visibleExpiredItems = expiredItems.filter((item) => shopId === 'all'
    || Boolean(shopId && item.location_id === shopId));
  const productCount = products.filter((product) => product.archived !== true
    && (shopId === 'all' || Boolean(shopId && (!product.available_shop_ids?.length
      || product.available_shop_ids.includes(shopId))))).length;
  const todayTotal = dailyTotals?.revenue || 0;
  const todayOrders = dailyTotals?.sales || 0;
  const avgOrder = todayOrders ? todayTotal / todayOrders : 0;

  const bestSellers = useMemo(() => {
    const productUnits = new Map(products.map((product) => [product.id, product.sale_unit]));
    const totals = new Map();
    today.forEach((s) => s.items?.forEach((it) => {
      const quantity = Number(it.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) return;
      // Sale-time units take priority; use the catalog only for legacy items.
      const saleUnit = it.sale_unit || productUnits.get(it.product_id) || 'piece';
      const unit = saleUnit === 'gram' ? 'kg' : 'ta';
      const key = JSON.stringify([it.product_id || it.product_name, unit]);
      const entry = totals.get(key) || { key, name: it.product_name, unit, rawQuantity: 0 };
      entry.rawQuantity += quantity;
      totals.set(key, entry);
    }));
    return Array.from(totals.values(), (entry) => ({
      ...entry,
      quantity: entry.unit === 'kg' ? entry.rawQuantity / 1000 : entry.rawQuantity,
    })).sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  }, [today, products]);

  const topEmployees = useMemo(() => {
    const map = {};
    today.forEach((s) => { map[s.user_name] = (map[s.user_name] || 0) + s.total; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [today]);

  if (role === 'cashier') return null;

  return (
    <div className="odina-page p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader title="Bosh sahifa" subtitle={formatUzbekistan(Date.now(), { weekday: 'long', day: 'numeric', month: 'long' })} icon={LayoutDashboard} />

      <div className="odina-panel mb-5 rounded-2xl border border-border bg-card p-4 premium-shadow">
        <label htmlFor="dashboard-shop" className="block text-sm font-semibold mb-3">Do‘konni tanlang</label>
        <OdinaSelect
          id="dashboard-shop"
          aria-label="Do‘kon bo‘yicha ko‘rish"
          value={shopId}
          disabled={loading || shops.length === 0}
          onChange={(event) => setSelectedShopId(event.target.value)}
          placeholder={shopName}
          className="w-full sm:max-w-sm min-h-12 bg-primary text-primary-foreground border-transparent font-semibold touch-manipulation"
        >
          {[
            ...(role === 'manager' ? [] : [{ shop_id: 'all', shop_name: 'Barcha do‘konlar' }]),
            ...shops,
            ...(role === 'manager' && shops.length === 0 ? [{ shop_id: assignedShopId, shop_name: shopName }] : []),
          ].map((shop) => (
            <option key={shop.shop_id} value={shop.shop_id}>{shop.shop_name}</option>
          ))}
        </OdinaSelect>
        <p aria-live="polite" className="mt-3 text-xs text-muted-foreground">{shopName} · Bugungi ko‘rsatkichlar</p>
      </div>

      {visibleExpiredItems.length > 0 && (
        <button
          type="button"
          onClick={() => navigate('/waste')}
          className="w-full mb-5 flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3.5 text-left text-red-900 hover:bg-red-100 transition-colors premium-shadow touch-manipulation"
        >
          <span className="w-10 h-10 rounded-xl bg-red-100 text-red-700 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{visibleExpiredItems.length} tur mahsulot 3 kundan oshgan</span>
            <span className="block text-sm text-red-700/80 mt-0.5">{shopName} · Ko‘rish va chiqitga chiqarish uchun bosing.</span>
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
            <StatCard icon={TrendingUp} label="Bugungi olingan pul" value={dailyTotals ? formatUZS(dailyTotals.collections) : '—'} accent />
            <StatCard icon={Receipt} label="Kassa savdolari" value={dailyTotals ? formatNum(todayOrders) : '—'} />
            <StatCard icon={ShoppingBag} label="Kassa o‘rtacha sof savdosi" value={dailyTotals ? formatUZS(avgOrder) : '—'} />
            <StatCard icon={Star} label="Mahsulotlar" value={formatNum(productCount)} />
          </div>

          {reportError ? <p role="alert" className="mt-3 text-sm text-destructive">Kunlik jami yuklanmadi: {reportError}</p>
            : dailyTotals && <p className="mt-3 text-xs text-muted-foreground">Kassa sof savdo: {formatUZS(dailyTotals.revenue)} · Buyurtma to‘lovlari: {formatUZS(dailyTotals.orderPayments)}. Jami olingan pul foyda emas.</p>}
          <div className="grid lg:grid-cols-2 gap-5 mt-6">
            <Panel title="Bugungi Kassa mahsulotlari" icon={Star}>
              {bestSellers.length === 0 ? <Empty text="Bugun hali savdo yo‘q" /> : (
                <div className="space-y-2.5">
                  {bestSellers.map(({ key, name, quantity, unit }, i) => (
                    <div key={key} className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-lg bg-primary/15 text-brand-ink flex items-center justify-center text-xs font-bold">{i + 1}</div>
                      <span className="flex-1 text-sm font-medium truncate">{name}</span>
                      <span className="text-sm font-semibold text-muted-foreground">{Number(quantity.toFixed(3))} {unit} sotildi</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Bugungi Kassa xodimlari" icon={UsersIcon}>
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
