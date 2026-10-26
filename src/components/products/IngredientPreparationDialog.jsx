import React, { useEffect, useRef, useState } from 'react';
import { ChefHat, ClipboardList, Loader2, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatStockQuantity, inventoryUnits } from '@/lib/cake-stock-shelf';
import { preparationPreview } from '@/lib/ingredient-preparation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const errorText = problem => problem?.response?.data?.error || problem?.message || 'Ma’lumotni yuklab bo‘lmadi.';
const readPending = key => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value?.request_id && Number.isFinite(value.quantity) && value.quantity > 0 ? value : null;
  } catch { return null; }
};
const display = (quantity, unit) => new Intl.NumberFormat('uz-UZ', { maximumFractionDigits: 3 }).format(quantity) + ' ' + (unit === 'piece' ? 'dona' : unit);

export default function IngredientPreparationDialog({ item, shop, userId, online, onClose, onSaved }) {
  const units = inventoryUnits(item);
  const storageKey = 'odina:ingredient-preparation:' + userId + ':' + shop.id + ':' + item.id;
  const [pending, setPending] = useState(() => readPending(storageKey));
  const [value, setValue] = useState(() => {
    const saved = readPending(storageKey);
    return saved ? String(saved.quantity / units.factor) : '';
  });
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const flight = useRef(false);
  const alive = useRef(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let disposed = false;
    setState({ loading: true, data: null, error: '' });
    base44.functions.invoke('production-run', {
      action: 'preview_ingredient_preparation', location_id: shop.id, ingredient_id: item.id,
    }).then(response => {
      const data = response?.data || response;
      if (data?.error) throw new Error(data.error);
      if (!data?.output) throw new Error('Tayyorlash ma’lumoti olinmadi.');
      if (!disposed) setState({ loading: false, data, error: '' });
    }).catch(problem => {
      if (!disposed) setState({ loading: false, data: null, error: errorText(problem) });
    });
    return () => { disposed = true; };
  }, [shop.id, item.id, refresh]);
  const data = state.data;
  const preview = preparationPreview(data?.recipe, value, units.factor);
  const save = async event => {
    event.preventDefault();
    if (flight.current || !online || (!pending && (!data?.configured || data.pending || preview.error))) return;
    flight.current = true; setSaving(true); setError('');
    try {
      const request = pending || {
        request_id: crypto.randomUUID(), quantity: preview.quantity, recipe_version: data.recipe.version,
      };
      // Persist before sending. On an uncertain reply the same request is retried,
      // including after a refresh; it cannot silently become a second batch.
      localStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
      const response = await base44.functions.invoke('production-run', {
        ...request, action: 'prepare_ingredient', location_id: shop.id, ingredient_id: item.id,
      });
      const payload = response?.data || response;
      if (!payload?.stock) throw new Error(payload?.error || 'Natija tasdiqlanmadi.');
      localStorage.removeItem(storageKey);
      if (alive.current) {
        setPending(null);
        await onSaved(payload.stock);
      }
    } catch (problem) {
      if (alive.current) setError(errorText(problem) + ' Natijani shu oynada tekshiring; qayta tayyorlash kiritmang.');
    } finally {
      flight.current = false;
      if (alive.current) setSaving(false);
    }
  };
  return <Dialog open onOpenChange={open => { if (!open && !flight.current) onClose(); }}>
    <DialogContent className="cake-stock-dialog sm:max-w-xl max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><ChefHat className="h-5 w-5" />Sous tayyorlash</DialogTitle><p className="text-sm text-muted-foreground">{item.name} · {shop.name}</p></DialogHeader>
      <form onSubmit={save} className="space-y-4">
        {state.loading ? <p role="status" className="flex items-center gap-2 py-5"><Loader2 className="h-4 w-4 animate-spin" />Retsept tekshirilmoqda…</p>
          : state.error ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{state.error}</p><Button type="button" variant="outline" onClick={() => setRefresh(n => n + 1)} disabled={!online || saving}><RefreshCw className="mr-2 h-4 w-4" />Qayta yuklash</Button></div>
          : !data?.configured ? <div className="preparation-empty" role="status">
            <ClipboardList className="h-8 w-8" aria-hidden="true" /><strong>Retsept kiritilmagan</strong>
            <p>Masalliqlar miqdori va tayyor sousning chiqish miqdori tasdiqlangach, tayyorlash ochiladi.</p>
            <small>Hozir qoldiqlar o‘zgarmaydi.</small>
          </div> : <>
            <p className="cake-stock-operation-note">Tayyorlangan sous miqdorini kiriting. Saqlanganda retsept bo‘yicha masalliqlar kamayadi, sous qoldig‘i oshadi va barchasi tarixga yoziladi.</p>
            <div><Label htmlFor="preparation-quantity">Tayyorlangan miqdor ({units.label})</Label><Input id="preparation-quantity" autoFocus inputMode="decimal" value={value} onChange={event => setValue(event.target.value)} placeholder="0" disabled={saving || Boolean(pending)} required /></div>
            <div className="cake-stock-operation-preview"><span>Hozir: {formatStockQuantity(data.output.stock_quantity, item)} {units.label}</span><strong>Tayyorlashdan keyin: {preview.quantity ? formatStockQuantity(data.output.stock_quantity + preview.quantity, item) + ' ' + units.label : '—'}</strong></div>
            <div className="preparation-ingredients"><h3>Sarflanadigan masalliqlar</h3><p>Retsept v{data.recipe.version} · chiqish: {display(data.recipe.output_quantity, data.recipe.output_unit)}</p>
              <ul>{(preview.items.length ? preview.items : data.recipe.items).map(line => <li key={line.ingredient_id}><span>{line.name}<small>Hozir: {display(line.stock_quantity, line.unit)}</small></span><span className={line.shortage ? 'text-destructive' : ''}><strong>{line.required == null ? '—' : '−' + display(line.required, line.unit)}</strong><small>{line.after == null ? '' : 'Qoladi: ' + display(line.after, line.unit)}</small></span></li>)}</ul>
            </div>
            {value && preview.error && !pending && <p role="alert" className="text-sm text-destructive">{preview.error}</p>}
            {data.pending && !pending && <p role="alert" className="text-sm text-destructive">Oldingi tayyorlash holati tekshirilishi kerak. Egasi bilan bog‘laning.</p>}
          </>}
        {pending && <p className="cake-stock-operation-note" role="status">Yuborilgan tayyorlash: {formatStockQuantity(pending.quantity, item)} {units.label}. “Natijani tekshirish” o‘sha amal holatini tekshiradi.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!online && <p role="alert" className="text-sm text-destructive">Internet yo‘q. Tayyorlashni saqlash uchun ulaning.</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={saving}>Yopish</Button><Button type="submit" disabled={saving || !online || (!pending && (state.loading || Boolean(state.error) || !data?.configured || data?.pending || Boolean(preview.error)))}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ChefHat className="mr-2 h-4 w-4" />}{saving ? 'Saqlanmoqda…' : pending ? 'Natijani tekshirish' : 'Tayyorlashni saqlash'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
