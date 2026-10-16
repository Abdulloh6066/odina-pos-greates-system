import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Cake, Check, ClipboardCheck, History, Loader2, RefreshCw, Search, Truck, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatUZS } from '@/lib/pos';
import { priceForShop } from '@/lib/shop-pricing';
import { formatUzbekistanDateTime, formatUzbekistanTime } from '@/lib/uzbekistan-time';
import { CAKE_STOCK_ROLES, cakeProducts, cakeStockColumns, allStockProducts, formatStockQuantity, INGREDIENT_SHELF_CATEGORIES, inventoryStockChange, inventoryStockInfo, inventoryUnits, loadAllCakeBalances, mergeCakeStockEvent, shelfIngredients, stockShops } from '@/lib/cake-stock-shelf';
import OdinaSelect from '@/components/ui/odina-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import TransfersPanel from '@/components/warehouse/TransfersPanel';
import './cake-stock-shelf.css';

function useLiveCakeBalances(shopId, itemKind = 'product') {
  const entityName = itemKind === 'ingredient' ? 'IngredientStock' : 'ProductStock';
  const itemIdField = itemKind === 'ingredient' ? 'ingredient_id' : 'product_id';
  const balanceKey = entityName + ':' + shopId;
  const [data, setData] = useState({ shopId: '', rows: [], ready: false, loading: false, error: '', updatedAt: null });
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const refreshRef = useRef(async () => false);
  useEffect(() => {
    if (!shopId) { setData({ shopId: '', rows: [], ready: false, loading: false, error: '', updatedAt: null }); return undefined; }
    let disposed = false, inflight = null, queuedEvents = [], timer = null, unsubscribe = null;
    setData({ shopId: balanceKey, rows: [], ready: false, loading: true, error: '', updatedAt: null });
    const refresh = () => {
      if (disposed) return Promise.resolve(false);
      if (inflight) return inflight;
      setData((state) => ({ ...state, loading: true }));
      inflight = (async () => {
        try {
          let rows = await loadAllCakeBalances(base44.entities[entityName], shopId);
          for (const event of queuedEvents) rows = mergeCakeStockEvent(rows, event, shopId, itemIdField) || rows;
          queuedEvents = [];
          if (!disposed) setData({ shopId: balanceKey, rows, ready: true, loading: false, error: '', updatedAt: new Date().toISOString() });
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
      unsubscribe = base44.entities[entityName].subscribe((event) => {
        if (disposed || (event?.data?.location_id && event.data.location_id !== shopId)) return;
        if (inflight) queuedEvents.push(event);
        setData((state) => {
          const merged = mergeCakeStockEvent(state.rows, event, shopId, itemIdField);
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
  }, [shopId, entityName, itemIdField, balanceKey]);
  return { ...(data.shopId === balanceKey ? data : { rows: [], ready: false, loading: Boolean(shopId), error: '', updatedAt: null }), online, refresh: useCallback(() => refreshRef.current(), []) };
}

function CakeSymbol({ large = false }) {
  return <span className={'cake-stock-symbol' + (large ? ' is-large' : '')} aria-hidden="true">
    <svg viewBox="0 0 120 120" focusable="false">
      <ellipse cx="60" cy="89" rx="40" ry="8" fill="#ece9df" />
      <path d="M25 53h70v29c0 14-70 14-70 0z" fill="#ddc69a" />
      <path d="M25 64c16 8 54 8 70 0v8c-16 8-54 8-70 0z" fill="#fff4d8" opacity=".8" />
      <ellipse cx="60" cy="53" rx="35" ry="15" fill="#ddc69a" />
      <ellipse cx="60" cy="49" rx="33" ry="12" fill="#fff3d9" opacity=".7" />
      <path d="M37 49q23-19 46 0" stroke="#ddc69a" fill="none" strokeWidth="3" />
      <circle cx="55" cy="39" r="5" fill="#6d7c46" />
      <circle cx="64" cy="38" r="5" fill="#99a95d" />
    </svg>
  </span>;
}


function InventorySymbol({ product, large = false }) {
  if (product?.stock_kind !== 'ingredient') return <CakeSymbol large={large} />;
  const milk = product.category_id === 'ingredient-milk';
  const coffee = product.category_id === 'ingredient-coffee';
  const liquid = product.base_unit === 'ml';
  return <span className={'cake-stock-symbol' + (large ? ' is-large' : '')} aria-hidden="true">
    <svg viewBox="0 0 120 120" focusable="false">
      <ellipse cx="60" cy="94" rx="32" ry="6" fill="#ece9df" />
      {milk ? <>
        <path d="M44 20h32v16l7 15v38q0 6-6 6H43q-6 0-6-6V51l7-15z" fill="#f7f0dc" stroke="#c8b88d" strokeWidth="2" />
        <path d="M44 20h32v12H44z" fill="#9ba96c" />
        <path d="M37 57h46v25H37z" fill="#dce6cb" />
        <path d="M60 61q-15 15-9 20q9 9 18 0q6-5-9-20z" fill="#fffefa" />
      </> : coffee ? <>
        <path d="M39 27h42l7 61q0 7-9 7H41q-9 0-9-7z" fill="#ddc69a" />
        <path d="M39 27h42v8H39z" fill="#a18a64" />
        <ellipse cx="60" cy="63" rx="14" ry="20" transform="rotate(30 60 63)" fill="#806149" />
        <path d="M67 47q-16 13-13 33" stroke="#ead8b5" strokeWidth="3" fill="none" />
      </> : liquid ? <>
        <path d="M49 20h22v20l12 16v33q0 6-6 6H43q-6 0-6-6V56l12-16z" fill="#e5d8b4" stroke="#b6a575" strokeWidth="2" />
        <path d="M48 19h24v12H48z" fill="#9ba96c" />
        <rect x="38" y="60" width="44" height="22" rx="3" fill="#f8f2df" />
        <path d="M52 72h16" stroke="#b6a575" strokeWidth="3" strokeLinecap="round" />
      </> : <>
        <path d="M25 43l35-18 35 18v40L60 99 25 83z" fill="#e6d5ad" />
        <path d="M25 43l35 17 35-17-35-18z" fill="#f1e5c7" />
        <path d="M60 60v39M25 43l35 17 35-17" fill="none" stroke="#c5af7d" strokeWidth="2" />
        <path d="M43 34l35 17v17l-12 6V57L31 40z" fill="#a3ae7d" />
      </>}
    </svg>
  </span>;
}

export default function CakeStockShelf({ user, products, categories, shops, ingredients = [] }) {
  const allowedShops = useMemo(() => stockShops(shops, user), [shops, user]);
  const [selectedShopId, setSelectedShopId] = useState(() => allowedShops.find((s) => /branch/i.test(s.name))?.id || allowedShops[0]?.id || '');
  const shop = allowedShops.find((s) => s.id === selectedShopId) || allowedShops[0] || null;
  const [view, setView] = useState('shelf');
  const [entryMode, setEntryMode] = useState(false);
  const [notice, setNotice] = useState('');
  const [scope, setScope] = useState('cakes');
  const isIngredient = scope === 'ingredients';
  const noun = scope === 'cakes' ? 'Tort' : 'Mahsulot';
  const plural = scope === 'cakes' ? 'Tortlar' : 'Mahsulotlar';
  const shelfCategories = isIngredient ? INGREDIENT_SHELF_CATEGORIES : categories;
  const balances = useLiveCakeBalances(shop?.id || '', isIngredient ? 'ingredient' : 'product');
  const cakes = useMemo(() => isIngredient ? shelfIngredients(ingredients)
    : scope === 'cakes' ? cakeProducts(products, categories, shop?.id) : allStockProducts(products, categories, shop?.id),
  [products, categories, ingredients, shop?.id, scope, isIngredient]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [stockFilter, setStockFilter] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [operation, setOperation] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const shelfRef = useRef(null);
  const categoryName = (product) => shelfCategories.find((c) => c.id === (product.shop_category_ids?.[shop?.id] || product.category_id))?.name || product.category_name || 'Kategoriyasiz';
  const categoryIds = useMemo(() => [...new Set(cakes.map((p) => p.shop_category_ids?.[shop?.id] || p.category_id).filter(Boolean))], [cakes, shop?.id]);
  const visible = cakes.filter((p) => {
    const info = inventoryStockInfo(balances.rows, p, balances.ready);
    return (category === 'all' || (p.shop_category_ids?.[shop?.id] || p.category_id) === category)
      && (!search.trim() || p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
      && (stockFilter === 'all' || (stockFilter === 'positive' ? info.status === 'positive' : ['negative', 'missing', 'invalid'].includes(info.status)));
  });
  const columns = cakeStockColumns(visible, shelfCategories, shop?.id);
  const shelfProducts = columns.flatMap((column) => column.products);

  const scrollRef = useRef(null);
  const dragRef = useRef(null);
  const blockClickRef = useRef(false);
  const clickResetRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => { clearTimeout(clickResetRef.current); dragRef.current = null; }, []);
  useEffect(() => {
    dragRef.current = null;
    setDragging(false);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [search, category, stockFilter, shop?.id, scope, view]);

  const startShelfDrag = (event) => {
    // Touch keeps the browser's native scrolling and pinch zoom.
    if (!['mouse', 'pen'].includes(event.pointerType) || event.button !== 0 || event.isPrimary === false) return;
    clearTimeout(clickResetRef.current);
    blockClickRef.current = false;
    const viewport = event.currentTarget;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      scrollLeft: viewport.scrollLeft, maxScroll: Math.max(0, viewport.scrollWidth - viewport.clientWidth),
      moved: false, horizontal: false };
  };
  const moveShelfDrag = (event) => {
    const gesture = dragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < 7) return;
      gesture.moved = true;
      gesture.horizontal = Math.abs(dx) > Math.abs(dy);
      blockClickRef.current = true;
      if (gesture.horizontal) {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
      }
    }
    if (!gesture.horizontal) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = Math.max(0, Math.min(gesture.maxScroll, gesture.scrollLeft - dx));
  };
  const finishShelfDrag = (event) => {
    const gesture = dragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    const viewport = event.currentTarget;
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    // The browser dispatches the release click before this timer. A later
    // intentional click must still select a product or open its receipt form.
    clickResetRef.current = setTimeout(() => { blockClickRef.current = false; }, 0);
  };
  const blockDraggedClick = (event) => {
    if (blockClickRef.current && event.detail !== 0) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const selected = shelfProducts.find((p) => p.id === selectedId) || shelfProducts[0] || null;
  const selectedStock = selected ? inventoryStockInfo(balances.rows, selected, balances.ready) : null;
  const counts = cakes.reduce((result, p) => { const s = inventoryStockInfo(balances.rows, p, balances.ready); if (s.status === 'positive') result.inStock++; if (['negative', 'missing', 'invalid'].includes(s.status)) result.needsCount++; return result; }, { inStock: 0, needsCount: 0 });
  const canChange = CAKE_STOCK_ROLES.has(user?.role) && balances.online && balances.ready && !balances.error;
  useEffect(() => { setSelectedId(''); setOperation(null); setShowHistory(false); setEntryMode(false); setNotice(''); setCategory('all'); setSearch(''); setStockFilter('all'); setView('shelf'); }, [shop?.id, scope]);
  const openOperation = (mode, product = selected) => {
    const info = product ? inventoryStockInfo(balances.rows, product, balances.ready) : null;
    if (!product || !canChange || product.active === false || info.status === 'invalid') return;
    if (mode !== 'count' && (info.quantity == null || info.quantity < 0)) return;
    if (mode === 'out' && !(info.quantity > 0)) return;
    setNotice('');
    setOperation({ product, shop, mode, scope, current: info.quantity, stockStatus: info.status });
  };
  const selectProduct = (product) => {
    setSelectedId(product.id); setShowHistory(false);
    if (entryMode) openOperation('in', product);
  };
  const onSaved = async (stock) => {
    setOperation(null); setHistoryVersion((version) => version + 1);
    await balances.refresh();
    if (stock?.ingredient_id || stock?.product_id) {
      setSelectedId(stock.ingredient_id || stock.product_id);
      setNotice((operation?.product?.name || 'Mahsulot') + ': qoldiq ' + formatStockQuantity(stock.quantity, operation?.product) + ' ' + inventoryUnits(operation?.product).label + '. ' + (operation?.mode === 'in' ? 'Kirim tarixga yozildi.' : 'Qoldiq saqlandi.'));
    }
  };

  if (!shop) return <div className="cake-stock-message" role="status"><AlertTriangle aria-hidden="true" /><div><strong>Do‘kon biriktirilmagan</strong><p>Qoldiqni ko‘rish uchun hisobingizga do‘kon biriktirilishi kerak.</p></div></div>;
  return <section className="cake-stock-workspace" aria-label="Mahsulotlar jonli qoldig‘i">
    <div className="cake-stock-topbar">
      <div className="cake-stock-shop">
        <Label htmlFor="cake-stock-shop">Do‘kon</Label>
        <OdinaSelect id="cake-stock-shop" value={shop.id} onChange={(e) => setSelectedShopId(e.target.value)} disabled={allowedShops.length < 2}>
          {allowedShops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </OdinaSelect>
      </div>
    </div>
    <nav className="cake-stock-scopes" aria-label="Qoldiq mahsulot turi">
      {[['cakes', 'Tortlar'], ['ingredients', 'Sut, kofe va masalliqlar'], ['products', 'Barcha tayyor mahsulotlar']].map(([id, label]) =>
        <Button key={id} type="button" variant={scope === id ? 'default' : 'outline'} aria-pressed={scope === id} onClick={() => setScope(id)}>{label}</Button>)}
    </nav>
    <div className="cake-stock-statusbar">
      <span><i className={balances.online && !balances.error ? 'is-connected' : ''} aria-hidden="true" />{!balances.online ? 'Internet yo‘q · oxirgi qoldiq' : balances.error ? 'Qoldiq yangilanmadi' : balances.ready ? 'Server bilan ulangan' : 'Qoldiq yuklanmoqda'}</span>
      {balances.updatedAt && <small>Yangilangan: {formatUzbekistanTime(balances.updatedAt, { second: '2-digit' })}</small>}
      <Button type="button" variant="outline" onClick={() => void balances.refresh()} disabled={balances.loading || !balances.online} className="min-h-10 rounded-xl"><RefreshCw className={'mr-2 h-4 w-4' + (balances.loading ? ' animate-spin' : '')} />Yangilash</Button>
    </div>
    {balances.error && <div className="cake-stock-message is-warning" role="alert"><AlertTriangle aria-hidden="true" /><p>{balances.error} Oxirgi ma’lumot ko‘rsatilishi mumkin. Kirim yoki chiqimdan oldin yangilang.</p></div>}
    <nav className="cake-stock-tabs" aria-label="Tort ombori ko‘rinishi">
      <Button type="button" variant={view === 'shelf' && !entryMode ? 'default' : 'outline'} onClick={() => { setView('shelf'); setEntryMode(false); }} aria-pressed={view === 'shelf' && !entryMode}><Cake className="mr-2 h-4 w-4" />{scope === 'cakes' ? 'Tort tokchasi' : 'Mahsulotlar tokchasi'}</Button>
      {CAKE_STOCK_ROLES.has(user?.role) && <Button type="button" variant={entryMode ? 'default' : 'outline'} onClick={() => { setView('shelf'); setEntryMode(true); setNotice(''); }} aria-pressed={entryMode} disabled={!canChange}><ArrowDownLeft className="mr-2 h-4 w-4" />Kirim kiritish</Button>}
      {!isIngredient && <Button type="button" variant={view === 'transfers' ? 'default' : 'outline'} onClick={() => { setView('transfers'); setEntryMode(false); }} aria-pressed={view === 'transfers'}><Truck className="mr-2 h-4 w-4" />Kelgan transferlar</Button>}
    </nav>
    {notice && <div className="cake-stock-message cake-stock-success" role="status"><Check aria-hidden="true" /><p>{notice}</p></div>}
    {view === 'shelf' && entryMode && <div className="cake-stock-entry-guide"><ArrowDownLeft aria-hidden="true" /><div><strong>{noun}ni tanlab kirim qo‘shing</strong><p>1. {noun}ni tanlang · 2. Kelgan miqdorni kiriting · 3. Kirimni saqlang</p><small>{isIngredient ? 'Hisob-faktura va to‘lov bilan kirim uchun Ombor → Kirim va qarzlar bo‘limidan foydalaning.' : 'Markazdan yuborilgan transfer uchun “Kelgan transferlar”ni oching.'}</small></div></div>}
    {view === 'transfers' && !isIngredient ? <CakeIncomingTransfers key={shop.id} user={user} shop={shop} shops={shops} products={products} cakes={cakes} onBalanceRefresh={balances.refresh} /> : <>
      <div className="cake-stock-filters">
        <label className="cake-stock-search"><span className="sr-only">{noun} qidirish</span><Search aria-hidden="true" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={noun + " nomini qidiring…"} /></label>
        <OdinaSelect aria-label={noun + " kategoriyasi"} value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">Barcha {plural.toLocaleLowerCase()}</option>{categoryIds.map((id) => <option key={id} value={id}>{shelfCategories.find((c) => c.id === id)?.name || cakes.find((p) => p.category_id === id)?.category_name || 'Kategoriyasiz'}</option>)}</OdinaSelect>
        <OdinaSelect aria-label="Qoldiq bo‘yicha saralash" value={stockFilter} onChange={(e) => setStockFilter(e.target.value)}><option value="all">Barcha qoldiqlar</option><option value="positive">Qoldig‘i bor</option><option value="review">Sanoq / tekshiruv kerak</option></OdinaSelect>
      </div>
      <div className="cake-stock-layout">
        <div className="cake-stock-board">
          <div className="cake-stock-board-heading"><div><h3>{shop.name} · {scope === 'cakes' ? 'tort tokchasi' : 'mahsulotlar tokchasi'}</h3><p>{visible.length} ta mahsulot turi</p></div><span>{balances.ready ? counts.inStock + ' turda qoldiq bor' : 'Yuklanmoqda…'}</span></div>
          <div className={'cake-stock-board-scroll cake-stock-category-scroll' + (dragging ? ' is-dragging' : '')} ref={scrollRef}
            onPointerDown={startShelfDrag} onPointerMove={moveShelfDrag} onPointerUp={finishShelfDrag}
            onPointerCancel={finishShelfDrag} onLostPointerCapture={finishShelfDrag}
            onClickCapture={blockDraggedClick} onDragStart={(event) => event.preventDefault()} aria-describedby="cake-stock-drag-help"
            role="region" aria-label="Mahsulotlar tokchasini surish" tabIndex={0}>
            {visible.length > 0 ? <div className="cake-stock-category-rows" ref={shelfRef} role="group" aria-label={"Kategoriyalar bo‘yicha " + noun.toLocaleLowerCase() + " tokchasi"}>
              {columns.map((column, categoryIndex) => <section key={column.id} className="cake-stock-category-row" aria-label={column.name}>
                <h4 className="cake-stock-category-heading">{column.name}<span>{column.products.length} tur</span></h4>
                <div className="cake-stock-category-items">
                  {column.products.map((p, productIndex) => {
                    const info = inventoryStockInfo(balances.rows, p, balances.ready);
                    return <button key={p.id} type="button" data-column={productIndex} data-row={categoryIndex} className={'cake-stock-cell ' + info.status + (selected?.id === p.id ? ' is-selected' : '')} aria-pressed={selected?.id === p.id} aria-label={p.name + ': ' + (info.quantity == null ? info.label : formatStockQuantity(info.quantity, p) + ' ' + inventoryUnits(p).label + ', ' + info.label)} onClick={() => selectProduct(p)} onKeyDown={(e) => {
                      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
                      const nextRow = e.key === 'ArrowDown' ? categoryIndex + 1 : e.key === 'ArrowUp' ? categoryIndex - 1 : categoryIndex;
                      const adjacent = columns[nextRow];
                      const nextColumn = e.key === 'ArrowRight' ? productIndex + 1 : e.key === 'ArrowLeft' ? productIndex - 1
                        : Math.min(productIndex, (adjacent?.products.length || 0) - 1);
                      if (!adjacent?.products[nextColumn]) return;
                      e.preventDefault();
                      shelfRef.current?.querySelector('[data-column="' + nextColumn + '"][data-row="' + nextRow + '"]')?.focus();
                    }}><InventorySymbol product={p} /><strong title={p.name}>{p.name}</strong><span className="cake-stock-cell-quantity">{info.quantity == null ? (info.status === 'loading' ? '…' : '—') : formatStockQuantity(info.quantity, p)}<small>{info.quantity == null ? '' : ' ' + inventoryUnits(p).label}</small></span>{entryMode ? <span className="cake-stock-entry-badge">{p.active === false ? 'Sotuvda emas' : ['positive', 'zero'].includes(info.status) ? '+ Kirim' : 'Sanoq kerak'}</span> : <span className="cake-stock-cell-note">{['negative', 'missing', 'invalid'].includes(info.status) ? info.label : '\u00a0'}</span>}</button>;
                  })}
                </div>
              </section>)}
            </div> : <div className="cake-stock-empty"><Cake aria-hidden="true" /><h3>{noun} topilmadi</h3><p>Qidiruv yoki filtrni o‘zgartiring.</p></div>}
          </div>
          <div className="cake-stock-board-footer"><span className="cake-stock-swipe" id="cake-stock-drag-help">Mahsulotlarni ko‘rish uchun ushlab o‘ng-chapga suring<span className="sr-only">. Mahsulotlar orasida klaviaturaning yo‘nalish tugmalari bilan yuring.</span></span></div>
        </div>
        <aside className="cake-stock-detail" aria-label={"Tanlangan " + noun.toLocaleLowerCase()}>
          {selected ? <>
            <span className="cake-stock-eyebrow">{shop.name}</span><InventorySymbol product={selected} large /><h3>{selected.name}</h3><p className="cake-stock-detail-category">{categoryName(selected)}</p>{isIngredient ? <p className="cake-stock-detail-price"><small>Hisob birligi: </small>{inventoryUnits(selected).label}</p> : <p className="cake-stock-detail-price">{formatUZS(priceForShop(selected, shop.id))}<small> / dona yoki bo‘lak</small></p>}
            <div className={'cake-stock-balance ' + selectedStock.status}><span>Do‘kondagi qoldiq</span><strong>{selectedStock.quantity == null ? '—' : formatStockQuantity(selectedStock.quantity, selected)}<small>{selectedStock.quantity == null ? '' : ' ' + inventoryUnits(selected).label}</small></strong><p>{selectedStock.label}</p></div>
            {canChange && selectedStock.status !== 'invalid' && <div className="cake-stock-operations">
              <Button type="button" onClick={() => openOperation('in')} disabled={selected.active === false || selectedStock.quantity == null || selectedStock.quantity < 0}><ArrowDownLeft className="mr-1.5 h-4 w-4" />Kirim</Button>
              <Button type="button" variant="outline" onClick={() => openOperation('out')} disabled={selected.active === false || !(selectedStock.quantity > 0)}><ArrowUpRight className="mr-1.5 h-4 w-4" />Chiqim</Button>
              <Button type="button" variant="outline" onClick={() => openOperation('count')} disabled={selected.active === false} className="cake-stock-count-action"><ClipboardCheck className="mr-2 h-4 w-4" />Haqiqiy sanoq</Button>
            </div>}
            {entryMode && ['negative', 'missing'].includes(selectedStock.status) && <p className="cake-stock-help cake-stock-entry-warning">Kirimdan oldin “Haqiqiy sanoq” orqali hozir mavjud miqdorni kiriting. Keyin kelgan mahsulotlarni alohida kirim qiling.</p>}
            {selected.active === false && <p className="cake-stock-help">Sotuvdan olingan mahsulot. O‘zgartirish uchun katalogdagi holatini tekshiring.</p>}
            <p className="cake-stock-help">{isIngredient ? 'Bu qoldiq ombordagi masalliq bilan bir xil. Yetkazib beruvchi, narx va to‘lov bilan kirimni Ombor → Kirim va qarzlar orqali kiriting. Bir kirimni qayta kiritmang.' : 'Kassa savdolari avtomatik kamayadi. Markazdan transfer kelgan bo‘lsa, “Kelgan transferlar”dan qabul qiling. Bir kirimni qayta kiritmang.'}</p>
            <Button type="button" variant="outline" onClick={() => setShowHistory((value) => !value)} aria-expanded={showHistory} className="w-full min-h-11"><History className="mr-2 h-4 w-4" />Kirim-chiqim tarixi</Button>
            {showHistory && <CakeMovementHistory key={shop.id + selected.id} shopId={shop.id} productId={selected.id} item={selected} refreshVersion={historyVersion} />}
          </> : <div className="cake-stock-empty"><Cake aria-hidden="true" /><p>Do‘konda tort mahsuloti topilmadi.</p></div>}
        </aside>
      </div>
      <p className="cake-stock-footnote"><Check className="h-4 w-4" aria-hidden="true" />{isIngredient ? 'Sut litrda, og‘irlik kg yoki grammda, qadoqlar donada hisoblanadi. Qoldiq mavjud ombor bilan bir xil.' : 'Retseptli ichimlik va taomlar uchun masalliqlar qoldig‘ini “Sut, kofe va masalliqlar” bo‘limida kiriting.'}</p>
    </>}
    <CakeStockOperation key={operation ? operation.shop.id + (operation.product.stock_kind || 'product') + operation.product.id + operation.mode : 'closed'} operation={operation} onClose={() => setOperation(null)} onSaved={onSaved} onRefresh={balances.refresh} online={balances.online} />
  </section>;
}

const MODE_LABELS = { in: 'Tort kirimi', out: 'Tort chiqimi', count: 'Haqiqiy sanoq' };
export function CakeStockOperation({ operation, onClose, onSaved, onRefresh, online }) {
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState(() => operation?.mode === 'in' ? (operation?.scope === 'cakes' ? 'Kelgan tortlar' : 'Kelgan mahsulotlar') : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  const flight = useRef(false);
  if (!operation) return null;
  const units = inventoryUnits(operation.product);
  const labels = operation.scope === 'cakes' ? MODE_LABELS : { in: 'Mahsulot kirimi', out: 'Mahsulot chiqimi', count: 'Haqiqiy sanoq' };
  const change = inventoryStockChange(operation.mode, quantity, operation.current, operation.product);
  const save = async (event) => {
    event.preventDefault();
    if (flight.current || needsReview || change.error || !reason.trim() || !online) return;
    flight.current = true; setSaving(true); setError('');
    try {
      const request = {
        action: 'adjust_stock', location_id: operation.shop.id, item_kind: operation.product.stock_kind || 'product', item_id: operation.product.id,
        movement_type: 'adjustment', expected_quantity: change.before,
        reason: labels[operation.mode] + ': ' + reason.trim(),
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
      <DialogHeader><DialogTitle>{labels[operation.mode]}</DialogTitle><p className="text-sm text-muted-foreground">{operation.product.name} · {operation.shop.name}</p></DialogHeader>
      <form onSubmit={save} className="space-y-4">
        <p className="cake-stock-operation-note">{operation.mode === 'in' ? 'Kelgan miqdorni ' + units.label + 'da kiriting. Shu miqdor mavjud qoldiqqa qo‘shiladi. Hisob-faktura bilan kirimni Ombor → Kirim va qarzlar orqali, yuborilgan transferni “Kelgan transferlar” orqali qabul qiling.' : operation.mode === 'count' ? 'Hozir mavjud haqiqiy miqdorni ' + units.label + 'da kiriting. Eski qoldiq shu miqdorga tuzatiladi.' : 'Qo‘lda chiqim qoldiqni kamaytiradi va tarixga yoziladi. Kassa savdosi yoki qabul qilingan transferni qayta kiritmang.'}</p>
        <div><Label htmlFor="cake-operation-quantity">{(operation.mode === 'in' ? 'Kelgan miqdor' : operation.mode === 'count' ? 'Hozir mavjud' : 'Miqdor') + ' (' + units.label + ')'}</Label><Input id="cake-operation-quantity" autoFocus type="number" min={operation.mode === 'count' ? 0 : units.step} step={units.step} inputMode={units.step === 1 ? 'numeric' : 'decimal'} value={quantity} onChange={(e) => setQuantity(e.target.value)} required disabled={saving || needsReview} /></div>
        <div><Label htmlFor="cake-operation-reason">Sabab / izoh</Label><Textarea id="cake-operation-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} placeholder="Masalan: ertalabki sanoq" required disabled={saving || needsReview} /></div>
        <div className="cake-stock-operation-preview"><span>Oldingi: {operation.current == null ? 'kiritilmagan' : formatStockQuantity(operation.current, operation.product) + ' ' + units.label}</span><strong>Keyingi: {change.error ? '—' : formatStockQuantity(change.after, operation.product) + ' ' + units.label}</strong></div>
        {quantity !== '' && change.error && <p role="alert" className="text-sm text-destructive">{change.error}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!online && <p role="alert" className="text-sm text-destructive">Internet yo‘q. Qoldiqni hozir o‘zgartirib bo‘lmaydi.</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={saving}><X className="mr-2 h-4 w-4" />Yopish</Button><Button type="submit" disabled={saving || needsReview || !online || Boolean(change.error) || !reason.trim()}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{saving ? 'Saqlanmoqda…' : operation.mode === 'in' ? 'Kirimni saqlash' : 'Tarix bilan saqlash'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

const MOVEMENTS = { adjustment: 'Qo‘lda tuzatish', opening: 'Boshlang‘ich qoldiq', transfer_in: 'Kelgan transfer', transfer_out: 'Ketgan transfer', sale: 'Kassa savdosi', refund: 'Qaytarish', waste: 'Chiqit', waste_cancel: 'Chiqit bekor qilindi', production_output: 'Ishlab chiqarildi', receipt: 'Kirim', receipt_cancel: 'Kirim bekor qilindi' };
function CakeMovementHistory({ shopId, productId, item, refreshVersion }) {
  const [state, setState] = useState({ rows: [], loading: true, error: '' });
  useEffect(() => {
    let disposed = false;
    setState({ rows: [], loading: true, error: '' });
    base44.entities.StockMovement.filter({ location_id: shopId, item_kind: item?.stock_kind || 'product', item_id: productId }, '-created_at', 20)
      .then((rows) => { if (!disposed) setState({ rows: rows || [], loading: false, error: '' }); })
      .catch(() => { if (!disposed) setState({ rows: [], loading: false, error: 'Tarix yuklanmadi. Oynani qayta oching.' }); });
    return () => { disposed = true; };
  }, [shopId, productId, item?.stock_kind, refreshVersion]);
  return <div className="cake-stock-history" role="region" aria-label="Oxirgi 20 ta harakat"><p className="cake-stock-eyebrow">OXIRGI 20 TA HARAKAT</p>{state.loading ? <p>Yuklanmoqda…</p> : state.error ? <p role="alert">{state.error}</p> : !state.rows.length ? <p>Hali harakat yozilmagan.</p> : state.rows.map((row) => <div key={row.id}><span>{MOVEMENTS[row.movement_type] || row.movement_type}<small>{formatUzbekistanDateTime(row.created_at || row.created_date)}</small><small>{row.reason}</small></span><strong className={Number(row.quantity_change) < 0 ? 'is-out' : 'is-in'}>{Number(row.quantity_change) > 0 ? '+' : ''}{formatStockQuantity(row.quantity_change, item)} {inventoryUnits(item).label}</strong></div>)}</div>;
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
