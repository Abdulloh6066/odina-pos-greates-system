import React, { useMemo, useState } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Image } from '@/components/ui/image';
import { Input } from '@/components/ui/input';
import { Search, Plus, Minus, X } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

export default function ProductCombobox({ products, onAdd, loading }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [qty, setQty] = useState(1);

  const categories = useMemo(() => {
    const map = new Map();
    (products || []).forEach((p) => {
      const id = p.category_id || p.category_name || '_';
      if (!map.has(id)) map.set(id, p.category_name || 'Boshqa');
    });
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products || []).filter((p) => {
      const cid = p.category_id || p.category_name || '_';
      if (categoryId && cid !== categoryId) return false;
      if (q && !String(p.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, search, categoryId]);

  const add = (p) => {
    onAdd(p, Math.max(1, Math.floor(Number(qty) || 1)));
    setQty(1);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full h-12 rounded-xl border border-input bg-card px-3 flex items-center gap-2 text-sm text-muted-foreground shadow-sm hover:bg-brand-olive/10 transition-colors"
        >
          <Search className="w-4 h-4" />
          <span className="truncate">LIST yoki MINI mahsulotni tanlash...</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] sm:w-[460px] p-0 premium-shadow-lg">
        <div className="p-3 space-y-2 border-b border-border">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Mahsulot nomi..."
              className="pl-9 pr-9"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {categories.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setCategoryId('')}
                className={`px-3 py-1 rounded-full text-xs border transition-colors ${categoryId === '' ? 'bg-brand-olive text-white border-brand-olive' : 'bg-card text-muted-foreground border-border hover:bg-secondary'}`}
              >
                Hammasi
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategoryId(c.id)}
                  className={`px-3 py-1 rounded-full text-xs border transition-colors ${categoryId === c.id ? 'bg-brand-olive text-white border-brand-olive' : 'bg-card text-muted-foreground border-border hover:bg-secondary'}`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-muted-foreground">Miqdor</span>
            <button
              type="button"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:bg-secondary shrink-0"
            >
              <Minus className="w-4 h-4" />
            </button>
            <Input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              className="h-9 w-16 text-center"
            />
            <button
              type="button"
              onClick={() => setQty((q) => q + 1)}
              className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:bg-secondary shrink-0"
            >
              <Plus className="w-4 h-4" />
            </button>
            <span className="text-xs text-muted-foreground ml-auto">{filtered.length} ta</span>
          </div>
        </div>

        <div
          className="max-h-72 overflow-y-auto overscroll-contain touch-pan-y scrollbar-thin"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          {loading && <div className="p-4 text-sm text-muted-foreground">Yuklanmoqda...</div>}
          {!loading && filtered.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">LIST yoki MINI nomli mahsulot topilmadi.</div>
          )}
          {filtered.map((p) => {
            const isSheet = p.production_unit === 'sheet';
            const unit = isSheet ? 'varaq' : 'dona';
            const price = isSheet ? p.sheet_price : p.price;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => add(p)}
                className="w-full flex items-center gap-3 p-2.5 hover:bg-secondary/60 text-left border-b border-border/60 transition-colors"
              >
                <div className="w-11 h-11 rounded-lg overflow-hidden bg-secondary shrink-0 flex items-center justify-center">
                  {p.image_url ? (
                    <Image src={p.image_url} alt={p.name || 'Mahsulot rasmi'} fittingType="fill" className="w-full h-full" />
                  ) : (
                    <span className="text-base font-medium">{(p.name || '')[0]}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {p.category_name || 'Boshqa'} · {formatUZS(price)}/{unit}
                  </div>
                </div>
                <span className="shrink-0 w-8 h-8 rounded-lg bg-brand-olive/15 text-brand-ink flex items-center justify-center">
                  <Plus className="w-4 h-4" />
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}