import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { formatUZS } from '@/lib/pos';
import { uzbekistanDateKey, uzbekistanMonthStartKey } from '@/lib/uzbekistan-time';
import { Button } from '@/components/ui/button';
import OdinaSelect from '@/components/ui/odina-select';
import { Image } from '@/components/ui/image';
import { TrendingUp, Filter, Loader2, Receipt, Wallet, Percent, PiggyBank, Coins, ChevronRight, AlertTriangle } from 'lucide-react';
import ProductBreakdownDialog from '@/components/profit/ProductBreakdownDialog';
import TvarojniCostDemo from '@/components/profit/TvarojniCostDemo';

const firstOfMonth = () => uzbekistanMonthStartKey();
const todayISO = () => uzbekistanDateKey();

export default function ProfitReport() {
  const { user } = useAuth();
  const role = user?.role;
  const isAdmin = role === 'admin';

  const [shops, setShops] = useState([]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(todayISO());
  const [shopId, setShopId] = useState('');
  const [productId, setProductId] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownData, setBreakdownData] = useState(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        if (isAdmin) {
          const s = await base44.entities.Shop.list('name', 100);
          setShops((s || []).filter((x) => x.active !== false));
        }
        const [p, c] = await Promise.all([
          base44.entities.Product.list('name', 500),
          base44.entities.Category.list('name', 100),
        ]);
        setProducts((p || []).filter((x) => x.archived !== true));
        setCategories((c || []).filter((x) => x.active !== false));
      } catch {}
    })();
  }, [isAdmin]);

  const loadReport = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await base44.functions.invoke('profit-report', {
        action: 'report',
        date_from: dateFrom,
        date_to: dateTo,
        shop_id: shopId,
        product_id: productId,
        category_id: categoryId,
      });
      setReport(res?.data || res);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || 'Hisobotni yuklab bo‘lmadi.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadReport(); }, []);

  const openBreakdown = async (prodId) => {
    setBreakdownOpen(true);
    setBreakdownLoading(true);
    setBreakdownData(null);
    try {
      const res = await base44.functions.invoke('profit-report', {
        action: 'product_breakdown',
        product_id: prodId,
      });
      setBreakdownData(res?.data || res);
    } catch {
      setBreakdownData(null);
    } finally {
      setBreakdownLoading(false);
    }
  };

  if (role && role !== 'admin' && role !== 'accountant') {
    return <Navigate to="/" replace />;
  }

  const s = report?.summary || {};
  const productsRows = report?.products || [];

  return (
    <div className="odina-page p-5 sm:p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-display font-bold text-foreground flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-brand-olive" /> Tannarx va foyda
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Sotuv tannarxi, yalpi foyda va xarajatlardan keyingi foyda hisoboti.</p>
      </div>

      <TvarojniCostDemo />

      {/* Filters */}
      <div className="bg-card rounded-2xl border border-border premium-shadow p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Sanadan</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Sanagacha</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm" />
          </div>
          {isAdmin && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">Do‘kon</label>
              <OdinaSelect value={shopId} onChange={(e) => setShopId(e.target.value)} className="h-11 w-full">
                <option value="">Barcha do‘konlar</option>
                {shops.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </OdinaSelect>
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Kategoriya</label>
            <OdinaSelect value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="h-11 w-full">
              <option value="">Barcha kategoriyalar</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </OdinaSelect>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Mahsulot</label>
            <OdinaSelect value={productId} onChange={(e) => setProductId(e.target.value)} className="h-11 w-full">
              <option value="">Barcha mahsulotlar</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </OdinaSelect>
          </div>
          <div className="flex items-end">
            <Button onClick={loadReport} disabled={loading} className="w-full">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Filter className="w-4 h-4" />}
              Hisobotni yangilash
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 p-3 mb-4 text-sm">{error}</div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
        <StatCard icon={Receipt} label="Sof savdo" value={s.net_revenue} />
        <StatCard icon={Coins} label="Sotilgan tannarx" value={s.cost_of_goods} tone="muted" />
        <StatCard icon={PiggyBank} label="Yalpi foyda" value={s.gross_profit} tone="positive" />
        <StatCard icon={Percent} label="Foyda marjasi" suffix={`${s.margin ?? 0}%`} tone="neutral" />
        <StatCard icon={Wallet} label="Xarajatlar" value={s.expenses} tone="muted" />
        <StatCard icon={TrendingUp} label="Xarajatlardan keyingi foyda" value={s.net_profit} tone="positive" />
      </div>

      {(s.unknown_count > 0 || s.estimate_count > 0) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 p-3 mb-4 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            {(s.estimate_count + s.unknown_count) > 0 && (
              <span><b>{s.estimate_count + s.unknown_count}</b> ta mahsulot tannarxi retsept yoki xarid narxi yo‘qligi uchun <b>taxminiy / noma’lum</b> hisoblangan (“Taxminiy”). </span>
            )}
            Mahsulot qatoriga bosib retsept tannarxini tekshiring.
          </div>
        </div>
      )}

      {/* Product table */}
      <div className="bg-card rounded-2xl border border-border premium-shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-display text-lg font-semibold">Mahsulotlar bo‘yicha tahlil</h2>
        </div>
        {loading && !report ? (
          <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-muted-foreground" /></div>
        ) : productsRows.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            <Filter className="w-9 h-9 mx-auto mb-2 opacity-40" />
            Tanlangan davr uchun savdo topilmadi.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left font-semibold px-4 py-3">Mahsulot</th>
                  <th className="text-right font-semibold px-3 py-3">Sotilgan</th>
                  <th className="text-right font-semibold px-3 py-3">Sof savdo</th>
                  <th className="text-right font-semibold px-3 py-3">Tannarx</th>
                  <th className="text-right font-semibold px-3 py-3">Yalpi foyda</th>
                  <th className="text-right font-semibold px-3 py-3">Marja</th>
                  <th className="px-2 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {productsRows.map((p) => (
                  <tr
                    key={p.product_id}
                    onClick={() => openBreakdown(p.product_id)}
                    className="border-t border-border hover:bg-secondary/40 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="w-9 h-9 rounded-lg overflow-hidden bg-secondary shrink-0 flex items-center justify-center">
                          {p.image_url ? <Image src={p.image_url} alt={p.name || 'Mahsulot rasmi'} fittingType="fill" className="w-full h-full" /> : <span className="text-xs font-medium text-muted-foreground">{(p.name || '?')[0]}</span>}
                        </span>
                        <div className="min-w-0">
                          <div className="font-medium truncate">{p.name}</div>
                          {p.estimate && <span className="text-[11px] text-amber-600">Taxminiy</span>}
                          {p.unknown && <span className="text-[11px] text-rose-600">Noma’lum</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right text-muted-foreground">{p.quantity}</td>
                    <td className="px-3 py-3 text-right">{formatUZS(p.net_revenue)}</td>
                    <td className="px-3 py-3 text-right text-muted-foreground">{p.unknown ? '—' : formatUZS(p.total_cost)}</td>
                    <td className={`px-3 py-3 text-right font-semibold ${p.gross_profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{p.unknown ? '—' : formatUZS(p.gross_profit)}</td>
                    <td className="px-3 py-3 text-right text-muted-foreground">{p.unknown ? '—' : `${p.margin.toFixed(1)}%`}</td>
                    <td className="px-2 py-3 text-muted-foreground"><ChevronRight className="w-4 h-4" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ProductBreakdownDialog open={breakdownOpen} onClose={() => setBreakdownOpen(false)} loading={breakdownLoading} data={breakdownData} />
    </div>
  );
}

function StatCard({ icon: Icon, label, value, suffix, tone }) {
  const toneClass = tone === 'positive' ? 'text-emerald-600' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div className="rounded-2xl border border-border bg-card premium-shadow p-3 sm:p-4">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className={`text-lg sm:text-xl font-bold ${toneClass}`}>
        {suffix !== undefined && suffix !== null ? suffix : formatUZS(value ?? 0)}
      </div>
    </div>
  );
}