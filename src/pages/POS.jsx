import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Search, Star, Clock, Building2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUZS, formatNum, logAction, todayISO, isSameDay } from '@/lib/pos';
import ProductCard from '@/components/pos/ProductCard';
import Cart from '@/components/pos/Cart';
import PaymentModal from '@/components/pos/PaymentModal';
import Receipt from '@/components/pos/Receipt';
import { OpenShiftDialog, CloseShiftDialog } from '@/components/pos/ShiftDialog';

export default function POS() {
  const { user } = useOutletContext();
  const navigate = useNavigate();

  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [activeCat, setActiveCat] = useState('all');
  const [search, setSearch] = useState('');
  const [showFav, setShowFav] = useState(false);
  const [cart, setCart] = useState([]);
  const [shops, setShops] = useState([]);
  const [shift, setShift] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loadingData, setLoadingData] = useState(true);

  const [discountCode, setDiscountCode] = useState('');
  const [discountPct, setDiscountPct] = useState(0);
  const [discountError, setDiscountError] = useState('');

  const [payOpen, setPayOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [lastSale, setLastSale] = useState(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const [openShiftOpen, setOpenShiftOpen] = useState(false);
  const [closeShiftOpen, setCloseShiftOpen] = useState(false);
  const [shiftLoading, setShiftLoading] = useState(false);

  const loadAll = async () => {
    setLoadingData(true);
    const [cats, prods, shopList, settingsList, shifts] = await Promise.all([
      base44.entities.Category.list(),
      base44.entities.Product.list(),
      base44.entities.Shop.list(),
      base44.entities.Settings.list(),
      base44.entities.Shift.list(),
    ]);
    setCategories((cats || []).filter((c) => c.active));
    setProducts((prods || []).filter((p) => p.active));
    setShops(shopList || []);
    setSettings(settingsList?.[0] || null);
    const myOpen = (shifts || []).find((s) => s.user_id === user?.id && s.status === 'open');
    setShift(myOpen || null);
    setLoadingData(false);
  };

  useEffect(() => { if (user) loadAll(); }, [user]);

  const subtotal = useMemo(() => cart.reduce((s, i) => s + i.subtotal, 0), [cart]);
  const discount = useMemo(() => Math.round(subtotal * discountPct) / 100 * (100 * (discountPct / 100)) || Math.round(subtotal * discountPct / 100 * 100) / 100, [subtotal, discountPct]);
  const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);

  const addToCart = (product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.product_id === product.id);
      if (existing) {
        return prev.map((i) => i.product_id === product.id ? { ...i, quantity: i.quantity + 1, subtotal: i.subtotal + product.price } : i);
      }
      return [...prev, { product_id: product.id, product_name: product.name, image_url: product.image_url, price: product.price, quantity: 1, subtotal: product.price }];
    });
  };

  const inc = (item) => setCart((p) => p.map((i) => i.product_id === item.product_id ? { ...i, quantity: i.quantity + 1, subtotal: i.subtotal + i.price } : i));
  const dec = (item) => setCart((p) => p.flatMap((i) => {
    if (i.product_id !== item.product_id) return [i];
    const q = i.quantity - 1;
    return q <= 0 ? [] : [{ ...i, quantity: q, subtotal: q * i.price }];
  }));
  const removeItem = (item) => setCart((p) => p.filter((i) => i.product_id !== item.product_id));
  const clearCart = () => { setCart([]); setDiscountCode(''); setDiscountPct(0); setDiscountError(''); };

  const applyDiscount = async (code) => {
    if (!code) return;
    try {
      const found = await base44.entities.DiscountCode.filter({ code: code.trim(), active: true });
      const dc = found?.[0];
      if (!dc) { setDiscountError('Invalid or inactive code.'); return; }
      setDiscountPct(dc.percentage);
      setDiscountCode(dc.code);
      setDiscountError('');
    } catch (e) { setDiscountError('Could not validate code.'); }
  };

  const removeDiscount = () => { setDiscountCode(''); setDiscountPct(0); setDiscountError(''); };

  const filtered = useMemo(() => {
    let list = products;
    if (activeCat !== 'all') list = list.filter((p) => p.category_id === activeCat);
    if (showFav) list = list.filter((p) => p.is_favorite);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [products, activeCat, showFav, search]);

  const openCheckout = () => {
    if (!shift) { setOpenShiftOpen(true); return; }
    setPayOpen(true);
  };

  const completeSale = async (payments) => {
    setPaying(true);
    try {
      const summary = payments.map((p) => p.method).join(' + ');
      const sale = await base44.entities.Sale.create({
        shift_id: shift.id,
        user_id: user.id,
        user_name: user.full_name || user.email,
        shop_id: shift.shop_id,
        shop_name: shift.shop_name,
        items: cart,
        subtotal,
        discount_code: discountCode || undefined,
        discount_amount: discount,
        total,
        payments,
        payment_methods_summary: summary,
        status: 'completed',
      });

      // update shift totals
      const cashInc = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0);
      const uzcardInc = payments.filter((p) => p.method === 'uzcard').reduce((s, p) => s + p.amount, 0);
      const humoInc = payments.filter((p) => p.method === 'humo').reduce((s, p) => s + p.amount, 0);
      const onlineInc = payments.filter((p) => ['click', 'payme', 'other'].includes(p.method)).reduce((s, p) => s + p.amount, 0);
      await base44.entities.Shift.update(shift.id, {
        cash_sales: shift.cash_sales + cashInc,
        uzcard_sales: shift.uzcard_sales + uzcardInc,
        humo_sales: shift.humo_sales + humoInc,
        online_sales: shift.online_sales + onlineInc,
        total_sales: shift.total_sales + total,
        expected_cash: (shift.starting_cash + shift.cash_sales) + cashInc,
        order_count: shift.order_count + 1,
      });

      // bump discount usage
      if (discountCode) {
        try {
          const dc = (await base44.entities.DiscountCode.filter({ code: discountCode }))?.[0];
          if (dc) await base44.entities.DiscountCode.update(dc.id, { usage_count: (dc.usage_count || 0) + 1 });
        } catch {}
      }

      await logAction(user, 'sale_completed', `Total ${formatUZS(total)} via ${summary}. ${cart.length} items.`);

      setLastSale({ ...sale, items: cart, user_name: sale.user_name, shop_name: sale.shop_name, created_date: sale.created_date });
      setShift({ ...shift, cash_sales: shift.cash_sales + cashInc, uzcard_sales: shift.uzcard_sales + uzcardInc, humo_sales: shift.humo_sales + humoInc, online_sales: shift.online_sales + onlineInc, total_sales: shift.total_sales + total, expected_cash: (shift.starting_cash + shift.cash_sales) + cashInc, order_count: shift.order_count + 1 });
      setPayOpen(false);
      setReceiptOpen(true);
      clearCart();
    } catch (e) {
      alert('Could not complete sale: ' + (e?.message || e));
    } finally {
      setPaying(false);
    }
  };

  const openShift = async ({ shop, starting_cash }) => {
    setShiftLoading(true);
    try {
      const newShift = await base44.entities.Shift.create({
        user_id: user.id,
        user_name: user.full_name || user.email,
        shop_id: shop.id,
        shop_name: shop.name,
        status: 'open',
        opened_at: todayISO(),
        starting_cash,
        expected_cash: starting_cash,
      });
      setShift(newShift);
      setOpenShiftOpen(false);
      await logAction(user, 'shift_opened', `${shop.name}, starting cash ${formatUZS(starting_cash)}`);
    } catch (e) { alert('Could not open shift: ' + (e?.message || e)); }
    finally { setShiftLoading(false); }
  };

  const closeShift = async ({ actual_cash }) => {
    setShiftLoading(true);
    try {
      const expected = shift.expected_cash;
      await base44.entities.Shift.update(shift.id, {
        status: 'closed',
        closed_at: todayISO(),
        actual_cash,
        difference: actual_cash - expected,
      });
      await logAction(user, 'shift_closed', `${shift.shop_name}. Difference ${formatUZS(actual_cash - expected)}`);
      setShift(null);
      setCloseShiftOpen(false);
    } catch (e) { alert('Could not close shift: ' + (e?.message || e)); }
    finally { setShiftLoading(false); }
  };

  return (
    <div className="flex flex-col h-screen lg:h-screen">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-border bg-card sticky top-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-primary/15 text-primary-strong flex items-center justify-center shrink-0">
            <Building2 className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{shift?.shop_name || 'No active shift'}</div>
            <div className="text-xs text-muted-foreground truncate">
              {shift ? `${formatUZS(shift.total_sales)} · ${shift.order_count} orders` : 'Open a shift to start selling'}
            </div>
          </div>
        </div>
        <div className="flex-1" />
        {shift ? (
          <>
            <div className="hidden sm:flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">
              <Clock className="w-3.5 h-3.5" /> Shift open
            </div>
            <Button variant="outline" size="sm" onClick={() => setCloseShiftOpen(true)} className="h-9">
              Close shift
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setOpenShiftOpen(true)} className="h-9 bg-primary text-primary-foreground hover:bg-primary-strong">
            Open shift
          </Button>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Center: categories + grid */}
        <div className="flex-1 flex min-w-0">
          {/* Category rail */}
          <div className="hidden md:flex w-44 shrink-0 border-r border-border bg-sidebar/50 flex-col py-3 overflow-y-auto scrollbar-thin">
            <CatTab active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }} icon={<Search className="w-4 h-4" />} label="All" />
            <CatTab active={showFav} onClick={() => setShowFav(true)} icon={<Star className="w-4 h-4" />} label="Favorites" />
            <div className="h-px bg-border my-2 mx-3" />
            {categories.map((c) => (
              <CatTab key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }} icon={<span className="text-base">{c.icon || '🍰'}</span>} label={c.name} />
            ))}
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            {/* Search + mobile categories */}
            <div className="px-4 sm:px-5 pt-4 pb-2 space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products…" className="pl-9 h-11 rounded-xl" />
              </div>
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 md:hidden">
                <Chip active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }}>All</Chip>
                <Chip active={showFav} onClick={() => setShowFav(true)}>★ Favorites</Chip>
                {categories.map((c) => (
                  <Chip key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }}>{c.name}</Chip>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin px-4 sm:px-5 pb-6">
              {loadingData ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                  {Array.from({ length: 8 }).map((_, i) => <div key={i} className="aspect-[3/4] rounded-2xl bg-secondary animate-pulse" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-20">
                  <div className="text-5xl mb-3">🧁</div>
                  <p className="text-sm font-medium text-muted-foreground">No products found</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                  {filtered.map((p) => <ProductCard key={p.id} product={p} onAdd={addToCart} />)}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Cart */}
        <div className="hidden lg:flex w-[360px] xl:w-[400px] shrink-0 border-l border-border">
          <Cart
            cart={cart}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            total={total} onCheckout={openCheckout} disabled={!shift}
          />
        </div>
      </div>

      {/* Mobile cart button */}
      {cart.length > 0 && (
        <div className="lg:hidden sticky bottom-0 p-3 bg-card border-t border-border">
          <Button onClick={openCheckout} className="w-full h-12 text-base font-semibold bg-primary text-primary-foreground hover:bg-primary-strong">
            View order · {formatUZS(total)} ({cart.reduce((s, i) => s + i.quantity, 0)})
          </Button>
        </div>
      )}

      <PaymentModal open={payOpen} total={total} onClose={() => setPayOpen(false)} onConfirm={completeSale} loading={paying} />
      <Receipt open={receiptOpen} sale={lastSale} settings={settings} onClose={() => setReceiptOpen(false)} />
      <OpenShiftDialog open={openShiftOpen} shops={shops} onClose={() => setOpenShiftOpen(false)} onConfirm={openShift} loading={shiftLoading} />
      <CloseShiftDialog open={closeShiftOpen} shift={shift} onClose={() => setCloseShiftOpen(false)} onConfirm={closeShift} loading={shiftLoading} />
    </div>
  );
}

function CatTab({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2.5 px-4 py-2.5 mx-2 rounded-xl text-sm font-medium transition-colors text-left ${active ? 'bg-primary text-primary-foreground premium-shadow' : 'text-foreground/70 hover:bg-secondary'}`}>
      <span className="w-5 flex justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={`whitespace-nowrap px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground/70'}`}>
      {children}
    </button>
  );
}