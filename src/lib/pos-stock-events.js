// POS uses only these stock fields. A timestamp-only event (including our own
// sale echo) must not redraw the catalog. Keep every shop for later shift changes.
export function mergePosStockEvent(current, event) {
  const recordId = event?.data?.id || event?.id;
  if (!recordId) return current;
  const index = current.findIndex((stock) => stock.id === recordId);
  if (event.type === 'delete') {
    return index < 0 ? current : current.filter((stock) => stock.id !== recordId);
  }
  const existing = index < 0 ? null : current[index];
  const next = { ...(existing || {}), ...(event.data || {}), id: recordId };
  if (existing && existing.product_id === next.product_id
    && existing.location_id === next.location_id
    && Number(existing.quantity || 0) === Number(next.quantity || 0)) return current;
  return existing
    ? current.map((stock, position) => position === index ? next : stock)
    : [next, ...current];
}
