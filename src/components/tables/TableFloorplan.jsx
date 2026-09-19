import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Armchair, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Building2, Check, DoorOpen,
  Edit3, Grip, Maximize2, Minus, MousePointer2, Move, Plus, RotateCcw, Save, Sun, Trash2, X,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import {
  buildTableLayout, clamp, entranceFromPoint, normalizeEntrance, normalizeOutdoorPolygon,
  nudgeEntrance, pointInOutdoorPolygon, tableBounds, tableSize, TABLE_SIZES,
  validOutdoorPolygon, validateTableLayout, polygonToBox, boxToPolygon, PRESET_ZONES,
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

export default function TableFloorplan({ shop, canManage, onSaved, onOpen, onEditingChange, selectedViewNumber = null }) {
  const defaultLayout = useMemo(
    () => buildTableLayout(shop.table_count, shop.layout),
    [shop.id, shop.table_count, shop.layout_version],
  );
  const defaultEntrance = useMemo(
    () => normalizeEntrance(shop.entrance),
    [shop.id, shop.layout_version, shop.entrance?.side, shop.entrance?.offset],
  );
  const defaultOutdoor = useMemo(
    () => normalizeOutdoorPolygon(shop.outdoor_polygon),
    [shop.id, shop.layout_version, shop.outdoor_polygon],
  );
  const [layout, setLayout] = useState(defaultLayout);
  const [entrance, setEntrance] = useState(defaultEntrance);
  const [outdoorPolygon, setOutdoorPolygon] = useState(defaultOutdoor);
  const [zoneMode, setZoneMode] = useState(false);
  const [tempBox, setTempBox] = useState(null);
  const [editing, setEditing] = useState(false);
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const boardRef = useRef(null);
  const dragging = useRef(null);

  useEffect(() => {
    setLayout(defaultLayout);
    setEntrance(defaultEntrance);
    setOutdoorPolygon(defaultOutdoor);
    setZoneMode(false);
    setTempBox(null);
    setEditing(false);
    setSelectedNumber(null);
    setError('');
    dragging.current = null;
  }, [defaultLayout, defaultEntrance, defaultOutdoor]);

  const outdoorBox = useMemo(() => polygonToBox(outdoorPolygon), [outdoorPolygon]);

  const tableDirty = layout.some((point, index) =>
    point.x !== defaultLayout[index]?.x || point.y !== defaultLayout[index]?.y
    || tableSize(point) !== tableSize(defaultLayout[index]));
  const entranceDirty = entrance.side !== defaultEntrance.side || entrance.offset !== defaultEntrance.offset;
  const zoneDirty = JSON.stringify(outdoorPolygon) !== JSON.stringify(defaultOutdoor);
  const dirty = tableDirty || entranceDirty || zoneDirty;
  const zoneValid = validOutdoorPolygon(outdoorPolygon);
  const valid = validateTableLayout(shop.table_count, layout) && zoneValid;
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

    if (target === 'entrance') {
      setEntrance(entranceFromPoint(position.x, position.y));
    } else if (target === 'table') {
      place(dragging.current.extra, position.x, position.y);
    } else if (target === 'zone-draw') {
      const start = dragging.current.startPointer;
      const x = clamp(Math.min(start.x, position.x), 0, 1000);
      const y = clamp(Math.min(start.y, position.y), 0, 1000);
      const width = clamp(Math.abs(position.x - start.x), 0, 1000 - x);
      const height = clamp(Math.abs(position.y - start.y), 0, 1000 - y);
      setTempBox({ x, y, width, height });
    } else if (target === 'zone-corner') {
      const corner = dragging.current.extra;
      const init = dragging.current.initialBox;
      if (!init) return;

      const right = init.x + init.width;
      const bottom = init.y + init.height;

      let newX = init.x;
      let newY = init.y;
      let newW = init.width;
      let newH = init.height;

      if (corner === 'se') {
        newW = clamp(position.x - init.x, 150, 1000 - init.x);
        newH = clamp(position.y - init.y, 140, 1000 - init.y);
      } else if (corner === 'sw') {
        newX = clamp(position.x, 0, right - 150);
        newW = right - newX;
        newH = clamp(position.y - init.y, 140, 1000 - init.y);
      } else if (corner === 'ne') {
        newY = clamp(position.y, 0, bottom - 140);
        newW = clamp(position.x - init.x, 150, 1000 - init.x);
        newH = bottom - newY;
      } else if (corner === 'nw') {
        newX = clamp(position.x, 0, right - 150);
        newY = clamp(position.y, 0, bottom - 140);
        newW = right - newX;
        newH = bottom - newY;
      }

      setOutdoorPolygon(boxToPolygon({ x: newX, y: newY, width: newW, height: newH }));
    } else if (target === 'zone-move') {
      const start = dragging.current.startPointer;
      const init = dragging.current.initialBox;
      if (!init || !start) return;
      const dx = position.x - start.x;
      const dy = position.y - start.y;
      const newX = clamp(init.x + dx, 0, 1000 - init.width);
      const newY = clamp(init.y + dy, 0, 1000 - init.height);
      setOutdoorPolygon(boxToPolygon({ ...init, x: newX, y: newY }));
    }
  };
  const startDrag = (event, target, extra = null) => {
    if (!editing || saving) return;
    event.preventDefault();
    const pos = pointerCoordinates(event);
    if (!pos) return;

    dragging.current = {
      target,
      extra,
      pointerId: event.pointerId,
      startPointer: pos,
      initialBox: outdoorBox ? { ...outdoorBox } : null,
    };

    if (target === 'table') setSelectedNumber(extra);
    else setSelectedNumber(null);

    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const stopDrag = (event) => {
    if (dragging.current?.pointerId === event.pointerId) {
      if (dragging.current.target === 'zone-draw' && tempBox) {
        if (tempBox.width >= 100 && tempBox.height >= 100) {
          setOutdoorPolygon(boxToPolygon(tempBox));
        }
        setTempBox(null);
      }
      dragging.current = null;
    }
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
    setOutdoorPolygon(defaultOutdoor);
    setZoneMode(false);
    setTempBox(null);
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
        outdoor_polygon: outdoorPolygon,
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
  const openOrders = shop.orders || [];
  const occupiedCount = openOrders.filter((order) => order.state === 'occupied').length;
  const payingCount = openOrders.filter((order) => order.state === 'paying').length;
  const unpaidTotal = openOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const verticalDoor = entrance.side === 'left' || entrance.side === 'right';
  const finishedZone = outdoorPolygon.length >= 3 && validOutdoorPolygon(outdoorPolygon);
  const outdoorCount = finishedZone
    ? layout.filter((point) => pointInOutdoorPolygon(point, outdoorPolygon)).length : 0;
  const indoorCount = layout.length - outdoorCount;
  const zonePoints = outdoorPolygon.map((point) => `${point.x},${point.y}`).join(' ');

  return (
    <section aria-label={`${shop.name} stollar xaritasi`} className="rounded-[28px] border border-border bg-card premium-shadow p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-olive/15 text-brand-ink"><Armchair className="h-5 w-5" /></span>
          <div className="min-w-0 space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-brand-ink">{shop.name} · Zal rejasi</p>
            <h2 className="font-display text-xl sm:text-2xl font-semibold">Stollar xaritasi</h2>
            <p className="text-sm text-muted-foreground">{editing
              ? 'Stollarni do‘kon ichi yoki ko‘cha hududiga suring. Eshikni ham o‘zingiz joylashtirasiz.'
              : 'Do‘kon ichi va ko‘chadagi stollar bir xaritada. Stolni bosing — Kassa ochiladi.'}</p>
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

      {!editing && <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="Zal holati">
        <div className="rounded-xl border border-border bg-[#fbf8f0] p-3"><p className="text-[11px] text-muted-foreground">Bo‘sh</p><p className="text-xl font-bold tabular-nums">{Math.max(0, shop.table_count - openOrders.length)}</p></div>
        <div className="rounded-xl border border-brand-olive/35 bg-brand-olive/10 p-3"><p className="text-[11px] text-muted-foreground">Band</p><p className="text-xl font-bold tabular-nums">{occupiedCount}</p></div>
        <div className="rounded-xl border border-amber-300/70 bg-[#FECD7C]/20 p-3"><p className="text-[11px] text-muted-foreground">To‘lovda</p><p className="text-xl font-bold tabular-nums">{payingCount}</p></div>
        <div className="rounded-xl border border-brand-sand/50 bg-card p-3"><p className="text-[11px] text-muted-foreground">Ochiq hisoblar</p><p className="text-lg font-bold tabular-nums text-brand-ink">{unpaidTotal.toLocaleString('en-US')} <span className="text-xs">UZS</span></p></div>
      </div>}

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

      {editing && (
        <div className={`rounded-2xl border p-3 sm:p-4 space-y-3 transition-colors ${zoneMode ? 'border-brand-olive bg-[#f3f4e8]' : 'border-brand-olive/30 bg-brand-olive/5'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-card border border-brand-olive/30 text-brand-ink">
                <Sun className="h-5 w-5 text-[#969a55]" />
              </span>
              <div>
                <h3 className="text-sm font-bold">Ko‘cha / terassa hududini sozlash</h3>
                <p className="text-xs text-muted-foreground">
                  {zoneMode
                    ? outdoorBox
                      ? 'Burchaklardagi doiralardan ushlab cho‘zing yoki o‘rtasidan ushlab suring. Yangi chizish uchun xaritada sichqonchani torting.'
                      : 'Xaritada bosib torting — to‘rtburchak ko‘cha hududi chiziladi yoki tayyor andozalardan birini tanlang.'
                    : outdoorPolygon.length
                      ? 'Ko‘cha hududi belgilangan. Stollarni xaritada erkin joylashtiring.'
                      : 'Xaritada alohida ko‘cha yoki terassa maydonini ajratish uchun bosing.'}
                </p>
              </div>
            </div>
            {!zoneMode ? (
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setZoneMode(true);
                  setSelectedNumber(null);
                }}
                className="min-h-11 rounded-xl border-brand-olive bg-card text-brand-ink font-semibold hover:bg-brand-olive/15"
              >
                <Sun className="h-4 w-4 mr-2 text-[#969a55]" />
                {outdoorPolygon.length ? 'Ko‘cha hududini sozlash / cho‘zish' : 'Ko‘cha hududini chizish'}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => setZoneMode(false)}
                className="min-h-11 rounded-xl bg-primary hover:bg-primary-strong text-primary-foreground font-semibold"
              >
                <Check className="h-4 w-4 mr-2" />
                ✓ Tayyor · Stollarni joylashtirish
              </Button>
            )}
          </div>

          {zoneMode && (
            <div className="border-t border-brand-olive/25 pt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-brand-ink mr-1">Tezkor andozalar:</span>
                {PRESET_ZONES.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={() => {
                      setOutdoorPolygon(boxToPolygon(preset.box));
                      setTempBox(null);
                    }}
                    className="min-h-9 text-xs rounded-xl bg-card hover:border-brand-olive hover:bg-brand-olive/15 font-semibold"
                  >
                    {preset.label}
                  </Button>
                ))}
                {outdoorPolygon.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={() => {
                      setOutdoorPolygon([]);
                      setTempBox(null);
                    }}
                    className="min-h-9 text-xs rounded-xl bg-card text-destructive hover:bg-destructive/10 ml-auto font-semibold"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Hududni tozalash
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                💡 <strong>Maslahat:</strong> Andozalardan birini tanlab, so‘ng xaritadagi 4 ta burchakdan ushlab uni xohlagancha kengaytirishingiz yoki butunicha surishingiz mumkin.
              </p>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {editing && !zoneValid && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Ko‘cha chegarasi mos emas. Iltimos, andozalardan foydalaning yoki yangidan chizing.</p>}
      {editing && !validateTableLayout(shop.table_count, layout) && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Stollar joylashuvi mos emas: ustma-ust tushgan stollarni ajrating yoki kichraytiring.</p>}

      <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Xarita hududlari">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-sand/60 bg-[#fbf6eb] px-3 py-2 font-semibold text-brand-ink"><Building2 className="h-4 w-4" aria-hidden="true" /> Do‘kon ichi · {indoorCount} stol</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-olive/40 bg-[#eef0e4] px-3 py-2 font-semibold text-brand-ink"><Sun className="h-4 w-4" aria-hidden="true" /> Ko‘cha / terassa · {outdoorCount} stol</span>
        {editing && <span className="text-muted-foreground">{zoneMode ? 'Xaritadagi burchaklar orqali ko‘cha chegarasini cho‘zing.' : 'Stollarni joylashtiring yoki ko‘cha hududini sozlang.'}</span>}
        <span className="w-full text-[11px] text-muted-foreground">{outdoorPolygon.length ? 'Ko‘cha hududi belgilangan. Stollar koordinatalari o‘z-o‘zidan o‘zgarmaydi.' : 'Ko‘cha hali belgilanmagan. «Xaritani tahrirlash» → «Ko‘cha hududini chizish» orqali tanlang.'}</span>
      </div>

      <div className="rounded-2xl border border-border/70 bg-[#f7f5ed] p-2 sm:p-3">
        <div className="max-w-full overflow-x-auto overscroll-x-contain pb-2">
          <div className="relative min-w-[760px] w-full px-16 py-16">
            <div ref={boardRef} aria-label="Do‘kon va qo‘lda belgilangan ko‘cha hududi xaritasi"
              className={`relative isolate w-full aspect-[10/7] sm:aspect-[16/10] overflow-visible rounded-[25px] border-[3px] shadow-inner ${editing ? 'border-brand-olive' : 'border-[#b8b087]'}`}
              style={{ backgroundColor: '#fbf6eb', backgroundImage: 'linear-gradient(rgba(208,177,127,.14) 1px, transparent 1px), linear-gradient(90deg, rgba(208,177,127,.14) 1px, transparent 1px)', backgroundSize: '34px 34px' }}>
              {/* The street is a user-drawn polygon */}
              <svg aria-hidden="true" viewBox="0 0 1000 1000" preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 z-[1] h-full w-full rounded-[22px] overflow-hidden">
                <defs><pattern id="odina-outdoor-tiles" width="36" height="36" patternUnits="userSpaceOnUse">
                  <rect width="36" height="36" fill="#e8edda" />
                  <path d="M0 0H36M0 0V36" fill="none" stroke="#aca95d" strokeOpacity=".20" strokeWidth="2" />
                </pattern></defs>
                {outdoorPolygon.length >= 3 && <polygon points={zonePoints}
                  fill="url(#odina-outdoor-tiles)" stroke={validOutdoorPolygon(outdoorPolygon) ? '#969a55' : '#b45309'}
                  strokeWidth="5" strokeLinejoin="round" />}
                {tempBox && <rect x={tempBox.x} y={tempBox.y} width={tempBox.width} height={tempBox.height}
                  fill="rgba(172, 169, 93, 0.35)" stroke="#777b3d" strokeWidth="4" strokeDasharray="8 6" rx="10" />}
              </svg>
              <div className="pointer-events-none absolute z-[2] left-4 top-4 max-w-[54%] inline-flex items-center gap-1.5 rounded-xl border border-brand-sand/70 bg-white/90 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-brand-ink shadow-sm">
                <Building2 className="h-4 w-4 shrink-0" /> <span className="truncate">{shop.name}</span>
              </div>
              <div className="pointer-events-none absolute z-[2] right-4 top-4 rounded-full border border-border bg-card/90 px-3 py-1 text-[10px] font-semibold text-muted-foreground">
                {zoneMode ? (outdoorBox ? 'BURCHAKLARDAN USHLAB CHO‘ZING' : 'XARITADA TORTIB CHIZING') : editing ? 'STOLNI SURING' : 'STOLNI BOSING'}
              </div>

              {/* Canvas drag-to-draw overlay in zoneMode */}
              {zoneMode && (
                <div
                  onPointerDown={(event) => startDrag(event, 'zone-draw')}
                  onPointerMove={(event) => onMove(event, 'zone-draw')}
                  onPointerUp={stopDrag}
                  onPointerCancel={stopDrag}
                  style={{ touchAction: 'none' }}
                  className="absolute inset-0 z-20 cursor-crosshair"
                />
              )}

              <button type="button" aria-label={`Kirish eshigi: ${WALLS.find((wall) => wall.side === entrance.side)?.label} devor${editing ? ', joyini o‘zgartirish' : ''}`}
                title={editing ? 'Eshikni ushlab devor bo‘ylab suring' : 'Kirish eshigi'}
                disabled={!editing || saving || zoneMode}
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

              {/* Outdoor Box Interactive Handles */}
              {zoneMode && outdoorBox && (
                <>
                  {/* Top-Left NW */}
                  <button
                    type="button"
                    title="Burchakdan ushlab cho‘zing"
                    aria-label="Yuqori chap burchakni cho‘zish"
                    onPointerDown={(e) => startDrag(e, 'zone-corner', 'nw')}
                    onPointerMove={(e) => onMove(e, 'zone-corner')}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    style={{ left: `${outdoorBox.x / 10}%`, top: `${outdoorBox.y / 10}%`, transform: 'translate(-50%, -50%)', touchAction: 'none' }}
                    className="absolute z-40 flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-[#aca95d] text-white shadow-lg cursor-nwse-resize active:scale-125 transition-transform"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>

                  {/* Top-Right NE */}
                  <button
                    type="button"
                    title="Burchakdan ushlab cho‘zing"
                    aria-label="Yuqori o‘ng burchakni cho‘zish"
                    onPointerDown={(e) => startDrag(e, 'zone-corner', 'ne')}
                    onPointerMove={(e) => onMove(e, 'zone-corner')}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    style={{ left: `${(outdoorBox.x + outdoorBox.width) / 10}%`, top: `${outdoorBox.y / 10}%`, transform: 'translate(-50%, -50%)', touchAction: 'none' }}
                    className="absolute z-40 flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-[#aca95d] text-white shadow-lg cursor-nesw-resize active:scale-125 transition-transform"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>

                  {/* Bottom-Right SE */}
                  <button
                    type="button"
                    title="Burchakdan ushlab cho‘zing"
                    aria-label="Pastki o‘ng burchakni cho‘zish"
                    onPointerDown={(e) => startDrag(e, 'zone-corner', 'se')}
                    onPointerMove={(e) => onMove(e, 'zone-corner')}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    style={{ left: `${(outdoorBox.x + outdoorBox.width) / 10}%`, top: `${(outdoorBox.y + outdoorBox.height) / 10}%`, transform: 'translate(-50%, -50%)', touchAction: 'none' }}
                    className="absolute z-40 flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-[#aca95d] text-white shadow-lg cursor-nwse-resize active:scale-125 transition-transform"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>

                  {/* Bottom-Left SW */}
                  <button
                    type="button"
                    title="Burchakdan ushlab cho‘zing"
                    aria-label="Pastki chap burchakni cho‘zish"
                    onPointerDown={(e) => startDrag(e, 'zone-corner', 'sw')}
                    onPointerMove={(e) => onMove(e, 'zone-corner')}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    style={{ left: `${outdoorBox.x / 10}%`, top: `${(outdoorBox.y + outdoorBox.height) / 10}%`, transform: 'translate(-50%, -50%)', touchAction: 'none' }}
                    className="absolute z-40 flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-[#aca95d] text-white shadow-lg cursor-nesw-resize active:scale-125 transition-transform"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>

                  {/* Center Move Handle */}
                  <button
                    type="button"
                    title="Ko‘cha hududini ushlab suring"
                    aria-label="Ko‘cha hududini siljitish"
                    onPointerDown={(e) => startDrag(e, 'zone-move')}
                    onPointerMove={(e) => onMove(e, 'zone-move')}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    style={{
                      left: `${(outdoorBox.x + outdoorBox.width / 2) / 10}%`,
                      top: `${(outdoorBox.y + outdoorBox.height / 2) / 10}%`,
                      transform: 'translate(-50%, -50%)',
                      touchAction: 'none',
                    }}
                    className="absolute z-40 inline-flex items-center gap-1.5 rounded-full border-2 border-brand-olive bg-white/95 px-3 py-1.5 text-xs font-bold text-brand-ink shadow-md cursor-grab active:cursor-grabbing hover:bg-primary/20 select-none"
                  >
                    <Move className="h-3.5 w-3.5 text-brand-ink" />
                    <span>Ko‘cha hududi · siljitish</span>
                  </button>
                </>
              )}

              {layout.map((point) => {
                const order = (shop.orders || []).find((row) => row.number === point.number);
                const isOccupied = Boolean(order);
                const isPaying = order?.state === 'paying';
                const isSelected = selectedViewNumber === point.number;

                return (
                  <button
                    key={point.number}
                    type="button"
                    aria-label={`${point.number}-stol, ${isOccupied ? (isPaying ? 'To‘lov tekshirilmoqda' : `Band, ${Number(order.total || 0).toLocaleString('en-US')} UZS`) : 'Bo‘sh'}${editing ? ', joylashuvni o‘zgartirish' : ', Ko‘rish va kassaga o‘tish'}`}
                    title={editing ? 'Ushlab suring yoki tanlab yo‘nalish tugmalari bilan siljiting' : `${point.number}-stol${isOccupied ? ` — Band (${Number(order.total || 0).toLocaleString('en-US')} UZS)` : ' — Bo‘sh'}`}
                    disabled={saving || zoneMode}
                    onPointerDown={(event) => startDrag(event, 'table', point.number)}
                    onPointerMove={(event) => onMove(event, 'table')}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    onKeyDown={(event) => keyboardMove(event, point)}
                    onClick={() => {
                      if (zoneMode) return;
                      if (editing) setSelectedNumber(point.number);
                      else onOpen(shop.id, point.number);
                    }}
                    style={{
                      left: `${point.x / 10}%`,
                      top: `${point.y / 10}%`,
                      width: `${Math.round(68 * tableSize(point) / 100)}px`,
                      height: `${Math.round(68 * tableSize(point) / 100)}px`,
                      transform: 'translate(-50%, -50%)',
                      touchAction: editing ? 'none' : 'manipulation',
                    }}
                    className={`absolute z-10 rounded-2xl border-2 flex flex-col items-center justify-center gap-0.5 font-semibold shadow-md select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-olive transition-all ${
                      editing
                        ? selectedNumber === point.number
                          ? 'cursor-grab active:cursor-grabbing bg-primary border-brand-olive text-foreground ring-4 ring-brand-olive/20'
                          : 'cursor-grab active:cursor-grabbing bg-card border-brand-olive/65 text-foreground hover:bg-primary/40'
                        : isSelected
                          ? 'cursor-pointer bg-[#FECD7C] border-brand-olive text-brand-ink ring-4 ring-brand-olive/50 shadow-xl scale-105 z-20'
                          : isOccupied
                            ? isPaying
                              ? 'cursor-pointer bg-[#FECD7C] border-amber-600 text-brand-ink ring-2 ring-amber-500/60 shadow-md hover:scale-105'
                              : 'cursor-pointer bg-[#FECD7C] border-brand-olive text-brand-ink ring-2 ring-brand-olive/40 shadow-md hover:scale-105'
                            : 'cursor-pointer bg-card border-brand-olive/65 text-foreground hover:bg-primary/30 hover:shadow-lg'
                    }`}
                  >
                    {editing ? (
                      <Grip aria-hidden="true" className="h-4 w-4 text-brand-ink" />
                    ) : (
                      <Armchair aria-hidden="true" className="h-5 w-5 text-brand-ink" />
                    )}
                    <span className="text-xs">{point.number}-stol</span>
                    {!editing && isOccupied && (
                      <span className="pointer-events-none absolute top-full mt-1.5 rounded-lg border border-amber-300/80 bg-[#fff9ea] px-2 py-0.5 text-[10px] font-bold text-brand-ink whitespace-nowrap shadow-sm">
                        {isPaying ? `${Number(order.total || 0).toLocaleString('en-US')} UZS · To‘lov` : `${Number(order.total || 0).toLocaleString('en-US')} UZS`}
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="pointer-events-none absolute z-[2] bottom-3 left-4 right-4 text-center text-[10px] font-semibold text-brand-ink/70">{shop.table_count} ta stol · {zoneMode ? 'Ko‘cha hududini cho‘zing yoki suring' : editing ? 'Stollarni kerakli joyga suring' : 'Stolni tanlang'}</div>
            </div>
          </div>
        </div>
      </div>

      {editing && !zoneMode && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-secondary/30 p-3 sm:p-4">
        <div className="min-w-0">
          <p className="font-semibold text-sm">{chosen ? `${chosen.number}-stolni aniq joylashtirish` : 'Stolni tanlang'}</p>
          <p className="text-xs text-muted-foreground">{chosen ? 'Stolni suring yoki o‘lchamini alohida o‘zgartiring.' : 'Xaritadan stolni tanlang: joyi va o‘lchamini tahrirlaysiz.'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {chosen && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-olive/30 bg-card px-3 py-2">
            <span className="text-xs font-semibold whitespace-nowrap">Stol o‘lchami</span>
            <button type="button" aria-label="Stolni kichraytirish" disabled={saving || tableSize(chosen) <= 80}
              onClick={() => resizeTable(chosen.number, tableSize(chosen) - 10)}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-primary/20 disabled:opacity-40"><Minus className="h-4 w-4" /></button>
            <input type="range" aria-label={`${chosen.number}-stol o‘lchami`} min="80" max="140" step="10"
              value={tableSize(chosen)} disabled={saving}
              onChange={(event) => resizeTable(chosen.number, Number(event.target.value))}
              className="w-28 sm:w-36 accent-[#ACA95D]" />
            <button type="button" aria-label="Stolni kattalashtirish" disabled={saving || tableSize(chosen) >= 140}
              onClick={() => resizeTable(chosen.number, tableSize(chosen) + 10)}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-primary/20 disabled:opacity-40"><Plus className="h-4 w-4" /></button>
            <span className="w-10 text-right text-xs font-bold tabular-nums text-brand-ink">{tableSize(chosen)}%</span>
          </div>}
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
        <span className="inline-flex items-center gap-1.5"><Armchair className="h-4 w-4 text-brand-ink" /> Stol {editing ? '— surib joylashtiring' : '— Bo‘sh / Band / To‘lov holati'}</span>
        <span className="inline-flex items-center gap-1.5"><DoorOpen className="h-4 w-4 text-brand-ink" /> Eshik {editing ? '— suring yoki devorni tanlang' : '— kirish joyi'}</span>
        <span className="inline-flex items-center gap-1.5"><Sun className="h-4 w-4 text-brand-ink" /> Ko‘cha — to‘rtburchak hudud</span>
        <span className="inline-flex items-center gap-1.5">{editing ? <Save className="h-4 w-4" /> : <MousePointer2 className="h-4 w-4" />} {editing ? 'Saqlash bosilmaguncha o‘zgarmaydi' : 'Buyurtma to‘lovgacha stolda qoladi · bron keyingi bosqichda'}</span>
      </div>
    </section>
  );
}
