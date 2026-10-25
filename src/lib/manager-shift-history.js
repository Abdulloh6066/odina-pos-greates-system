const payload = response => response?.data || response;
export function managerShiftHistoryEntity(client, filters) {
  return { filter: async (query, sort, limit, skip) => {
    const createdBefore = query?.$and?.find(part => part?.created_date?.$lte)?.created_date?.$lte;
    const result = payload(await client.functions.invoke('manager-shop', {
      action: 'list_shift_history', filters, limit, skip, created_before: createdBefore,
    }));
    if (result?.error || !Array.isArray(result?.rows)) throw new Error(result?.error || 'Smena tarixi yuklanmadi.');
    return result.rows;
  } };
}
export async function loadManagerShiftDetail(client, shiftId) {
  const result = payload(await client.functions.invoke('manager-shop', { action: 'get_shift_detail', shift_id: shiftId }));
  const keys = ['sales', 'saleItems', 'movements', 'refunds', 'stockSnapshots'];
  if (result?.error || !result?.detail || keys.some(key => !Array.isArray(result.detail[key]))) {
    throw new Error(result?.error || 'Smena tafsilotlari yuklanmadi.');
  }
  return result;
}
