// Pure floor-plan coordinates. No SDK calls, inventory access or local storage.
export const TABLE_MAX = 30;
export const LIMITS = { minX: 60, maxX: 940, minY: 70, maxY: 930 };
export const TABLE_SIZES = [80, 90, 100, 110, 120, 130, 140];
export const MAX_OUTDOOR_VERTICES = 12;

// Shop-specific outdoor area. No default street is assumed: the owner draws it.
// Points use the same 0–1000 coordinates as tables; no existing positions migrate.
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (a, b, p) => cross(a, b, p) === 0
  && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
  && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
const segmentCrosses = (a, b, c, d) => {
  const abC = cross(a, b, c); const abD = cross(a, b, d);
  const cdA = cross(c, d, a); const cdB = cross(c, d, b);
  return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d))
    || (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b))
    || ((abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0));
};

export function validOutdoorPolygon(polygon) {
  if (!Array.isArray(polygon)) return false;
  if (polygon.length === 0) return true;
  if (polygon.length < 3 || polygon.length > MAX_OUTDOOR_VERTICES) return false;
  const seen = new Set();
  for (const point of polygon) {
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)
      || point.x < 0 || point.x > 1000 || point.y < 0 || point.y > 1000) return false;
    const key = `${point.x}:${point.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const doubleArea = Math.abs(polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0));
  if (doubleArea < 20000) return false;
  for (let i = 0; i < polygon.length; i += 1) {
    for (let j = i + 1; j < polygon.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === polygon.length - 1)) continue;
      if (segmentCrosses(polygon[i], polygon[(i + 1) % polygon.length],
        polygon[j], polygon[(j + 1) % polygon.length])) return false;
    }
  }
  return true;
}

export const normalizeOutdoorPolygon = (value) => validOutdoorPolygon(value)
  ? value.map(({ x, y }) => ({ x, y })) : [];

export function pointInOutdoorPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]; const b = polygon[j];
    if (onSegment(a, b, point)) return true;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export const tableSize = (entry) => entry?.size === undefined ? 100 : entry.size;
export const tableBounds = (size) => ({
  minX: Math.max(LIMITS.minX, LIMITS.minX * size / 100),
  maxX: Math.min(LIMITS.maxX, 1000 - LIMITS.minX * size / 100),
  minY: Math.max(LIMITS.minY, (size > 100 ? 90 : 70) * size / 100),
  maxY: Math.min(LIMITS.maxY, 1000 - (size > 100 ? 90 : 70) * size / 100),
});
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const ENTRANCE_SIDES = ['top', 'right', 'bottom', 'left'];
export const DEFAULT_ENTRANCE = { side: 'top', offset: 500 };
export const normalizeEntrance = (entry) => (
  entry && ENTRANCE_SIDES.includes(entry.side) && Number.isInteger(entry.offset)
    && entry.offset >= 150 && entry.offset <= 850
    ? { side: entry.side, offset: entry.offset }
    : { ...DEFAULT_ENTRANCE }
);

// The entrance lives on a WALL, not inside the seating area. Pointer motion
// snaps to the nearest wall and keeps the doorway away from tight corners.
export function entranceFromPoint(x, y) {
  const edges = [
    { side: 'top', distance: Math.abs(y), axis: x },
    { side: 'right', distance: Math.abs(1000 - x), axis: y },
    { side: 'bottom', distance: Math.abs(1000 - y), axis: x },
    { side: 'left', distance: Math.abs(x), axis: y },
  ];
  const closest = edges.reduce((best, current) => current.distance < best.distance ? current : best);
  return { side: closest.side, offset: clamp(Math.round(closest.axis / 10) * 10, 150, 850) };
}

export function nudgeEntrance(entrance, direction, step = 20) {
  const current = normalizeEntrance(entrance);
  const change = (current.side === 'top' || current.side === 'bottom')
    ? direction === 'ArrowLeft' ? -step : direction === 'ArrowRight' ? step : 0
    : direction === 'ArrowUp' ? -step : direction === 'ArrowDown' ? step : 0;
  return { ...current, offset: clamp(current.offset + change, 150, 850) };
}

export const tablesOverlap = (left, right) => {
  const factor = (tableSize(left) + tableSize(right)) / 200;
  const verticalSpacing = tableSize(left) === 100 && tableSize(right) === 100 ? 125 : 175 * factor;
  return Math.abs(left.x - right.x) < 115 * factor && Math.abs(left.y - right.y) < verticalSpacing;
};

export function buildTableLayout(count, saved = []) {
  const amount = Number.isInteger(count) ? clamp(count, 0, TABLE_MAX) : 0;
  const valid = new Map();
  for (const row of Array.isArray(saved) ? saved : []) {
    const size = tableSize(row);
    if (!Number.isInteger(row?.number) || row.number < 1 || row.number > amount
      || !TABLE_SIZES.includes(size)
      || !Number.isInteger(row?.x) || !Number.isInteger(row?.y)
      || row.x < tableBounds(size).minX || row.x > tableBounds(size).maxX
      || row.y < tableBounds(size).minY || row.y > tableBounds(size).maxY
      || valid.has(row.number)) continue;
    const proposed = { number: row.number, x: row.x, y: row.y, size };
    if (![...valid.values()].some((position) => tablesOverlap(position, proposed))) valid.set(row.number, proposed);
  }

  const columns = Math.min(5, Math.max(1, amount));
  const rows = Math.ceil(amount / columns);
  const positions = [];
  for (let i = 0; i < amount; i += 1) {
    positions.push({
      x: Math.round(100 + ((i % columns) + 0.5) * 800 / columns),
      y: Math.round(100 + (Math.floor(i / columns) + 0.5) * 800 / rows),
    });
  }
  // Extra fallback slots allow a new table to be added without moving saved tables.
  for (let y = 90; y <= 910; y += 140) {
    for (let x = 90; x <= 910; x += 140) positions.push({ x, y });
  }

  for (let number = 1; number <= amount; number += 1) {
    if (valid.has(number)) continue;
    const slot = positions.find((position) => ![...valid.values()].some((used) => tablesOverlap(used, position)));
    // Max 30 seats on a 7x6 grid means a valid slot always exists for normal counts.
    valid.set(number, { number, ...(slot || { x: 500, y: 500 }), size: 100 });
  }
  return [...valid.values()].sort((a, b) => a.number - b.number);
}

export function validateTableLayout(count, layout) {
  if (!Number.isInteger(count) || count < 1 || count > TABLE_MAX
      || !Array.isArray(layout) || layout.length !== count) return false;
  const unique = new Set();
  for (const point of layout) {
    const size = tableSize(point);
    const bounds = tableBounds(size);
    if (!point || !Number.isInteger(point.number) || point.number < 1 || point.number > count
      || !TABLE_SIZES.includes(size)
      || !Number.isInteger(point.x) || point.x < bounds.minX || point.x > bounds.maxX
      || !Number.isInteger(point.y) || point.y < bounds.minY || point.y > bounds.maxY
      || unique.has(point.number)) return false;
    unique.add(point.number);
  }
  return !layout.some((point, i) => layout.some((other, j) => i < j && tablesOverlap(point, other)));
}
