// Owner-confirmed production inputs, 2026-11-14. Display only: never deletes data.
const CENTRAL_ID = '6a999c5afc5d285f47ee50ad';
const APPROVED_IDS = new Set([
  '6af818a543e757a9f179eda7', // Qaymoq Sofdil
  '6af818a543e757a9f179eda8', // Qaymoq Akbar
  '6a9ac0c56fc562c64749b55d', // un
  '6ac8e73d5ebcefada9c74972', // Asal
  '6af87822ff61351c1ecba750', // Sariyog‘
  '6af87822ff61351c1ecba751', // Margarin
  '6af87822ff61351c1ecba752', // Shokolad
]);
export const isCentralSupplierLocation = location => location?.id === CENTRAL_ID;
export function supplierCatalogForLocation(items, location, selectedIds = [], showAll = false) {
  if (!isCentralSupplierLocation(location) || showAll) return items;
  const selected = new Set(selectedIds);
  // Existing and newly selected links stay visible even outside the initial list.
  return items.filter(item => selected.has(item.id) || (item.active !== false && APPROVED_IDS.has(item.id)));
}
