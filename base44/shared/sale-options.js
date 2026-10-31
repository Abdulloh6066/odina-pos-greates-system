// Shared line identity and serialization for POS, saved orders and offline receipts.
// Missing options keep their original meaning and request fingerprints.
export const saleLineKey = (row) =>
  String(row?.product_id || '')
  + (row?.fries_option === 'with' ? '::fries' : '')
  + (row?.tea_option === 'cup' ? '::tea-cup' : '');

export const saleOptionFields = (row) => ({
  ...(['with', 'without'].includes(row?.fries_option) ? { fries_option: row.fries_option } : {}),
  ...(['cup', 'pot'].includes(row?.tea_option) ? { tea_option: row.tea_option } : {}),
});
