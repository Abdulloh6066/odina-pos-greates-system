import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Armchair, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Building2, Check,
  DoorOpen, Edit3, Grip, Maximize2, Minus, MousePointer2, Move, Plus,
  RotateCcw, Save, Sun, Trash2, X, Sliders, Layers, Coffee, Sparkles,
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

  const [customZoneMode, setCustomZoneMode] = useState(false);
  const [tempBox, setTempBox] = useState(null);
  const [editing, setEditing] = useState(false);
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const boardRef = useRef(null);
  const dragging = useRef(null);

  // Sync state when shop changes
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
    setCustomZoneMode(false);
    setTempBox(null);
    setEditing(false);
    setSelectedNumber(null);
    setError('');
    dragging.current = null;
  }, [defaultLayout, defaultEntrance, defaultOutdoor, fenceStorageKey, enclosureStorageKey]);

  // Persist fence preference locally
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

  // Change street side & update outdoor polygon
  const handleStreetSideChange = (newSide) => {
    setStreetSide(newSide);
    if (newSide === 'none') {
      setOutdoorPolygon([]);
    } else {
      const poly = generateStreetPolygon(newSide, streetDepth);
      setOutdoorPolygon(poly);
      // Align entrance side to match the street boundary wall
      if (['top', 'bottom', 'left', 'right'].includes(newSide)) {
        setEntrance((prev) => ({ ...prev, side: newSide }));
      }
    }
  };

  // Adjust street depth & sync polygon
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
      // Entrance slides along dividing wall
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
      // User is dragging the dividing wall handle directly on the canvas!
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
    setCustomZoneMode(false);
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
        action: 'set_table_layout',
        shop_id: shop.id,
        layout_version: shop.layout_version,
        layout,
        entrance,
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

  const hasOutdoorStreet = outdoorPolygon.length >= 3 && validOutdoorPolygon(outdoorPolygon) && streetSide !== 'none';
  const outdoorCount = hasOutdoorStreet
    ? layout.filter((point) => pointInOutdoorPolygon(point, outdoorPolygon)).length : 0;
  const indoorCount = layout.length - outdoorCount;

  // Door position calculation along the dividing wall
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
        // Shop only, outer perimeter
        switch (entrance.side) {
          case 'right': return { left: '100%', top: offsetPercent, transform: 'translate(-50%, -50%)' };
          case 'bottom': return { left: offsetPercent, top: '100%', transform: 'translate(-50%, -50%)' };
          case 'left': return { left: '0%', top: offsetPercent, transform: 'translate(-50%, -50%)' };
          default: return { left: offsetPercent, top: '0%', transform: 'translate(-50%, -50%)' };
        }
    }
  }, [streetSide, streetDepth, entrance.offset, entrance.side]);

  // Wall move handle position
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
                ? 'Stollarni bino ichi yoki ko‘chaga erkin suring. Devor va to‘siqlarni o‘zingiz sozlang.'
                : 'Bino zali va tashqi terassa bir xaritada. Stolni bosing — Kassa va hisob ochiladi.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${
            editing && dirty ? 'border-amber-300 bg-amber-50 text-amber-900' : editing ? 'border-brand-olive/30 bg-brand-olive/10 text-brand-ink' : 'border-brand-olive/30 bg-brand-olive/10 text-brand-ink'
          }`}>
            {editing && dirty ? '● Saqlanmagan o‘zgarishlar' : editing ? '● Tahrirlash rejimi' : '✓ Ko‘rish rejimi'}
          </span>
          {canManage && (editing ? (
            <>
              <Button type="button" variant="outline" disabled={saving} onClick={discard} className="min-h-11 rounded-xl">
                <X className="mr-1.5 h-4 w-4" /> Bekor qilish
              </Button>
              <Button type="button" onClick={save} disabled={saving || !dirty || !valid} className="min-h-11 rounded-xl bg-primary hover:bg-primary-strong text-primary-foreground">
                <Save className="mr-1.5 h-4 w-4" /> {saving ? 'Saqlanmoqda…' : 'O‘zgarishlarni saqlash'}
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => { setError(''); setEditing(true); }} className="min-h-11 rounded-xl">
              <Edit3 className="mr-1.5 h-4 w-4" /> Xaritani tahrirlash
            </Button>
          ))}
        </div>
      </div>

      {/* Real-time Floorplan Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" aria-label="Zal va ko‘cha statistikasi">
        <div className="rounded-xl border border-border bg-[#fbf8f0] p-3">
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Armchair className="w-3.5 h-3.5" /> Jami stollar</p>
          <p className="text-xl font-bold tabular-nums">{shop.table_count}</p>
        </div>
        <div className="rounded-xl border border-brand-sand/60 bg-[#fbf6eb] p-3">
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Building2 className="w-3.5 h-3.5" /> Do‘kon ichi</p>
          <p className="text-xl font-bold tabular-nums text-brand-ink">{indoorCount} ta</p>
        </div>
        <div className="rounded-xl border border-brand-olive/40 bg-[#eef0e4] p-3">
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Sun className="w-3.5 h-3.5 text-[#969a55]" /> Ko‘cha / terassa</p>
          <p className="text-xl font-bold tabular-nums text-brand-ink">{outdoorCount} ta</p>
        </div>
        <div className="rounded-xl border border-brand-olive/35 bg-brand-olive/10 p-3">
          <p className="text-[11px] text-muted-foreground">Band stollar</p>
          <p className="text-xl font-bold tabular-nums text-brand-ink">{occupiedCount}</p>
        </div>
        <div className="rounded-xl border border-amber-300/70 bg-[#FECD7C]/20 p-3 col-span-2 sm:col-span-1">
          <p className="text-[11px] text-muted-foreground">Kutilayotgan tushum</p>
          <p className="text-base sm:text-lg font-bold tabular-nums text-brand-ink">
            {unpaidTotal.toLocaleString('en-US')} <span className="text-xs">UZS</span>
          </p>
        </div>
      </div>

      {/* Editing Toolbar */}
      {editing && (
        <div className="rounded-2xl border border-brand-olive/30 bg-brand-olive/5 p-3.5 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-olive/20 pb-2">
            <span className="inline-flex items-center gap-2 text-sm font-bold text-brand-ink">
              <Sliders className="h-4 w-4" /> Bino va ko‘cha devorlarini sozlash
            </span>
            <span className="text-xs text-muted-foreground">
              Ko‘cha tomoni, devor turi va to‘siqlarni xohlagancha o‘zgartiring
            </span>
          </div>

          {/* 1. Street Side Selector */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-brand-ink flex items-center gap-1.5">
              <Sun className="h-3.5 w-3.5 text-[#969a55]" /> Ko‘cha / terassa qaysi tomonda?
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" role="group">
              {STREET_SIDES.map((side) => (
                <button
                  key={side.id}
                  type="button"
                  disabled={saving}
                  onClick={() => handleStreetSideChange(side.id)}
                  aria-pressed={streetSide === side.id}
                  className={`min-h-11 rounded-xl border px-3 text-xs font-semibold transition-all touch-manipulation flex flex-col items-center justify-center gap-0.5 ${
                    streetSide === side.id
                      ? 'border-brand-olive bg-primary text-foreground shadow-sm ring-2 ring-brand-olive/25 font-bold'
                      : 'border-border bg-card hover:border-brand-olive/60'
                  }`}
                >
                  <span>{side.label}</span>
                  <span className="text-[10px] opacity-70 font-normal">{side.description.split(',')[0]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 2. Street Walls & Fence Customization (User's special request!) */}
          {streetSide !== 'none' && (
            <div className="space-y-3 rounded-xl border border-brand-olive/25 bg-card/80 p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-brand-ink flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 text-brand-ink" /> Ko‘cha atrofi devorlari va to‘siqlari (O‘zingiz tanlang)
                </span>
                <span className="text-[11px] text-muted-foreground">Devor turi xaritada darhol aks etadi</span>
              </div>

              {/* Fence Style */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {FENCE_STYLES.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    disabled={saving}
                    onClick={() => handleFenceStyleChange(style.id)}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-xs font-semibold transition-all text-left ${
                      fenceStyle === style.id
                        ? 'border-brand-olive bg-brand-olive/20 text-brand-ink shadow-xs ring-2 ring-brand-olive/30 font-bold'
                        : 'border-border bg-background hover:bg-muted/40'
                    }`}
                  >
                    <p className="font-bold">{style.label}</p>
                    <p className="text-[10px] opacity-75 font-normal truncate">{style.description}</p>
                  </button>
                ))}
              </div>

              {/* Fence Enclosure Sides */}
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
                <span className="text-xs font-semibold text-brand-ink mr-1">To‘siq o‘rnatilishi:</span>
                {FENCE_ENCLOSURES.map((enc) => (
                  <button
                    key={enc.id}
                    type="button"
                    disabled={saving}
                    onClick={() => handleFenceEnclosureChange(enc.id)}
                    className={`min-h-8 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-all ${
                      fenceEnclosure === enc.id
                        ? 'border-brand-olive bg-primary text-foreground font-bold'
                        : 'border-border bg-background hover:border-brand-olive/50'
                    }`}
                  >
                    {enc.label}
                  </button>
                ))}
              </div>

              {/* Street Depth Slider */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <label htmlFor="street-depth-slider" className="text-xs font-semibold whitespace-nowrap">
                  Ko‘cha hududi chuqurligi (nisbati):
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
                <span className="w-12 text-right text-xs font-bold tabular-nums text-brand-ink">
                  {Math.round(streetDepth / 10)}%
                </span>
                <span className="text-[11px] text-muted-foreground w-full sm:w-auto">
                  (Xaritadagi devor ustidagi tutqichni ham surishingiz mumkin)
                </span>
              </div>
            </div>
          )}

          {/* 3. Entrance Door Position */}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
            <label htmlFor="entrance-position" className="text-xs font-semibold whitespace-nowrap flex items-center gap-1.5">
              <DoorOpen className="h-4 w-4 text-brand-ink" /> Kirish eshigining devordagi o‘rni:
            </label>
            <input
              id="entrance-position"
              type="range"
              min="150"
              max="850"
              step="10"
              value={entrance.offset}
              disabled={saving}
              onChange={(event) => setEntrance((previous) => ({ ...previous, offset: Number(event.target.value) }))}
              className="min-w-[120px] flex-1 accent-[#ACA95D]"
            />
            <span className="w-12 text-right text-xs font-bold tabular-nums text-brand-ink">
              {entrance.offset / 10}%
            </span>
            <span className="text-[11px] text-muted-foreground">
              (Eshikni xaritada devor bo‘ylab to‘g‘ridan-to‘g‘ri ushlab surish ham mumkin)
            </span>
          </div>

          {/* Freeform Box Drawing Toggle (optional advanced custom terrace) */}
          <div className="flex items-center justify-between pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCustomZoneMode((prev) => !prev)}
              className="text-xs text-muted-foreground hover:text-foreground h-8"
            >
              <Maximize2 className="h-3.5 w-3.5 mr-1" />
              {customZoneMode ? 'Devorli rejimga qaytish' : 'Qo‘lda erkin shakl / to‘rtburchak chizish (ixtiyoriy)'}
            </Button>
            {outdoorPolygon.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setOutdoorPolygon([]);
                  setStreetSide('none');
                }}
                className="text-xs text-destructive hover:underline inline-flex items-center gap-1"
              >
                <Trash2 className="h-3 w-3" /> Ko‘cha hududini olib tashlash
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {editing && !zoneValid && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Ko‘cha chegarasi mos emas. Iltimos, andozalardan foydalaning yoki ko‘cha tomonini tanlang.
        </p>
      )}
      {editing && !validateTableLayout(shop.table_count, layout) && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Stollar joylashuvi mos emas: ustma-ust tushgan stollarni ajrating yoki o‘lchamini kichraytiring.
        </p>
      )}

      {/* Interactive Map Board */}
      <div className="rounded-2xl border border-border/70 bg-[#f7f5ed] p-2 sm:p-3">
        <div className="max-w-full overflow-x-auto overscroll-x-contain pb-2">
          <div className="relative min-w-[760px] w-full px-14 py-14">
            <div
              ref={boardRef}
              aria-label="Do‘kon zali va ko‘cha xaritasi"
              className={`relative isolate w-full aspect-[10/7] sm:aspect-[16/10] overflow-visible rounded-[25px] border-[3px] shadow-inner ${
                editing ? 'border-brand-olive' : 'border-[#b8b087]'
              }`}
              style={{
                backgroundColor: '#fbf6eb',
                backgroundImage: 'linear-gradient(rgba(208,177,127,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(208,177,127,.12) 1px, transparent 1px)',
                backgroundSize: '34px 34px',
              }}
            >
              {/* SVG Map Architecture: Ground, Walls, Doors, Fence */}
              <svg
                aria-hidden="true"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 z-[1] h-full w-full rounded-[22px] overflow-hidden"
              >
                <defs>
                  {/* Street Cobblestone Floor Pattern */}
                  <pattern id="street-cobblestone" width="40" height="40" patternUnits="userSpaceOnUse">
                    <rect width="40" height="40" fill="#e8edda" />
                    <rect x="2" y="2" width="16" height="16" rx="3" fill="#dde4cc" stroke="#aca95d" strokeOpacity=".3" strokeWidth="1" />
                    <rect x="20" y="2" width="18" height="16" rx="3" fill="#e2e8d3" stroke="#aca95d" strokeOpacity=".3" strokeWidth="1" />
                    <rect x="2" y="20" width="18" height="18" rx="3" fill="#e2e8d3" stroke="#aca95d" strokeOpacity=".3" strokeWidth="1" />
                    <rect x="22" y="20" width="16" height="18" rx="3" fill="#dde4cc" stroke="#aca95d" strokeOpacity=".3" strokeWidth="1" />
                  </pattern>

                  {/* Wood deck pattern */}
                  <pattern id="wood-deck" width="60" height="16" patternUnits="userSpaceOnUse">
                    <rect width="60" height="16" fill="#ded7be" />
                    <line x1="0" y1="16" x2="60" y2="16" stroke="#bdae8e" strokeWidth="1.5" />
                    <line x1="28" y1="0" x2="28" y2="16" stroke="#bdae8e" strokeWidth="1" />
                  </pattern>

                  {/* Brick Wall Texture */}
                  <pattern id="brick-wall" width="24" height="12" patternUnits="userSpaceOnUse">
                    <rect width="24" height="12" fill="#4d493a" />
                    <rect x="1" y="1" width="10" height="4" fill="#635e4d" />
                    <rect x="13" y="1" width="10" height="4" fill="#5a5544" />
                    <rect x="7" y="7" width="10" height="4" fill="#635e4d" />
                  </pattern>
                </defs>

                {/* 1. Outdoor Street Ground Area */}
                {hasOutdoorStreet && (
                  <polygon
                    points={outdoorPolygon.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill={fenceStyle === 'railing' ? 'url(#wood-deck)' : 'url(#street-cobblestone)'}
                    stroke={validOutdoorPolygon(outdoorPolygon) ? '#969a55' : '#b45309'}
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                )}

                {/* Temp box when drawing freely */}
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

                {/* 2. Physical Dividing Wall with Door Cutout & Door Swing Arc */}
                {hasOutdoorStreet && (
                  <>
                    {/* Top Street: Horizontal dividing wall at y = streetDepth */}
                    {streetSide === 'top' && (
                      <g id="dividing-wall-top">
                        {/* Shadow */}
                        <line x1="0" y1={streetDepth + 5} x2="1000" y2={streetDepth + 5} stroke="rgba(0,0,0,0.12)" strokeWidth="16" />
                        {/* Wall Left of Door */}
                        <line x1="0" y1={streetDepth} x2={Math.max(0, entrance.offset - 50)} y2={streetDepth} stroke="#4d493a" strokeWidth="12" strokeLinecap="square" />
                        {/* Wall Right of Door */}
                        <line x1={Math.min(1000, entrance.offset + 50)} y1={streetDepth} x2="1000" y2={streetDepth} stroke="#4d493a" strokeWidth="12" strokeLinecap="square" />
                        {/* Door Jambs */}
                        <rect x={entrance.offset - 52} y={streetDepth - 8} width="5" height="16" fill="#8c734b" rx="1" />
                        <rect x={entrance.offset + 47} y={streetDepth - 8} width="5" height="16" fill="#8c734b" rx="1" />
                        {/* Door Opening Swing Arc */}
                        <path d={`M ${entrance.offset - 48} ${streetDepth} A 48 48 0 0 0 ${entrance.offset} ${streetDepth + 48}`} fill="none" stroke="#aca95d" strokeWidth="2" strokeDasharray="4 3" />
                        {/* Door Leaf */}
                        <line x1={entrance.offset} y1={streetDepth} x2={entrance.offset} y2={streetDepth + 46} stroke="#8c734b" strokeWidth="4" strokeLinecap="round" />
                      </g>
                    )}

                    {/* Bottom Street: Horizontal dividing wall at y = 1000 - streetDepth */}
                    {streetSide === 'bottom' && (
                      <g id="dividing-wall-bottom">
                        <line x1="0" y1={1000 - streetDepth + 4} x2="1000" y2={1000 - streetDepth + 4} stroke="rgba(0,0,0,0.12)" strokeWidth="16" />
                        <line x1="0" y1={1000 - streetDepth} x2={Math.max(0, entrance.offset - 50)} y2={1000 - streetDepth} stroke="#4d493a" strokeWidth="12" strokeLinecap="square" />
                        <line x1={Math.min(1000, entrance.offset + 50)} y1={1000 - streetDepth} x2="1000" y2={1000 - streetDepth} stroke="#4d493a" strokeWidth="12" strokeLinecap="square" />
                        <rect x={entrance.offset - 52} y={1000 - streetDepth - 8} width="5" height="16" fill="#8c734b" rx="1" />
                        <rect x={entrance.offset + 47} y={1000 - streetDepth - 8} width="5" height="16" fill="#8c734b" rx="1" />
                        <path d={`M ${entrance.offset - 48} ${1000 - streetDepth} A 48 48 0 0 1 ${entrance.offset} ${1000 - streetDepth - 48}`} fill="none" stroke="#aca95d" strokeWidth="2" strokeDasharray="4 3" />
                        <line x1={entrance.offset} y1={1000 - streetDepth} x2={entrance.offset} y2={1000 - streetDepth - 46} stroke="#8c734b" strokeWidth="4" strokeLinecap="round" />
                      </g>
                    )}

                    {/* Right Street: Vertical dividing wall at x = 1000 - streetDepth */}
                    {streetSide === 'right' && (
                      <g id="dividing-wall-right">
                        <line x1={1000 - streetDepth + 4} y1="0" x2={1000 - streetDepth + 4} y2="1000" stroke="rgba(0,0,0,0.12)" strokeWidth="16" />
                        <line x1={1000 - streetDepth} y1="0" x2={1000 - streetDepth} y2={Math.max(0, entrance.offset - 50)} stroke="#4d493a" strokeWidth="12" strokeLinecap="square" />
                        <line x1={1000 - streetDepth} y1={Math.min(1000, entrance.offset + 50)} x2={1000 - streetDepth} y2="1000" stroke="#4d493a" strokeWidth="12" strokeLinecap="square" />
                        <rect x={1000 - streetDepth - 8} y={entrance.offset - 52} width="16" height="5" fill="#8c734b" rx="1" />
                        <rect x={1000 - streetDepth - 8} y={entrance.offset + 47} width="16" height="5" fill="#8c734b" rx="1" />
                        <path d={`M ${1000 - streetDepth} ${entrance.offset - 48} A 48 48 0 0 0 ${1000 - streetDepth - 48} ${entrance.offset}`} fill="none" stroke="#aca95d" strokeWidth="2" strokeDasharray="4 3" />
                        <line x1={1000 - streetDepth} y1={entrance.offset} x2={1000 - streetDepth - 46} y2={entrance.offset} stroke="#8c734b" strokeWidth="4" strokeLinecap="round" />
                      </g>
                    )}

                    {/* Left Street: Vertical dividing wall at x = streetDepth */}
                    {streetSide === 'left' && (
                      <g id="dividing-wall-left">
                        <line x1={streetDepth + 4} y1="0" x2={streetDepth + 4} y2="1000" stroke="rgba(0,0,0,0.12)" strokeWidth="16" />
                        <line x1={streetDepth} y1="0" x2={streetDepth} y2={Math.max(0, entrance.offset - 50)} stroke="#4d493a" strokeWidth="12" strokeLinecap="square" />
                        <line x1={streetDepth} y1={Math.min(1000, entrance.offset + 50)} x2={streetDepth} y2="1000" stroke="#4d493a" strokeWidth="12" strokeLinecap="square" />
                        <rect x={streetDepth - 8} y={entrance.offset - 52} width="16" height="5" fill="#8c734b" rx="1" />
                        <rect x={streetDepth - 8} y={entrance.offset + 47} width="16" height="5" fill="#8c734b" rx="1" />
                        <path d={`M ${streetDepth} ${entrance.offset - 48} A 48 48 0 0 1 ${streetDepth + 48} ${entrance.offset}`} fill="none" stroke="#aca95d" strokeWidth="2" strokeDasharray="4 3" />
                        <line x1={streetDepth} y1={entrance.offset} x2={streetDepth + 46} y2={entrance.offset} stroke="#8c734b" strokeWidth="4" strokeLinecap="round" />
                      </g>
                    )}
                  </>
                )}

                {/* 3. Street Perimeter Fencing/Walls ("kochani devoralrini ham ozim qiladigan bolsin") */}
                {hasOutdoorStreet && (
                  <g id="street-perimeter-fence">
                    {/* Render fence lines based on fenceStyle and fenceEnclosure */}
                    {streetSide === 'top' && (
                      <>
                        {/* Top Outer Edge */}
                        {fenceEnclosure !== 'front_open' && (
                          fenceStyle === 'railing' ? (
                            <line x1="0" y1="4" x2="1000" y2="4" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                          ) : fenceStyle === 'walled' ? (
                            <line x1="0" y1="5" x2="1000" y2="5" stroke="#786c5e" strokeWidth="10" />
                          ) : fenceStyle === 'glass' ? (
                            <line x1="0" y1="4" x2="1000" y2="4" stroke="#38bdf8" strokeWidth="5" strokeDasharray="90 8" />
                          ) : (
                            <line x1="0" y1="3" x2="1000" y2="3" stroke="#a8a29e" strokeWidth="5" strokeDasharray="20 10" />
                          )
                        )}
                        {/* Left Wing Fence */}
                        {fenceStyle === 'railing' ? (
                          <line x1="4" y1="0" x2="4" y2={streetDepth} stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        ) : fenceStyle === 'walled' ? (
                          <line x1="5" y1="0" x2="5" y2={streetDepth} stroke="#786c5e" strokeWidth="10" />
                        ) : fenceStyle === 'glass' ? (
                          <line x1="4" y1="0" x2="4" y2={streetDepth} stroke="#38bdf8" strokeWidth="5" strokeDasharray="90 8" />
                        ) : (
                          <line x1="3" y1="0" x2="3" y2={streetDepth} stroke="#a8a29e" strokeWidth="5" strokeDasharray="20 10" />
                        )}
                        {/* Right Wing Fence */}
                        {fenceStyle === 'railing' ? (
                          <line x1="996" y1="0" x2="996" y2={streetDepth} stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        ) : fenceStyle === 'walled' ? (
                          <line x1="995" y1="0" x2="995" y2={streetDepth} stroke="#786c5e" strokeWidth="10" />
                        ) : fenceStyle === 'glass' ? (
                          <line x1="996" y1="0" x2="996" y2={streetDepth} stroke="#38bdf8" strokeWidth="5" strokeDasharray="90 8" />
                        ) : (
                          <line x1="997" y1="0" x2="997" y2={streetDepth} stroke="#a8a29e" strokeWidth="5" strokeDasharray="20 10" />
                        )}
                        {/* Corner Planters / Posts */}
                        <circle cx="16" cy="16" r="10" fill="#758249" />
                        <circle cx="984" cy="16" r="10" fill="#758249" />
                      </>
                    )}

                    {streetSide === 'bottom' && (
                      <>
                        {fenceEnclosure !== 'front_open' && (
                          fenceStyle === 'railing' ? (
                            <line x1="0" y1="996" x2="1000" y2="996" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                          ) : fenceStyle === 'walled' ? (
                            <line x1="0" y1="995" x2="1000" y2="995" stroke="#786c5e" strokeWidth="10" />
                          ) : fenceStyle === 'glass' ? (
                            <line x1="0" y1="996" x2="1000" y2="996" stroke="#38bdf8" strokeWidth="5" strokeDasharray="90 8" />
                          ) : (
                            <line x1="0" y1="997" x2="1000" y2="997" stroke="#a8a29e" strokeWidth="5" strokeDasharray="20 10" />
                          )
                        )}
                        <line x1="4" y1={1000 - streetDepth} x2="4" y2="1000" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        <line x1="996" y1={1000 - streetDepth} x2="996" y2="1000" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        <circle cx="16" cy="984" r="10" fill="#758249" />
                        <circle cx="984" cy="984" r="10" fill="#758249" />
                      </>
                    )}

                    {streetSide === 'right' && (
                      <>
                        {fenceEnclosure !== 'front_open' && (
                          <line x1="996" y1="0" x2="996" y2="1000" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        )}
                        <line x1={1000 - streetDepth} y1="4" x2="1000" y2="4" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        <line x1={1000 - streetDepth} y1="996" x2="1000" y2="996" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        <circle cx="984" cy="16" r="10" fill="#758249" />
                        <circle cx="984" cy="984" r="10" fill="#758249" />
                      </>
                    )}

                    {streetSide === 'left' && (
                      <>
                        {fenceEnclosure !== 'front_open' && (
                          <line x1="4" y1="0" x2="4" y2="1000" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        )}
                        <line x1="0" y1="4" x2={streetDepth} y2="4" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        <line x1="0" y1="996" x2={streetDepth} y2="996" stroke="#845e3c" strokeWidth="7" strokeDasharray="16 8" />
                        <circle cx="16" cy="16" r="10" fill="#758249" />
                        <circle cx="16" cy="984" r="10" fill="#758249" />
                      </>
                    )}
                  </g>
                )}
              </svg>

              {/* Area Labels */}
              <div className="pointer-events-none absolute z-[2] left-4 top-4 max-w-[50%] inline-flex items-center gap-1.5 rounded-xl border border-brand-sand/70 bg-white/90 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-brand-ink shadow-sm">
                <Building2 className="h-4 w-4 shrink-0" />
                <span className="truncate">{shop.name} · Do‘kon zali</span>
              </div>

              {hasOutdoorStreet && (
                <div
                  className={`pointer-events-none absolute z-[2] inline-flex items-center gap-1.5 rounded-xl border border-brand-olive/40 bg-white/90 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-brand-ink shadow-sm ${
                    streetSide === 'top'
                      ? 'left-4 top-14'
                      : streetSide === 'bottom'
                        ? 'left-4 bottom-4'
                        : streetSide === 'right'
                          ? 'right-4 top-4'
                          : 'left-4 top-14'
                  }`}
                >
                  <Sun className="h-4 w-4 text-[#969a55] shrink-0" />
                  <span>Ko‘cha / Terassa ({outdoorCount} ta stol)</span>
                </div>
              )}

              <div className="pointer-events-none absolute z-[2] right-4 top-4 rounded-full border border-border bg-card/90 px-3 py-1 text-[10px] font-semibold text-muted-foreground">
                {editing ? 'STOL VA DEVORLARNI SURING' : 'STOLNI BOSING'}
              </div>

              {/* Free Draw overlay if active */}
              {customZoneMode && (
                <div
                  onPointerDown={(event) => startDrag(event, 'zone-draw')}
                  onPointerMove={(event) => onMove(event, 'zone-draw')}
                  onPointerUp={stopDrag}
                  onPointerCancel={stopDrag}
                  style={{ touchAction: 'none' }}
                  className="absolute inset-0 z-20 cursor-crosshair"
                />
              )}

              {/* Interactive Entrance Door along Dividing Wall */}
              <button
                type="button"
                aria-label={`Kirish-chiqish eshigi${editing ? ', devor bo‘ylab surish' : ''}`}
                title={editing ? 'Eshikni ushlab devor bo‘ylab suring' : 'Kirish-chiqish eshigi'}
                disabled={!editing || saving}
                onPointerDown={(event) => startDrag(event, 'entrance')}
                onPointerMove={(event) => onMove(event, 'entrance')}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                onKeyDown={(event) => {
                  if (!editing || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                  event.preventDefault();
                  setEntrance((prev) => nudgeEntrance(prev, event.key, event.shiftKey ? 50 : 20));
                }}
                style={{
                  ...doorPositionStyle,
                  touchAction: editing ? 'none' : 'manipulation',
                }}
                className={`absolute z-30 flex items-center justify-center gap-1.5 border-2 border-brand-olive bg-card text-brand-ink font-bold shadow-lg select-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-olive ${
                  verticalWall ? 'h-16 w-14 flex-col rounded-2xl text-[10px]' : 'h-11 min-w-[110px] rounded-xl text-xs'
                } ${editing ? 'cursor-grab active:cursor-grabbing ring-4 ring-primary/40' : 'cursor-default'}`}
              >
                <DoorOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-ink" />
                <span>Eshik</span>
                {editing && <Grip aria-hidden="true" className="h-3 w-3 shrink-0 opacity-60" />}
              </button>

              {/* Interactive Draggable Dividing Wall Handle (Editing Mode) */}
              {editing && hasOutdoorStreet && wallHandleStyle && !customZoneMode && (
                <button
                  type="button"
                  title="Devorni ushlab suring (zal va ko‘cha nisbatini o‘zgartirish)"
                  aria-label="Bino devorini surish"
                  onPointerDown={(e) => startDrag(e, 'wall-move')}
                  onPointerMove={(e) => onMove(e, 'wall-move')}
                  onPointerUp={stopDrag}
                  onPointerCancel={stopDrag}
                  style={{
                    ...wallHandleStyle,
                    touchAction: 'none',
                  }}
                  className={`absolute z-35 inline-flex items-center gap-1.5 rounded-full border-2 border-brand-olive bg-[#4d493a] text-white px-3 py-1 text-[11px] font-bold shadow-xl cursor-grab active:cursor-grabbing hover:scale-105 transition-transform select-none ${
                    verticalWall ? 'cursor-col-resize' : 'cursor-row-resize'
                  }`}
                >
                  <Move className="h-3.5 w-3.5 text-white" />
                  <span>Devorni surish</span>
                </button>
              )}

              {/* Custom Zone Resize Handles (if customZoneMode is enabled) */}
              {customZoneMode && outdoorBox && (
                <>
                  <button
                    type="button"
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
                </>
              )}

              {/* Tables: Freely Draggable Across the Whole Floor & Street */}
              {layout.map((point) => {
                const order = (shop.orders || []).find((row) => row.number === point.number);
                const isOccupied = Boolean(order);
                const isPaying = order?.state === 'paying';
                const isSelected = selectedViewNumber === point.number;
                const isTableOutdoor = hasOutdoorStreet && pointInOutdoorPolygon(point, outdoorPolygon);

                return (
                  <button
                    key={point.number}
                    type="button"
                    aria-label={`${point.number}-stol (${isTableOutdoor ? 'Ko‘cha' : 'Zal'}), ${
                      isOccupied ? (isPaying ? 'To‘lov kutilmoqda' : `Band, ${Number(order.total || 0).toLocaleString('en-US')} UZS`) : 'Bo‘sh'
                    }${editing ? ', joyini suring' : ', ko‘rish va kassa'}`}
                    title={
                      editing
                        ? `${point.number}-stol (${isTableOutdoor ? 'Ko‘cha hududida' : 'Zal ichida'}) · Ushlab suring`
                        : `${point.number}-stol${isOccupied ? ` — Band (${Number(order.total || 0).toLocaleString('en-US')} UZS)` : ''}`
                    }
                    disabled={saving}
                    onPointerDown={(event) => startDrag(event, 'table', point.number)}
                    onPointerMove={(event) => onMove(event, 'table')}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                    onKeyDown={(event) => keyboardMove(event, point)}
                    onClick={() => {
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
                          ? 'cursor-grab active:cursor-grabbing bg-primary border-brand-olive text-foreground ring-4 ring-brand-olive/30 shadow-xl'
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
                              ? 'cursor-pointer bg-[#f7f9f2] border-[#969a55]/70 text-foreground hover:bg-primary/30 hover:shadow-lg'
                              : 'cursor-pointer bg-card border-brand-olive/65 text-foreground hover:bg-primary/30 hover:shadow-lg'
                    }`}
                  >
                    {/* Table Icon */}
                    {editing ? (
                      <Grip aria-hidden="true" className="h-4 w-4 text-brand-ink" />
                    ) : isTableOutdoor ? (
                      <Coffee aria-hidden="true" className="h-5 w-5 text-[#777b3d]" />
                    ) : (
                      <Armchair aria-hidden="true" className="h-5 w-5 text-brand-ink" />
                    )}

                    {/* Table Number */}
                    <span className="text-xs font-bold leading-tight">{point.number}</span>

                    {/* Outdoor Indicator Tag */}
                    {isTableOutdoor && (
                      <span className="text-[9px] font-bold text-[#656b2a] leading-none">Ko‘cha</span>
                    )}

                    {/* Occupied Amount Badge Underneath */}
                    {!editing && isOccupied && (
                      <span className="pointer-events-none absolute top-full mt-1.5 rounded-lg border border-amber-300/80 bg-[#fff9ea] px-2 py-0.5 text-[10px] font-bold text-brand-ink whitespace-nowrap shadow-sm">
                        {isPaying
                          ? `${Number(order.total || 0).toLocaleString('en-US')} UZS · To‘lov`
                          : `${Number(order.total || 0).toLocaleString('en-US')} UZS`}
                      </span>
                    )}
                  </button>
                );
              })}

              <div className="pointer-events-none absolute z-[2] bottom-3 left-4 right-4 text-center text-[10px] font-semibold text-brand-ink/70">
                {shop.table_count} ta stol · {editing ? 'Stollarni xohlagan joyingizga erkin surib qo‘ying' : 'Stolni tanlang'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Selected Table Controls (Fine placement and size) */}
      {editing && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-secondary/30 p-3 sm:p-4">
          <div className="min-w-0">
            <p className="font-semibold text-sm">
              {chosen
                ? `${chosen.number}-stol tanlandi (${
                    hasOutdoorStreet && pointInOutdoorPolygon(chosen, outdoorPolygon) ? '🌿 Ko‘chada' : '🏛️ Zal ichida'
                  })`
                : 'Stolni tanlang'}
            </p>
            <p className="text-xs text-muted-foreground">
              {chosen
                ? 'Stolni suring, o‘lchamini o‘zgartiring yoki yo‘nalish tugmalari bilan siljiting.'
                : 'Xaritadan stolni tanlab, uning joylashuvi va o‘lchamini alohida sozlashingiz mumkin.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {chosen && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-olive/30 bg-card px-3 py-2">
                <span className="text-xs font-semibold whitespace-nowrap">O‘lcham</span>
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
          <Armchair className="h-4 w-4 text-brand-ink" /> Stol {editing ? '— erkin suring' : '— Bo‘sh / Band / To‘lovda'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <DoorOpen className="h-4 w-4 text-brand-ink" /> Eshik {editing ? '— devor bo‘ylab suring' : '— zalga kirish'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Layers className="h-4 w-4 text-brand-ink" /> Devor & To‘siq — {fenceStyle === 'railing' ? 'Yog‘och panjara' : fenceStyle === 'walled' ? 'Past devor' : fenceStyle === 'glass' ? 'Shisha to‘siq' : 'Ochiq trotuar'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          {editing ? <Save className="h-4 w-4" /> : <MousePointer2 className="h-4 w-4" />}{' '}
          {editing ? 'Saqlash bosilmaguncha serverda o‘zgarmaydi' : 'Stolni bosish orqali kassa ochiladi'}
        </span>
      </div>
    </section>
  );
}
