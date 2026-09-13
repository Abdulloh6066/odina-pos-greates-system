import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { Image } from '@/components/ui/image';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import OdinaBrand from '@/components/brand/OdinaBrand';
import { typeLabel, tashkentNowParts, pad2 } from '@/lib/orders';
import { ROLE_HOME } from '@/lib/pos';
import { formatUzbekistanTime, uzbekistanDateKey } from '@/lib/uzbekistan-time';
import { useOrderAlerts } from '@/hooks/useOrderAlerts';
import OrderAlertSummary from '@/components/orders/OrderAlertSummary';
import OrderDetail from '@/components/orders/OrderDetail';
import DemandSection from '@/components/production/DemandSection';
import TomorrowIngredientForecast from '@/components/production/TomorrowIngredientForecast';
import {
  ChefHat, Clock, AlertTriangle, CheckCircle2, Truck, Loader2, Home, LogOut, ImageOff, Monitor, CalendarDays,
} from 'lucide-react';

const ACTIVE_STATUSES = ['qabul_qilindi', 'tayyorlanmoqda', 'tayyor'];
const URGENT_HOURS = 12;

const unitLabel = (u) => (u === 'sheet' ? 'varaq' : 'dona');

const dateOffsetStr = (days = 0) => {
  const p = tashkentNowParts();
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};

const todayStr = () => dateOffsetStr(0);

const displayDate = (value) => {
  const [year, month, day] = (value || '').split('-');
  return year && month && day ? `${day}.${month}.${year}` : value || '—';
};

