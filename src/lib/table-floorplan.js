// Pure floor-plan coordinates. No SDK calls, inventory access or local storage.
export const TABLE_MAX = 30;
export const LIMITS = { minX: 60, maxX: 940, minY: 70, maxY: 930 };
export const TABLE_SIZES = [80, 90, 100, 110, 120, 130, 140];
export const tableSize = (entry) => entry?.size === undefined ? 100 : entry.size;
export const tableBounds = (size) => ({
  minX: LIMITS.minX * size / 100, maxX: 1000 - LIMITS.minX * size / 100,
  minY: LIMITS.minY * size / 100, maxY: 1000 - LIMITS.minY * size / 100,
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
  return Math.abs(left.x - right.x) < 115 * factor && Math.abs(left.y - right.y) < 125 * factor;
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
