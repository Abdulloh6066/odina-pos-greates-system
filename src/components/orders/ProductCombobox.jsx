import React, { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Plus, Minus, X, PackagePlus, Check } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

const CATEGORY_LABELS = {
  Pastries: 'Piroglar',
  Cakes: 'Tortlar',
  Desserts: 'Desertlar',
};

const safeQty = (value) => Math.max(0, Math.floor(Number(value) || 0));

export default function ProductCombobox({ products, onAdd, loading }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [selected, setSelected] = useState({});

  const categories = useMemo(() => {
    const map = new Map();
    (products || []).forEach((p) => {
      const id = p.category_id || p.category_name || '_';
      if (!map.has(id)) map.set(id, p.category_name || 'Boshqa');
    });
    return Array.from(map, ([id, name]) => ({ id, name: CATEGORY_LABELS[name] || name }));
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('uz-UZ');
    return (products || []).filter((p) => {
      const cid = p.category_id || p.category_name || '_';
      if (categoryId && cid !== categoryId) return false;
      if (q && !String(p.name || '').toLocaleLowerCase('uz-UZ').includes(q)) return false;
      return true;
    });
  }, [products, search, categoryId]);

  const selectedProducts = useMemo(
    () => (products || []).filter((p) => safeQty(selected[p.id]) > 0),
    [products, selected],
  );
  const selectedQuantity = useMemo(
    () => Object.values(selected).reduce((sum, qty) => sum + safeQty(qty), 0),
    [selected],
  );

  const updateQty = (productId, nextQty) => {
    const qty = safeQty(nextQty);
    setSelected((current) => {
      if (qty === 0) {
        const next = { ...current };
        delete next[productId];
        return next;
      }
      return { ...current, [productId]: qty };
    });
  };

  const changeQty = (productId, delta) => {
    updateQty(productId, safeQty(selected[productId]) + delta);
  };

  const handleOpenChange = (nextOpen) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setSearch('');
      setCategoryId('');
      setSelected({});
    }
  };

  const applySelection = () => {
    selectedProducts.forEach((product) => onAdd(product, safeQty(selected[product.id])));
    setOpen(false);
    setSelected({});
  };

  return (
    <>
      <button
        type="button"
        onClick={() => handleOpenChange(true)}
        className="group w-full min-h-16 rounded-2xl border border-brand-olive/40 bg-gradient-to-r from-brand-olive/10 via-card to-primary/10 px-4 py-3 flex items-center gap-3 text-left shadow-sm transition-all hover:border-brand-olive hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-olive text-white shadow-sm">
          <PackagePlus className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-foreground">Mahsulot qo‘shish</span>
          <span className="block truncate text-xs text-muted-foreground">
            Qidirish, miqdorni belgilash va bir nechta mahsulotni tanlash
          </span>
        </span>
        <span className="shrink-0 rounded-full border border-brand-olive/25 bg-card px-2.5 py-1 text-xs font-semibold text-brand-ink">
          {loading ? '...' : `${products?.length || 0} ta`}
        </span>
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="grid h-[100dvh] w-screen min-w-0 max-h-none max-w-none grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[min(88dvh,820px)] sm:w-[calc(100%_-_2rem)] sm:max-w-5xl sm:rounded-2xl sm:border">
          <DialogHeader className="border-b border-border bg-card px-4 py-4 pr-14 sm:px-6">
            <DialogTitle className="flex items-center gap-2 text-xl">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-olive/15 text-brand-ink">
                <PackagePlus className="h-5 w-5" />
              </span>
              Mahsulotlarni tanlash
            </DialogTitle>
            <DialogDescription>
              Kerakli mahsulotlarni tanlang va har birining miqdorini kiriting.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-3 border-b border-border bg-secondary/20 px-4 py-3 sm:px-6">
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Mahsulot nomini yozing..."
                className="h-12 rounded-xl bg-card pl-11 pr-11 text-base"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Qidiruvni tozalash"
                  className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="-mx-1 flex min-w-0 max-w-full gap-2 overflow-x-auto px-1 pb-1 scrollbar-thin">
              <button
                type="button"
                onClick={() => setCategoryId('')}
                className={`min-h-10 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors ${categoryId === '' ? 'border-brand-olive bg-brand-olive text-white' : 'border-border bg-card text-muted-foreground hover:bg-secondary'}`}
              >
                Hammasi
              </button>
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setCategoryId(category.id)}
                  className={`min-h-10 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors ${categoryId === category.id ? 'border-brand-olive bg-brand-olive text-white' : 'border-border bg-card text-muted-foreground hover:bg-secondary'}`}
                >
                  {category.name}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{filtered.length} ta mahsulot</span>
              {selectedProducts.length > 0 && (
                <span className="font-semibold text-brand-ink">
                  {selectedProducts.length} xil · {selectedQuantity} dona tanlandi
                </span>
              )}
            </div>
          </div>

          <div
            className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-[#faf9f6] p-3 pb-6 touch-pan-y sm:p-5"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            {loading && (
              <div className="flex min-h-52 items-center justify-center text-sm text-muted-foreground">
                Mahsulotlar yuklanmoqda...
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="flex min-h-52 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card p-6 text-center">
                <Search className="h-8 w-8 text-brand-olive" />
                <strong>Mahsulot topilmadi</strong>
                <span className="text-sm text-muted-foreground">Qidiruv yoki kategoriyani o‘zgartirib ko‘ring.</span>
              </div>
            )}

            {!loading && filtered.length > 0 && (
              <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
                {filtered.map((product) => {
                  const isSheet = product.production_unit === 'sheet';
                  const unit = isSheet ? 'list' : 'dona';
                  const price = isSheet ? product.sheet_price : product.price;
                  const qty = safeQty(selected[product.id]);
                  const isSelected = qty > 0;

                  return (
                    <div
                      key={product.id}
                      className={`flex min-w-0 items-center gap-3 rounded-2xl border bg-card p-3 transition-all ${isSelected ? 'border-brand-olive shadow-[0_0_0_2px_rgba(172,169,93,0.16)]' : 'border-border hover:border-brand-olive/60'}`}
                    >
                      <button
                        type="button"
                        onClick={() => changeQty(product.id, 1)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-secondary text-lg font-semibold text-brand-ink">
                          {product.image_url ? (
                            <Image src={product.image_url} alt={product.name || 'Mahsulot rasmi'} fittingType="fill" className="h-full w-full" />
                          ) : (
                            String(product.name || '')[0]
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-foreground">{product.name}</span>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            {CATEGORY_LABELS[product.category_name] || product.category_name || 'Boshqa'} · {formatUZS(price)}/{unit}
                          </span>
                        </span>
                      </button>

                      {isSelected ? (
                        <div className="flex shrink-0 items-center gap-1 rounded-xl bg-secondary/70 p-1">
                          <button
                            type="button"
                            onClick={() => changeQty(product.id, -1)}
                            aria-label="Miqdorni kamaytirish"
                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card hover:bg-secondary"
                          >
                            <Minus className="h-4 w-4" />
                          </button>
                          <Input
                            type="number"
                            min="1"
                            value={qty}
                            onChange={(e) => updateQty(product.id, e.target.value)}
                            aria-label={`${product.name} miqdori`}
                            className="h-10 w-14 rounded-lg bg-card px-1 text-center font-semibold"
                          />
                          <button
                            type="button"
                            onClick={() => changeQty(product.id, 1)}
                            aria-label="Miqdorni ko‘paytirish"
                            className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-olive text-white hover:bg-brand-olive/90"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => changeQty(product.id, 1)}
                          aria-label={`${product.name}ni tanlash`}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-olive/15 text-brand-ink transition-colors hover:bg-brand-olive hover:text-white"
                        >
                          <Plus className="h-5 w-5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="min-w-0 border-t border-border bg-card px-4 py-3 shadow-[0_-8px_24px_rgba(28,31,20,0.06)] sm:px-6">
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="hidden min-w-0 flex-1 sm:block">
                <div className="text-sm font-semibold">
                  {selectedProducts.length > 0 ? `${selectedProducts.length} xil mahsulot tanlandi` : 'Hali mahsulot tanlanmadi'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {selectedProducts.length > 0 ? `Jami miqdor: ${selectedQuantity}` : 'Mahsulot yonidagi + tugmasini bosing'}
                </div>
              </div>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} className="w-full sm:w-auto sm:flex-none">
                Bekor
              </Button>
              <Button
                type="button"
                onClick={applySelection}
                disabled={selectedProducts.length === 0}
                className="h-auto min-h-11 w-full min-w-0 whitespace-normal py-2 text-center sm:w-auto sm:min-w-64 sm:flex-none"
              >
                <Check className="h-4 w-4" />
                {selectedProducts.length > 0
                  ? `Tanlanganlarni qo‘shish · ${selectedQuantity}`
                  : 'Mahsulot tanlang'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
