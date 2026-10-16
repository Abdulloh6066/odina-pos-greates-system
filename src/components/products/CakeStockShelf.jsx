import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Cake, Check, ChevronLeft, ChevronRight, ClipboardCheck, History, Loader2, RefreshCw, Search, Truck, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatNum, formatUZS } from '@/lib/pos';
import { priceForShop } from '@/lib/shop-pricing';
import { formatUzbekistanDateTime, formatUzbekistanTime } from '@/lib/uzbekistan-time';
import { CAKE_STOCK_PAGE_SIZE, CAKE_STOCK_ROLES, cakeProducts, cakeStockInfo, loadAllCakeBalances, mergeCakeStockEvent, stockChange, stockShops } from '@/lib/cake-stock-shelf';
import OdinaSelect from '@/components/ui/odina-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Image } from '@/components/ui/image';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import TransfersPanel from '@/components/warehouse/TransfersPanel';
import './cake-stock-shelf.css';

function useLiveCakeBalances(shopId) {
  const [data, setData] = useState({ shopId: '', rows: [], ready: false, loading: false, error: '', updatedAt: null });
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const refreshRef = useRef(async () => false);
  useEffect(() => {
    if (!shopId) { setData({ shopId: '', rows: [], ready: false, loading: false, error: '', updatedAt: null }); return undefined; }
    let disposed = false, inflight = null, queuedEvents = [], timer = null, unsubscribe = null;
    setData({ shopId, rows: [], ready: false, loading: true, error: '', updatedAt: null });
    const refresh = () => {
      if (disposed) return Promise.resolve(false);
      if (inflight) return inflight;
      setData((state) => ({ ...state, loading: true }));
      inflight = (async () => {
        try {
          let rows = await loadAllCakeBalances(base44.entities.ProductStock, shopId);
          for (const event of queuedEvents) rows = mergeCakeStockEvent(rows, event, shopId) || rows;
          queuedEvents = [];
          if (!disposed) setData({ shopId, rows, ready: true, loading: false, error: '', updatedAt: new Date().toISOString() });
          return true;
        } catch (error) {
          if (!disposed) setData((state) => ({ ...state, loading: false, error: error?.message || 'Qoldiqni yuklab bo‘lmadi.' }));
          return false;
        } finally { inflight = null; }
      })();
      return inflight;
    };
    refreshRef.current = refresh;
    const scheduleRefresh = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 800); };
    try {
      unsubscribe = base44.entities.ProductStock.subscribe((event) => {
        if (disposed || (event?.data?.location_id && event.data.location_id !== shopId)) return;
        if (inflight) queuedEvents.push(event);
        setData((state) => {
          const merged = mergeCakeStockEvent(state.rows, event, shopId);
          if (!merged) { scheduleRefresh(); return state; }
          return { ...state, rows: merged, updatedAt: new Date().toISOString() };
        });
      });
    } catch { /* The visibility refresh and bounded polling remain available. */ }
    const resume = () => {
      const connected = navigator.onLine !== false;
      setOnline(connected);
      if (connected && document.visibilityState !== 'hidden') void refresh();
    };
    const offline = () => setOnline(false);
    const interval = setInterval(() => { if (navigator.onLine !== false && document.visibilityState !== 'hidden') void refresh(); }, 30000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    void refresh();
    return () => {
      disposed = true; clearTimeout(timer); clearInterval(interval);
      if (typeof unsubscribe === 'function') unsubscribe();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume); window.removeEventListener('offline', offline);
      refreshRef.current = async () => false;
    };
  }, [shopId]);
  return { ...(data.shopId === shopId ? data : { rows: [], ready: false, loading: Boolean(shopId), error: '', updatedAt: null }), online, refresh: useCallback(() => refreshRef.current(), []) };
}

function CakePhoto({ product, large = false }) {
  return <span className={'cake-stock-photo' + (large ? ' is-large' : '')}>
    {product.image_url ? <Image src={product.image_url} alt="" fittingType="fit" loading="lazy" decoding="async" className="h-full w-full" /> : <Cake aria-hidden="true" />}
  </span>;
}

