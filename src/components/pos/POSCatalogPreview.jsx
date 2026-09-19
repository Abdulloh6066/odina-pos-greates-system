import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Minus, Plus, Search, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ProductCard from '@/components/pos/ProductCard';
import { formatUZS } from '@/lib/pos';
import { draftPreviewProducts, PREVIEW_PRICE_UZS } from '@/lib/pos-catalog-preview';

const categoryName = (name) => ({
  Cakes: 'Tortlar',
  Pastries: 'Pishiriqlar',
  Cookies: 'Pechenyelar',
  Drinks: 'Ichimliklar',
  Cupcakes: 'Kapkeyklar',
  Desserts: 'Desertlar',
}[name] || name);

export default function POSCatalogPreview({ onExit }) {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [cart, setCart] = useState([]);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([
      base44.entities.Product.list('name', 500),
      base44.entities.Category.list('sort_order', 100),
    ]).then(([productRows, categoryRows]) => {
      if (!active) return;
      setProducts(draftPreviewProducts(productRows));
      setCategories((categoryRows || []).filter((category) => category.active !== false));
    }).catch(() => {
      if (active) setError('Mahsulotlar yuklanmadi. Sahifani yangilab ko‘ring.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => products.filter((product) =>
    (categoryId === 'all' || product.category_id === categoryId)
    && product.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  ), [products, categoryId, search]);

  const addProduct = (product) => setCart((current) => {
    const item = current.find((row) => row.id === product.id);
    return item
      ? current.map((row) => row.id === product.id ? { ...row, quantity: row.quantity + 1 } : row)
      : [...current, { id: product.id, name: product.name, quantity: 1 }];
  });
  const changeQuantity = (id, delta) => setCart((current) => current
    .map((row) => row.id === id ? { ...row, quantity: row.quantity + delta } : row)
    .filter((row) => row.quantity > 0));
  const total = cart.reduce((sum, row) => sum + row.quantity * PREVIEW_PRICE_UZS, 0);

  return (
    <div className="odina-pos flex flex-col w-full max-w-full h-[calc(100dvh-3.5rem)] lg:h-dvh bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
        <Button type="button" variant="outline" onClick={onExit} className="min-h-11 rounded-xl">
          <ArrowLeft className="mr-2 h-4 w-4" /> Kassaga qaytish
        </Button>
        <div className="min-w-0">
          <h1 className="font-display text-lg font-bold">Kassa sinovi</h1>
          <p className="text-xs text-muted-foreground">Faqat egasi uchun · vaqtinchalik {formatUZS(PREVIEW_PRICE_UZS)} narx</p>
        </div>
      </header>
      <div role="status" className="mx-4 mt-3 rounded-xl border border-brand-olive/40 bg-brand-olive/10 px-4 py-3 text-sm text-brand-ink">
        Bu faqat ko‘rish va savatni sinash uchun. To‘lov, savdo, smena va ombor o‘zgarmaydi. Haqiqiy narxlar saqlanmagan.
      </div>
      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-label="Sinov mahsulotlari">
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)}
              aria-label="Mahsulotlarni qidirish" placeholder="Mahsulotlarni qidirish…" className="h-11 pl-9" />
          </div>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            <Button type="button" variant={categoryId === 'all' ? 'default' : 'outline'}
              onClick={() => setCategoryId('all')} className="min-h-11 shrink-0">Barchasi</Button>
            {categories.map((category) => (
              <Button key={category.id} type="button" variant={categoryId === category.id ? 'default' : 'outline'}
                onClick={() => setCategoryId(category.id)} className="min-h-11 shrink-0">
                {categoryName(category.name)}
              </Button>
            ))}
          </div>
          {error ? <p role="alert" className="text-destructive">{error}</p>
            : loading ? <p className="text-sm text-muted-foreground">Mahsulotlar yuklanmoqda…</p>
              : <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
                {filtered.map((product) => (
                  <ProductCard key={product.id} product={product} onAdd={addProduct} />
                ))}
              </div>}
          {!loading && !error && filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">Mahsulot topilmadi.</p>
          )}
        </section>
        <aside className="max-h-[38dvh] shrink-0 overflow-y-auto border-t border-border bg-card p-4 xl:max-h-none xl:w-[380px] xl:border-l xl:border-t-0"
          aria-label="Sinov savati">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold">Sinov savati</h2>
            {cart.length > 0 && <Button type="button" variant="ghost" onClick={() => setCart([])}
              className="min-h-11"><Trash2 className="mr-2 h-4 w-4" /> Tozalash</Button>}
          </div>
          {cart.length === 0 ? <p className="py-6 text-sm text-muted-foreground">Mahsulotni bosib savatga qo‘shing.</p>
            : <div className="space-y-2">{cart.map((row) => (
              <div key={row.id} className="rounded-xl border border-border p-3">
                <p className="font-semibold break-words">{row.name}</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex items-center rounded-xl border border-border">
                    <Button type="button" variant="ghost" size="icon" onClick={() => changeQuantity(row.id, -1)}
                      aria-label={`${row.name} miqdorini kamaytirish`} className="h-11 w-11">
                      <Minus className="h-4 w-4" />
                    </Button>
                    <span className="min-w-8 text-center">{row.quantity}</span>
                    <Button type="button" variant="ghost" size="icon" onClick={() => changeQuantity(row.id, 1)}
                      aria-label={`${row.name} miqdorini oshirish`} className="h-11 w-11">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <span className="font-semibold">{formatUZS(row.quantity * PREVIEW_PRICE_UZS)}</span>
                </div>
              </div>
            ))}</div>}
          <div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-lg font-bold">
            <span>Jami</span><span>{formatUZS(total)}</span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Sinov savati saqlanmaydi. Bu yerdan to‘lovga o‘tib bo‘lmaydi.</p>
        </aside>
      </div>
    </div>
  );
}