const clockStr = () => {
  const p = tashkentNowParts();
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year} · ${pad2(p.hour)}:${pad2(p.minute)}`;
};

function urgency(o) {
  if (!o.required_date || !o.required_time) return '';
  const req = o.required_date.replace(/-/g, '') + o.required_time.replace(':', '');
  const p = tashkentNowParts();
  const now = `${p.year}${pad2(p.month)}${pad2(p.day)}${pad2(p.hour)}${pad2(p.minute)}`;
  if (req < now) return 'overdue';
  const reqMs = new Date(`${o.required_date}T${o.required_time}:00+05:00`).getTime();
  if (!Number.isFinite(reqMs)) return '';
  const diffH = (reqMs - Date.now()) / 3600000;
  return diffH <= URGENT_HOURS ? 'urgent' : '';
}

const shippedTime = (o) => o.shipped_at ? formatUzbekistanTime(o.shipped_at) : '';

// Error boundary that catches render/effect crashes of the screen content,
// so the page can never blank out (React otherwise tears down the whole root).
class ScreenErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Surface to console for diagnosis; never rethrow.
    // eslint-disable-next-line no-console
    console.error('ProductionScreen error:', error, info);
  }
  render() {
    if (this.state.error) {
      return <ScreenCrashFallback error={this.state.error} onReset={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function ScreenCrashFallback({ error, onReset }) {
  const { user } = useAuth();
  const homePath = ROLE_HOME[user?.role] || '/';
  const logout = () => base44.auth.logout();
  return (
    <div className="min-h-dvh bg-background flex flex-col">
      <header className="shrink-0 sticky top-0 z-20 bg-card border-b border-border premium-shadow">
        <div className="px-4 sm:px-6 h-16 flex items-center gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="hidden sm:flex"><OdinaBrand /></div>
            <div className="flex items-center gap-2 sm:hidden">
              <span className="w-9 h-9 rounded-xl brand-mark flex items-center justify-center"><ChefHat className="w-5 h-5 text-brand-ink" /></span>
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-lg sm:text-xl font-semibold leading-tight truncate flex items-center gap-2">
                <Monitor className="w-5 h-5 text-brand-olive hidden sm:inline" />
                Ishlab chiqarish ekrani
              </h1>
              <p className="text-xs text-muted-foreground hidden sm:block">Texnik nosozlik</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <Link to={homePath} className="hidden sm:flex">
              <Button variant="outline" size="sm"><Home className="w-4 h-4" /> Menyu</Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={logout}><LogOut className="w-4 h-4" /> Chiqish</Button>
          </div>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
        <div className="h-[60vh] flex flex-col items-center justify-center gap-3 text-center">
          <AlertTriangle className="w-12 h-12 text-rose-500" />
          <p className="font-display text-xl font-semibold">Ekranni yuklab bo‘lmadi</p>
          <p className="text-sm text-muted-foreground max-w-md break-words">
            {error?.message || 'Noma’lum xatolik.'}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
            <Button onClick={onReset}><Loader2 className="w-4 h-4" /> Qayta yuklash</Button>
            <Link to={homePath}>
              <Button variant="outline"><Home className="w-4 h-4" /> Menyuga qaytish</Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

function ProductionScreenInner() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [active, setActive] = useState([]);
  const [shippedToday, setShippedToday] = useState([]);
  const [itemsByOrder, setItemsByOrder] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [preview, setPreview] = useState('');
  const [detailOrder, setDetailOrder] = useState(null);
  const [clock, setClock] = useState(clockStr());
  const [forecast, setForecast] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(true);
  const [forecastError, setForecastError] = useState('');
  const loadedOnce = useRef(false);
  const { alerts, counts } = useOrderAlerts(active);

  const loadOrders = async () => {
    try {
      const all = await base44.entities.CustomerOrder.list('-created_date', 200);
      const list = all || [];
      setActive(list.filter((o) => ACTIVE_STATUSES.includes(o.order_status)));
      const today = todayStr();
      setShippedToday(
        list.filter((o) => o.order_status === 'yuborildi_olib_ketildi' && uzbekistanDateKey(o.shipped_at) === today),
      );
      return true;
    } catch (e) {
      if (!loadedOnce.current) setError(e?.message || 'Buyurtmalarni yuklab bo‘lmadi.');
      return false;
    }
  };

  const loadItems = async () => {
    try {
      const rows = await base44.entities.CustomerOrderItem.list('-created_date', 500);
      const map = {};
      (rows || []).forEach((it) => {
        if (!map[it.order_id]) map[it.order_id] = [];
        map[it.order_id].push(it);
      });
      setItemsByOrder(map);
      return true;
    } catch (e) {
      setItemsByOrder({});
      return false;
    }
  };

  const loadForecast = async () => {
    try {
      const response = await base44.functions.invoke('production-run', {
        action: 'tomorrow_ingredient_forecast',
      });
      const data = response?.data || response;
      if (data?.error) throw new Error(data.error);
      setForecast(data || null);
      setForecastError('');
      return true;
    } catch (e) {
      setForecastError(e?.response?.data?.error || e?.message || 'Masalliq nazoratini yuklab bo‘lmadi.');
      return false;
    } finally {
      setForecastLoading(false);
    }
  };

  const load = async () => {
    setError('');
    await Promise.allSettled([loadOrders(), loadItems(), loadForecast()]);
    loadedOnce.current = true;
    setLoading(false);
  };

  const safeSubscribe = (entityName, handler) => {
    try {
      const unsub = base44.entities[entityName]?.subscribe?.(handler);
      return typeof unsub === 'function' ? unsub : () => {};
    } catch (e) {
      return () => {};
    }
  };

  useEffect(() => {
    let cancelled = false;
    let t;
    const tick = () => { if (!cancelled) setClock(clockStr()); };
    const schedule = () => { clearTimeout(t); t = setTimeout(load, 250); };

    load();
    const interval = setInterval(tick, 30000);
    const u1 = safeSubscribe('CustomerOrder', schedule);
    const u2 = safeSubscribe('CustomerOrderItem', schedule);
    const u3 = safeSubscribe('IngredientStock', schedule);
    const u4 = safeSubscribe('Recipe', schedule);
    const u5 = safeSubscribe('RecipeItem', schedule);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(t);
      try { u1(); } catch (e) {}
      try { u2(); } catch (e) {}
      try { u3(); } catch (e) {}
      try { u4(); } catch (e) {}
      try { u5(); } catch (e) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doAction = async (order, step) => {
    setBusyId(order.id);
    try {
      const res = await base44.functions.invoke('customer-orders', {
        action: 'update_production_status',
        order_id: order.id,
        step,
      });
      const data = res?.data || res;
      if (data?.order) {
        toast({
          title: step === 'ready' ? 'Tayyor bo‘ldi' : 'Yuborildi',
          description: step === 'ready' && data.production_applied
            ? `${data.order.order_number} · Masalliqlar ombordan kamaydi`
            : data.order.order_number,
        });
        await load();
      } else {
        throw new Error(data?.error || 'Amal bajarilmadi');
      }
    } catch (e) {
      toast({ title: 'Xatolik', description: e?.message || 'Amal bajarilmadi', variant: 'destructive' });
    } finally {
      setBusyId('');
      setConfirm(null);
    }
  };

  const visibleDays = useMemo(() => {
    const today = todayStr();
    const tomorrow = dateOffsetStr(1);
    const sortByTime = (a, b) => {
      const timeCompare = (a.required_time || '').localeCompare(b.required_time || '');
      return timeCompare || (a.order_number || '').localeCompare(b.order_number || '');
    };
    const ordersFor = (date) => active.filter((o) => o.required_date === date).sort(sortByTime);

    return [
      { key: 'today', title: 'Bugungi buyurtmalar', date: today, orders: ordersFor(today) },
      { key: 'tomorrow', title: 'Ertangi buyurtmalar', date: tomorrow, orders: ordersFor(tomorrow) },
    ];
  }, [active, clock]);

  const logout = () => base44.auth.logout();
  const homePath = ROLE_HOME[user?.role] || '/';

  return (
    <div className="min-h-dvh bg-background flex flex-col">
      {/* Header — always rendered */}
      <header className="shrink-0 sticky top-0 z-20 bg-card border-b border-border premium-shadow">
        <div className="px-4 sm:px-6 h-16 flex items-center gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="hidden sm:flex"><OdinaBrand /></div>
            <div className="flex items-center gap-2 sm:hidden">
              <span className="w-9 h-9 rounded-xl brand-mark flex items-center justify-center"><ChefHat className="w-5 h-5 text-brand-ink" /></span>
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-lg sm:text-xl font-semibold leading-tight truncate flex items-center gap-2">
                <Monitor className="w-5 h-5 text-brand-olive hidden sm:inline" />
                Ishlab chiqarish ekrani
              </h1>
              <p className="text-xs text-muted-foreground hidden sm:block">Faol buyurtmalar · ishlab chiqarish xodimi</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 text-sm font-medium text-muted-foreground bg-secondary/60 rounded-xl px-3 h-10">
              <Clock className="w-4 h-4 text-brand-olive" /> {clock}
            </div>
            <Link to={homePath} className="hidden sm:flex">
              <Button variant="outline" size="sm"><Home className="w-4 h-4" /> Menyu</Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={logout}><LogOut className="w-4 h-4" /> Chiqish</Button>
          </div>
        </div>
      </header>

      {/* Body — always one of loading / error / empty / orders */}
      <main className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4 sm:p-6">
        {loading ? (
          <div className="h-[60vh] flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin text-brand-olive" />
            <span className="text-sm">Buyurtmalar yuklanmoqda…</span>
          </div>
        ) : error ? (
          <div className="h-[60vh] flex flex-col items-center justify-center gap-3 text-center">
            <AlertTriangle className="w-12 h-12 text-rose-500" />
            <p className="font-display text-xl font-semibold">Yuklashda xatolik</p>
            <p className="text-sm text-muted-foreground max-w-md">{error}</p>
            <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
              <Button onClick={load}><Loader2 className="w-4 h-4" /> Qayta yuklash</Button>
              <Link to={homePath}>
                <Button variant="outline"><Home className="w-4 h-4" /> Menyuga qaytish</Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            <OrderAlertSummary alerts={alerts} counts={counts} onOpen={(o) => setDetailOrder(o)} />
            {visibleDays.map((day) => (
              <OrderDaySection
                key={day.key}
                title={day.title}
                date={day.date}
                orders={day.orders}
                itemsByOrder={itemsByOrder}
                busyId={busyId}
                onReady={(order) => setConfirm({ order, step: 'ready' })}
                onShip={(order) => setConfirm({ order, step: 'shipped' })}
                onPreview={(order) => setPreview(order.reference_image)}
                forecast={day.key === 'tomorrow' ? (
                  <TomorrowIngredientForecast
                    forecast={forecast}
                    loading={forecastLoading}
                    error={forecastError}
                  />
                ) : null}
              />
            ))}

            <DemandSection user={user} />
          </div>
        )}

        {/* Bugun yuborilgan */}
        {shippedToday.length > 0 && !loading && !error && (
          <section className="mt-8">
            <div className="flex items-center gap-2 mb-3">
              <Truck className="w-5 h-5 text-brand-olive" />
              <h2 className="font-display text-lg font-semibold">Bugun yuborilgan</h2>
              <span className="text-xs font-medium bg-secondary text-muted-foreground rounded-full px-2 py-0.5">{shippedToday.length}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {shippedToday.map((o) => (
                <div key={o.id} className="rounded-xl border border-border bg-card p-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-brand-olive/15 flex items-center justify-center shrink-0">
                    <Truck className="w-4 h-4 text-brand-olive" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{o.order_number}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {o.shop_name_snapshot} · {typeLabel(o.order_type)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-muted-foreground">Yuborildi</div>
                    <div className="text-sm font-medium">{shippedTime(o) || '—'}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Confirm dialog */}
      <Dialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        {confirm && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {confirm.step === 'ready' ? 'Tayyor bo‘ldi?' : 'Yuborildi?'}
              </DialogTitle>
              <DialogDescription>
                {confirm.step === 'ready'
                  ? `${confirm.order.order_number} tayyor deb belgilanadi va tex-karta bo‘yicha masalliqlar markaziy ombordan avtomatik kamayadi.`
                  : `${confirm.order.order_number} buyurtmasini yuborilgan deb belgilaysiz.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <DialogClose asChild>
                <Button variant="outline">Bekor</Button>
              </DialogClose>
              <Button
                onClick={() => doAction(confirm.order, confirm.step)}
                disabled={busyId === confirm.order.id}
              >
                {busyId === confirm.order.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Tasdiqlash
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {/* Image preview */}
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview('')}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Namuna rasm</DialogTitle>
            <DialogDescription>Kattalashtirilgan ko‘rinish.</DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="rounded-xl overflow-hidden bg-secondary">
              <Image src={preview} fittingType="fit" className="w-full max-h-[70vh] object-contain" />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <OrderDetail
        order={detailOrder}
        onClose={() => setDetailOrder(null)}
        onPaid={() => load()}
        onRepeat={() => setDetailOrder(null)}
      />
    </div>
  );
}

