// The backend resolves the authenticated staff record and owns the shift lookup.
// Do not substitute an empty entity list for an unconfirmed or failed lookup.
export async function fetchCurrentPosShift(client) {
  const response = await client.functions.invoke('complete-sale', { action: 'get_current_shift' });
  const payload = response?.data || response;
  if (payload?.ok !== true || !Object.prototype.hasOwnProperty.call(payload, 'shift')
      || (payload.shift !== null && (!payload.shift?.id || payload.shift.status !== 'open'))) {
    throw new Error(payload?.error || 'Smena holatini tekshirib bo‘lmadi.');
  }
  return payload.shift;
}
