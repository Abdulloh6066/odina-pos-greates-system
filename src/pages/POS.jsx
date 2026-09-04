import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Search, Star, Clock, Building2, Banknote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUZS } from '@/lib/pos';
import ProductCard from '@/components/pos/ProductCard';
import Cart from '@/components/pos/Cart';
import PaymentModal from '@/components/pos/PaymentModal';
import Receipt from '@/components/pos/Receipt';
import { OpenShiftDialog, CloseShiftDialog } from '@/components/pos/ShiftDialog';
import { OwnerPinDialog, CashWithdrawalDialog } from '@/components/pos/KassaActionDialogs';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

export default function POS() {
  const { user, sidebarCollapsed } = useOutletContext();

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
  const [discountApprovalOpen, setDiscountApprovalOpen] = useState(false);
  const [pendingDiscountCode, setPendingDiscountCode] = useState('');
  const [discountLoading, setDiscountLoading] = useState(false);
  const [cashWithdrawalOpen, setCashWithdrawalOpen] = useState(false);
  const [cashWithdrawalLoading, setCashWithdrawalLoading] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);

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
    setProducts((prods || []).filter((p) => p.active && p.archived !== true));
    setShops((shopList || []).filter((shop) => shop.active !== false && shop.allows_pos !== false));
    setSettings(settingsList?.[0] || null);
    const myOpen = (shifts || []).find((s) => s.user_id === user?.id && s.status === 'open');
    setShift(myOpen || null);
    setLoadingData(false);
  };

  useEffect(() => { if (user) loadAll(); }, [user]);

  const subtotal = useMemo(() => cart.reduce((s, i) => s + i.subtotal, 0), [cart]);
  const discount = useMemo(() => Math.round(subtotal * discountPct / 100), [subtotal, discountPct]);
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

  const validateDiscount = async (code, ownerPin) => {
    setDiscountLoading(true);
    try {
      const result = await base44.functions.invoke('complete-sale', {
        action: 'validate_discount',
        code,
        owner_pin: ownerPin,
      });
      const dc = result?.data || result;
      if (!dc?.code) throw new Error(dc?.error || 'Kod noto‘g‘ri yoki faol emas.');
      setDiscountPct(dc.percentage);
      setDiscountCode(dc.code);
      setDiscountError('');
      setDiscountApprovalOpen(false);
      setPendingDiscountCode('');
    } catch (e) {
      setDiscountError(e?.response?.data?.error || e?.data?.error || e?.message || 'Kodni tekshirib bo‘lmadi.');
      setDiscountApprovalOpen(false);
    } finally {
      setDiscountLoading(false);
    }
  };

  const applyDiscount = (code) => {
    const normalized = code?.trim().toUpperCase();
    if (!normalized) return;
    if (user?.role === 'cashier') {
      setPendingDiscountCode(normalized);
      setDiscountApprovalOpen(true);
      return;
    }
    validateDiscount(normalized);
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
      const result = await base44.functions.invoke('complete-sale', {
        shift_id: shift.id,
        items: cart.map((item) => ({
          product_id: item.product_id,
          quantity: item.quantity,
        })),
        discount_code: discountCode || undefined,
        payments,
      });
      const payload = result?.data || result;
      if (!payload?.sale) {
        throw new Error(payload?.error || 'Savdoni yakunlab bo‘lmadi.');
      }

      setLastSale(payload.sale);
      if (payload.shift) setShift(payload.shift);
      setPayOpen(false);
      setReceiptOpen(true);
      clearCart();
    } catch (e) {
      alert('Savdoni yakunlab bo‘lmadi: ' + (e?.message || e));
    } finally {
      setPaying(false);
    }
  };

  const openShift = async ({ shop, starting_cash }) => {
    setShiftLoading(true);
    try {
      const result = await base44.functions.invoke('complete-sale', {
        action: 'open_shift',
        shop_id: shop?.id,
        starting_cash,
      });
      const payload = result?.data || result;
      if (!payload?.shift) throw new Error(payload?.error || 'Smenani ochib bo‘lmadi.');
      setShift(payload.shift);
      setOpenShiftOpen(false);
    } catch (e) { alert('Smenani ochib bo‘lmadi: ' + (e?.message || e)); }
    finally { setShiftLoading(false); }
  };

  const closeShift = async ({ actual_cash }) => {
    setShiftLoading(true);
    try {
      const result = await base44.functions.invoke('complete-sale', {
        action: 'close_shift',
        shift_id: shift.id,
        actual_cash,
      });
      const payload = result?.data || result;
      if (!payload?.shift) throw new Error(payload?.error || 'Smenani yopib bo‘lmadi.');
      window.print();
      setShift(null);
      setCloseShiftOpen(false);
    } catch (e) { alert('Smenani yopib bo‘lmadi: ' + (e?.message || e)); }
    finally { setShiftLoading(false); }
  };

  const recordCashWithdrawal = async ({ amount, reason }) => {
    if (!shift) return;
    setCashWithdrawalLoading(true);
    try {
      const result = await base44.functions.invoke('complete-sale', {
        action: 'cash_withdrawal',
        shift_id: shift.id,
        amount,
        reason,
      });
      const payload = result?.data || result;
      if (!payload?.shift) throw new Error(payload?.error || 'Pul olishni saqlab bo‘lmadi.');
      setShift(payload.shift);
      setCashWithdrawalOpen(false);
    } catch (e) {
      alert('Pul olish amalga oshmadi: ' + (e?.response?.data?.error || e?.data?.error || e?.message || e));
    } finally {
      setCashWithdrawalLoading(false);
    }
  };

  return (
    <div className="flex flex-col w-full max-w-full h-[calc(100dvh-3.5rem)] lg:h-screen bg-background overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-6 py-2.5 sm:py-3 border-b border-border bg-card/95 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-primary/15 text-primary-strong flex items-center justify-center shrink-0">
            <Building2 className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{shift?.shop_name || 'Faol smena yo‘q'}</div>
            <div className="text-xs text-muted-foreground truncate">
              {shift ? `${formatUZS(shift.total_sales)} · ${shift.order_count} ta buyurtma` : 'Savdoni boshlash uchun smenani oching'}
            </div>
          </div>
        </div>
        <div className="flex-1" />
        {shift ? (
          <>
            <div className="hidden sm:flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">
              <Clock className="w-3.5 h-3.5" /> Smena ochiq
            </div>
            <Button variant="outline" size="sm" onClick={() => setCashWithdrawalOpen(true)} className="h-10 px-3 touch-manipulation">
              <Banknote className="w-4 h-4 sm:mr-1.5" /> <span className="hidden sm:inline">Pul olish</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCloseShiftOpen(true)} className="h-10 px-3 touch-manipulation">
              <Clock className="w-4 h-4 sm:mr-1.5" /> <span className="hidden sm:inline">Smenani yopish</span><span className="sm:hidden">Yopish</span>
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setOpenShiftOpen(true)} className="h-10 bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            Smenani ochish
          </Button>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Center: categories + grid */}
        <div className="flex-1 flex min-w-0">
          {/* Category rail */}
          <div className="hidden md:flex w-44 shrink-0 border-r border-border bg-sidebar/50 flex-col py-3 overflow-y-auto scrollbar-thin">
            <CatTab active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }} icon={<Search className="w-4 h-4" />} label="Barchasi" />
            <CatTab active={showFav} onClick={() => setShowFav(true)} icon={<Star className="w-4 h-4" />} label="Sevimlilar" />
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
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mahsulotlarni qidirish…" className="pl-9 h-11 rounded-xl" />
              </div>
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 md:hidden">
                <Chip active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }}>Barchasi</Chip>
                <Chip active={showFav} onClick={() => setShowFav(true)}>★ Sevimlilar</Chip>
                {categories.map((c) => (
                  <Chip key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }}>{c.name}</Chip>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin px-4 sm:px-5 pb-28 xl:pb-6">
              {loadingData ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                  {Array.from({ length: 8 }).map((_, i) => <div key={i} className="aspect-[3/4] rounded-2xl bg-secondary animate-pulse" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-20">
                  <div className="text-5xl mb-3">🧁</div>
                  <p className="text-sm font-medium text-muted-foreground">Mahsulot topilmadi</p>
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
        <div className="hidden xl:flex w-[380px] 2xl:w-[420px] min-w-0 shrink-0 border-l border-border overflow-hidden">
          <Cart
            cart={cart}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            total={total} onCheckout={openCheckout} disabled={!shift}
          />
        </div>
      </div>

      {/* Telefon va iPad uchun doim ko‘rinadigan buyurtma paneli */}
      <div className={`xl:hidden fixed left-0 ${sidebarCollapsed ? 'lg:left-20' : 'lg:left-64'} right-0 bottom-0 z-40 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-card/95 backdrop-blur border-t border-border transition-[left] duration-200`}>
        <Button onClick={() => setMobileCartOpen(true)} className="w-full h-14 text-base font-semibold rounded-2xl bg-primary text-primary-foreground hover:bg-primary-strong premium-shadow-lg touch-manipulation">
          Buyurtma · {formatUZS(total)} ({cart.reduce((s, i) => s + i.quantity, 0)} ta)
        </Button>
      </div>

      <Sheet open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <SheetContent side="bottom" className="xl:hidden h-[88dvh] p-0 rounded-t-[28px] overflow-hidden">
          <SheetTitle className="sr-only">Joriy buyurtma</SheetTitle>
          <Cart
            cart={cart}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            total={total} onCheckout={() => { setMobileCartOpen(false); openCheckout(); }} disabled={!shift}
          />
        </SheetContent>
      </Sheet>

      <PaymentModal open={payOpen} total={total} onClose={() => setPayOpen(false)} onConfirm={completeSale} loading={paying} />
      <Receipt open={receiptOpen} sale={lastSale} settings={settings} onClose={() => setReceiptOpen(false)} />
      <OpenShiftDialog open={openShiftOpen} shops={shops} user={user} onClose={() => setOpenShiftOpen(false)} onConfirm={openShift} loading={shiftLoading} />
      <CloseShiftDialog open={closeShiftOpen} shift={shift} onClose={() => setCloseShiftOpen(false)} onConfirm={closeShift} loading={shiftLoading} />
      <OwnerPinDialog
        open={discountApprovalOpen}
        title="Chegirmani tasdiqlash"
        description={pendingDiscountCode ? `${pendingDiscountCode} kodini qo‘llash uchun egasi tasdig‘i kerak.` : ''}
        onClose={() => { setDiscountApprovalOpen(false); setPendingDiscountCode(''); }}
        onConfirm={(pin) => validateDiscount(pendingDiscountCode, pin)}
        loading={discountLoading}
      />
      <CashWithdrawalDialog
        open={cashWithdrawalOpen}
        shift={shift}
        user={user}
        onClose={() => setCashWithdrawalOpen(false)}
        onConfirm={recordCashWithdrawal}
        loading={cashWithdrawalLoading}
      />
    </div>
  );
}

function CatTab({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2.5 px-4 py-3 mx-2 rounded-xl text-sm font-medium transition-all active:scale-[0.98] touch-manipulation text-left ${active ? 'bg-primary text-primary-foreground premium-shadow' : 'text-foreground/70 hover:bg-secondary'}`}>
      <span className="w-5 flex justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={`whitespace-nowrap min-h-11 px-4 py-2 rounded-full text-sm font-medium transition-all active:scale-[0.98] touch-manipulation ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground/70'}`}>
      {children}
    </button>
  );
}