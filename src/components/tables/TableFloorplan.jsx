import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Armchair, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, DoorOpen,
  Edit3, Grip, Minus, MousePointer2, Plus, RotateCcw, Save, X,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import {
  buildTableLayout, clamp, entranceFromPoint, normalizeEntrance,
  nudgeEntrance, tableBounds, tableSize, TABLE_SIZES, validateTableLayout,
} from '@/lib/table-floorplan';

const WALLS = [
  { side: 'top', label: 'Yuqori' },
  { side: 'right', label: 'O‘ng' },
  { side: 'bottom', label: 'Pastki' },
  { side: 'left', label: 'Chap' },
];
const ARROWS = [
  { key: 'ArrowLeft', icon: ArrowLeft, label: 'Chapga surish' },
  { key: 'ArrowUp', icon: ArrowUp, label: 'Yuqoriga surish' },
  { key: 'ArrowDown', icon: ArrowDown, label: 'Pastga surish' },
  { key: 'ArrowRight', icon: ArrowRight, label: 'O‘ngga surish' },
];

const entranceStyle = (entrance) => {
  const position = `${entrance.offset / 10}%`;
  switch (entrance.side) {
    case 'right': return { left: '100%', top: position, transform: 'translate(-15%, -50%)' };
    case 'bottom': return { left: position, top: '100%', transform: 'translate(-50%, -15%)' };
    case 'left': return { left: '0%', top: position, transform: 'translate(-85%, -50%)' };
    default: return { left: position, top: '0%', transform: 'translate(-50%, -85%)' };
  }
};

