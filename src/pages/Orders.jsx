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