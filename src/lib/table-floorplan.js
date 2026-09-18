// Pure floor-plan coordinates. No SDK calls, inventory access or local storage.
export const TABLE_MAX = 30;
export const LIMITS = { minX: 60, maxX: 940, minY: 70, maxY: 930 };
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const tablesOverlap = (left, right) =>
  Math.abs(left.x - right.x) < 115 && Math.abs(left.y - right.y) < 125;

export function buildTableLayout(count, saved = []) {
  const amount = Number.isInteger(count) ? clamp(count, 0, TABLE_MAX) : 0;
  const valid = new Map();
  for (const row of Array.isArray(saved) ? saved : []) {
    if (!Number.isInteger(row?.number) || row.number < 1 || row.number > amount
      || !Number.isInteger(row?.x) || row.x < LIMITS.minX || row.x > LIMITS.maxX
      || !Number.isInteger(row?.y) || row.y < LIMITS.minY || row.y > LIMITS.maxY
      || valid.has(row.number)) continue;
    const proposed = { number: row.number, x: row.x, y: row.y };
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
    valid.set(number, { number, ...(slot || { x: 500, y: 500 }) });
  }
  return [...valid.values()].sort((a, b) => a.number - b.number);
}

export function validateTableLayout(count, layout) {
  if (!Number.isInteger(count) || count < 1 || count > TABLE_MAX
      || !Array.isArray(layout) || layout.length !== count) return false;
  const unique = new Set();
  for (const point of layout) {
    if (!point || !Number.isInteger(point.number) || point.number < 1 || point.number > count
      || !Number.isInteger(point.x) || point.x < LIMITS.minX || point.x > LIMITS.maxX
      || !Number.isInteger(point.y) || point.y < LIMITS.minY || point.y > LIMITS.maxY
      || unique.has(point.number)) return false;
    unique.add(point.number);
  }
  return !layout.some((point, i) => layout.some((other, j) => i < j && tablesOverlap(point, other)));
}