export default function TableFloorplan({ shop, canManage, onSaved, onOpen, onEditingChange }) {
  const defaultLayout = useMemo(
    () => buildTableLayout(shop.table_count, shop.layout),
    [shop.id, shop.table_count, shop.layout_version],
  );
  const defaultEntrance = useMemo(
    () => normalizeEntrance(shop.entrance),
    [shop.id, shop.layout_version, shop.entrance?.side, shop.entrance?.offset],
  );
  const [layout, setLayout] = useState(defaultLayout);
  const [entrance, setEntrance] = useState(defaultEntrance);
  const [editing, setEditing] = useState(false);
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const boardRef = useRef(null);
  const dragging = useRef(null);

  useEffect(() => {
    setLayout(defaultLayout);
    setEntrance(defaultEntrance);
    setEditing(false);
    setSelectedNumber(null);
    setError('');
    dragging.current = null;
  }, [defaultLayout, defaultEntrance]);

  const tableDirty = layout.some((point, index) =>
    point.x !== defaultLayout[index]?.x || point.y !== defaultLayout[index]?.y
    || tableSize(point) !== tableSize(defaultLayout[index]));
  const entranceDirty = entrance.side !== defaultEntrance.side || entrance.offset !== defaultEntrance.offset;
  const dirty = tableDirty || entranceDirty;
  const valid = validateTableLayout(shop.table_count, layout);
  useEffect(() => { onEditingChange?.(editing && dirty); }, [editing, dirty, onEditingChange]);

  const place = (number, x, y) => {
    setLayout((previous) => previous.map((point) => {
      if (point.number !== number) return point;
      const bounds = tableBounds(tableSize(point));
      return {
        ...point,
        x: clamp(Math.round(x / 5) * 5, bounds.minX, bounds.maxX),
        y: clamp(Math.round(y / 5) * 5, bounds.minY, bounds.maxY),
      };
    }));
  };
  const resizeTable = (number, requestedSize) => {
    if (!editing || saving || !TABLE_SIZES.includes(requestedSize)) return;
    setLayout((previous) => previous.map((point) => {
      if (point.number !== number) return point;
      const bounds = tableBounds(requestedSize);
      return { ...point, size: requestedSize,
        x: clamp(point.x, bounds.minX, bounds.maxX),
        y: clamp(point.y, bounds.minY, bounds.maxY) };
    }));
  };
  const pointerCoordinates = (event) => {
    const bounds = boardRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds?.height) return null;
    return {
      x: (event.clientX - bounds.left) / bounds.width * 1000,
      y: (event.clientY - bounds.top) / bounds.height * 1000,
    };
  };
  const onMove = (event, target) => {
    if (!editing || !dragging.current || dragging.current.target !== target
      || dragging.current.pointerId !== event.pointerId) return;
    const position = pointerCoordinates(event);
    if (!position) return;
    if (target === 'entrance') setEntrance(entranceFromPoint(position.x, position.y));
    else place(target, position.x, position.y);
  };
  const startDrag = (event, target) => {
    if (!editing || saving) return;
    event.preventDefault();
    dragging.current = { target, pointerId: event.pointerId };
    if (target !== 'entrance') setSelectedNumber(target);
    else setSelectedNumber(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const stopDrag = (event) => {
    if (dragging.current?.pointerId === event.pointerId) dragging.current = null;
  };
  const keyboardMove = (event, point) => {
    if (!editing || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    setSelectedNumber(point.number);
    const step = event.shiftKey ? 50 : 20;
    place(point.number,
      point.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      point.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
  };
  const reset = () => {
    setLayout(defaultLayout);
    setEntrance(defaultEntrance);
    setSelectedNumber(null);
    setError('');
  };
  const discard = () => {
    reset();
    setEditing(false);
  };
  const save = async () => {
    if (!editing || !dirty || !valid || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'set_table_layout', shop_id: shop.id,
        layout_version: shop.layout_version, layout, entrance,
      });
      const result = response?.data || response;
      if (!result?.ok || result?.shop?.id !== shop.id) throw new Error('Xarita saqlangani tasdiqlanmadi.');
      // Clear the parent's unsaved-change flag even when its versioned key remounts this component.
      onEditingChange?.(false);
      onSaved(result.shop);
      setEditing(false);
    } catch (err) {
      setError(err?.response?.data?.error || err?.data?.error || err?.message || 'Xaritani saqlab bo‘lmadi.');
    } finally {
      setSaving(false);
    }
  };

  const chosen = layout.find((point) => point.number === selectedNumber);
  const verticalDoor = entrance.side === 'left' || entrance.side === 'right';

  return (
    <section aria-label={`${shop.name} stollar xaritasi`} className="rounded-[28px] border border-border bg-card premium-shadow p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-olive/15 text-brand-ink"><Armchair className="h-5 w-5" /></span>
          <div className="min-w-0 space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-brand-ink">{shop.name} · Zal rejasi</p>
            <h2 className="font-display text-xl sm:text-2xl font-semibold">Stollar xaritasi</h2>
            <p className="text-sm text-muted-foreground">{editing
              ? 'Stol va eshikni ushlab suring. Eshik devorga avtomatik joylashadi.'
              : 'Stolni tanlang — unga biriktirilgan Kassa ochiladi.'}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${editing && dirty ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-brand-olive/30 bg-brand-olive/10 text-brand-ink'}`}>
            {editing && dirty ? '● Saqlanmagan' : editing ? '● Tahrirlash' : '✓ Ko‘rish'}
          </span>
          {canManage && (editing ? <>
            <Button type="button" variant="outline" disabled={saving} onClick={discard} className="min-h-11 rounded-xl"><X className="mr-1.5 h-4 w-4" /> Bekor qilish</Button>
            <Button type="button" onClick={save} disabled={saving || !dirty || !valid} className="min-h-11 rounded-xl bg-primary hover:bg-primary-strong text-primary-foreground"><Save className="mr-1.5 h-4 w-4" /> {saving ? 'Saqlanmoqda…' : 'Joylashuvni saqlash'}</Button>
          </> : <Button type="button" variant="outline" onClick={() => { setError(''); setEditing(true); }} className="min-h-11 rounded-xl"><Edit3 className="mr-1.5 h-4 w-4" /> Xaritani tahrirlash</Button>)}
        </div>
      </div>

      {editing && (
        <div className="rounded-2xl border border-brand-olive/30 bg-brand-olive/5 p-3 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-sm font-semibold"><DoorOpen className="h-4 w-4 text-brand-ink" /> Eshik qayerda?</span>
            <span className="text-xs text-muted-foreground">Devorni tanlang yoki xaritadagi eshikni suring</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="group" aria-label="Eshik devorini tanlash">
            {WALLS.map((wall) => <button key={wall.side} type="button" disabled={saving} aria-pressed={entrance.side === wall.side}
              onClick={() => { setEntrance((previous) => ({ ...previous, side: wall.side })); setSelectedNumber(null); }}
              className={`min-h-11 rounded-xl border px-3 text-sm font-semibold transition-colors touch-manipulation ${entrance.side === wall.side ? 'border-brand-olive bg-primary/60 text-foreground shadow-sm' : 'border-border bg-card hover:border-brand-olive/60'}`}>
              {wall.label} devor
            </button>)}
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
            <label htmlFor="entrance-position" className="text-xs font-semibold whitespace-nowrap">Eshikning devordagi joyi</label>
            <input id="entrance-position" type="range" min="150" max="850" step="10" value={entrance.offset} disabled={saving}
              onChange={(event) => setEntrance((previous) => ({ ...previous, offset: Number(event.target.value) }))}
              className="min-w-[120px] flex-1 accent-[#ACA95D]" />
            <span className="w-11 text-right text-xs font-bold tabular-nums text-brand-ink">{entrance.offset / 10}%</span>
          </div>
          <p className="text-xs text-muted-foreground">Eshikni devor bo‘ylab suring, yuqoridagi slayderdan foydalaning yoki klaviaturada yo‘nalish tugmalarini bosing.</p>
        </div>
      )}

      {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {editing && !valid && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Stollar ustma-ust tushmoqda. Saqlash uchun ularni biroz uzoqlashtiring.</p>}

      <div className="rounded-2xl border border-border/70 bg-[#f7f5ed] p-2 sm:p-3">
        <div className="max-w-full overflow-x-auto overscroll-x-contain pb-2">
          <div className="relative min-w-[760px] w-full px-16 py-16">
            <div ref={boardRef} aria-label="Stollar joylashuvini ko‘rsatuvchi xarita"
              className={`relative w-full aspect-[10/7] sm:aspect-[16/10] rounded-[25px] border-[3px] shadow-inner ${editing ? 'border-brand-olive bg-[#f8f4e9]' : 'border-[#b8b087] bg-[#fbf8f0]'}`}
              style={{ backgroundImage: 'radial-gradient(circle, rgba(172,169,93,.22) 1px, transparent 1px)', backgroundSize: '22px 22px' }}>
              <div className="pointer-events-none absolute left-4 top-4 right-4 flex items-center justify-between gap-2">
                <span className="rounded-full border border-brand-olive/30 bg-card/90 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-brand-ink">{shop.name}</span>
                <span className="rounded-full border border-border bg-card/90 px-3 py-1 text-[10px] font-semibold text-muted-foreground">{editing ? 'JOYNI TANLANG' : 'STOLNI BOSING'}</span>
              </div>

              <button type="button" aria-label={`Kirish eshigi: ${WALLS.find((wall) => wall.side === entrance.side)?.label} devor${editing ? ', joyini o‘zgartirish' : ''}`}
                title={editing ? 'Eshikni ushlab devor bo‘ylab suring' : 'Kirish eshigi'}
                disabled={!editing || saving}
                onPointerDown={(event) => startDrag(event, 'entrance')}
                onPointerMove={(event) => onMove(event, 'entrance')}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                onKeyDown={(event) => {
                  if (!editing || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                  event.preventDefault();
                  setEntrance((previous) => nudgeEntrance(previous, event.key, event.shiftKey ? 50 : 20));
                }}
                style={{ ...entranceStyle(entrance), touchAction: editing ? 'none' : 'manipulation' }}
                className={`absolute z-20 flex items-center justify-center gap-1.5 border-2 border-brand-olive bg-card text-brand-ink font-bold shadow-md select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-olive ${verticalDoor ? 'h-16 w-16 flex-col rounded-2xl text-[10px]' : 'h-12 min-w-[118px] rounded-xl text-xs'} ${editing ? 'cursor-grab active:cursor-grabbing ring-4 ring-primary/30' : 'cursor-default'}`}>
                <DoorOpen aria-hidden="true" className="h-5 w-5 shrink-0" />
                <span>Eshik</span>
                {editing && <Grip aria-hidden="true" className="h-3 w-3 shrink-0 opacity-65" />}
              </button>

              {layout.map((point) => <button key={point.number} type="button"
                aria-label={`${point.number}-stol${editing ? ', joylashuvni o‘zgartirish' : ', Kassaga o‘tish'}`}
                title={editing ? 'Ushlab suring yoki tanlab yo‘nalish tugmalari bilan siljiting' : `${point.number}-stol — Kassaga o‘tish`}
                disabled={saving}
                onPointerDown={(event) => startDrag(event, point.number)}
                onPointerMove={(event) => onMove(event, point.number)}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                onKeyDown={(event) => keyboardMove(event, point)}
                onClick={() => { if (editing) setSelectedNumber(point.number); else onOpen(shop.id, point.number); }}
                style={{ left: `${point.x / 10}%`, top: `${point.y / 10}%`, transform: 'translate(-50%, -50%)', touchAction: editing ? 'none' : 'manipulation' }}
                className={`absolute z-10 h-[58px] w-[58px] sm:h-[68px] sm:w-[68px] rounded-2xl border-2 flex flex-col items-center justify-center gap-0.5 font-semibold shadow-md select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-olive transition-[background-color,border-color,box-shadow] ${editing
                  ? selectedNumber === point.number ? 'cursor-grab active:cursor-grabbing bg-primary border-brand-olive text-foreground ring-4 ring-brand-olive/20' : 'cursor-grab active:cursor-grabbing bg-card border-brand-olive/65 text-foreground hover:bg-primary/40'
                  : 'cursor-pointer bg-card border-brand-olive/65 text-foreground hover:bg-primary/30 hover:shadow-lg'}`}>
                {editing ? <Grip aria-hidden="true" className="h-4 w-4 text-brand-ink" /> : <Armchair aria-hidden="true" className="h-5 w-5 text-brand-ink" />}
                <span className="text-xs">{point.number}-stol</span>
              </button>)}
              <div className="pointer-events-none absolute bottom-3 left-4 right-4 text-center text-[10px] text-brand-ink/65">{shop.table_count} ta stol · {editing ? 'Surib joylashtiring' : 'Stolni tanlang'}</div>
            </div>
          </div>
        </div>
      </div>

      {editing && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-secondary/30 p-3 sm:p-4">
        <div className="min-w-0">
          <p className="font-semibold text-sm">{chosen ? `${chosen.number}-stolni aniq joylashtirish` : 'Stolni tanlang'}</p>
          <p className="text-xs text-muted-foreground">{chosen ? 'Quyidagi tugmalar stolni kichik qadam bilan suradi.' : 'Stolni bosing yoki ushlab suring. Eshikni ham xaritada surish mumkin.'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ARROWS.map(({ key, icon: Icon, label }) => <button key={key} type="button" aria-label={label} disabled={!chosen || saving}
            onClick={() => {
              if (!chosen) return;
              place(chosen.number,
                chosen.x + (key === 'ArrowLeft' ? -20 : key === 'ArrowRight' ? 20 : 0),
                chosen.y + (key === 'ArrowUp' ? -20 : key === 'ArrowDown' ? 20 : 0));
            }}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card text-foreground hover:bg-primary/30 disabled:cursor-not-allowed disabled:opacity-40"><Icon className="h-4 w-4" /></button>)}
          <Button type="button" variant="outline" disabled={!dirty || saving} onClick={reset} className="min-h-11 rounded-xl"><RotateCcw className="mr-1.5 h-4 w-4" /> Avvalgi holat</Button>
        </div>
      </div>}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><Armchair className="h-4 w-4 text-brand-ink" /> Stol {editing ? '— surib joylashtiring' : '— Kassaga o‘tish'}</span>
        <span className="inline-flex items-center gap-1.5"><DoorOpen className="h-4 w-4 text-brand-ink" /> Eshik {editing ? '— suring yoki devorni tanlang' : '— kirish joyi'}</span>
        <span className="inline-flex items-center gap-1.5">{editing ? <Save className="h-4 w-4" /> : <MousePointer2 className="h-4 w-4" />} {editing ? 'Saqlash bosilmaguncha o‘zgarmaydi' : 'Ochiq buyurtma va bron keyingi bosqichda'}</span>
      </div>
    </section>
  );
}
