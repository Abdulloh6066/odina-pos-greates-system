import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { Image } from '@/components/ui/image';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import OdinaBrand from '@/components/brand/OdinaBrand';
import { displayOrderNumber, typeLabel, tashkentNowParts, pad2 } from '@/lib/orders';
import { ROLE_HOME } from '@/lib/pos';
import { formatUzbekistanTime, uzbekistanDateKey } from '@/lib/uzbekistan-time';
import DemandSection from '@/components/production/DemandSection';
import TomorrowIngredientForecast from '@/components/production/TomorrowIngredientForecast';
import {
  ChefHat, Clock, AlertTriangle, CheckCircle2, Truck, Loader2, Home, LogOut, ImageOff, Monitor, CalendarDays, ChevronDown, CakeSlice, RefreshCw,
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
    <div className="odina-production-board min-h-dvh bg-background flex flex-col">
      <header className="odina-production-header shrink-0 sticky top-0 z-20 bg-card border-b border-border premium-shadow">
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
  const [clock, setClock] = useState(clockStr());
  const [forecast, setForecast] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(true);
  const [forecastError, setForecastError] = useState('');
  const loadedOnce = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const refreshInFlight = useRef(null);
  const refreshQueued = useRef(false);
  const forecastQueued = useRef(false);

  const loadOrders = async () => {
    try {
      const all = await base44.entities.CustomerOrder.list('-created_date', 200);
      if (!Array.isArray(all)) throw new Error('Buyurtmalar javobi noto‘g‘ri.');
      const list = all;
      setActive(list.filter((o) => ACTIVE_STATUSES.includes(o.order_status)));
      const today = todayStr();
      setShippedToday(
        list.filter((o) => o.order_status === 'yuborildi_olib_ketildi' && uzbekistanDateKey(o.shipped_at) === today),
      );
      setRefreshError('');
      return true;
    } catch (e) {
      if (loadedOnce.current) setRefreshError('Buyurtmalar yangilanmadi. Oxirgi yuklangan ro‘yxat ko‘rsatilmoqda.');
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
      // Keep the last successful product details during a temporary connection failure.
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

  const load = async (includeForecast = true) => {
    // A realtime event arriving during a fetch needs a fresh follow-up read.
    // Never let an older concurrent response hide a newer order.
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      forecastQueued.current ||= includeForecast;
      return refreshInFlight.current;
    }
    setRefreshing(true);
    setError('');
    const request = (async () => {
      let withForecast = includeForecast;
      do {
        refreshQueued.current = false;
        forecastQueued.current = false;
        const results = await Promise.allSettled([
          loadOrders(), loadItems(), ...(withForecast ? [loadForecast()] : []),
        ]);
        if (results[0].status === 'fulfilled' && results[0].value === true) {
          loadedOnce.current = true;
        }
        setLoading(false);
        withForecast = forecastQueued.current;
      } while (refreshQueued.current);
    })();
    refreshInFlight.current = request;
    try {
      await request;
    } finally {
      refreshInFlight.current = null;
      setRefreshing(false);
    }
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
    const schedule = () => { clearTimeout(t); t = setTimeout(() => !cancelled && load(), 250); };
    const refreshVisible = () => {
      if (!cancelled && document.visibilityState !== 'hidden' && navigator.onLine !== false) {
        load(false);
      }
    };

    load();
    const interval = setInterval(tick, 30000);
    // Subscription messages can be missed after sleep or a reconnect.
    // Refresh reads independently of the ready/shipped action buttons.
    const orderInterval = setInterval(refreshVisible, 15000);
    window.addEventListener('focus', refreshVisible);
    window.addEventListener('online', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    const u1 = safeSubscribe('CustomerOrder', schedule);
    const u2 = safeSubscribe('CustomerOrderItem', schedule);
    const u3 = safeSubscribe('IngredientStock', schedule);
    const u4 = safeSubscribe('Recipe', schedule);
    const u5 = safeSubscribe('RecipeItem', schedule);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(orderInterval);
      clearTimeout(t);
      refreshQueued.current = false;
      window.removeEventListener('focus', refreshVisible);
      window.removeEventListener('online', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
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
            ? `${displayOrderNumber(data.order)} · Masalliqlar ombordan kamaydi`
            : displayOrderNumber(data.order),
        });
        await load();
      } else {
        throw new Error(data?.error || 'Amal bajarilmadi');
      }
    } catch (e) {
      toast({ title: 'Xatolik', description: e?.response?.data?.error || e?.message || 'Amal bajarilmadi', variant: 'destructive' });
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
      return timeCompare || (a.order_sequence || 0) - (b.order_sequence || 0);
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
    <div className="odina-production-board min-h-dvh bg-background flex flex-col">
      {/* Header — always rendered */}
      <header className="odina-production-header shrink-0 sticky top-0 z-20 bg-card border-b border-border premium-shadow">
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
            <Button variant="outline" size="sm" onClick={() => load(false)} disabled={refreshing} aria-label="Buyurtmalarni yangilash">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Yangilash</span>
            </Button>
            <Link to={homePath} className="hidden sm:flex">
              <Button variant="outline" size="sm"><Home className="w-4 h-4" /> Menyu</Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={logout}><LogOut className="w-4 h-4" /> Chiqish</Button>
          </div>
        </div>
      </header>

      {/* Body — always one of loading / error / empty / orders */}
      <main className="odina-production-content flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4 sm:p-6">
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
            {refreshError && (
              <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-brand-ink flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {refreshError}
              </div>
            )}
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
                    <div className="text-sm font-semibold truncate">{displayOrderNumber(o)}</div>
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
                  ? `${displayOrderNumber(confirm.order)} buyurtmasini tayyor deb belgilaysiz.`
                  : `${displayOrderNumber(confirm.order)} buyurtmasini yuborilgan deb belgilaysiz.`}
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
              <Image src={preview} alt="Buyurtma namuna rasmi" fittingType="fit" className="w-full max-h-[70vh] object-contain" />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

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
  const [expanded, setExpanded] = useState(false);
  const detailsId = React.useId();
  if (!groups.length) return null;
  return (
    <div className="mt-3 rounded-xl border border-border bg-card/70 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        className="w-full min-h-11 px-3 py-2.5 flex items-center gap-2 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-olive"
      >
        <ChefHat className="w-4 h-4 text-brand-olive shrink-0" />
        <span className="text-xs sm:text-sm font-medium flex-1">Ishlab chiqarish rejasi</span>
        <span className="text-xs text-muted-foreground">{groups.length} ta mahsulot</span>
        <ChevronDown aria-hidden="true" className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <div id={detailsId} hidden={!expanded} className={`p-3 border-t border-border gap-2.5 ${expanded ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'hidden'}`}>
        {groups.map((g) => (
          <div key={g.name} className="flex items-center gap-3 rounded-xl border border-border bg-card p-2.5">
            <div className="w-10 h-10 rounded-lg overflow-hidden bg-secondary shrink-0 flex items-center justify-center">
              {g.image ? <Image src={g.image} alt={g.name || 'Mahsulot rasmi'} fittingType="fill" className="w-full h-full" /> : <span className="text-sm font-medium text-muted-foreground">{g.name[0]}</span>}
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
    <section className="odina-production-day">
      <div className="odina-production-day-heading mb-3 flex items-center gap-3">
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

      {orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/60 py-8 px-4 text-center">
          <CheckCircle2 className="w-9 h-9 text-brand-olive/50 mx-auto mb-2" />
          <p className="text-sm font-medium">Bu kun uchun faol buyurtma yo‘q</p>
          <p className="text-xs text-muted-foreground mt-1">Yangi buyurtma bo‘lsa, avtomatik shu yerda chiqadi.</p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
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
          <ProductionPlanSummary orders={orders} itemsByOrder={itemsByOrder} />
        </>
      )}
      {forecast && <div className="mt-3">{forecast}</div>}
    </section>
  );
}

function OrderCard({ order, items, busy, onReady, onShip, onPreview }) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = `order-summary-${order.id}`;
  const detailsId = `order-details-${order.id}`;
  const productSummary = items.length
    ? items.map((it) => `${it.product_name_snapshot || 'Mahsulot'} · ${it.quantity} ${unitLabel(it.unit_snapshot)}`).join(' / ')
    : 'Mahsulotlar yuklanmoqda…';
  const statusLabel = order.order_status === 'tayyor'
    ? 'Tayyor'
    : order.order_status === 'tayyorlanmoqda' ? 'Tayyorlanmoqda' : 'Qabul qilindi';
  const u = urgency(order);
  const isReady = order.order_status === 'tayyor';
  const hasImage = !!order.reference_image;

  return (
    <div className={`odina-production-ticket rounded-2xl border bg-card premium-shadow overflow-hidden ${
      u === 'overdue' ? 'border-rose-300' : u === 'urgent' ? 'border-amber-300' : 'border-border'
    }`}>
      <div className="flex flex-col xl:flex-row xl:items-stretch">
        <button
          type="button"
          id={summaryId}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((open) => !open)}
          className="w-full min-w-0 flex-1 min-h-[72px] p-3 sm:px-4 flex items-center gap-3 text-left hover:bg-secondary/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-olive"
        >
          <span className="min-w-0 flex-1 grid gap-x-4 gap-y-1 lg:grid-cols-[minmax(250px,0.9fr)_minmax(110px,0.7fr)_minmax(0,1.4fr)] lg:items-center">
            <span className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="inline-flex items-center rounded-lg border border-border bg-secondary/70 px-2.5 py-1 font-sans text-sm sm:text-base font-semibold tabular-nums whitespace-nowrap">Buyurtma №{displayOrderNumber(order)}</span>
              <span className="inline-flex items-center gap-1.5 text-sm sm:text-base font-semibold tabular-nums shrink-0 bg-secondary/70 border border-border rounded-lg px-2.5 py-1">
                <Clock className="w-3.5 h-3.5 text-brand-olive" /> {order.required_time || '—'}
              </span>
            </span>
            <span className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
              <ChefHat className="w-4 h-4 text-brand-olive shrink-0" />
              <span className="truncate">{order.shop_name_snapshot || '—'}</span>
            </span>
            <span className="flex items-center gap-2 min-w-0 text-xs sm:text-sm text-muted-foreground">
              <CakeSlice className="w-4 h-4 text-brand-olive shrink-0" />
              <span className="truncate">{productSummary}</span>
            </span>
          </span>
          <span className="shrink-0 flex flex-col lg:flex-row items-end lg:items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 text-[11px] sm:text-xs font-medium rounded-full px-2.5 py-1 ${isReady ? 'text-brand-ink bg-brand-olive/20' : 'text-muted-foreground bg-secondary'}`}>
              {isReady && <CheckCircle2 className="w-3.5 h-3.5" />}
              {statusLabel}
            </span>
            {u === 'overdue' && (
              <span className="inline-flex items-center gap-1 text-[11px] sm:text-xs font-semibold text-rose-700 bg-rose-100 border border-rose-200 rounded-full px-2 py-1">
                <AlertTriangle className="w-3.5 h-3.5" /> Muddati o‘tgan
              </span>
            )}
            {u === 'urgent' && (
              <span className="inline-flex items-center gap-1 text-[11px] sm:text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-1">
                <AlertTriangle className="w-3.5 h-3.5" /> Shoshilinch
              </span>
            )}
          </span>
          <ChevronDown aria-hidden="true" className={`w-5 h-5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        <div className="grid grid-cols-2 gap-2 px-3 py-2.5 border-t xl:border-t-0 xl:border-l border-border bg-secondary/20 xl:shrink-0">
          <Button
            variant="outline"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`Buyurtma ${displayOrderNumber(order)}: ${expanded ? 'Yopish' : 'Ko‘rish'}`}
            className="h-11 min-w-24 bg-card font-semibold"
          >
            <ChevronDown aria-hidden="true" className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            {expanded ? 'Yopish' : 'Ko‘rish'}
          </Button>
          <Button
            onClick={isReady ? onShip : onReady}
            disabled={busy}
            aria-label={`Buyurtma ${displayOrderNumber(order)}: ${isReady ? 'Yuborildi' : 'Tayyor bo‘ldi'}`}
            className="h-11 min-w-32 font-semibold text-brand-ink"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : isReady ? <Truck className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
            {isReady ? 'Yuborildi' : 'Tayyor bo‘ldi'}
          </Button>
        </div>
      </div>

      {expanded && (
        <div id={detailsId} role="region" aria-labelledby={summaryId} className="border-t border-border pt-3">
          <div className="px-4 sm:px-5 pb-3 flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
            <span>{displayDate(order.required_date)} · {order.required_time || '—'}</span>
            <span className="rounded-full bg-secondary px-2 py-0.5">{typeLabel(order.order_type)}</span>
          </div>
          <div className={hasImage ? 'grid md:grid-cols-[minmax(240px,34%)_minmax(0,1fr)]' : ''}>
            {/* Reference image */}
            {hasImage && (
              <div className="px-4 sm:px-5 pb-4 md:pr-2">
                <button
                  type="button"
                  onClick={onPreview}
                  className="relative w-full h-52 sm:h-60 rounded-xl overflow-hidden bg-secondary/70 border border-border block"
                  aria-label="Rasmini kattalashtirish"
                >
                  <Image
                    src={order.reference_image}
                    alt={`${displayOrderNumber(order)} namuna rasmi`}
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
                            <Image src={it.product_image_snapshot} alt={it.product_name_snapshot || 'Mahsulot rasmi'} fittingType="fill" className="w-full h-full" />
                          ) : (
                            <span className="text-sm font-medium text-muted-foreground">{(it.product_name_snapshot || '?')[0]}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium leading-snug">{it.product_name_snapshot}</div>
                          {it.item_type === 'custom' && <div className="text-xs text-muted-foreground">Katalogdagi mos mahsulot topilmadi · oddiy buyurtma</div>}
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
