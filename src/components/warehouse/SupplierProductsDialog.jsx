import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const PAGE_SIZE = 500;
const ingredientIds = value => [...new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : [])];
const errorText = error => error?.response?.data?.error || error?.message || 'Amal bajarilmadi.';
const categoryName = category => ({ food: 'Masalliq', packaging: 'Qadoq', household: 'Xo‘jalik mahsuloti' })[category] || 'Mahsulot';

async function readIngredients() {
  const rows = [], seen = new Set();
  // Read the complete catalog. An incomplete or repeated page must never become a saved selection.
  for (let skip = 0; skip < 50000; skip += PAGE_SIZE) {
    const page = await base44.entities.Ingredient.list('id', PAGE_SIZE, skip);
    if (!Array.isArray(page) || page.length > PAGE_SIZE) throw new Error('Mahsulotlar ro‘yxati to‘liq yuklanmadi. Qayta urinib ko‘ring.');
    for (const row of page) {
      if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) {
        throw new Error('Mahsulotlar ro‘yxati o‘zgardi yoki takrorlandi. Qayta yuklang.');
      }
      seen.add(row.id);
      rows.push(row);
    }
    if (page.length < PAGE_SIZE) return rows;
  }
  throw new Error('Mahsulotlar ro‘yxati juda katta. To‘liq yuklanmagani uchun saqlash yopildi.');
}

export default function SupplierProductsDialog({ supplier, user, onClose, onSaved }) {
  const canManage = user?.role === 'admin';
  const [ingredients, setIngredients] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const savingRef = useRef(false);
  const currentSupplierRef = useRef(supplier?.id);
  currentSupplierRef.current = supplier?.id;

  useEffect(() => {
    setSelectedIds(ingredientIds(supplier?.supplied_ingredient_ids));
    setSearch('');
    setSaveError('');
  }, [supplier?.id]);

  useEffect(() => {
    if (!canManage || !supplier?.id) return;
    let current = true;
    setLoading(true);
    setLoadError('');
    setIngredients([]);
    readIngredients()
      .then(rows => { if (current) setIngredients(rows); })
      .catch(error => { if (current) setLoadError(errorText(error)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [canManage, supplier?.id, reloadKey]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return [...ingredients].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'uz'))
      .filter(item => !query || `${item.name || ''} ${categoryName(item.category)}`.toLocaleLowerCase().includes(query));
  }, [ingredients, search]);
  const knownIds = useMemo(() => new Set(ingredients.map(item => item.id)), [ingredients]);
  const unseenCount = selectedIds.filter(id => !knownIds.has(id)).length;
  const initialIds = ingredientIds(supplier?.supplied_ingredient_ids);
  const unchanged = Array.isArray(supplier?.supplied_ingredient_ids)
    && selectedIds.length === initialIds.length && initialIds.every(id => selected.has(id));

  const close = () => { if (!savingRef.current) onClose?.(); };
  const toggle = item => {
    if (!canManage || loading || loadError || savingRef.current || (item.active === false && !selected.has(item.id))) return;
    setSaveError('');
    setSelectedIds(previous => previous.includes(item.id) ? previous.filter(id => id !== item.id) : [...previous, item.id]);
  };
  const save = async () => {
    if (!canManage || !supplier?.id || loading || loadError || savingRef.current || unchanged) return;
    const id = supplier.id;
    const ids = [...selectedIds];
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      const response = await base44.entities.CashRecipient.update(id, { supplied_ingredient_ids: ids });
      const record = response?.data || response;
      if (currentSupplierRef.current !== id) return;
      const updated = record?.id === id ? { ...supplier, ...record } : { ...supplier };
      onSaved?.({ ...updated, supplied_ingredient_ids: Array.isArray(record?.supplied_ingredient_ids) && record?.id === id
        ? ingredientIds(record.supplied_ingredient_ids) : ids });
    } catch (error) {
      if (currentSupplierRef.current === id) setSaveError('Mahsulotlarni saqlab bo‘lmadi: ' + errorText(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (!canManage || !supplier?.id) return null;

  return (
    <Dialog open={Boolean(supplier)} onOpenChange={open => !open && close()}>
      <DialogContent className="sm:max-w-xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Yetkazib beruvchi mahsulotlari</DialogTitle>
          <DialogDescription>{supplier.name} uchun masalliq va qadoqlarni tanlang. Bir mahsulot bir nechta yetkazib beruvchiga biriktirilishi mumkin.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input aria-label="Yetkazib beruvchi mahsulotlarini qidirish" value={search} onChange={event => setSearch(event.target.value)}
              placeholder="Masalliq yoki qadoqni qidirish…" disabled={loading || saving} className="min-h-11 pl-9 rounded-xl" />
          </div>
          <p className="text-sm font-medium" aria-live="polite">{selectedIds.length} ta mahsulot tanlangan</p>
          {loading ? <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Mahsulotlar yuklanmoqda…</p>
            : loadError ? <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 space-y-3">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button type="button" variant="outline" className="min-h-11" onClick={() => setReloadKey(value => value + 1)}><RefreshCw className="w-4 h-4 mr-2" aria-hidden="true" />Qayta yuklash</Button>
            </div> : <>
              {unseenCount > 0 && <p className="rounded-xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">{unseenCount} ta oldingi bog‘lanish katalogda topilmadi. Ular saqlashda o‘zgarmaydi.</p>}
              <div className="max-h-[42dvh] overflow-y-auto rounded-xl border border-border divide-y divide-border" aria-label="Masalliq va qadoqlar">
                {visible.length === 0 ? <p className="p-5 text-center text-sm text-muted-foreground">Mahsulot topilmadi</p> : visible.map(item => (
                  <label key={item.id} className={`flex items-center gap-3 min-h-11 px-3 py-3 ${item.active === false ? 'bg-secondary/30' : 'hover:bg-secondary/40'} ${saving ? 'opacity-60' : ''}`}>
                    <input type="checkbox" checked={selected.has(item.id)} disabled={saving || (item.active === false && !selected.has(item.id))}
                      onChange={() => toggle(item)} className="w-4 h-4 shrink-0 accent-primary" />
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium break-words">{item.name || item.id}</span>
                      <span className="block text-xs text-muted-foreground">{categoryName(item.category)}{item.active === false ? ' · Faol emas' : ''}</span></span>
                  </label>
                ))}
              </div>
            </>}
          {saveError && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{saveError}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11" onClick={close} disabled={saving}>Bekor qilish</Button>
          <Button type="button" className="min-h-11" onClick={save} disabled={loading || Boolean(loadError) || saving || unchanged}>{saving ? 'Saqlanmoqda…' : 'Mahsulotlarni saqlash'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
