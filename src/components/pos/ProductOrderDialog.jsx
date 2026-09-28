import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { ArrowUp, ArrowDown, ChevronsUp, ChevronsDown, GripVertical, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { moveVisibleProduct, productOrderBaseline, sortByShopOrder } from '@/lib/pos-product-order';

export default function ProductOrderDialog({ shopId, shopName, products, categories, initialCategory = 'all', onClose, onSaved }) {
  const [order, setOrder] = useState([]);
  const [original, setOriginal] = useState([]);
  const [version, setVersion] = useState(0);
  const [category, setCategory] = useState(initialCategory);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const available = useMemo(() => products.filter(p => !p.available_shop_ids?.length || p.available_shop_ids.includes(shopId)), [products, shopId]);
  const initialProducts = useRef(available);

  useEffect(() => {
    let cancelled = false;
    base44.functions.invoke('pos-product-order', { action: 'get', shop_id: shopId }).then(result => {
      if (cancelled) return;
      const data = result.data || result;
      if (data.error) throw new Error(data.error);
      const ids = sortByShopOrder(productOrderBaseline(initialProducts.current), data.order).map(p => p.id);
      setOrder(ids); setOriginal(ids); setVersion(data.version); setLoading(false);
    }).catch(e => {
      if (!cancelled) { setError(e?.response?.data?.error || e.message || 'Tartib yuklanmadi. Oynani qayta oching.'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [shopId]);

  const byId = useMemo(() => new Map(available.map(p => [p.id, p])), [available]);
  const visible = useMemo(() => {
    const chosen = categories.find(c => c.id === category);
    const sourceIds = chosen?.sourceCategoryIds || [category];
    const q = search.trim().toLowerCase();
    return order.map(id => byId.get(id)).filter(Boolean).filter(p =>
      (category === 'all' || sourceIds.includes(p.category_id)) && (!q || p.name.toLowerCase().includes(q)));
  }, [order, byId, categories, category, search]);
  const dirty = order.join('|') !== original.join('|');
  const move = (from, to) => {
    if (submitting.current) return;
    setOrder(current => moveVisibleProduct(current, visible.map(p => p.id), from, to));
  };
  const save = async () => {
    if (submitting.current || loading || !dirty) return;
    submitting.current = true; setSaving(true); setError('');
    try {
      const result = await base44.functions.invoke('pos-product-order', {
        action: 'save', shop_id: shopId, order, version,
      });
      const data = result.data || result;
      if (data.error) throw new Error(data.error);
      onSaved(data); onClose();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Tartib saqlanmadi. Qayta urinib ko‘ring.');
    } finally { submitting.current = false; setSaving(false); }
  };

  return <Dialog open onOpenChange={open => { if (!open && !submitting.current) onClose(); }}>
    <DialogContent className="w-[calc(100%-1rem)] max-w-2xl max-h-[90dvh] flex flex-col gap-3 overflow-hidden p-4 sm:p-5">
      <DialogHeader>
        <DialogTitle>Mahsulotlar tartibi · {shopName}</DialogTitle>
        <DialogDescription>≡ belgisidan ushlab ko‘chiring yoki strelkalarni bosing. Tartib faqat shu do‘kon uchun saqlanadi.</DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        <select aria-label="Tartiblash kategoriyasi" value={category} disabled={loading || saving}
          onChange={e => setCategory(e.target.value)} className="h-11 min-w-0 w-1/2 rounded-xl border border-border bg-background px-2 text-sm">
          <option value="all">Barcha mahsulotlar</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <Input aria-label="Tartiblash uchun mahsulot qidirish" placeholder="Mahsulot qidirish…" value={search}
          disabled={loading || saving} onChange={e => setSearch(e.target.value)} className="h-11 min-w-0 flex-1" />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading ? <div className="py-12 flex items-center justify-center gap-2"><Loader2 className="h-5 w-5 animate-spin" /> Yuklanmoqda…</div> :
        <DragDropContext onDragEnd={result => { if (result.destination) move(result.source.index, result.destination.index); }}>
          <Droppable droppableId="pos-product-order">
            {provided => <div ref={provided.innerRef} {...provided.droppableProps}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1" style={{ minHeight: 100 }}>
              {visible.map((product, index) => <Draggable key={product.id} draggableId={product.id} index={index} isDragDisabled={saving}>
                {(drag, state) => <div ref={drag.innerRef} {...drag.draggableProps}
                  style={drag.draggableProps.style}
                  className={`flex items-center gap-1 sm:gap-2 rounded-xl border border-border bg-card mb-2 p-1.5 ${state.isDragging ? 'shadow-xl ring-2 ring-primary' : ''}`}>
                  <button type="button" {...drag.dragHandleProps} aria-label={product.name + ' joyini ko‘chirish'}
                    className="h-11 w-8 shrink-0 flex items-center justify-center rounded-lg text-muted-foreground">
                    <GripVertical className="h-5 w-5" />
                  </button>
                  <span className="w-6 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                  <span className="min-w-0 flex-1 text-sm font-medium break-words">{product.name}</span>
                  {[
                    [ChevronsUp, 'Birinchiga', 0, index === 0],
                    [ArrowUp, 'Yuqoriga', index - 1, index === 0],
                    [ArrowDown, 'Pastga', index + 1, index === visible.length - 1],
                    [ChevronsDown, 'Oxiriga', visible.length - 1, index === visible.length - 1],
                  ].map(([Icon, label, target, edge]) => <Button key={label} type="button" variant="ghost" size="icon"
                    disabled={saving || edge} title={label} aria-label={product.name + ' — ' + label}
                    className="h-11 w-8 sm:w-11 shrink-0" onClick={() => move(index, target)}><Icon className="h-4 w-4" /></Button>)}
                </div>}
              </Draggable>)}
              {provided.placeholder}
              {!visible.length && <p className="py-8 text-center text-sm text-muted-foreground">Mahsulot topilmadi.</p>}
            </div>}
          </Droppable>
        </DragDropContext>}
      <DialogFooter className="shrink-0 gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onClose} className="h-11">Bekor qilish</Button>
        <Button type="button" disabled={loading || saving || !dirty} onClick={save} className="h-11">
          {saving ? 'Saqlanmoqda…' : 'Saqlash'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
