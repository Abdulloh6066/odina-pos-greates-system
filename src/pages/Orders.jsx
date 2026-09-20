import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import OrderForm from '@/components/orders/OrderForm';
import OrderDetail from '@/components/orders/OrderDetail';
import StaffOrderTicketModal from '@/components/tables/StaffOrderTicketModal';
import OrderAlertSummary from '@/components/orders/OrderAlertSummary';
import OrderLedgerHero from '@/components/orders/OrderLedgerHero';
import OrderLedgerKpis from '@/components/orders/OrderLedgerKpis';
import OrderFilterRail from '@/components/orders/OrderFilterRail';
import OrderLedgerCard from '@/components/orders/OrderLedgerCard';
import { useOrderAlerts } from '@/hooks/useOrderAlerts';
import { tashkentNowParts } from '@/lib/orders';
import { useToast } from '@/components/ui/use-toast';
import '@/styles/orders-premium-ledger.css';

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
  const [staffTicket, setStaffTicket] = useState(null);
  const [repeatPrefill, setRepeatPrefill] = useState(null);
  const { alerts, counts } = useOrderAlerts(orders);
  // Owner-only visual samples: never fetched, saved, counted, alerted or paid.
  const demoOrders = useMemo(() => {
    const { year, month, day } = tashkentNowParts();
    const date = (offset) => new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
    const sample = (number, details) => ({
      id: `demo-${number}`, order_number: `NAMUNA-${number}`, customer_phone: '—',
      shop_name_snapshot: 'Namuna', delivery_address: '', ...details,
    });
    return [
      sample('01', { customer_name: 'To‘y uchun list buyurtmasi', order_type: 'toy_va_bazmlar', fulfilment_type: 'pickup', required_date: date(1), required_time: '11:00', order_status: 'qabul_qilindi', payment_status: 'partial', total: 1200000, remaining_balance: 800000, demo_items: 'МАЛАКОЛИ ПИРОГ — 2 list; МАЛИНА ПИРОК — 1 list' }),
      sample('02', { customer_name: 'Tug‘ilgan kun torti', order_type: 'tugilgan_kun_va_boshqa', fulfilment_type: 'pickup', required_date: date(1), required_time: '15:30', order_status: 'tayyorlanmoqda', payment_status: 'unpaid', total: 260000, remaining_balance: 260000, demo_items: 'МАТИЛДА — 1 dona' }),
      sample('03', { customer_name: 'Bazm uchun aralash listlar', order_type: 'toy_va_bazmlar', fulfilment_type: 'delivery', delivery_address: 'Yetkazish manzili namunasi', required_date: date(2), required_time: '13:00', order_status: 'qabul_qilindi', payment_status: 'partial', total: 950000, remaining_balance: 450000, demo_items: 'СУТЛИ ПИРОГ — 2 list; ОЛМАЛИ ПИРОГ — 1 list' }),
      sample('04', { customer_name: 'Olib ketiladigan buyurtma', order_type: 'tugilgan_kun_va_boshqa', fulfilment_type: 'pickup', required_date: date(1), required_time: '18:00', order_status: 'tayyor', payment_status: 'paid', total: 180000, remaining_balance: 0, demo_items: 'САН СЕБЯСТАН — 1 list' }),
    ];
  }, []);
  const showDemo = isAdmin && !query && !shopFilter && !typeFilter && !statusFilter && !payFilter && !dateFilter;

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

  const handleCreated = (order, items) => {
    setFormOpen(false);
    setRepeatPrefill(null);
    setStaffTicket({ order, items });
    loadOrders();
  };

  return (
    <div className="opl-page">
      <OrderLedgerHero user={user} onCreate={() => setFormOpen(true)} />
      <OrderLedgerKpis orders={orders} />
      <main className="opl-workspace">
        <OrderFilterRail
          isAdmin={isAdmin}
          shops={shops}
          filters={{ query, shop: shopFilter, type: typeFilter, status: statusFilter, pay: payFilter, date: dateFilter }}
          setters={{ query: setQuery, shop: setShopFilter, type: setTypeFilter, status: setStatusFilter, pay: setPayFilter, date: setDateFilter }}
          typeOptions={TYPE_OPTIONS}
          statusOptions={STATUS_OPTIONS}
          payOptions={PAY_OPTIONS}
        />
        <section className="opl-ledger">
          <div className="opl-ledger-head"><h2 className="opl-ledger-title">Buyurtmalar</h2><span className="opl-ledger-count">{filtered.length} buyurtma</span></div>
          {showDemo && <section className="mb-5 rounded-xl border border-amber-300 bg-amber-50/60 p-3 sm:p-4" aria-label="Namunaviy buyurtmalar">
            <h3 className="mb-1 text-base font-semibold text-amber-900">Ko‘rinish uchun 4 ta namuna</h3>
            <p className="mb-3 text-xs text-amber-900">Narxlar va mijozlar namunaviy. Bu kartalar haqiqiy buyurtma, to‘lov, qoldiq va hisobotlarga kirmaydi. Bosib o‘zgartirib bo‘lmaydi.</p>
            <div className="opl-order-list">{demoOrders.map((order) => <OrderLedgerCard key={order.id} order={order} isAdmin demo />)}</div>
          </section>}
          <OrderAlertSummary alerts={alerts} counts={counts} onOpen={(order) => setDetailOrder(order)} loading={loading} />
          {loading ? <div className="opl-loading"><div className="opl-spinner" /></div> : filtered.length === 0 ? <div className="opl-empty">Buyurtmalar topilmadi.</div> : (
            <div className="opl-order-list">{filtered.map((order) => <OrderLedgerCard key={order.id} order={order} isAdmin={isAdmin} onOpen={setDetailOrder} onRepeat={handleRepeat} />)}</div>
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