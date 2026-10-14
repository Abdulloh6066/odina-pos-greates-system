// The backend resolves the authenticated staff record and owns the shift lookup.
// Do not substitute an empty entity list for an unconfirmed or failed lookup.
export async function fetchCurrentPosShift(client) {
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await client.functions.invoke('complete-sale', { action: 'get_current_shift' });
      break;
    } catch (error) {
      const status = Number(error?.response?.status || error?.status || 0);
      const transient = !status || [408, 429, 502, 503, 504].includes(status);
      // Do not multiply retries after the backend already exhausted its read
      // recovery budget. Only a lost/gateway response gets one fresh read here.
      if (attempt || !transient || error?.response?.data?.server_recovery_attempted) throw error;
      console.warn('[Odina shift read retry]', JSON.stringify({ status }));
    }
  }
  const payload = response?.data || response;
  if (payload?.ok !== true || !Object.prototype.hasOwnProperty.call(payload, 'shift')
      || (payload.shift !== null && (!payload.shift?.id || payload.shift.status !== 'open'))) {
    throw new Error(payload?.error || 'Smena holatini tekshirib bo‘lmadi.');
  }
  return payload.shift;
}
 
// A lost response may follow a successful create. Reconcile the authenticated
// shift once; never submit another create automatically after an uncertain write.
export async function openPosShift(client, { shopId, startingCash }) {
  try {
    const response = await client.functions.invoke('complete-sale', {
      action: 'open_shift', shop_id: shopId, starting_cash: startingCash,
    });
    const payload = response?.data || response;
    if (!payload?.shift?.id || payload.shift.status !== 'open' || payload.shift.shop_id !== shopId) {
      throw new Error(payload?.error || 'Smenani ochib bo‘lmadi.');
    }
    return payload.shift;
  } catch (error) {
    const status = Number(error?.response?.status || error?.status || 0);
    if (!status || status === 409 || status === 408 || status === 429 || status >= 500) {
      const current = await fetchCurrentPosShift(client).catch(() => null);
      if (current?.shop_id === shopId) return current;
    }
    throw error;
  }
}

