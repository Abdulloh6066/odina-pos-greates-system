import React, { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Search, Star } from 'lucide-react';
import { Input } from '@/components/ui/input';
import CategoryIcon from '@/components/CategoryIcon';
import ProductGrid from '@/components/pos/ProductGrid';
import { pricePosProducts, preparePosCatalog, selectPosProducts } from '@/lib/pos-catalog';

// Browsing is local to this subtree. Category/search updates never rerender
// the basket or checkout; stock, prices and checkout locks still arrive as props.
const PosCatalog = forwardRef(function PosCatalog({ products, categories, visibleCategories, shopId,
  productOrder, stockByProduct, showStock, onAdd, disabled, loading }, ref) {
  const [activeCat, setActiveCat] = useState('all');
  const [search, setSearch] = useState('');
  const [showFav, setShowFav] = useState(false);
  const pricedProducts = useMemo(() => pricePosProducts(products, shopId), [products, shopId]);
  const catalog = useMemo(() => preparePosCatalog(pricedProducts, categories, shopId, productOrder),
    [pricedProducts, categories, shopId, productOrder]);
  const filtered = useMemo(() => selectPosProducts(catalog, { activeCat, showFav, search }),
    [catalog, activeCat, showFav, search]);

  useEffect(() => {
    if (activeCat !== 'all' && categories.length && !visibleCategories.some(category => category.id === activeCat)) setActiveCat('all');
  }, [activeCat, categories.length, visibleCategories]);
  useImperativeHandle(ref, () => ({
    reset() { setActiveCat('all'); setShowFav(false); setSearch(''); },
    getInitialCategory: () => showFav ? 'all' : activeCat,
  }), [activeCat, showFav]);

  const chooseCategory = id => { setActiveCat(id); setShowFav(false); };
  return <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
    <div className="odina-category-rail hidden md:flex w-36 shrink-0 border-r border-border bg-sidebar/50 flex-col py-3 overflow-y-auto scrollbar-thin">
      <p className="odina-category-title">KATEGORIYALAR</p>
      <CatTab active={activeCat === 'all' && !showFav} onClick={() => chooseCategory('all')} icon={<Search className="w-4 h-4" />} label="Barchasi" />
      <CatTab active={showFav} onClick={() => setShowFav(true)} icon={<Star className="w-4 h-4" />} label="Sevimlilar" />
      <div className="h-px bg-border my-2 mx-3" />
      {visibleCategories.map(category => <CatTab key={category.id} active={activeCat === category.id && !showFav}
        onClick={() => chooseCategory(category.id)} icon={<CategoryIcon icon={category.icon} className="text-base" imgClassName="w-5 h-5" />}
        label={category.name.replaceAll('&', ' & ')} />)}
    </div>
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
      <div className="odina-pos-search px-4 sm:px-5 pt-4 pb-2 space-y-3">
        <div className="odina-catalog-toolbar">
          <h1>Mahsulotlar</h1>
          <div className="odina-catalog-search relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input aria-label="Mahsulotlarni qidirish" value={search} onChange={event => setSearch(event.target.value)} placeholder="Mahsulotlarni qidirish…" className="pl-9 h-11 rounded-xl" />
          </div>
          {!loading && <span className="odina-catalog-count">{filtered.length} ta mahsulot</span>}
        </div>
        <div className="odina-category-chips flex gap-2 overflow-x-auto no-scrollbar pb-1 md:hidden">
          <Chip active={activeCat === 'all' && !showFav} onClick={() => chooseCategory('all')}>Barchasi</Chip>
          <Chip active={showFav} onClick={() => setShowFav(true)}><Star className="h-4 w-4" aria-hidden="true" /> Sevimlilar</Chip>
          {visibleCategories.map(category => <Chip key={category.id} active={activeCat === category.id && !showFav}
            onClick={() => chooseCategory(category.id)}>{category.name.replaceAll('&', ' & ')}</Chip>)}
        </div>
      </div>
      <div role="region" aria-label="Kassadagi mahsulotlar" tabIndex={0} className="odina-product-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-4 sm:px-5 pb-20 lg:pb-6">
        <ProductGrid products={filtered} shopId={shopId} stockByProduct={stockByProduct} showStock={showStock}
          onAdd={onAdd} disabled={disabled} loading={loading} />
      </div>
    </div>
  </div>;
});

export default memo(PosCatalog);

function CatTab({ active, onClick, icon, label }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`odina-category-tab flex items-center gap-2.5 px-3 py-3 mx-2 min-h-11 border rounded-xl text-sm font-medium transition-all active:scale-[0.98] touch-manipulation text-left ${active ? 'bg-primary/35 text-brand-ink border-brand-sand' : 'text-muted-foreground hover:bg-secondary border-transparent'}`}>
    <span className="w-5 flex justify-center">{icon}</span>
    <span className="min-w-0 break-words leading-snug">{label}</span>
  </button>;
}

function Chip({ active, onClick, children }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`odina-category-chip whitespace-nowrap min-h-11 px-4 py-2 rounded-full text-sm font-medium transition-colors touch-manipulation ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground/70'}`}>
    {children}
  </button>;
}
