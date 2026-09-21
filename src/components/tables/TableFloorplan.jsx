import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Armchair, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Building2, Check,
  Coffee, DoorOpen, Edit3, Grip, Layers, Maximize2, Minus, MousePointer2,
  Link2, Move, Plus, RotateCcw, Save, Sliders, Sun, Trash2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import {
  buildTableLayout, clamp, entranceFromPoint, normalizeEntrance, normalizeOutdoorPolygon,
  nudgeEntrance, pointInOutdoorPolygon, tableBounds, tableSize, TABLE_SIZES,
  validOutdoorPolygon, validateTableLayout, polygonToBox, boxToPolygon,
  PRESET_ZONES, STREET_SIDES, FENCE_STYLES, FENCE_ENCLOSURES,
  generateStreetPolygon, detectStreetConfig,
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

export default function TableFloorplan({
  shop,
  canManage,
  onSaved,
  onOpen,
  onEditingChange,
  selectedViewNumber = null,
}) {
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

  const detectedConfig = useMemo(
    () => detectStreetConfig(defaultOutdoor, defaultEntrance),
    [defaultOutdoor, defaultEntrance],
  );

  const fenceStorageKey = `odina_pos_fence_style_${shop.id}`;
  const enclosureStorageKey = `odina_pos_fence_enclosure_${shop.id}`;

  const [layout, setLayout] = useState(defaultLayout);
  const [entrance, setEntrance] = useState(defaultEntrance);
  const [outdoorPolygon, setOutdoorPolygon] = useState(defaultOutdoor);
  const [streetSide, setStreetSide] = useState(detectedConfig.side);
  const [streetDepth, setStreetDepth] = useState(detectedConfig.depth);
  const [fenceStyle, setFenceStyle] = useState(() => {
    try {
      return localStorage.getItem(fenceStorageKey) || detectedConfig.fence || 'railing';
    } catch {
      return 'railing';
    }
  });
  const [fenceEnclosure, setFenceEnclosure] = useState(() => {
    try {
      return localStorage.getItem(enclosureStorageKey) || 'full';
    } catch {
      return 'full';
    }
  });

  const [zoneMode, setZoneMode] = useState(false);
  const [isLargeCanvas, setIsLargeCanvas] = useState(false);
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
    const detected = detectStreetConfig(defaultOutdoor, defaultEntrance);
    setStreetSide(detected.side);
    setStreetDepth(detected.depth);
    try {
      const savedFence = localStorage.getItem(fenceStorageKey);
      if (savedFence) setFenceStyle(savedFence);
      const savedEnclosure = localStorage.getItem(enclosureStorageKey);
      if (savedEnclosure) setFenceEnclosure(savedEnclosure);
    } catch {}
    setZoneMode(false);
    setTempBox(null);
    setEditing(false);
    setSelectedNumber(null);
    setError('');
    dragging.current = null;
  }, [defaultLayout, defaultEntrance, defaultOutdoor, fenceStorageKey, enclosureStorageKey]);

  const handleFenceStyleChange = (style) => {
    setFenceStyle(style);
    try {
      localStorage.setItem(fenceStorageKey, style);
    } catch {}
  };

  const handleFenceEnclosureChange = (enclosure) => {
    setFenceEnclosure(enclosure);
    try {
      localStorage.setItem(enclosureStorageKey, enclosure);
    } catch {}
  };

  const handleStreetSideChange = (newSide) => {
    setStreetSide(newSide);
    if (newSide === 'none') {
      setOutdoorPolygon([]);
    } else {
      const poly = generateStreetPolygon(newSide, streetDepth);
      setOutdoorPolygon(poly);
      if (['top', 'bottom', 'left', 'right'].includes(newSide)) {
        setEntrance((prev) => ({ ...prev, side: newSide }));
      }
    }
  };

  const handleStreetDepthChange = (depth) => {
    const clampedDepth = clamp(depth, 200, 650);
    setStreetDepth(clampedDepth);
    if (streetSide !== 'none') {
      const poly = generateStreetPolygon(streetSide, clampedDepth);
      setOutdoorPolygon(poly);
    }
  };

  const outdoorBox = useMemo(() => polygonToBox(outdoorPolygon), [outdoorPolygon]);

  const tableDirty = layout.some((point, index) =>
    point.x !== defaultLayout[index]?.x || point.y !== defaultLayout[index]?.y
    || tableSize(point) !== tableSize(defaultLayout[index]));
  const entranceDirty = entrance.side !== defaultEntrance.side || entrance.offset !== defaultEntrance.offset;
  const zoneDirty = JSON.stringify(outdoorPolygon) !== JSON.stringify(defaultOutdoor);
  const dirty = tableDirty || entranceDirty || zoneDirty;
  const zoneValid = validOutdoorPolygon(outdoorPolygon);
  const valid = validateTableLayout(shop.table_count, layout) && zoneValid;

  useEffect(() => {
    onEditingChange?.(editing && dirty);
  }, [editing, dirty, onEditingChange]);

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
      return {
        ...point,
        size: requestedSize,
        x: clamp(point.x, bounds.minX, bounds.maxX),
        y: clamp(point.y, bounds.minY, bounds.maxY),
      };
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
      if (streetSide === 'top' || streetSide === 'bottom') {
        const offset = clamp(Math.round(position.x / 10) * 10, 150, 850);
        setEntrance((prev) => ({ ...prev, offset }));
      } else if (streetSide === 'left' || streetSide === 'right') {
        const offset = clamp(Math.round(position.y / 10) * 10, 150, 850);
        setEntrance((prev) => ({ ...prev, offset }));
      } else {
        setEntrance(entranceFromPoint(position.x, position.y));
      }
    } else if (target === 'wall-move') {
      if (streetSide === 'top') {
        handleStreetDepthChange(Math.round(position.y));
      } else if (streetSide === 'bottom') {
        handleStreetDepthChange(Math.round(1000 - position.y));
      } else if (streetSide === 'left') {
        handleStreetDepthChange(Math.round(position.x));
      } else if (streetSide === 'right') {
        handleStreetDepthChange(Math.round(1000 - position.x));
      }
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
    const detected = detectStreetConfig(defaultOutdoor, defaultEntrance);
    setStreetSide(detected.side);
    setStreetDepth(detected.depth);
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

  const finishedZone = outdoorPolygon.length >= 3 && validOutdoorPolygon(outdoorPolygon);
  const outdoorCount = finishedZone
    ? layout.filter((point) => pointInOutdoorPolygon(point, outdoorPolygon)).length : 0;
  const indoorCount = layout.length - outdoorCount;
  const zonePoints = outdoorPolygon.map((point) => `${point.x},${point.y}`).join(' ');

  const doorPositionStyle = useMemo(() => {
    const offsetPercent = `${entrance.offset / 10}%`;
    const depthPercent = `${streetDepth / 10}%`;
    const invDepthPercent = `${(1000 - streetDepth) / 10}%`;

    switch (streetSide) {
      case 'top':
        return { left: offsetPercent, top: depthPercent, transform: 'translate(-50%, -50%)' };
      case 'bottom':
        return { left: offsetPercent, top: invDepthPercent, transform: 'translate(-50%, -50%)' };
      case 'right':
        return { left: invDepthPercent, top: offsetPercent, transform: 'translate(-50%, -50%)' };
      case 'left':
        return { left: depthPercent, top: offsetPercent, transform: 'translate(-50%, -50%)' };
      default:
        switch (entrance.side) {
          case 'right': return { left: '100%', top: offsetPercent, transform: 'translate(-50%, -50%)' };
          case 'bottom': return { left: offsetPercent, top: '100%', transform: 'translate(-50%, -50%)' };
          case 'left': return { left: '0%', top: offsetPercent, transform: 'translate(-50%, -50%)' };
          default: return { left: offsetPercent, top: '0%', transform: 'translate(-50%, -50%)' };
        }
    }
  }, [streetSide, streetDepth, entrance.offset, entrance.side]);

  const wallHandleStyle = useMemo(() => {
    switch (streetSide) {
      case 'top':
        return { left: '50%', top: `${streetDepth / 10}%`, transform: 'translate(-50%, -50%)' };
      case 'bottom':
        return { left: '50%', top: `${(1000 - streetDepth) / 10}%`, transform: 'translate(-50%, -50%)' };
      case 'right':
        return { left: `${(1000 - streetDepth) / 10}%`, top: '50%', transform: 'translate(-50%, -50%)' };
      case 'left':
        return { left: `${streetDepth / 10}%`, top: '50%', transform: 'translate(-50%, -50%)' };
      default:
        return null;
    }
  }, [streetSide, streetDepth]);

  const verticalWall = streetSide === 'left' || streetSide === 'right';

  return (
    <section aria-label={`${shop.name} stollar xaritasi`} className="rounded-[28px] border border-border bg-card premium-shadow p-4 sm:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-olive/15 text-brand-ink">
            <Armchair className="h-5 w-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-brand-ink">
              {shop.name} · Zal va ko‘cha rejasi
            </p>
            <h2 className="font-display text-xl sm:text-2xl font-semibold">Stollar xaritasi</h2>
            <p className="text-sm text-muted-foreground">
              {editing
                ? 'Stollarni do‘kon ichi yoki ko‘cha hududiga suring. Eshikni ham o‘zingiz joylashtirasiz.'
                : 'Do‘kon ichi va ko‘chadagi stollar bir xaritada. Stolni bosing — Kassa ochiladi.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Canvas size expander */}
          <button
            type="button"
            onClick={() => setIsLargeCanvas((prev) => !prev)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all"
            title={isLargeCanvas ? 'Standart o‘lchamga qaytish' : 'Xaritani kattalashtirish (Keng bino va ko‘cha)'}
          >
            {isLargeCanvas ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
            <span>{isLargeCanvas ? 'Standart xarita' : 'Katta xarita'}</span>
          </button>

          <span role="status" className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${
            editing && dirty ? 'border-amber-300 bg-amber-50 text-amber-900' : editing ? 'border-brand-olive/30 bg-brand-olive/10 text-brand-ink' : 'border-brand-olive/30 bg-brand-olive/10 text-brand-ink'
          }`}>
            {editing && dirty ? '● Saqlanmagan' : editing ? '● Tahrirlash' : '✓ Ko‘rish'}
          </span>
          {canManage && (editing ? (
            <>
              <Button type="button" variant="outline" disabled={saving} onClick={discard} className="min-h-11 rounded-xl">
                <X className="mr-1.5 h-4 w-4" /> Bekor qilish
              </Button>
              <Button type="button" onClick={save} disabled={saving || !dirty || !valid} className="min-h-11 rounded-xl bg-primary hover:bg-primary-strong text-primary-foreground">
                <Save className="mr-1.5 h-4 w-4" /> {saving ? 'Saqlanmoqda…' : 'Joylashuvni saqlash'}
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => { setError(''); setEditing(true); }} className="min-h-11 rounded-xl">
              <Edit3 className="mr-1.5 h-4 w-4" /> Xaritani tahrirlash
            </Button>
          ))}
        </div>
      </div>

      {/* Real-time Floorplan Status in View Mode */}
      {!editing && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="Zal holati">
          <div className="rounded-xl border border-border bg-[#fbf8f0] p-3">
            <p className="text-[11px] text-muted-foreground">Bo‘sh</p>
            <p className="text-xl font-bold tabular-nums">{Math.max(0, shop.table_count - openOrders.length)}</p>
          </div>
          <div className="rounded-xl border border-brand-olive/35 bg-brand-olive/10 p-3">
            <p className="text-[11px] text-muted-foreground">Band</p>
            <p className="text-xl font-bold tabular-nums">{occupiedCount}</p>
          </div>
          <div className="rounded-xl border border-amber-300/70 bg-[#FECD7C]/20 p-3">
            <p className="text-[11px] text-muted-foreground">To‘lovda</p>
            <p className="text-xl font-bold tabular-nums">{payingCount}</p>
          </div>
          <div className="rounded-xl border border-brand-sand/50 bg-card p-3">
            <p className="text-[11px] text-muted-foreground">Ochiq hisoblar</p>
            <p className="text-lg font-bold tabular-nums text-brand-ink">
              {unpaidTotal.toLocaleString('en-US')} <span className="text-xs">UZS</span>
            </p>
          </div>
        </div>
      )}

      {/* Entrance Door Controls in Edit Mode */}
      {editing && (
        <div className="rounded-2xl border border-brand-olive/30 bg-brand-olive/5 p-3 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <DoorOpen className="h-4 w-4 text-brand-ink" /> Eshik qayerda?
            </span>
            <span className="text-xs text-muted-foreground">Devorni tanlang yoki xaritadagi eshikni suring</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="group" aria-label="Eshik devorini tanlash">
            {WALLS.map((wall) => (
              <button
                key={wall.side}
                type="button"
                disabled={saving}
                aria-pressed={entrance.side === wall.side}
                onClick={() => {
                  setEntrance((previous) => ({ ...previous, side: wall.side }));
                  setSelectedNumber(null);
                }}
                className={`min-h-11 rounded-xl border px-3 text-sm font-semibold transition-colors touch-manipulation ${
                  entrance.side === wall.side
                    ? 'border-brand-olive bg-primary/60 text-foreground shadow-sm'
                    : 'border-border bg-card hover:border-brand-olive/60'
                }`}
              >
                {wall.label} devor
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
            <label htmlFor="entrance-position" className="text-xs font-semibold whitespace-nowrap">
              Eshikning devordagi joyi
            </label>
            <input id="entrance-position" type="range" min="150" max="850" step="10" value={entrance.offset} disabled={saving}
              onChange={(event) => setEntrance((previous) => ({ ...previous, offset: Number(event.target.value) }))}
              className="min-w-[120px] flex-1 accent-[#ACA95D]" />
            <span className="w-11 text-right text-xs font-bold tabular-nums text-brand-ink">
              {entrance.offset / 10}%
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Eshikni devor bo‘ylab suring, yuqoridagi slayderdan foydalaning yoki klaviaturada yo‘nalish tugmalarini bosing.
          </p>
        </div>
      )}

      {/* Street & Coffee Shop Custom Architecture Toolbar */}
      {editing && (
        <div className={`rounded-2xl border p-3 sm:p-4 space-y-4 transition-colors ${zoneMode ? 'border-brand-olive bg-[#f3f4e8]' : 'border-brand-olive/30 bg-brand-olive/5'}`}>
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

          {/* Street Side & Custom Coffee Shop Building Controls */}
          <div className="space-y-3 border-t border-brand-olive/20 pt-3">
            <div className="space-y-1.5">
              <span className="text-xs font-bold text-brand-ink flex items-center gap-1.5">
                <Sliders className="h-3.5 w-3.5 text-brand-ink" /> Ko‘cha qayerda joylashgan?
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {STREET_SIDES.map((side) => (
                  <button
                    key={side.id}
                    type="button"
                    disabled={saving}
                    onClick={() => handleStreetSideChange(side.id)}
                    aria-pressed={streetSide === side.id}
                    className={`min-h-10 rounded-xl border px-3 text-xs font-semibold transition-all flex flex-col items-center justify-center ${
                      streetSide === side.id
                        ? 'border-brand-olive bg-primary text-foreground font-bold shadow-xs'
                        : 'border-border bg-card hover:border-brand-olive/60'
                    }`}
                  >
                    <span>{side.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Street Walls & Fences Selector ("kochani devorlarini ham ozim qiladigan bolsin") */}
            {streetSide !== 'none' && (
              <div className="space-y-2.5 rounded-xl border border-brand-olive/25 bg-card/80 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-brand-ink flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5 text-brand-ink" /> Ko‘cha devorlari va to‘siqlari (O‘zingiz sozlang)
                  </span>
                  <span className="text-[11px] text-muted-foreground">To‘siq turi darhol xaritada chiziladi</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {FENCE_STYLES.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      disabled={saving}
                      onClick={() => handleFenceStyleChange(style.id)}
                      className={`min-h-10 rounded-xl border px-2.5 py-1.5 text-xs font-semibold text-left transition-all ${
                        fenceStyle === style.id
                          ? 'border-brand-olive bg-brand-olive/20 text-brand-ink font-bold shadow-xs'
                          : 'border-border bg-background hover:bg-muted/40'
                      }`}
                    >
                      <p className="font-bold truncate">{style.label}</p>
                      <p className="text-[10px] opacity-75 font-normal truncate">{style.description}</p>
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
                  <span className="text-xs font-semibold text-brand-ink mr-1">To‘siq o‘rnatilishi:</span>
                  {FENCE_ENCLOSURES.map((enc) => (
                    <button
                      key={enc.id}
                      type="button"
                      disabled={saving}
                      onClick={() => handleFenceEnclosureChange(enc.id)}
                      className={`min-h-7 rounded-lg border px-2.5 py-0.5 text-[11px] font-semibold transition-all ${
                        fenceEnclosure === enc.id
                          ? 'border-brand-olive bg-primary text-foreground font-bold'
                          : 'border-border bg-background hover:border-brand-olive/50'
                      }`}
                    >
                      {enc.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <label htmlFor="street-depth-slider" className="text-xs font-semibold whitespace-nowrap">
                    Bino va ko‘cha nisbati (chuqurligi):
                  </label>
                  <input
                    id="street-depth-slider"
                    type="range"
                    min="200"
                    max="650"
                    step="10"
                    value={streetDepth}
                    disabled={saving}
                    onChange={(e) => handleStreetDepthChange(Number(e.target.value))}
                    className="min-w-[120px] flex-1 accent-[#ACA95D]"
                  />
                  <span className="w-11 text-right text-xs font-bold tabular-nums text-brand-ink">
                    {Math.round(streetDepth / 10)}%
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    (Xaritadagi bino devori tutqichini ushlab ham surish mumkin)
                  </span>
                </div>
              </div>
            )}

            {/* Presets Toolbar */}
            {zoneMode && (
              <div className="border-t border-brand-olive/25 pt-2 space-y-2">
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
                        setStreetSide('none');
                      }}
                      className="min-h-9 text-xs rounded-xl bg-card text-destructive hover:bg-destructive/10 ml-auto font-semibold"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Hududni tozalash
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {editing && !zoneValid && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Ko‘cha chegarasi mos emas. Iltimos, andozalardan foydalaning yoki yangidan chizing.</p>}
      {editing && !validateTableLayout(shop.table_count, layout) && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Stollar joylashuvi mos emas: ustma-ust tushgan stollarni ajrating yoki kichraytiring.</p>}

      {/* Areas Indicator */}
      <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Xarita hududlari">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-sand/60 bg-[#fbf6eb] px-3 py-2 font-semibold text-brand-ink">
          <Building2 className="h-4 w-4" aria-hidden="true" /> Do‘kon ichi · {indoorCount} stol
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-olive/40 bg-[#eef0e4] px-3 py-2 font-semibold text-brand-ink">
          <Sun className="h-4 w-4" aria-hidden="true" /> Ko‘cha / terassa · {outdoorCount} stol
        </span>
        {editing && (
          <span className="text-muted-foreground">
            {zoneMode ? 'Xaritadagi burchaklar orqali ko‘cha chegarasini cho‘zing.' : 'Stollarni xohlagan joyingizga (zal ichi yoki ko‘chaga) erkin surib qo‘ying.'}
          </span>
        )}
        <span className="w-full text-[11px] text-muted-foreground">
          {outdoorPolygon.length ? 'Ko‘cha va do‘kon zali belgilangan. Stollar erkin harakatlanadi.' : 'Ko‘cha hali belgilanmagan. «Xaritani tahrirlash» → «Ko‘cha hududini chizish» orqali tanlang.'}
        </span>
      </div>

      {/* Big Map Board (Free Open Space without trapping green border) */}
      <div className="rounded-2xl border border-border/80 bg-[#f4f1e8] p-1.5 sm:p-2 shadow-inner">
        <div className="max-w-full overflow-x-auto overscroll-x-contain">
          <div className={`relative w-full ${isLargeCanvas ? 'min-w-[980px] min-h-[620px] aspect-[16/9]' : 'min-w-[760px] aspect-[16/10]'}`}>
            <div
              ref={boardRef}
              aria-label="Do‘kon va qo‘lda belgilangan ko‘cha hududi xaritasi"
              className="relative isolate w-full h-full overflow-visible rounded-[20px] border-2 border-[#cfc8b0] bg-[#fbf6eb] shadow-sm"
              style={{
                backgroundImage: 'radial-gradient(rgba(172,169,93,.15) 1.5px, transparent 1.5px)',
                backgroundSize: '28px 28px',
              }}
            >
              {/* SVG Layer: Street, Coffee Shop Building Walls, Doors & Decor */}
              <svg
                aria-hidden="true"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 z-[1] h-full w-full rounded-[18px] overflow-hidden"
              >
                <defs>
                  {/* Street Cobblestone Floor Pattern */}
                  <pattern id="odina-outdoor-tiles" width="36" height="36" patternUnits="userSpaceOnUse">
                    <rect width="36" height="36" fill="#e8edda" />
                    <rect x="2" y="2" width="14" height="14" rx="2" fill="#dfe6d0" stroke="#aca95d" strokeOpacity=".25" strokeWidth="1" />
                    <rect x="18" y="2" width="16" height="14" rx="2" fill="#e4ebd5" stroke="#aca95d" strokeOpacity=".25" strokeWidth="1" />
                    <rect x="2" y="18" width="16" height="16" rx="2" fill="#e4ebd5" stroke="#aca95d" strokeOpacity=".25" strokeWidth="1" />
                    <rect x="20" y="18" width="14" height="16" rx="2" fill="#dfe6d0" stroke="#aca95d" strokeOpacity=".25" strokeWidth="1" />
                  </pattern>

                  {/* Coffee Shop Parquet Floor Pattern */}
                  <pattern id="shop-parquet" width="40" height="40" patternUnits="userSpaceOnUse">
                    <rect width="40" height="40" fill="#fdfbf7" />
                    <line x1="0" y1="20" x2="40" y2="20" stroke="#d5c8a8" strokeOpacity=".3" strokeWidth="1" />
                    <line x1="20" y1="0" x2="20" y2="40" stroke="#d5c8a8" strokeOpacity=".3" strokeWidth="1" />
                  </pattern>
                </defs>

                {/* 1. Street Area Polygon */}
                {outdoorPolygon.length >= 3 && (
                  <polygon points={zonePoints}
                    fill="url(#odina-outdoor-tiles)"
                    stroke={validOutdoorPolygon(outdoorPolygon) ? '#969a55' : '#b45309'}
                    strokeWidth="5"
                    strokeLinejoin="round"
                  />
                )}

                {/* Freehand box when drawing */}
                {tempBox && (
                  <rect
                    x={tempBox.x}
                    y={tempBox.y}
                    width={tempBox.width}
                    height={tempBox.height}
                    fill="rgba(172, 169, 93, 0.35)"
                    stroke="#777b3d"
                    strokeWidth="4"
                    strokeDasharray="8 6"
                    rx="10"
                  />
                )}

                {/* 2. Coffee Shop Building Walls & Door Swing Arc ("this will be our coffee shop") */}
                {finishedZone && streetSide !== 'none' && (
                  <>
                    {streetSide === 'top' && (
                      <g id="coffee-shop-building-top">
                        {/* Coffee Shop Indoor Parquet Floor */}
                        <rect x="25" y={streetDepth} width="950" height={975 - streetDepth} fill="url(#shop-parquet)" rx="4" />
                        
                        {/* Shadow under front dividing wall */}
                        <line x1="25" y1={streetDepth + 5} x2="975" y2={streetDepth + 5} stroke="rgba(0,0,0,0.15)" strokeWidth="16" />
                        
                        {/* Front Dividing Wall (with entrance door gap) */}
                        <line x1="25" y1={streetDepth} x2={Math.max(35, entrance.offset - 50)} y2={streetDepth} stroke="#4a4637" strokeWidth="14" strokeLinecap="square" />
                        <line x1={Math.min(965, entrance.offset + 50)} y1={streetDepth} x2="975" y2={streetDepth} stroke="#4a4637" strokeWidth="14" strokeLinecap="square" />
                        
                        {/* Coffee shop left, right, and bottom building walls */}
                        <line x1="25" y1={streetDepth} x2="25" y2="975" stroke="#4a4637" strokeWidth="10" />
                        <line x1="975" y1={streetDepth} x2="975" y2="975" stroke="#4a4637" strokeWidth="10" />
                        <line x1="25" y1="975" x2="975" y2="975" stroke="#4a4637" strokeWidth="10" />

                        {/* Door Jambs */}
                        <rect x={entrance.offset - 52} y={streetDepth - 9} width="6" height="18" fill="#8c734b" rx="1" />
                        <rect x={entrance.offset + 46} y={streetDepth - 9} width="6" height="18" fill="#8c734b" rx="1" />

                        {/* Door Opening Swing Arc (into the coffee shop) */}
                        <path d={`M ${entrance.offset - 48} ${streetDepth} A 48 48 0 0 0 ${entrance.offset} ${streetDepth + 48}`} fill="none" stroke="#aca95d" strokeWidth="2.5" strokeDasharray="5 4" />
                        {/* Door Leaf */}
                        <line x1={entrance.offset} y1={streetDepth} x2={entrance.offset} y2={streetDepth + 46} stroke="#8c734b" strokeWidth="4.5" strokeLinecap="round" />

                        {/* Corner Pillars */}
                        <rect x="18" y={streetDepth - 7} width="14" height="14" fill="#363327" rx="2" />
                        <rect x="968" y={streetDepth - 7} width="14" height="14" fill="#363327" rx="2" />
                        <rect x="18" y="968" width="14" height="14" fill="#363327" rx="2" />
                        <rect x="968" y="968" width="14" height="14" fill="#363327" rx="2" />
                      </g>
                    )}

                    {streetSide === 'bottom' && (
                      <g id="coffee-shop-building-bottom">
                        <rect x="25" y="25" width="950" height={975 - streetDepth} fill="url(#shop-parquet)" rx="4" />
                        <line x1="25" y1={1000 - streetDepth + 5} x2="975" y2={1000 - streetDepth + 5} stroke="rgba(0,0,0,0.15)" strokeWidth="16" />
                        <line x1="25" y1={1000 - streetDepth} x2={Math.max(35, entrance.offset - 50)} y2={1000 - streetDepth} stroke="#4a4637" strokeWidth="14" strokeLinecap="square" />
                        <line x1={Math.min(965, entrance.offset + 50)} y1={1000 - streetDepth} x2="975" y2={1000 - streetDepth} stroke="#4a4637" strokeWidth="14" strokeLinecap="square" />
                        <line x1="25" y1="25" x2="25" y2={1000 - streetDepth} stroke="#4a4637" strokeWidth="10" />
                        <line x1="975" y1="25" x2="975" y2={1000 - streetDepth} stroke="#4a4637" strokeWidth="10" />
                        <line x1="25" y1="25" x2="975" y2="25" stroke="#4a4637" strokeWidth="10" />
                        <rect x={entrance.offset - 52} y={1000 - streetDepth - 9} width="6" height="18" fill="#8c734b" rx="1" />
                        <rect x={entrance.offset + 46} y={1000 - streetDepth - 9} width="6" height="18" fill="#8c734b" rx="1" />
                        <path d={`M ${entrance.offset - 48} ${1000 - streetDepth} A 48 48 0 0 1 ${entrance.offset} ${1000 - streetDepth - 48}`} fill="none" stroke="#aca95d" strokeWidth="2.5" strokeDasharray="5 4" />
                        <line x1={entrance.offset} y1={1000 - streetDepth} x2={entrance.offset} y2={1000 - streetDepth - 46} stroke="#8c734b" strokeWidth="4.5" strokeLinecap="round" />
                      </g>
                    )}

                    {streetSide === 'right' && (
                      <g id="coffee-shop-building-right">
                        <rect x="25" y="25" width={975 - streetDepth} height="950" fill="url(#shop-parquet)" rx="4" />
                        <line x1={1000 - streetDepth + 5} y1="25" x2={1000 - streetDepth + 5} y2="975" stroke="rgba(0,0,0,0.15)" strokeWidth="16" />
                        <line x1={1000 - streetDepth} y1="25" x2={1000 - streetDepth} y2={Math.max(35, entrance.offset - 50)} stroke="#4a4637" strokeWidth="14" strokeLinecap="square" />
                        <line x1={1000 - streetDepth} y1={Math.min(965, entrance.offset + 50)} x2={1000 - streetDepth} y2="975" stroke="#4a4637" strokeWidth="14" strokeLinecap="square" />
                        <line x1="25" y1="25" x2="25" y2="975" stroke="#4a4637" strokeWidth="10" />
                        <line x1="25" y1="25" x2={1000 - streetDepth} y2="25" stroke="#4a4637" strokeWidth="10" />
                        <line x1="25" y1="975" x2={1000 - streetDepth} y2="975" stroke="#4a4637" strokeWidth="10" />
                        <rect x={1000 - streetDepth - 9} y={entrance.offset - 52} width="18" height="6" fill="#8c734b" rx="1" />
                        <rect x={1000 - streetDepth - 9} y={entrance.offset + 46} width="18" height="6" fill="#8c734b" rx="1" />
                        <path d={`M ${1000 - streetDepth} ${entrance.offset - 48} A 48 48 0 0 0 ${1000 - streetDepth - 48} ${entrance.offset}`} fill="none" stroke="#aca95d" strokeWidth="2.5" strokeDasharray="5 4" />
                        <line x1={1000 - streetDepth} y1={entrance.offset} x2={1000 - streetDepth - 46} y2={entrance.offset} stroke="#8c734b" strokeWidth="4.5" strokeLinecap="round" />
                      </g>
                    )}

                    {streetSide === 'left' && (
                      <g id="coffee-shop-building-left">
                        <rect x={streetDepth} y="25" width={975 - streetDepth} height="950" fill="url(#shop-parquet)" rx="4" />
                        <line x1={streetDepth + 5} y1="25" x2={streetDepth + 5} y2="975" stroke="rgba(0,0,0,0.15)" strokeWidth="16" />
                        <line x1={streetDepth} y1="25" x2={streetDepth} y2={Math.max(35, entrance.offset - 50)} stroke="#4a4637" strokeWidth="14" strokeLinecap="square" />
                        <line x1={streetDepth} y1={Math.min(965, entrance.offset + 50)} x2={streetDepth} y2="975" stroke="#4a4637" strokeWidth="14" strokeLinecap="square" />
                        <line x1="975" y1="25" x2="975" y2="975" stroke="#4a4637" strokeWidth="10" />
                        <line x1={streetDepth} y1="25" x2="975" y2="25" stroke="#4a4637" strokeWidth="10" />
                        <line x1={streetDepth} y1="975" x2="975" y2="975" stroke="#4a4637" strokeWidth="10" />
                        <rect x={streetDepth - 9} y={entrance.offset - 52} width="18" height="6" fill="#8c734b" rx="1" />
                        <rect x={streetDepth - 9} y={entrance.offset + 46} width="18" height="6" fill="#8c734b" rx="1" />
                        <path d={`M ${streetDepth} ${entrance.offset - 48} A 48 48 0 0 1 ${streetDepth + 48} ${entrance.offset}`} fill="none" stroke="#aca95d" strokeWidth="2.5" strokeDasharray="5 4" />
                        <line x1={streetDepth} y1={entrance.offset} x2={streetDepth + 46} y2={entrance.offset} stroke="#8c734b" strokeWidth="4.5" strokeLinecap="round" />
                      </g>
                    )}
                  </>
                )}

                {/* 3. Street Perimeter Fences ("this will be our street" boundary) */}
                {finishedZone && streetSide !== 'none' && (
                  <g id="street-perimeter-fence">
                    {streetSide === 'top' && (
                      <>
                        {fenceEnclosure !== 'front_open' && (
                          fenceStyle === 'railing' ? (
                            <line x1="0" y1="6" x2="1000" y2="6" stroke="#845e3c" strokeWidth="8" strokeDasharray="18 8" />
                          ) : fenceStyle === 'walled' ? (
                            <line x1="0" y1="6" x2="1000" y2="6" stroke="#786c5e" strokeWidth="12" />
                          ) : fenceStyle === 'glass' ? (
                            <line x1="0" y1="5" x2="1000" y2="5" stroke="#38bdf8" strokeWidth="6" strokeDasharray="90 8" />
                          ) : (
                            <line x1="0" y1="4" x2="1000" y2="4" stroke="#a8a29e" strokeWidth="6" strokeDasharray="24 12" />
                          )
                        )}
                        {/* Street Corner Flower Planters / Lamps */}
                        <circle cx="24" cy="24" r="12" fill="#5b6e3b" />
                        <circle cx="976" cy="24" r="12" fill="#5b6e3b" />
                      </>
                    )}
                  </g>
                )}
              </svg>

              {/* Coffee Shop Inner Plaque ("this will be our coffee shop") */}
              <div
                className={`pointer-events-none absolute z-[2] inline-flex items-center gap-2 rounded-xl border border-[#d5c8a8] bg-white/95 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-brand-ink shadow-sm ${
                  streetSide === 'top'
                    ? 'left-8 bottom-6'
                    : streetSide === 'bottom'
                      ? 'left-8 top-6'
                      : streetSide === 'right'
                        ? 'left-8 top-6'
                        : 'right-8 top-6'
                }`}
              >
                <Coffee className="h-4 w-4 text-[#8c734b] shrink-0" />
                <span className="truncate">{shop.name} · Qahvaxona zali (Do‘kon)</span>
              </div>

              {/* Street Outer Plaque ("this will be our street") */}
              {finishedZone && streetSide !== 'none' && (
                <div
                  className={`pointer-events-none absolute z-[2] inline-flex items-center gap-1.5 rounded-xl border border-brand-olive/40 bg-white/95 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[#656b2a] shadow-sm ${
                    streetSide === 'top'
                      ? 'left-8 top-6'
                      : streetSide === 'bottom'
                        ? 'left-8 bottom-6'
                        : streetSide === 'right'
                          ? 'right-8 top-6'
                          : 'left-8 top-6'
                  }`}
                >
                  <Sun className="h-4 w-4 text-[#969a55] shrink-0" />
                  <span>Ko‘cha / Terassa ({outdoorCount} ta stol)</span>
                </div>
              )}

              <div className="pointer-events-none absolute z-[2] right-6 bottom-6 rounded-full border border-border bg-card/90 px-3 py-1 text-[10px] font-semibold text-muted-foreground shadow-xs">
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

              {/* Entrance Door (On the Coffee Shop Wall) */}
              <button
                type="button"
                aria-label={`Kirish eshigi: ${WALLS.find((wall) => wall.side === entrance.side)?.label} devor${editing ? ', joyini o‘zgartirish' : ''}`}
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
                style={{ ...doorPositionStyle, touchAction: editing ? 'none' : 'manipulation' }}
                className={`absolute z-30 flex items-center justify-center gap-1.5 border-2 border-brand-olive bg-card text-brand-ink font-bold shadow-lg select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-olive ${
                  verticalWall ? 'h-16 w-16 flex-col rounded-2xl text-[10px]' : 'h-11 min-w-[110px] rounded-xl text-xs'
                } ${editing ? 'cursor-grab active:cursor-grabbing ring-4 ring-primary/40' : 'cursor-default'}`}
              >
                <DoorOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-ink" />
                <span>Eshik</span>
                {editing && <Grip aria-hidden="true" className="h-3 w-3 shrink-0 opacity-65" />}
              </button>

              {/* Interactive Wall Move Handle (Drag to make coffee shop bigger/smaller) */}
              {editing && finishedZone && wallHandleStyle && !zoneMode && (
                <button
                  type="button"
                  title="Qahvaxona devorini ushlab suring (bino va ko‘cha hajmini o‘zgartirish)"
                  aria-label="Bino devorini surish"
                  onPointerDown={(e) => startDrag(e, 'wall-move')}
                  onPointerMove={(e) => onMove(e, 'wall-move')}
                  onPointerUp={stopDrag}
                  onPointerCancel={stopDrag}
                  style={{
                    ...wallHandleStyle,
                    touchAction: 'none',
                  }}
                  className={`absolute z-35 inline-flex items-center gap-1.5 rounded-full border-2 border-brand-olive bg-[#4a4637] text-white px-3 py-1 text-[11px] font-bold shadow-xl cursor-grab active:cursor-grabbing hover:scale-105 transition-transform select-none ${
                    verticalWall ? 'cursor-col-resize' : 'cursor-row-resize'
                  }`}
                >
                  <Move className="h-3.5 w-3.5 text-white" />
                  <span>Devorni surish</span>
                </button>
              )}

              {/* Outdoor Box Interactive Handles */}
              {zoneMode && outdoorBox && (
                <>
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

              {/* Tables: Freely Draggable Everywhere between Coffee Shop and Street */}
              {layout.map((point) => {
                const order = (shop.orders || []).find((row) => row.number === point.number);
                const group = (shop.groups || []).find((row) => row.numbers?.includes(point.number));
                const isOccupied = Boolean(order);
                const isPaying = order?.state === 'paying';
                const isSelected = selectedViewNumber === point.number;
                const isTableOutdoor = finishedZone && pointInOutdoorPolygon(point, outdoorPolygon);

                return (
                  <button
                    key={point.number}
                    type="button"
                    aria-label={`${point.number}-stol, ${isOccupied ? (isPaying ? 'To‘lov tekshirilmoqda' : `Band, ${Number(order.total || 0).toLocaleString('en-US')} UZS`) : 'Bo‘sh'}${editing ? ', joylashuvni o‘zgartirish' : ', Ko‘rish va kassaga o‘tish'}`}
                    title={editing ? 'Ushlab suring yoki tanlab yo‘nalish tugmalari bilan siljiting' : `${point.number}-stol${isOccupied ? ` — Band (${Number(order.total || 0).toLocaleString('en-US')} UZS)` : ' — Bo‘sh'}`}
                    disabled={saving}
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
                    className={`absolute z-20 rounded-2xl border-2 flex flex-col items-center justify-center gap-0.5 font-semibold shadow-md select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-olive transition-all ${
                      editing
                        ? selectedNumber === point.number
                          ? 'cursor-grab active:cursor-grabbing bg-primary border-brand-olive text-foreground ring-4 ring-brand-olive/25 shadow-xl scale-105'
                          : isTableOutdoor
                            ? 'cursor-grab active:cursor-grabbing bg-[#f4f7ee] border-[#969a55] text-foreground hover:bg-primary/40'
                            : 'cursor-grab active:cursor-grabbing bg-card border-brand-olive/65 text-foreground hover:bg-primary/40'
                        : isSelected
                          ? 'cursor-pointer bg-[#FECD7C] border-brand-olive text-brand-ink ring-4 ring-brand-olive/50 shadow-xl scale-105 z-25'
                          : isOccupied
                            ? isPaying
                              ? 'cursor-pointer bg-[#FECD7C] border-amber-600 text-brand-ink ring-2 ring-amber-500/60 shadow-md hover:scale-105'
                              : 'cursor-pointer bg-[#FECD7C] border-brand-olive text-brand-ink ring-2 ring-brand-olive/40 shadow-md hover:scale-105'
                            : isTableOutdoor
                              ? 'cursor-pointer bg-[#f7f9f2] border-[#969a55]/80 text-foreground hover:bg-primary/30 hover:shadow-lg'
                              : 'cursor-pointer bg-card border-brand-olive/65 text-foreground hover:bg-primary/30 hover:shadow-lg'
                    }`}
                  >
                    {editing ? (
                      <Grip aria-hidden="true" className="h-4 w-4 text-brand-ink" />
                    ) : isTableOutdoor ? (
                      <Coffee aria-hidden="true" className="h-5 w-5 text-[#656b2a]" />
                    ) : (
                      <Armchair aria-hidden="true" className="h-5 w-5 text-brand-ink" />
                    )}
                    <span className="text-xs font-bold leading-tight">{point.number}-stol</span>
                    {!editing && group && (
                      <span className="flex items-center gap-0.5 text-[8px] font-bold leading-none text-brand-ink">
                        <Link2 className="h-2.5 w-2.5" />
                        {group.numbers.join('+')}
                      </span>
                    )}
                    {isTableOutdoor && (
                      <span className="text-[9px] font-bold text-[#656b2a] leading-none">Ko‘cha</span>
                    )}
                    {!editing && isOccupied && (
                      <span className="pointer-events-none absolute top-full mt-1.5 rounded-lg border border-amber-300/80 bg-[#fff9ea] px-2 py-0.5 text-[10px] font-bold text-brand-ink whitespace-nowrap shadow-sm">
                        {isPaying ? `${Number(order.total || 0).toLocaleString('en-US')} UZS · To‘lov` : `${Number(order.total || 0).toLocaleString('en-US')} UZS`}
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="pointer-events-none absolute z-[2] bottom-3 left-4 right-4 text-center text-[10px] font-semibold text-brand-ink/70">
                {shop.table_count} ta stol · {zoneMode ? 'Ko‘cha hududini cho‘zing yoki suring' : editing ? 'Stollarni erkin surib qo‘ying' : 'Stolni tanlang'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Selected Table Fine Adjustment */}
      {editing && !zoneMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-secondary/30 p-3 sm:p-4">
          <div className="min-w-0">
            <p className="font-semibold text-sm">
              {chosen
                ? `${chosen.number}-stolni aniq joylashtirish (${
                    finishedZone && pointInOutdoorPolygon(chosen, outdoorPolygon) ? '🌿 Ko‘chada' : '☕ Qahvaxona ichida'
                  })`
                : 'Stolni tanlang'}
            </p>
            <p className="text-xs text-muted-foreground">{chosen ? 'Stolni suring yoki o‘lchamini alohida o‘zgartiring.' : 'Xaritadan stolni tanlang: joyi va o‘lchamini tahrirlaysiz.'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {chosen && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-olive/30 bg-card px-3 py-2">
                <span className="text-xs font-semibold whitespace-nowrap">Stol o‘lchami</span>
                <button
                  type="button"
                  aria-label="Stolni kichraytirish"
                  disabled={saving || tableSize(chosen) <= 80}
                  onClick={() => resizeTable(chosen.number, tableSize(chosen) - 10)}
                  className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-primary/20 disabled:opacity-40"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <input
                  type="range"
                  aria-label={`${chosen.number}-stol o‘lchami`}
                  min="80"
                  max="140"
                  step="10"
                  value={tableSize(chosen)}
                  disabled={saving}
                  onChange={(event) => resizeTable(chosen.number, Number(event.target.value))}
                  className="w-28 sm:w-36 accent-[#ACA95D]"
                />
                <button
                  type="button"
                  aria-label="Stolni kattalashtirish"
                  disabled={saving || tableSize(chosen) >= 140}
                  onClick={() => resizeTable(chosen.number, tableSize(chosen) + 10)}
                  className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-primary/20 disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <span className="w-10 text-right text-xs font-bold tabular-nums text-brand-ink">{tableSize(chosen)}%</span>
              </div>
            )}
            {ARROWS.map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                type="button"
                aria-label={label}
                disabled={!chosen || saving}
                onClick={() => {
                  if (!chosen) return;
                  place(
                    chosen.number,
                    chosen.x + (key === 'ArrowLeft' ? -20 : key === 'ArrowRight' ? 20 : 0),
                    chosen.y + (key === 'ArrowUp' ? -20 : key === 'ArrowDown' ? 20 : 0),
                  );
                }}
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card text-foreground hover:bg-primary/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
            <Button type="button" variant="outline" disabled={!dirty || saving} onClick={reset} className="min-h-11 rounded-xl">
              <RotateCcw className="mr-1.5 h-4 w-4" /> Avvalgi holat
            </Button>
          </div>
        </div>
      )}

      {/* Footer Legend */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Armchair className="h-4 w-4 text-brand-ink" /> Stol {editing ? '— surib joylashtiring' : '— Bo‘sh / Band / To‘lov holati'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <DoorOpen className="h-4 w-4 text-brand-ink" /> Eshik {editing ? '— suring yoki devorni tanlang' : '— kirish joyi'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Sun className="h-4 w-4 text-brand-ink" /> Ko‘cha — to‘rtburchak hudud
        </span>
        <span className="inline-flex items-center gap-1.5">
          {editing ? <Save className="h-4 w-4" /> : <MousePointer2 className="h-4 w-4" />}{' '}
          {editing ? 'Saqlash bosilmaguncha o‘zgarmaydi' : 'Buyurtma to‘lovgacha stolda qoladi · bron keyingi bosqichda'}
        </span>
      </div>
    </section>
  );
}
