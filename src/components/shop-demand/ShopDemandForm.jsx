import React, { useMemo, useState } from 'react';
import { Minus, Plus, Search, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { unitLabel } from '@/lib/shop-demand';

export default function ShopDemandForm({ open, onClose, user, shopName, products, editing, onSubmit }) {
  const [requiredDate, setRequiredDate] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState({}); // productId -> quantity
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (!open) return;
    if (editing) {
      setRequiredDate(editing.required_date || '');
      setNotes(editing.notes || '');
      const map = {};
      (editing.items || []).forEach((it) => { map[it.product_id] = Number(it.requested_quantity) || 0; });
      setSelected(map);
    } else {
      setRequiredDate('');
      setNotes('');
      setSelected({});
    }
    setSearch('');
  }, [open, editing?.id]);

  const normalizedSearch = search.toLowerCase().trim();
  const available = useMemo(() => (products || [])
    .filter((p) => p.active !== false && p.archived !== true && p.track_stock !== false)
    .filter((p) => !normalizedSearch || String(p.name || '').toLowerCase().includes(normalizedSearch)
      || String(p.category_name || '').toLowerCase().includes(normalizedSearch))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'uz')), [products, normalizedSearch]);

  const selectedList = useMemo(() => Object.entries(selected)
    .map(([productId, q]) => ({ product: (products || []).find((p) => p.id === productId), quantity: Number(q) }))
    .filter((x) => x.product && Number.isInteger(x.quantity) && x.quantity > 0), [selected, products]);

  const add = (product) => setSelected((s) => (s[product.id] ? s : { ...s, [product.id]: 1 }));
  const remove = (productId) => setSelected((s) => { const n = { ...s }; delete n[productId]; return n; });
  const change = (productId, value, max) => {
    const v = Math.max(0, Math.floor(Number(value) || 0));
    setSelected((s) => ({ ...s, [productId]: v }));
  };

  const valid = selectedList.length > 0 && selectedList.length <= 50 && requiredDate && /^\d{4}-\d{2}-\d{2}$/.test(requiredDate);

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSubmit({
        required_date: requiredDate,
        notes: notes.trim(),
        items: selectedList.map((x) => ({ product_id: x.product.id, quantity: x.quantity })),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Talabni tahrirlash' : "Markazga talab yuborish"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">Do'kon</Label>
              <div className="h-11 rounded-xl bg-secondary/70 px-3 flex items-center text-sm font-medium">
                {shopName || user?.shop_name || user?.data?.shop_name || 'Biriktirilmagan'}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">Do'kon avtomatik tanlanadi va o'zgartirib bo'lmaydi.</p>
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Talab sanasi</Label>
              <Input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} className="h-11 rounded-xl" />
            </div>
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Mahsulot qidirish</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mahsulot nomi bo'yicha qidirish…" className="h-11 pl-9 rounded-xl" />
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-4 items-start">
            <div className="odina-panel rounded-2xl border border-border bg-card p-3 max-h-[280px] overflow-y-auto">
              {available.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">Mahsulot topilmadi.</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-2">
                  {available.map((p) => {
                    const isSel = Boolean(selected[p.id]);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => add(p)}
                        disabled={editing && (editing.items || []).some((it) => it.product_id === p.id && Number(it.sent_quantity) > 0)}
                        className={`rounded-xl border p-2.5 text-left transition-colors touch-manipulation ${isSel ? 'border-primary bg-primary/5' : 'border-border bg-background hover:bg-secondary/50'}`}
                      >
                        <p className="text-sm font-medium truncate">{p.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{p.category_name || 'Kategoriyasiz'} · {unitLabel(p.production_unit)}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <aside className="rounded-2xl border border-primary/25 bg-primary/5 p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="font-semibold text-sm">Tanlanganlar</p>
                <span className="rounded-full bg-card px-2.5 py-0.5 text-xs font-semibold">{selectedList.length} tur</span>
              </div>
              {selectedList.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">Chap tomondan mahsulot tanlang.</p>
              ) : (
                <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                  {selectedList.map(({ product, quantity }) => (
                    <div key={product.id} className="rounded-xl border border-border bg-card p-2.5">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{product.name}</p>
                          <p className="text-[11px] text-muted-foreground">{unitLabel(product.production_unit)}</p>
                        </div>
                        <button type="button" onClick={() => remove(product.id)} className="w-8 h-8 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex items-center justify-center touch-manipulation" aria-label="Olib tashlash">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <Button type="button" size="icon" variant="outline" onClick={() => change(product.id, quantity - 1)} className="w-9 h-9 rounded-lg shrink-0"><Minus className="w-3.5 h-3.5" /></Button>
                        <Input type="number" inputMode="numeric" min={1} value={quantity} onChange={(e) => change(product.id, e.target.value)} className="h-9 rounded-lg text-center px-1 w-24" />
                        <Button type="button" size="icon" variant="outline" onClick={() => change(product.id, quantity + 1)} className="w-9 h-9 rounded-lg shrink-0"><Plus className="w-3.5 h-3.5" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Masalan: ertalabki yetkazib berish" />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor</Button>
          <Button onClick={submit} disabled={saving || !valid} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            <Send className="w-4 h-4 mr-1.5" />
            {saving ? 'Saqlanmoqda…' : editing ? 'Saqlash' : 'Talab yuborish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}