export default function CakeStockShelf({ user, products, categories, shops }) {
  const allowedShops = useMemo(() => stockShops(shops, user), [shops, user]);
  const [selectedShopId, setSelectedShopId] = useState(() => allowedShops.find((s) => /branch/i.test(s.name))?.id || allowedShops[0]?.id || '');
  const shop = allowedShops.find((s) => s.id === selectedShopId) || allowedShops[0] || null;
  const [view, setView] = useState('shelf');
  const [entryMode, setEntryMode] = useState(false);
  const [notice, setNotice] = useState('');
  const balances = useLiveCakeBalances(shop?.id || '');
  const cakes = useMemo(() => cakeProducts(products, categories, shop?.id), [products, categories, shop?.id]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [stockFilter, setStockFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [operation, setOperation] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const shelfRef = useRef(null);
  const categoryName = (product) => categories.find((c) => c.id === (product.shop_category_ids?.[shop?.id] || product.category_id))?.name || product.category_name || 'Kategoriyasiz';
  const categoryIds = useMemo(() => [...new Set(cakes.map((p) => p.shop_category_ids?.[shop?.id] || p.category_id).filter(Boolean))], [cakes, shop?.id]);
  const visible = cakes.filter((p) => {
    const info = cakeStockInfo(balances.rows, p.id, balances.ready);
    return (category === 'all' || (p.shop_category_ids?.[shop?.id] || p.category_id) === category)
      && (!search.trim() || p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
      && (stockFilter === 'all' || (stockFilter === 'positive' ? info.status === 'positive' : ['negative', 'missing', 'invalid'].includes(info.status)));
  });
  const pageCount = Math.max(1, Math.ceil(visible.length / CAKE_STOCK_PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const pageProducts = visible.slice(activePage * CAKE_STOCK_PAGE_SIZE, (activePage + 1) * CAKE_STOCK_PAGE_SIZE);
  const selected = cakes.find((p) => p.id === selectedId) || pageProducts[0] || cakes[0] || null;
  const selectedStock = selected ? cakeStockInfo(balances.rows, selected.id, balances.ready) : null;
  const counts = cakes.reduce((result, p) => { const s = cakeStockInfo(balances.rows, p.id, balances.ready); if (s.status === 'positive') result.inStock++; if (['negative', 'missing', 'invalid'].includes(s.status)) result.needsCount++; return result; }, { inStock: 0, needsCount: 0 });
  const canChange = CAKE_STOCK_ROLES.has(user?.role) && balances.online && balances.ready && !balances.error;
  useEffect(() => { setPage(0); }, [search, category, stockFilter, shop?.id]);
  useEffect(() => { setSelectedId(''); setOperation(null); setShowHistory(false); setEntryMode(false); setNotice(''); }, [shop?.id]);
  const openOperation = (mode, product = selected) => {
    const info = product ? cakeStockInfo(balances.rows, product.id, balances.ready) : null;
    if (!product || !canChange || product.active === false || info.status === 'invalid') return;
    if (mode !== 'count' && (info.quantity == null || info.quantity < 0)) return;
    if (mode === 'out' && !(info.quantity > 0)) return;
    setNotice('');
    setOperation({ product, shop, mode, current: info.quantity, stockStatus: info.status });
  };
  const selectProduct = (product) => {
    setSelectedId(product.id); setShowHistory(false);
    if (entryMode) openOperation('in', product);
  };
  const onSaved = async (stock) => {
    setOperation(null); setHistoryVersion((version) => version + 1);
    await balances.refresh();
    if (stock?.product_id) {
      setSelectedId(stock.product_id);
      setNotice((operation?.product?.name || 'Tort') + ': qoldiq ' + formatNum(stock.quantity) + ' dona. ' + (operation?.mode === 'in' ? 'Kirim tarixga yozildi.' : 'Qoldiq saqlandi.'));
    }
  };

  if (!shop) return <div className="cake-stock-message" role="status"><AlertTriangle aria-hidden="true" /><div><strong>Do‘kon biriktirilmagan</strong><p>Tort qoldig‘ini ko‘rish uchun hisobingizga do‘kon biriktirilishi kerak.</p></div></div>;
  return <section className="cake-stock-workspace" aria-label="Tortlar jonli qoldig‘i">
    <div className="cake-stock-topbar">
      <div><span className="cake-stock-eyebrow">TORTLAR VA SHIRINLIKLAR</span><h2>Har bir tort o‘z joyida<span>.</span></h2><p>Jonli qoldiq, kelgan va ketgan mahsulotlar — bir sahifada.</p></div>
      <div className="cake-stock-shop">
        <Label htmlFor="cake-stock-shop">Do‘kon</Label>
        <OdinaSelect id="cake-stock-shop" value={shop.id} onChange={(e) => setSelectedShopId(e.target.value)} disabled={allowedShops.length < 2}>
          {allowedShops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </OdinaSelect>
      </div>
    </div>
    <div className="cake-stock-statusbar">
      <span><i className={balances.online && !balances.error ? 'is-connected' : ''} aria-hidden="true" />{!balances.online ? 'Internet yo‘q · oxirgi qoldiq' : balances.error ? 'Qoldiq yangilanmadi' : balances.ready ? 'Server bilan ulangan' : 'Qoldiq yuklanmoqda'}</span>
      {balances.updatedAt && <small>Yangilangan: {formatUzbekistanTime(balances.updatedAt, { second: '2-digit' })}</small>}
      <Button type="button" variant="outline" onClick={() => void balances.refresh()} disabled={balances.loading || !balances.online} className="min-h-10 rounded-xl"><RefreshCw className={'mr-2 h-4 w-4' + (balances.loading ? ' animate-spin' : '')} />Yangilash</Button>
    </div>
    {balances.error && <div className="cake-stock-message is-warning" role="alert"><AlertTriangle aria-hidden="true" /><p>{balances.error} Oxirgi ma’lumot ko‘rsatilishi mumkin. Kirim yoki chiqimdan oldin yangilang.</p></div>}
    {balances.ready && counts.needsCount > 0 && <div className="cake-stock-message is-warning"><ClipboardCheck aria-hidden="true" /><p><strong>{counts.needsCount} ta tort turi sanoq yoki tekshiruv talab qiladi.</strong> Manfiy qoldiq haqiqiy dona soni emas. Mahsulotni tanlab, “Haqiqiy sanoq” orqali hozirgi miqdorni kiriting.</p></div>}
    <nav className="cake-stock-tabs" aria-label="Tort ombori ko‘rinishi">
      <Button type="button" variant={view === 'shelf' && !entryMode ? 'default' : 'outline'} onClick={() => { setView('shelf'); setEntryMode(false); }} aria-pressed={view === 'shelf' && !entryMode}><Cake className="mr-2 h-4 w-4" />Tort tokchasi</Button>
      {CAKE_STOCK_ROLES.has(user?.role) && <Button type="button" variant={entryMode ? 'default' : 'outline'} onClick={() => { setView('shelf'); setEntryMode(true); setNotice(''); }} aria-pressed={entryMode} disabled={!canChange}><ArrowDownLeft className="mr-2 h-4 w-4" />Kirim kiritish</Button>}
      <Button type="button" variant={view === 'transfers' ? 'default' : 'outline'} onClick={() => { setView('transfers'); setEntryMode(false); }} aria-pressed={view === 'transfers'}><Truck className="mr-2 h-4 w-4" />Kelgan transferlar</Button>
    </nav>
    {notice && <div className="cake-stock-message cake-stock-success" role="status"><Check aria-hidden="true" /><p>{notice}</p></div>}
    {view === 'shelf' && entryMode && <div className="cake-stock-entry-guide"><ArrowDownLeft aria-hidden="true" /><div><strong>Kelgan tortning rasmini bosib qo‘shing</strong><p>1. Tortni tanlang · 2. Kelgan dona sonini kiriting · 3. Kirimni saqlang</p><small>Markazdan yuborilgan transfer uchun “Kelgan transferlar”ni oching.</small></div></div>}
    {view === 'transfers' ? <CakeIncomingTransfers key={shop.id} user={user} shop={shop} shops={shops} products={products} cakes={cakes} onBalanceRefresh={balances.refresh} /> : <>
      <div className="cake-stock-filters">
        <label className="cake-stock-search"><span className="sr-only">Tort qidirish</span><Search aria-hidden="true" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tort nomini qidiring…" /></label>
        <OdinaSelect aria-label="Tort kategoriyasi" value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">Barcha tortlar</option>{categoryIds.map((id) => <option key={id} value={id}>{categories.find((c) => c.id === id)?.name || cakes.find((p) => p.category_id === id)?.category_name || 'Kategoriyasiz'}</option>)}</OdinaSelect>
        <OdinaSelect aria-label="Qoldiq bo‘yicha saralash" value={stockFilter} onChange={(e) => setStockFilter(e.target.value)}><option value="all">Barcha qoldiqlar</option><option value="positive">Qoldig‘i bor</option><option value="review">Sanoq / tekshiruv kerak</option></OdinaSelect>
      </div>
      <div className="cake-stock-layout">
        <div className="cake-stock-board">
          <div className="cake-stock-board-heading"><div><h3>{shop.name} · tort tokchasi</h3><p>{visible.length} ta mahsulot turi</p></div><span>{balances.ready ? counts.inStock + ' turda qoldiq bor' : 'Yuklanmoqda…'}</span></div>
          <div className="cake-stock-board-scroll"><div className="cake-stock-board-inner">
            <div className="cake-stock-column-labels" aria-hidden="true">{'ABCDEFGH'.split('').map((c) => <span key={c}>{c}</span>)}</div>
            <div className="cake-stock-grid" ref={shelfRef} role="group" aria-label="8 ustunli tort tokchasi">
              {pageProducts.map((p, index) => {
                const info = cakeStockInfo(balances.rows, p.id, balances.ready);
                return <button key={p.id} type="button" data-position={index} className={'cake-stock-cell ' + info.status + (selected?.id === p.id ? ' is-selected' : '')} aria-pressed={selected?.id === p.id} aria-label={p.name + ': ' + (info.quantity == null ? info.label : formatNum(info.quantity) + ' dona, ' + info.label)} onClick={() => selectProduct(p)} onKeyDown={(e) => {
                  const col = index % 8, target = e.key === 'ArrowRight' && col < 7 ? index + 1 : e.key === 'ArrowLeft' && col > 0 ? index - 1 : e.key === 'ArrowDown' ? index + 8 : e.key === 'ArrowUp' ? index - 8 : null;
                  if (target !== null && target >= 0 && target < pageProducts.length) { e.preventDefault(); shelfRef.current?.querySelector('[data-position="' + target + '"]')?.focus(); }
                }}><CakePhoto product={p} /><strong title={p.name}>{p.name}</strong>{entryMode && <span className="cake-stock-entry-badge">{p.active === false ? 'Sotuvda emas' : ['positive', 'zero'].includes(info.status) ? '+ Kirim' : 'Sanoq kerak'}</span>}<span className="cake-stock-cell-quantity">{info.quantity == null ? (info.status === 'loading' ? '…' : '—') : formatNum(info.quantity)}<small>{info.quantity == null ? '' : ' dona'}</small></span>{['negative', 'missing', 'invalid'].includes(info.status) && <span className="cake-stock-cell-note">{info.label}</span>}</button>;
              })}
              {visible.length > 0 && Array.from({ length: CAKE_STOCK_PAGE_SIZE - pageProducts.length }, (_, i) => <div key={'empty-' + i} className="cake-stock-empty-cell" aria-hidden="true"><span>·</span></div>)}
            </div>
            {!visible.length && <div className="cake-stock-empty"><Cake aria-hidden="true" /><h3>Tort topilmadi</h3><p>Qidiruv yoki filtrni o‘zgartiring.</p></div>}
          </div></div>
          <div className="cake-stock-board-footer"><span className="cake-stock-swipe">Barcha ustunlarni ko‘rish uchun suring</span><span>{activePage + 1} / {pageCount} sahifa</span><div><Button type="button" variant="outline" size="icon" aria-label="Oldingi tortlar" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button type="button" variant="outline" size="icon" aria-label="Keyingi tortlar" disabled={activePage + 1 >= pageCount} onClick={() => setPage(activePage + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>
        </div>
        <aside className="cake-stock-detail" aria-label="Tanlangan tort">
          {selected ? <>
            <span className="cake-stock-eyebrow">{shop.name}</span><CakePhoto product={selected} large /><h3>{selected.name}</h3><p className="cake-stock-detail-category">{categoryName(selected)}</p><p className="cake-stock-detail-price">{formatUZS(priceForShop(selected, shop.id))}<small> / dona yoki bo‘lak</small></p>
            <div className={'cake-stock-balance ' + selectedStock.status}><span>Do‘kondagi qoldiq</span><strong>{selectedStock.quantity == null ? '—' : formatNum(selectedStock.quantity)}<small>{selectedStock.quantity == null ? '' : ' dona'}</small></strong><p>{selectedStock.label}</p></div>
            {canChange && selectedStock.status !== 'invalid' && <div className="cake-stock-operations">
              <Button type="button" onClick={() => openOperation('in')} disabled={selected.active === false || selectedStock.quantity == null || selectedStock.quantity < 0}><ArrowDownLeft className="mr-1.5 h-4 w-4" />Kirim</Button>
              <Button type="button" variant="outline" onClick={() => openOperation('out')} disabled={selected.active === false || !(selectedStock.quantity > 0)}><ArrowUpRight className="mr-1.5 h-4 w-4" />Chiqim</Button>
              <Button type="button" variant="outline" onClick={() => openOperation('count')} disabled={selected.active === false} className="cake-stock-count-action"><ClipboardCheck className="mr-2 h-4 w-4" />Haqiqiy sanoq</Button>
            </div>}
            {entryMode && ['negative', 'missing'].includes(selectedStock.status) && <p className="cake-stock-help cake-stock-entry-warning">Kirimdan oldin “Haqiqiy sanoq” orqali hozir mavjud tortlar sonini kiriting. Keyin kelgan tortlarni alohida kirim qiling.</p>}
            {selected.active === false && <p className="cake-stock-help">Sotuvdan olingan mahsulot. O‘zgartirish uchun katalogdagi holatini tekshiring.</p>}
            <p className="cake-stock-help">Kassa savdolari avtomatik kamayadi. Markazdan transfer kelgan bo‘lsa, “Kelgan transferlar”dan qabul qiling. Bir kirimni qayta kiritmang.</p>
            <Button type="button" variant="outline" onClick={() => setShowHistory((value) => !value)} aria-expanded={showHistory} className="w-full min-h-11"><History className="mr-2 h-4 w-4" />Kirim-chiqim tarixi</Button>
            {showHistory && <CakeMovementHistory key={shop.id + selected.id} shopId={shop.id} productId={selected.id} refreshVersion={historyVersion} />}
          </> : <div className="cake-stock-empty"><Cake aria-hidden="true" /><p>Do‘konda tort mahsuloti topilmadi.</p></div>}
        </aside>
      </div>
      <p className="cake-stock-footnote"><Check className="h-4 w-4" aria-hidden="true" />Hozircha faqat tortlar va shirinliklar. Sut va boshqa masalliqlar keyin qo‘shiladi.</p>
    </>}
    <CakeStockOperation key={operation ? operation.shop.id + operation.product.id + operation.mode : 'closed'} operation={operation} onClose={() => setOperation(null)} onSaved={onSaved} onRefresh={balances.refresh} online={balances.online} />
  </section>;
}

const MODE_LABELS = { in: 'Tort kirimi', out: 'Tort chiqimi', count: 'Haqiqiy sanoq' };
export function CakeStockOperation({ operation, onClose, onSaved, onRefresh, online }) {
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState(() => operation?.mode === 'in' ? 'Kelgan tortlar' : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  const flight = useRef(false);
  if (!operation) return null;
  const change = stockChange(operation.mode, quantity, operation.current);
  const save = async (event) => {
    event.preventDefault();
    if (flight.current || needsReview || change.error || !reason.trim() || !online) return;
    flight.current = true; setSaving(true); setError('');
    try {
      const request = {
        action: 'adjust_stock', location_id: operation.shop.id, item_kind: 'product', item_id: operation.product.id,
        movement_type: 'adjustment', expected_quantity: change.before,
        reason: MODE_LABELS[operation.mode] + ': ' + reason.trim(),
        ...(operation.mode === 'count' ? { counted_quantity: change.quantity } : { quantity_change: change.delta }),
      };
      const response = await base44.functions.invoke('warehouse-stock', request);
      const payload = response?.data || response;
      if (!payload?.stock) throw new Error(payload?.error || 'Qoldiq saqlanmadi.');
      await onSaved(payload.stock);
    } catch (problem) {
      setNeedsReview(true);
      setError((problem?.response?.data?.error || problem?.message || 'Natijani tasdiqlab bo‘lmadi.') + ' Qoldiqni tekshiring; qayta amal uchun oynani qayta oching.');
      await onRefresh();
    } finally { flight.current = false; setSaving(false); }
  };
  return <Dialog open onOpenChange={(value) => { if (!value && !flight.current) onClose(); }}>
    <DialogContent className="cake-stock-dialog sm:max-w-md max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>{MODE_LABELS[operation.mode]}</DialogTitle><p className="text-sm text-muted-foreground">{operation.product.name} · {operation.shop.name}</p></DialogHeader>
      <form onSubmit={save} className="space-y-4">
        <p className="cake-stock-operation-note">{operation.mode === 'in' ? 'Do‘konga kelgan yangi tortlar sonini kiriting. Shu miqdor mavjud qoldiqqa qo‘shiladi. Markazdan yuborilgan transferni “Kelgan transferlar” orqali qabul qiling.' : operation.mode === 'count' ? 'Hozir sanab chiqqan haqiqiy dona sonini kiriting. Eski manfiy qoldiq shu miqdorga tuzatiladi.' : 'Bu qo‘lda qoldiq tuzatish. Kassa savdosi yoki qabul qilingan transferni qayta kiritmang. Masalliqlar sarfi hisoblanmaydi.'}</p>
        <div><Label htmlFor="cake-operation-quantity">{operation.mode === 'in' ? 'Kelgan miqdor (dona)' : operation.mode === 'count' ? 'Hozir mavjud (dona)' : 'Miqdor (dona)'}</Label><Input id="cake-operation-quantity" autoFocus type="number" min={operation.mode === 'count' ? 0 : 1} step="1" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} required disabled={saving || needsReview} /></div>
        <div><Label htmlFor="cake-operation-reason">Sabab / izoh</Label><Textarea id="cake-operation-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} placeholder="Masalan: ertalabki sanoq" required disabled={saving || needsReview} /></div>
        <div className="cake-stock-operation-preview"><span>Oldingi: {operation.current == null ? 'kiritilmagan' : formatNum(operation.current) + ' dona'}</span><strong>Keyingi: {change.error ? '—' : formatNum(change.after) + ' dona'}</strong></div>
        {quantity !== '' && change.error && <p role="alert" className="text-sm text-destructive">{change.error}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!online && <p role="alert" className="text-sm text-destructive">Internet yo‘q. Qoldiqni hozir o‘zgartirib bo‘lmaydi.</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={saving}><X className="mr-2 h-4 w-4" />Yopish</Button><Button type="submit" disabled={saving || needsReview || !online || Boolean(change.error) || !reason.trim()}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{saving ? 'Saqlanmoqda…' : operation.mode === 'in' ? 'Kirimni saqlash' : 'Tarix bilan saqlash'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

const MOVEMENTS = { adjustment: 'Qo‘lda tuzatish', opening: 'Boshlang‘ich qoldiq', transfer_in: 'Kelgan transfer', transfer_out: 'Ketgan transfer', sale: 'Kassa savdosi', refund: 'Qaytarish', waste: 'Chiqit', waste_cancel: 'Chiqit bekor qilindi', production_output: 'Ishlab chiqarildi', receipt: 'Kirim', receipt_cancel: 'Kirim bekor qilindi' };
function CakeMovementHistory({ shopId, productId, refreshVersion }) {
  const [state, setState] = useState({ rows: [], loading: true, error: '' });
  useEffect(() => {
    let disposed = false;
    setState({ rows: [], loading: true, error: '' });
    base44.entities.StockMovement.filter({ location_id: shopId, item_kind: 'product', item_id: productId }, '-created_at', 20)
      .then((rows) => { if (!disposed) setState({ rows: rows || [], loading: false, error: '' }); })
      .catch(() => { if (!disposed) setState({ rows: [], loading: false, error: 'Tarix yuklanmadi. Oynani qayta oching.' }); });
    return () => { disposed = true; };
  }, [shopId, productId, refreshVersion]);
  return <div className="cake-stock-history" role="region" aria-label="Oxirgi 20 ta harakat"><p className="cake-stock-eyebrow">OXIRGI 20 TA HARAKAT</p>{state.loading ? <p>Yuklanmoqda…</p> : state.error ? <p role="alert">{state.error}</p> : !state.rows.length ? <p>Hali harakat yozilmagan.</p> : state.rows.map((row) => <div key={row.id}><span>{MOVEMENTS[row.movement_type] || row.movement_type}<small>{formatUzbekistanDateTime(row.created_at || row.created_date)}</small><small>{row.reason}</small></span><strong className={Number(row.quantity_change) < 0 ? 'is-out' : 'is-in'}>{Number(row.quantity_change) > 0 ? '+' : ''}{formatNum(row.quantity_change)}</strong></div>)}</div>;
}

function CakeIncomingTransfers({ user, shop, shops, products, cakes, onBalanceRefresh }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    if (mounted.current) { setLoading(true); setError(''); }
    try {
      const collected = [];
      for (let skip = 0; skip < 10000; skip += 500) {
        const page = await base44.entities.StockTransfer.filter({ destination_location_id: shop.id }, '-sent_at', 500, skip);
        collected.push(...(page || []));
        if (page.length < 500) {
          if (mounted.current) setRows(collected);
          return;
        }
      }
      throw new Error('Transferlar to‘liq yuklanmadi.');
    } catch (problem) { if (mounted.current) setError(problem?.message || 'Transferlar yuklanmadi.'); }
    finally { if (mounted.current) setLoading(false); }
  }, [shop.id]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  const cakeIds = new Set(cakes.map((p) => p.id));
  const batches = new Set(rows.filter((row) => cakeIds.has(row.product_id) && row.batch_id).map((row) => row.batch_id));
  const cakeRows = rows.filter((row) => cakeIds.has(row.product_id) || (row.batch_id && batches.has(row.batch_id)));
  return <div className="space-y-4"><p className="cake-stock-message">Markazdan yuborilgan tortlarni shu yerda qabul qiling. Qabul qilinganda qoldiq avtomatik oshadi.</p>{error ? <div role="alert" className="cake-stock-message is-warning"><p>{error}</p><Button type="button" variant="outline" onClick={() => void load()}>Qayta yuklash</Button></div> : loading ? <div className="cake-stock-message"><Loader2 className="h-5 w-5 animate-spin" />Transferlar yuklanmoqda…</div> : <TransfersPanel user={user} location={shop} locations={shops} products={products} productStock={[]} transfers={cakeRows} archivedProductIds={products.filter((p) => p.archived).map((p) => p.id)} search="" onReload={async () => { await Promise.all([load(), onBalanceRefresh()]); }} />}</div>;
}
