import '@/styles/dashboard-workbench.css';
import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, Building2, Check, LayoutDashboard, ShoppingBag, Receipt, TrendingUp, Star, Users as UsersIcon, ArrowRight } from 'lucide-react';
import { formatUZS, formatNum, saleBusinessDate, tashkentDateKey, canAccess } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import OdinaSelect from '@/components/ui/odina-select';

const DASHBOARD_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const DASHBOARD_WEEKDAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];

// Display the existing Tashkent report date consistently when browser locale names fall back.
function formatDashboardDate(dateKey) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!parts) return '—';
  const date = new Date(`${dateKey}T12:00:00+05:00`);
  if (Number.isNaN(date.getTime())) return '—';
  return `${DASHBOARD_WEEKDAYS[date.getUTCDay()]}, ${Number(parts[3])}-${DASHBOARD_MONTHS[Number(parts[2]) - 1]}`;
}

export default function Dashboard() {
  const { user, adminShopScope } = useOutletContext();
  const navigate = useNavigate();
  const role = user?.role || 'cashier';
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [expiredItems, setExpiredItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dailyReports, setDailyReports] = useState(null);
  const [selectedShopId, setSelectedShopId] = useState('all');
  const [businessDate, setBusinessDate] = useState(tashkentDateKey);
  const [reportError, setReportError] = useState('');
  const assignedShopId = user?.shop_id || user?.data?.shop_id || '';
  const globalScope = role === 'admin' && adminShopScope?.isAdmin ? adminShopScope : null;
  const changeShop = (id) => globalScope ? globalScope.selectShop(id) : setSelectedShopId(id);

  useEffect(() => {
    if (role === 'cashier') { navigate('/pos', { replace: true }); return; }
    let active = true;
    setLoading(true);
    setSales([]);
    setProducts([]);
    setExpiredItems([]);
    setSelectedShopId('all');
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
      } catch (error) {
        if (active) setReportError(error?.response?.data?.error || error?.message || 'Bosh sahifa ma’lumotlari yuklanmadi.');
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [role, user?.id, assignedShopId, navigate]);

  // One preview supplies count and money together; catalog/alerts are not polled.
  useEffect(() => {
    if (role === 'cashier') return;
    let active = true;
    let inFlight = false;
    let timer;
    let lastAttempt = -Infinity;
    let retryAt = 0;
    let failures = 0;
    let day = tashkentDateKey();
    setBusinessDate(day);
    setDailyReports(null);
    setReportError('');

    const checkDay = () => {
      const nextDay = tashkentDateKey();
      if (day !== nextDay) {
        day = nextDay;
        setBusinessDate(day);
        setDailyReports(null); // Never label yesterday's totals as today's.
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      if (!active) return;
      const midnight = Date.parse(day + 'T00:00:00+05:00') + 86400000;
      timer = setTimeout(refresh, Math.min(60000, Math.max(1, midnight - Date.now())));
    };
    const refresh = async () => {
      if (!active) return;
      checkDay();
      if (inFlight) return;
      if (document.visibilityState === 'hidden' || navigator.onLine === false
        || Date.now() < retryAt || Date.now() - lastAttempt < 15000) {
        schedule();
        return;
      }
      inFlight = true;
      lastAttempt = Date.now();
      const requestDay = day;
      try {
        const result = await base44.functions.invoke('daily-sales-export', {
          action: 'preview', business_date: requestDay,
        });
        if (!active) return;
        checkDay();
        if (requestDay !== day) return;
        const data = result?.data || result;
        if (!Array.isArray(data?.reports)) throw new Error(data?.error || 'Kunlik hisobot yuklanmadi.');
        setDailyReports(data.reports);
        setReportError('');
        failures = 0;
        retryAt = 0;
      } catch (error) {
        if (!active) return;
        checkDay();
        failures += 1;
        // Back off on failures, including 429, and honor Retry-After.
        const headers = error?.response?.headers;
        const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after'];
        const seconds = Number(retryAfter);
        const serverDelay = retryAfter == null ? 0 : Number.isFinite(seconds)
          ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        retryAt = Date.now() + Math.max(Math.min(60000 * 2 ** (failures - 1), 300000), serverDelay || 0);
        if (requestDay === day) setReportError(error?.response?.data?.error || error?.message || 'Kunlik hisobot yuklanmadi.');
      } finally {
        inFlight = false;
        if (active) schedule();
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [role, user?.id, assignedShopId]);

  // The selector uses authorized report rows; managers retain their assigned store.
  const shops = useMemo(() => (dailyReports || []).filter((row) =>
    role !== 'manager' || row.shop_id === assignedShopId
  ), [dailyReports, role, assignedShopId]);
  const shopId = role === 'manager' ? assignedShopId
    : globalScope ? globalScope.shopId
      : shops.some((shop) => shop.shop_id === selectedShopId) ? selectedShopId : 'all';
  const shopName = shops.find((shop) => shop.shop_id === shopId)?.shop_name
    || globalScope?.shops.find((shop) => shop.id === shopId)?.name
    || (role === 'manager' ? user?.shop_name || 'Biriktirilgan do‘kon' : 'Barcha do‘konlar');
  const dailyTotals = useMemo(() => dailyReports === null ? null
    : dailyReports.filter((row) => shopId === 'all' || Boolean(shopId && row.shop_id === shopId)).reduce((totals, row) => ({
      revenue: totals.revenue + Number(row.total_revenue || 0),
      collections: totals.collections + Number(row.collections_total ?? row.total_revenue ?? 0),
      orderPayments: totals.orderPayments + Number(row.order_payment_total || 0),
      sales: totals.sales + Number(row.sale_count || 0),
    }), { revenue: 0, collections: 0, orderPayments: 0, sales: 0 }), [dailyReports, shopId]);
  const today = useMemo(() => sales.filter((s) => s.status !== 'refunded'
    && saleBusinessDate(s) === businessDate
    && (shopId === 'all' || Boolean(shopId && s.shop_id === shopId))), [sales, shopId, businessDate]);
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
    <div className="odina-page odina-home p-5 sm:p-8 max-w-7xl mx-auto">
      <PageHeader
        title="Bosh sahifa"
        eyebrow="Bugungi ish kuni"
        subtitle={<time dateTime={businessDate}>{formatDashboardDate(businessDate)}</time>}
        icon={LayoutDashboard}
        actions={canAccess(role, 'pos') && (
          <button type="button" onClick={() => navigate('/pos')} className="odina-home-pos-action odina-button odina-button-primary">
            Kassani ochish <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      />

      <div className={'odina-home-filter' + (role === 'admin' ? ' odina-home-filter-admin' : '')}>
        {role === 'admin' ? <>
          <span className="odina-home-filter-label">Do‘konni tanlang</span>
          <div className="odina-home-shop-buttons" role="group" aria-label="Do‘kon bo‘yicha ko‘rish">
            {[{ shop_id: 'all', shop_name: 'Barcha do‘konlar' }, ...shops].map((shop) => (
              <button key={shop.shop_id} type="button" className="odina-home-shop-button"
                aria-pressed={shopId === shop.shop_id} disabled={loading || shops.length === 0}
                onClick={() => changeShop(shop.shop_id)}>
                <Building2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{shop.shop_name}</span>
                {shopId === shop.shop_id && <Check className="w-4 h-4 shrink-0" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </> : <>
          <label htmlFor="dashboard-shop" className="odina-home-filter-label">Do‘konni tanlang</label>
          <OdinaSelect
            id="dashboard-shop"
            aria-label="Do‘kon bo‘yicha ko‘rish"
            value={shopId}
            disabled={loading || shops.length === 0}
            onChange={(event) => changeShop(event.target.value)}
            placeholder={shopName}
            className="odina-home-shop-select w-full min-h-11 touch-manipulation"
          >
            {[
              ...(role === 'manager' ? [] : [{ shop_id: 'all', shop_name: 'Barcha do‘konlar' }]),
              ...shops,
              ...(role === 'manager' && shops.length === 0 ? [{ shop_id: assignedShopId, shop_name: shopName }] : []),
            ].map((shop) => (
              <option key={shop.shop_id} value={shop.shop_id}>{shop.shop_name}</option>
            ))}
          </OdinaSelect>
        </>}
        <p aria-live="polite" className="odina-home-filter-scope">{shopName} · Bugungi ko‘rsatkichlar</p>
      </div>

      {visibleExpiredItems.length > 0 && (
        <button
          type="button"
          onClick={() => navigate('/waste')}
          className="odina-home-expiry w-full flex items-center gap-3 text-left touch-manipulation"
        >
          <span className="odina-home-expiry-icon flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{visibleExpiredItems.length} tur mahsulot 3 kundan oshgan</span>
            <span className="block text-sm mt-0.5">{shopName} · Ko‘rish va chiqitga chiqarish uchun bosing.</span>
          </span>
          <ArrowRight className="w-5 h-5 shrink-0" aria-hidden="true" />
        </button>
      )}

      {loading ? (
        <div className="odina-home-loading" role="status" aria-label="Bosh sahifa yuklanmoqda" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="odina-home-placeholder rounded-2xl bg-secondary animate-pulse" aria-hidden="true" />)}
        </div>
      ) : (
        <>
          <div className="odina-home-overview">
            <section className="odina-home-collections" aria-labelledby="dashboard-collections">
              <div className="odina-home-collections-heading">
                <TrendingUp className="w-5 h-5" aria-hidden="true" />
                <h2 id="dashboard-collections">Bugungi olingan pul</h2>
              </div>
              <p className="odina-home-collections-value">{dailyTotals ? formatUZS(dailyTotals.collections) : '—'}</p>
              {reportError ? <p role="alert" className="odina-home-report-error">Kunlik jami yuklanmadi: {reportError}</p>
                : dailyTotals && <div className="odina-home-collections-detail">
                  <dl className="odina-home-money-breakdown">
                    <div><dt>Kassa sof savdo</dt><dd>{formatUZS(dailyTotals.revenue)}</dd></div>
                    <div><dt>Buyurtma to‘lovlari</dt><dd>{formatUZS(dailyTotals.orderPayments)}</dd></div>
                  </dl>
                  <p className="odina-home-money-note">Jami olingan pul foyda emas.</p>
                </div>}
            </section>
            <dl className="odina-home-metrics">
              <StatCard icon={Receipt} label="Kassa savdolari" value={dailyTotals ? formatNum(todayOrders) : '—'} />
              <StatCard icon={ShoppingBag} label="Kassa o‘rtacha sof savdosi" value={dailyTotals ? formatUZS(avgOrder) : '—'} />
              <StatCard icon={Star} label="Katalogdagi mahsulotlar" value={formatNum(productCount)} />
            </dl>
          </div>

          <div className="odina-home-rankings">
            <Panel title="Bugungi Kassa mahsulotlari" icon={Star}>
              {bestSellers.length === 0 ? <Empty text="Bugun hali savdo yo‘q" /> : (
                <ol className="odina-home-ranking-list" role="list">
                  {bestSellers.map(({ key, name, quantity, unit }, i) => (
                    <li key={key} className="odina-home-ranking-row">
                      <span className="odina-home-rank" aria-hidden="true">{i + 1}</span>
                      <span className="odina-home-ranking-name">{name}</span>
                      <span className="odina-home-ranking-value">{Number(quantity.toFixed(3))} {unit} sotildi</span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            <Panel title="Bugungi Kassa xodimlari" icon={UsersIcon}>
              {topEmployees.length === 0 ? <Empty text="Bugun hali savdo yo‘q" /> : (
                <ol className="odina-home-ranking-list" role="list">
                  {topEmployees.map(([name, amt], i) => (
                    <li key={name} className="odina-home-ranking-row">
                      <span className="odina-home-rank" aria-hidden="true">{i + 1}</span>
                      <span className="odina-home-ranking-name">{name}</span>
                      <span className="odina-home-ranking-value">{formatUZS(amt)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </div>

        </>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div className={`odina-home-stat ${accent ? 'odina-home-stat-accent' : ''}`}>
      <dt><Icon className="w-4 h-4" aria-hidden="true" /><span>{label}</span></dt>
      <dd>{value}</dd>
    </div>
  );
}

function Panel({ title, icon: Icon, children }) {
  return (
    <section className="odina-home-panel" aria-label={title}>
      <header className="odina-home-panel-heading">
        <Icon className="w-4 h-4" aria-hidden="true" />
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

function Empty({ text }) {
  return <div className="odina-home-empty">{text}</div>;
}
