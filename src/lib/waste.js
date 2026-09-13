import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';

export const WASTE_REASONS = [
  { value: 'expired', label: '3 kundan oshgan' },
  { value: 'damaged', label: 'Shikastlangan' },
  { value: 'quality', label: 'Sifati buzilgan' },
  { value: 'other', label: 'Boshqa sabab' },
];

export const wasteError = (error) => (
  error?.response?.data?.error || error?.data?.error || error?.message || 'Chiqitni saqlab bo‘lmadi.'
);

export const wasteDateTime = (value) => formatUzbekistanDateTime(value);

export function makeWasteRow(item, defaults = {}) {
  return {
    product_id: item.product_id,
    product_name: item.product_name,
    quantity: String(defaults.quantity ?? 1),
    reason_code: defaults.reason_code || 'damaged',
    expected_quantity: Number(item.quantity),
    expected_stock_version: String(item.stock_version || ''),
    expired_quantity: Number(item.expired_quantity || 0),
    request_id: crypto.randomUUID(),
    attempt: null,
    error: '',
  };
}

export function validateWasteRows(rows) {
  if (!rows.length) return 'Kamida bitta mahsulotni tanlang.';
  if (rows.length > 50) return 'Bir martada 50 tagacha mahsulot turini tanlang.';
  if (new Set(rows.map((row) => row.product_id)).size !== rows.length) return 'Mahsulot takror tanlangan.';
  for (const row of rows) {
    const quantity = Number(row.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return row.product_name + ': musbat butun dona sonini kiriting.';
    if (quantity > row.expected_quantity) return row.product_name + ': miqdor qoldiqdan oshgan.';
    if (!WASTE_REASONS.some((reason) => reason.value === row.reason_code)) return row.product_name + ': sababni tanlang.';
    if (row.reason_code === 'expired' && quantity > row.expired_quantity) return row.product_name + ': 3 kundan oshgan qoldiq yetarli emas.';
  }
  return '';
}

export function wasteRequest(row, locationId, notes, photoUrl) {
  // Reuse the exact payload on a retry, even if the common note/photo has changed.
  return row.attempt || {
    action: 'create_waste',
    location_id: locationId,
    product_id: row.product_id,
    quantity: Number(row.quantity),
    reason_code: row.reason_code,
    notes: notes.trim() || undefined,
    photo_url: photoUrl || undefined,
    request_id: row.request_id,
    expected_quantity: row.expected_quantity,
    expected_stock_version: row.expected_stock_version,
  };
}

// Each success is removed from the remaining selection before the next item.
// A rejected or uncertain row keeps its request identifier for safe retries.
export async function submitWasteRows(rows, invoke, onResult) {
  const results = [];
  for (const row of rows) {
    let result;
    try {
      const response = await invoke(row.attempt);
      const payload = response?.data || response || {};
      if (!payload.waste?.id) throw new Error(payload.error || 'Chiqit saqlangani tasdiqlanmadi.');
      result = { product_id: row.product_id, ok: true, waste: payload.waste };
    } catch (error) {
      result = { product_id: row.product_id, ok: false, error: wasteError(error) };
    }
    results.push(result);
    onResult(result, results.length);
  }
  return results;
}
