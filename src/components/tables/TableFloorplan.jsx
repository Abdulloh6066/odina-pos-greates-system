import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Armchair, Check, Edit3, Grip, RefreshCw, Save, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { buildTableLayout, clamp, LIMITS, validateTableLayout } from '@/lib/table-floorplan';

export default function TableFloorplan({ shop, canManage, onSaved, onOpen, onEditingChange }) {
  const defaultLayout = useMemo(
    () => buildTableLayout(shop.table_count, shop.layout),
    [shop.id, shop.table_count, shop.layout_version],
  );
  const [layout, setLayout] = useState(defaultLayout);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const boardRef = useRef(null);
  const dragging = useRef(null);

  useEffect(() => {
    setLayout(defaultLayout);
    setEditing(false);
    setError('');
    dragging.current = null;
  }, [defaultLayout]);
  useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);

  const dirty = layout.some((point, index) => point.x !== defaultLayout[index]?.x || point.y !== defaultLayout[index]?.y);
  const valid = validateTableLayout(shop.table_count, layout);
  const place = (number, x, y) => {
    setLayout((previous) => previous.map((point) => point.number === number
      ? { ...point, x: clamp(Math.round(x / 5) * 5, LIMITS.minX, LIMITS.maxX), y: clamp(Math.round(y / 5) * 5, LIMITS.minY, LIMITS.maxY) }
      : point));
  };
  const onMove = (event, number) => {
    if (!editing || !dragging.current || dragging.current.number !== number
      || dragging.current.pointerId !== event.pointerId || !boardRef.current) return;
    const bounds = boardRef.current.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    place(number, (event.clientX - bounds.left) / bounds.width * 1000, (event.clientY - bounds.top) / bounds.height * 1000);
  };
  const keyboardMove = (event, point) => {
    if (!editing || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 50 : 20;
    place(point.number, point.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      point.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
  };
  const save = async () => {
    if (!editing || !dirty || !valid || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'set_table_layout', shop_id: shop.id, layout_version: shop.layout_version, layout,
      });
      const result = response?.data || response;
      if (!result?.ok || result?.shop?.id !== shop.id) throw new Error('Xarita saqlangani tasdiqlanmadi.');
      onSaved(result.shop);
      setEditing(false);
    } catch (err) {
      setError(err?.response?.data?.error || err?.data?.error || err?.message || 'Xaritani saqlab bo‘lmadi.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label={`${shop.name} stollar xaritasi`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-display text-xl font-semibold">Stollar xaritasi</h2>
          <p className="text-xs text-muted-foreground mt-1">{editing
            ? 'Stolni bosib suring yoki tanlab ↑ ↓ ← → tugmalari bilan joylashtiring. So‘ng saqlang.'
            : 'Xaritadagi stolni bosing — shu stol uchun Kassa ochiladi.'}</p></div>
        {canManage && <div className="flex gap-2 flex-wrap">
          {editing ? <>
            <Button type="button" variant="outline" disabled={saving} onClick={() => { setLayout(defaultLayout); setEditing(false); setError(''); }} className="min-h-11 rounded-xl"><X className="w-4 h-4 mr-1" /> Bekor qilish</Button>
            <Button type="button" onClick={save} disabled={saving || !dirty || !valid} className="min-h-11 rounded-xl bg-primary hover:bg-primary-strong text-primary-foreground"><Save className="w-4 h-4 mr-1" /> {saving ? 'Saqlanmoqda…' : 'Joylashuvni saqlash'}</Button>
          </> : <Button type="button" variant="outline" onClick={() => { setError(''); setEditing(true); }} className="min-h-11 rounded-xl"><Edit3 className="w-4 h-4 mr-1" /> Joylashuvni tahrirlash</Button>}
        </div>}
      </div>
      {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {editing && !valid && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Stollar ustma-ust tushmoqda. Saqlash uchun ularni biroz uzoqlashtiring.</p>}
      <div className="max-w-full overflow-x-auto overscroll-x-contain pb-2">
        <div ref={boardRef} aria-label="Stollar joylashuvini ko‘rsatuvchi xarita" className={`relative min-w-[620px] w-full aspect-[10/7] sm:aspect-[16/10] rounded-[28px] border-2 overflow-hidden shadow-inner ${editing ? 'border-brand-olive bg-[#f8f4e9]' : 'border-brand-sand/50 bg-[#fbf8f0]'}`}
          style={{ backgroundImage: 'radial-gradient(circle, rgba(172,169,93,.22) 1px, transparent 1px)', backgroundSize: '22px 22px' }}>
          <div className="absolute top-4 left-4 right-4 flex justify-between items-center pointer-events-none">
            <span className="rounded-full border border-brand-olive/30 bg-card/90 px-3 py-1 text-[11px] font-semibold tracking-widest text-brand-ink">{shop.name.toUpperCase()}</span>
            <span className="rounded-full border border-border bg-card/90 px-3 py-1 text-[11px] text-muted-foreground">{editing ? 'JOYLASHTIRISH' : 'STOLNI TANLANG'}</span>
          </div>
          {layout.map((point) => (
            <button key={point.number} type="button"
              aria-label={`${point.number}-stol${editing ? ', joylashuvni o‘zgartirish' : ', Kassaga o‘tish'}`}
              title={editing ? 'Ushlab suring yoki yo‘nalish tugmalarini bosing' : `${point.number}-stol — Kassaga o‘tish`}
              disabled={saving}
              onPointerDown={(event) => {
                if (!editing) return;
                event.preventDefault();
                dragging.current = { number: point.number, pointerId: event.pointerId };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => onMove(event, point.number)}
              onPointerUp={(event) => {
                if (dragging.current?.pointerId === event.pointerId) dragging.current = null;
              }}
              onPointerCancel={() => { dragging.current = null; }}
              onKeyDown={(event) => keyboardMove(event, point)}
              onClick={() => { if (!editing) onOpen(shop.id, point.number); }}
              style={{ left: `${point.x / 10}%`, top: `${point.y / 10}%`, transform: 'translate(-50%, -50%)', touchAction: editing ? 'none' : 'manipulation' }}
              className={`absolute z-10 w-[58px] h-[58px] sm:w-[68px] sm:h-[68px] rounded-2xl border-2 flex flex-col items-center justify-center gap-0.5 font-semibold shadow-md select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-olive transition-[background-color,border-color,box-shadow] ${editing
                ? 'cursor-grab active:cursor-grabbing bg-primary border-brand-olive text-brand-ink shadow-lg'
                : 'cursor-pointer bg-card border-brand-olive/70 text-foreground hover:bg-primary/30 hover:shadow-lg'}`}>
              {editing ? <Grip className="w-4 h-4" /> : <Armchair className="w-5 h-5 text-brand-ink" />}
              <span className="text-xs">{point.number}-stol</span>
            </button>
          ))}
          <div className="absolute bottom-3 left-4 right-4 pointer-events-none text-center text-[10px] text-brand-ink/65">{shop.table_count} ta stol · {editing ? 'Surib joylashtiring' : 'Stolni tanlang'}</div>
        </div>
      </div>
      {editing && <p className="text-xs text-muted-foreground flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Joylashuv faqat «Joylashuvni saqlash» bosilgandan keyin boshqa qurilmalarda ham ko‘rinadi.</p>}
      {!editing && <p className="text-xs text-muted-foreground flex items-center gap-2"><Check className="w-4 h-4 text-brand-ink" /> Kassa bilan tezkor ulanish tayyor. Ochiq buyurtma va bronlar keyingi bosqichga qoladi.</p>}
    </section>
  );
}