export default function ProductionScreen() {
  return (
    <ScreenErrorBoundary>
      <ProductionScreenInner />
    </ScreenErrorBoundary>
  );
}

function buildPlanGroups(orders, itemsByOrder) {
  const map = {};
  for (const o of orders) {
    const isReady = o.order_status === 'tayyor';
    const items = itemsByOrder[o.id] || [];
    for (const it of items) {
      const key = it.product_id || it.product_name_snapshot || '?';
      if (!map[key]) {
        map[key] = {
          name: it.product_name_snapshot || 'Noma’lum',
          image: it.product_image_snapshot || '',
          unit: it.unit_snapshot === 'sheet' ? 'varaq' : 'dona',
          total: 0, ready: 0, remaining: 0,
        };
      }
      const qty = Number(it.quantity) || 0;
      map[key].total += qty;
      if (isReady) map[key].ready += qty; else map[key].remaining += qty;
    }
  }
  return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
}

function ProductionPlanSummary({ orders, itemsByOrder }) {
  const groups = useMemo(() => buildPlanGroups(orders, itemsByOrder), [orders, itemsByOrder]);
  if (!groups.length) return null;
  return (
    <div className="mb-4 rounded-2xl border border-border bg-card premium-shadow overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-secondary/40 flex items-center gap-2">
        <ChefHat className="w-4 h-4 text-brand-olive" />
        <h3 className="text-sm font-semibold">Ishlab chiqarish rejasi</h3>
        <span className="ml-auto text-xs text-muted-foreground">{groups.length} ta mahsulot</span>
      </div>
      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {groups.map((g) => (
          <div key={g.name} className="flex items-center gap-3 rounded-xl border border-border bg-card p-2.5">
            <div className="w-10 h-10 rounded-lg overflow-hidden bg-secondary shrink-0 flex items-center justify-center">
              {g.image ? <Image src={g.image} fittingType="fill" className="w-full h-full" /> : <span className="text-sm font-medium text-muted-foreground">{g.name[0]}</span>}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{g.name}</div>
              <div className="text-xs text-muted-foreground">Jami: {g.total} {g.unit}</div>
            </div>
            <div className="text-right shrink-0 flex flex-col gap-0.5">
              <span className="text-[11px] text-emerald-700">Tayyor: {g.ready}</span>
              <span className={`text-[11px] font-semibold ${g.remaining > 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>Qoldi: {g.remaining}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrderDaySection({
  title, date, orders, itemsByOrder, busyId, onReady, onShip, onPreview, forecast,
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-brand-olive/15 flex items-center justify-center shrink-0">
          <CalendarDays className="w-5 h-5 text-brand-olive" />
        </div>
        <div className="min-w-0">
          <h2 className="font-display text-lg sm:text-xl font-semibold leading-tight">{title}</h2>
          <p className="text-xs text-muted-foreground">{displayDate(date)}</p>
        </div>
        <span className="ml-auto text-xs font-semibold bg-secondary text-muted-foreground rounded-full px-2.5 py-1">
          {orders.length}
        </span>
      </div>

      {forecast}

      {orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/60 py-8 px-4 text-center">
          <CheckCircle2 className="w-9 h-9 text-brand-olive/50 mx-auto mb-2" />
          <p className="text-sm font-medium">Bu kun uchun faol buyurtma yo‘q</p>
          <p className="text-xs text-muted-foreground mt-1">Yangi buyurtma bo‘lsa, avtomatik shu yerda chiqadi.</p>
        </div>
      ) : (
        <>
          <ProductionPlanSummary orders={orders} itemsByOrder={itemsByOrder} />
          <div className="space-y-4">
            {orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                items={itemsByOrder[order.id] || []}
                busy={busyId === order.id}
                onReady={() => onReady(order)}
                onShip={() => onShip(order)}
                onPreview={() => onPreview(order)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function OrderCard({ order, items, busy, onReady, onShip, onPreview }) {
  const u = urgency(order);
  const isReady = order.order_status === 'tayyor';
  const hasImage = !!order.reference_image;

  return (
    <div className={`rounded-2xl border bg-card premium-shadow overflow-hidden ${
      u === 'overdue' ? 'border-rose-300' : u === 'urgent' ? 'border-amber-300' : 'border-border'
    }`}>
      {/* Card head */}
      <div className="p-4 sm:p-5 pb-3 sm:pb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display text-base sm:text-lg font-semibold">{order.order_number}</span>
            <span className="text-[11px] font-medium bg-secondary text-muted-foreground rounded-full px-2 py-0.5">
              {typeLabel(order.order_type)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="w-4 h-4 text-brand-olive shrink-0" />
            <span className="font-medium text-foreground">{order.required_date} · {order.required_time}</span>
          </div>
          <div className="mt-1 text-sm text-muted-foreground truncate flex items-center gap-1.5">
            <ChefHat className="w-4 h-4 text-brand-olive shrink-0" />
            {order.shop_name_snapshot || '—'}
          </div>
        </div>
        {u === 'overdue' && (
          <span className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-rose-700 bg-rose-100 border border-rose-200 rounded-full px-2.5 py-1">
            <AlertTriangle className="w-3.5 h-3.5" /> Muddati o‘tgan
          </span>
        )}
        {u === 'urgent' && (
          <span className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2.5 py-1">
            <AlertTriangle className="w-3.5 h-3.5" /> Shoshilinch
          </span>
        )}
      </div>

      <div className={hasImage ? 'grid lg:grid-cols-[minmax(280px,38%)_minmax(0,1fr)]' : ''}>
        {/* Reference image */}
        {hasImage && (
          <div className="px-4 sm:px-5 pb-4 lg:pr-2">
            <button
              type="button"
              onClick={onPreview}
              className="relative w-full h-52 sm:h-60 lg:h-64 xl:h-72 rounded-xl overflow-hidden bg-secondary/70 border border-border block"
              aria-label="Rasmini kattalashtirish"
            >
              <Image
                src={order.reference_image}
                fittingType="fit"
                className="w-full h-full object-contain"
              />
            </button>
          </div>
        )}

        <div className="min-w-0 flex flex-col">
          {/* Products */}
          <div className="p-4 pt-0 sm:px-5 flex-1 min-h-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Mahsulotlar</div>
            {items.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ImageOff className="w-4 h-4" /> Mahsulotlar yuklanmoqda…
              </div>
            ) : (
              <ul className="grid grid-cols-1 xl:grid-cols-2 gap-x-5 gap-y-2">
                {items.map((it) => (
                  <li key={it.id} className="flex items-start gap-2.5">
                    <div className="w-10 h-10 rounded-lg overflow-hidden bg-secondary shrink-0 flex items-center justify-center">
                      {it.product_image_snapshot ? (
                        <Image src={it.product_image_snapshot} fittingType="fill" className="w-full h-full" />
                      ) : (
                        <span className="text-sm font-medium text-muted-foreground">{(it.product_name_snapshot || '?')[0]}</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium leading-snug">{it.product_name_snapshot}</div>
                      <div className="text-xs text-muted-foreground">
                        {it.quantity} {unitLabel(it.unit_snapshot)}
                        {it.category_name_snapshot ? ` · ${it.category_name_snapshot}` : ''}
                      </div>
                      {it.customization_note && (
                        <div className="text-xs text-brand-ink mt-0.5">✎ {it.customization_note}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {order.notes && (
              <div className="mt-3 rounded-xl bg-secondary/50 border border-border p-2.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Umumiy izoh</div>
                <div className="text-sm leading-snug whitespace-pre-wrap">{order.notes}</div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="p-4 sm:px-5 border-t border-border bg-secondary/20 grid grid-cols-2 gap-2">
            <Button
              variant={isReady ? 'secondary' : 'outline'}
              size="lg"
              disabled={busy || isReady}
              onClick={onReady}
              className="h-12 text-sm sm:text-base"
            >
              {isReady ? <CheckCircle2 className="w-5 h-5 text-brand-olive" /> : busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
              Tayyor bo‘ldi
            </Button>
            <Button
              size="lg"
              disabled={busy || !isReady}
              onClick={onShip}
              className="h-12 text-sm sm:text-base"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Truck className="w-5 h-5" />}
              Yuborildi
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}