// Connection state is separate from payment validation and server permissions.
export const POS_NETWORK_FAILURE_LIMIT = 2;
export const POS_CONNECTION_RECHECK_MS = 15000;

export function isPosNetworkError(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  if (error?.code === 'ERR_CANCELED' || error?.name === 'AbortError') return false;
  if (status) return status === 408;
  if (['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_INTERNET_DISCONNECTED'].includes(error?.code)) return true;
  if (error?.request && !error?.response) return true;
  return /\bNetwork Error\b|NetworkError|^network$|failed to fetch|^load failed$|network request failed|connection (?:lost|reset)|timed?\s*out/i.test(String(error?.message || ''));
}

export function nextPosConnectionState(current, error = null) {
  if (!error) return current.failures === 0 && !current.offline ? current : { failures: 0, offline: false };
  if (isPosNetworkError(error)) {
    const failures = current.failures + 1;
    return { failures, offline: failures >= POS_NETWORK_FAILURE_LIMIT };
  }
  // An HTTP response proves connectivity, including a rejected payment/session.
  if (Number(error?.response?.status || error?.status || 0)) {
    if ([401, 403].includes(Number(error?.response?.status || error?.status))) return { failures: 0, offline: false };
    return { failures: 0, offline: current.offline };
  }
  return current;
}

export function canQueuePosSale({ selectedTable, takeawayOrder, takeawayRequestId,
  discountCode, roundingTarget = null } = {}) {
  return !selectedTable && !takeawayOrder && !takeawayRequestId
    && !discountCode && roundingTarget === null;
}

export function isPosAuthorizationError(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  const rejection = String(error?.response?.data?.error || error?.data?.error || '');
  // A wrong owner PIN is a protected-action rejection, not a lost staff session.
  return status === 401 || (status === 403 && !/\bPIN\b/i.test(rejection));
}

export function queueAuthorizationBlocked(records) {
  return records.some(record => [401, 403].includes(Number(record.last_error_status)));
}

// A bounded, read-only health check. Late replies cannot claim or create sales.
export async function probePosConnection(client, { timeoutMs = 10000, timers = globalThis } = {}) {
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(Object.assign(new Error('Server javobi kelmadi.'), { code: 'ETIMEDOUT' })), timeoutMs);
    });
    const response = await Promise.race([
      Promise.resolve().then(() => client.functions.invoke('complete-sale', { action: 'get_current_shift' })),
      deadline,
    ]);
    const payload = response?.data || response;
    if (payload?.ok !== true || !Object.prototype.hasOwnProperty.call(payload, 'shift')
      || (payload.shift !== null && (!payload.shift?.id || payload.shift.status !== 'open'))) {
      throw Object.assign(new Error('Server aloqani tasdiqlamadi.'), { status: 502 });
    }
    return payload.shift;
  } finally { timers.clearTimeout(timer); }
}
