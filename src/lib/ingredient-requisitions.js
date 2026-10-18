export const REQUISITION_UNITS = { kg: 'kg', l: 'litr', g: 'g', ml: 'ml', piece: 'dona' };
export const REQUISITION_STATUSES = { waiting: 'Kutilmoqda', partial: 'Qisman qabul qilindi', received: 'Qabul qilindi', cancelled: 'Bekor qilindi' };
export const REQUISITION_GROUPS = { food: 'MASALLIQLAR', packaging: 'QADOQLAR', household: 'XO‘JALIK' };
export const tomorrowRequisitionDate = (now = Date.now()) => new Date(now + 5 * 3600000 + 86400000).toISOString().slice(0, 10);
export const requisitionNumber = value => Number(value || 0).toLocaleString('uz-UZ', { maximumFractionDigits: 3 });
export function requisitionGroups(items = []) {
  return Object.entries(REQUISITION_GROUPS).map(([key, title]) => ({
    title, items: items.filter(item => (Object.hasOwn(REQUISITION_GROUPS, item.category) ? item.category : 'food') === key),
  })).filter(group => group.items.length);
}
export function requisitionReceiptLines(request, values) {
  return request.items.map(item => ({ ingredient_id: item.ingredient_id,
    quantity: values[item.ingredient_id]?.quantity || '',
    unit_price: values[item.ingredient_id]?.unit_price ?? '',
  })).filter(item => Number(item.quantity) > 0);
}
export function requisitionReceiptTotal(request, values) {
  if (request.source_kind !== 'purchase') return 0;
  return requisitionReceiptLines(request, values).reduce((total, item) => total + Math.round(Number(item.quantity) * Number(item.unit_price || 0)), 0);
}
