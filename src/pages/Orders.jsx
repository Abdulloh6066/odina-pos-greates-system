import React, { useEffect, useMemo, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { formatUZS } from '@/lib/pos';
import { statusLabel, statusTone, typeLabel, payStatusLabel, payStatusTone, fulfilmentLabel } from '@/lib/orders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import OrderForm from '@/components/orders/OrderForm';
import OrderDetail from '@/components/orders/OrderDetail';
import { ClipboardList, Plus, Search, Filter, Calendar, Phone, MapPin, Store, Repeat2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

const TYPE_OPTIONS = [
  { value: '', label: 'Barcha turlar' },
  { value: 'toy_va_bazmlar', label: 'Toy va bazmlar' },
  { value: 'tugilgan_kun_va_boshqa', label: 'Tug‘ilgan kun va boshqa' },
];
const STATUS_OPTIONS = [
  { value: '', label: 'Barcha holatlar' },
  { value: 'qabul_qilindi', label: 'Qabul qilindi' },
  { value: 'tayyorlanmoqda', label: 'Tayyorlanmoqda' },
  { value: 'tayyor', label: 'Tayyor' },
  { value: 'yuborildi_olib_ketildi', label: 'Yuborildi / olib ketildi' },
  { value: 'yakunlandi', label: 'Yakunlandi' },
  { value: 'bekor_qilindi', label: 'Bekor qilindi' },
];
const PAY_OPTIONS = [
  { value: '', label: 'Barcha to‘lovlar' },
  { value: 'unpaid', label: 'To‘lanmagan' },
  { value: 'partial', label: 'Qisman' },
  { value: 'paid', label: 'To‘langan' },
];

export default function Orders() {
  const { user } = useAuth();
  const { toast } = useToast();
  const role = user?.role || 'cashier';
  const isAdmin = role === 'admin';

  const [orders, setOrders] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [shopFilter, setShopFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [payFilter, setPayFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [detailOrder, setDetailOrder] = useState(null);
  const [repeatPrefill, setRepeatPrefill] = useState(null);

  const loadOrders = async () => {
    setLoading(true);
    try {
      const list = await base44.entities.CustomerOrder.list('-created_date', 500);
      setOrders(list || []);
    } catch (e) {
      toast({ title: 'Buyurtmalarni yuklab bo‘lmadi', description: e?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const loadShops = async () => {
    if (!isAdmin) return;
    try {
      const list = await base44.entities.Shop.list('name', 100);
      setShops((list || []).filter((s) => s.active !== false));
    } catch { /* ignore */ }
  };

  useEffect(() => { loadOrders(); loadShops(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (q) {
        const hay = `${o.order_number} ${o.customer_name} ${o.customer_phone}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (shopFilter && o.shop_id !== shopFilter) return false;
      if (typeFilter && o.order_type !== typeFilter) return false;
      if (statusFilter && o.order_status !== statusFilter) return false;
      if (payFilter && o.payment_status !== payFilter) return false;
      if (dateFilter && o.required_date !== dateFilter) return false;
      return true;
    });
  }, [orders, query, shopFilter, typeFilter, statusFilter, payFilter, dateFilter]);

  const handleRepeat = async (order, items) => {
    try {
      let it = items;
      if (!it) it = await base44.entities.CustomerOrderItem.filter({ order_id: order.id });
      setDetailOrder(null);
      setRepeatPrefill({ order, items: it || [] });
      setFormOpen(true);
    } catch (e) {
      toast({ title: 'Buyurtma ma’lumotlarini yuklab bo‘lmadi', description: e?.message, variant: 'destructive' });
    }
  };

  const handleCreated = (order) => {
    setFormOpen(false);
    setRepeatPrefill(null);
    setDetailOrder(order);
    loadOrders();
  };

  return (
    <div className="px-4 lg:px-8 py-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground flex items-center gap-2">
            <ClipboardList className="w-6 h-6 text-brand-olive" /> Buyurtmalar
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Buyurtmalarni qabul qiling, to‘lovlarni kuzating.</p>
        </div>
        <Button onClick={() => setFormOpen(true)} className="self-start sm:self-auto">
          <Plus className="w-4 h-4" /> Yangi buyurtma
        </Button>
      </div>

      <div className="bg-card rounded-2xl border border-border premium-shadow p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <div className="relative lg:col-span-2">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nomer, mijoz, telefon" className="pl-9" />
          </div>
          {isAdmin && (
            <OdinaSelect value={shopFilter} onChange={(e) => setShopFilter(e.target.value)} className="h-11 rounded-xl border border-input bg-card px-3 text-sm">
              <option value="">Barcha do‘konlar</option>
              {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </OdinaSelect>
          )}
          <OdinaSelect value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="h-11 rounded-xl border border-input bg-card px-3 text-sm">
            {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </OdinaSelect>
          <OdinaSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-11 rounded-xl border border-input bg-card px-3 text-sm">
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </OdinaSelect>
          <OdinaSelect value={payFilter} onChange={(e) => setPayFilter(e.target.value)} className="h-11 rounded-xl border border-input bg-card px-3 text-sm">
            {PAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </OdinaSelect>
          <div className="relative">
            <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="h-11 w-full rounded-xl border border-input bg-card pl-9 pr-3 text-sm" />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-secondary border-t-primary rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Filter className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p>Buyurtmalar topilmadi.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((o) => (
            <div key={o.id} onClick={() => setDetailOrder(o)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailOrder(o); } }} className="text-left bg-card rounded-2xl border border-border premium-shadow p-4 hover:border-brand-olive/40 hover:premium-shadow-lg transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="font-semibold text-foreground truncate">{o.order_number}</div>
                  <div className="text-sm text-muted-foreground truncate">{o.customer_name}</div>
                </div>
                <span className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${statusTone(o.order_status)}`}>{statusLabel(o.order_status)}</span>
              </div>
              <div className="text-xs text-muted-foreground flex items-center gap-1.5 mb-3">
                <Phone className="w-3.5 h-3.5" /> {o.customer_phone}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mb-3">
                <span className="px-2 py-0.5 rounded-full bg-secondary">{typeLabel(o.order_type)}</span>
                <span className="px-2 py-0.5 rounded-full bg-secondary">{fulfilmentLabel(o.fulfilment_type)}</span>
                {isAdmin && <span className="px-2 py-0.5 rounded-full bg-secondary flex items-center gap-1"><Store className="w-3 h-3" />{o.shop_name_snapshot}</span>}
              </div>
              <div className="border-t border-border pt-3 flex items-center justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Umumiy</div>
                  <div className="font-bold text-foreground">{formatUZS(o.total)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Qoldi</div>
                  <div className={`font-semibold ${o.remaining_balance > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatUZS(o.remaining_balance)}</div>
                </div>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${payStatusTone(o.payment_status)}`}>{payStatusLabel(o.payment_status)}</span>
              </div>
              <div className="mt-3 text-xs text-muted-foreground flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" /> {o.required_date} · {o.required_time}
                {o.fulfilment_type === 'delivery' && <><MapPin className="w-3.5 h-3.5 ml-2" /> {o.delivery_address || '—'}</>}
              </div>
              <div className="mt-3 border-t border-border pt-2 flex justify-end">
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleRepeat(o); }} className="h-8 text-xs">
                  <Repeat2 className="w-3.5 h-3.5" /> Qayta buyurtma
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <OrderForm open={formOpen} onClose={() => { setFormOpen(false); setRepeatPrefill(null); }} onCreated={handleCreated} user={user} shops={shops} prefill={repeatPrefill} />
      <OrderDetail
        order={detailOrder}
        onClose={() => setDetailOrder(null)}
        onPaid={() => { loadOrders(); }}
        onRepeat={handleRepeat}
      />
    </div>
  );
}