import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import OrderForm from '@/components/orders/OrderForm';
import OrderDetail from '@/components/orders/OrderDetail';
import StaffOrderTicketModal from '@/components/tables/StaffOrderTicketModal';
import OrderAlertSummary from '@/components/orders/OrderAlertSummary';
import OrderLedgerHero from '@/components/orders/OrderLedgerHero';
import OrderFilterRail from '@/components/orders/OrderFilterRail';
import OrderLedgerCard from '@/components/orders/OrderLedgerCard';
import { useOrderAlerts } from '@/hooks/useOrderAlerts';
import { shiftDateKey, uzbekistanDateKey } from '@/lib/uzbekistan-time';
import { useToast } from '@/components/ui/use-toast';
import '@/styles/orders-premium-ledger.css';

const TYPE_OPTIONS = [
  { value: '', label: 'Barcha turlar' },
  { value: 'toy_va_bazmlar', label: 'To‘y va bazmlar' },
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
const FINISHED = ['yakunlandi', 'bekor_qilindi'];

export default function Orders() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === 'admin';

  const [orders, setOrders] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('today');
  const [query, setQuery] = useState('');
  const [shopFilter, setShopFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [payFilter, setPayFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [detailOrder, setDetailOrder] = useState(null);
  const [staffTicket, setStaffTicket] = useState(null);
  const [repeatPrefill, setRepeatPrefill] = useState(null);
  const { alerts, counts } = useOrderAlerts(orders);

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

  const today = uzbekistanDateKey();
  const tomorrow = shiftDateKey(today, 1);
  const isActive = (order) => !FINISHED.includes(order.order_status);
  const tabs = [
    { key: 'today', label: 'Bugun', count: orders.filter((o) => isActive(o) && o.required_date === today).length },
    { key: 'tomorrow', label: 'Ertaga', count: orders.filter((o) => isActive(o) && o.required_date === tomorrow).length },
    { key: 'other', label: 'Boshqa kunlar', count: orders.filter((o) => isActive(o) && o.required_date !== today && o.required_date !== tomorrow).length },
    { key: 'history', label: 'Tarix', count: orders.filter((o) => !isActive(o)).length },
    { key: 'all', label: 'Barchasi', count: orders.length },
  ];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (view === 'today' && (!isActive(o) || o.required_date !== today)) return false;
      if (view === 'tomorrow' && (!isActive(o) || o.required_date !== tomorrow)) return false;
      if (view === 'other' && (!isActive(o) || o.required_date === today || o.required_date === tomorrow)) return false;
      if (view === 'history' && isActive(o)) return false;
      if (view === 'date' && o.required_date !== dateFilter) return false;
      if (q) {
        const hay = `${o.order_number || ''} ${o.customer_name || ''} ${o.customer_phone || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (shopFilter && o.shop_id !== shopFilter) return false;
      if (typeFilter && o.order_type !== typeFilter) return false;
      if (statusFilter && o.order_status !== statusFilter) return false;
      if (payFilter && o.payment_status !== payFilter) return false;
      return true;
    }).sort((a, b) => {
      const left = `${a.required_date || ''} ${a.required_time || ''}`;
      const right = `${b.required_date || ''} ${b.required_time || ''}`;
      return view === 'history' ? right.localeCompare(left) : left.localeCompare(right);
    });
  }, [orders, view, today, tomorrow, query, shopFilter, typeFilter, statusFilter, payFilter, dateFilter]);

  const selectView = (next) => {
    setView(next);
    setDateFilter('');
  };
  const clearFilters = () => {
    setQuery('');
    setShopFilter('');
    setTypeFilter('');
    setStatusFilter('');
    setPayFilter('');
    setDateFilter('');
    setView('today');
  };
  const hasFilters = !!(query || shopFilter || typeFilter || statusFilter || payFilter || dateFilter);

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

  const handleCreated = (order, items) => {
    setFormOpen(false);
    setRepeatPrefill(null);
    setStaffTicket({ order, items });
    loadOrders();
  };

  return (
    <div className="opl-page">
      <OrderLedgerHero user={user} onCreate={() => setFormOpen(true)} />
      <main className="opl-workspace">
        <nav className="opl-tabs" aria-label="Buyurtma sanalari">
          {tabs.map((tab) => (
            <button key={tab.key} type="button" className={`opl-tab ${view === tab.key ? 'is-active' : ''}`}
              aria-current={view === tab.key ? 'page' : undefined} onClick={() => selectView(tab.key)}>
              {tab.label}<span className="opl-tab-count">{tab.count}</span>
            </button>
          ))}
        </nav>
        <OrderFilterRail
          isAdmin={isAdmin}
          shops={shops}
          filters={{ query, shop: shopFilter, type: typeFilter, status: statusFilter, pay: payFilter, date: dateFilter }}
          setters={{
            query: (value) => { setQuery(value); if (value.trim()) { setDateFilter(''); setView('all'); } },
            shop: setShopFilter, type: setTypeFilter,
            status: (value) => { setStatusFilter(value); if (value) { setDateFilter(''); setView('all'); } },
            pay: setPayFilter,
            date: (value) => { setDateFilter(value); setView(value ? 'date' : 'today'); },
          }}
          typeOptions={TYPE_OPTIONS}
          statusOptions={STATUS_OPTIONS}
          payOptions={PAY_OPTIONS}
          onClear={clearFilters}
          hasFilters={hasFilters}
        />
        {view === 'today' && !query && <OrderAlertSummary alerts={alerts} counts={counts} onOpen={setDetailOrder} loading={loading} />}
        <section className="opl-ledger" aria-live="polite">
          <div className="opl-ledger-head">
            <div>
              <h2 className="opl-ledger-title">{view === 'date' ? `${dateFilter} dagi buyurtmalar` : tabs.find((tab) => tab.key === view)?.label}</h2>
              <p className="opl-ledger-subtitle">{view === 'history' ? 'Yakunlangan va bekor qilingan buyurtmalar' : 'Olish yoki yetkazish vaqti bo‘yicha tartiblangan'}</p>
            </div>
            <span className="opl-ledger-count">{filtered.length} ta</span>
          </div>
          {loading ? <div className="opl-loading"><div className="opl-spinner" /><p>Buyurtmalar yuklanmoqda…</p></div> : filtered.length === 0 ? (
            <div className="opl-empty">
              <strong>{hasFilters ? 'Mos buyurtma topilmadi' : 'Bu bo‘limda buyurtma yo‘q'}</strong>
              <p>{hasFilters ? 'Boshqa sana yoki qidiruvni sinab ko‘ring.' : 'Boshqa sanalarni ko‘ring yoki yangi buyurtma qo‘shing.'}</p>
              {hasFilters && <button type="button" onClick={clearFilters}>Filtrlarni tozalash</button>}
            </div>
          ) : (
            <div className="opl-order-list">{filtered.map((order) => (
              <OrderLedgerCard key={order.id} order={order} isAdmin={isAdmin} onOpen={setDetailOrder} onRepeat={handleRepeat} />
            ))}</div>
          )}
        </section>
      </main>
      <OrderForm open={formOpen} onClose={() => { setFormOpen(false); setRepeatPrefill(null); }} onCreated={handleCreated} user={user} shops={shops} prefill={repeatPrefill} />
      <OrderDetail order={detailOrder} onClose={() => setDetailOrder(null)} onPaid={() => { loadOrders(); }} onRepeat={handleRepeat}
        onStaffTicket={(order, items) => { setDetailOrder(null); setStaffTicket({ order, items }); }} />
      <StaffOrderTicketModal open={!!staffTicket} mode="customer" order={staffTicket?.order}
        orderItems={staffTicket?.items} onClose={() => {
          setDetailOrder(staffTicket?.order || null);
          setStaffTicket(null);
        }} />
    </div>
  );
}
