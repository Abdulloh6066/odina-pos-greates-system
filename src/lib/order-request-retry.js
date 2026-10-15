// Keep the exact submitted intent through dialog unmounts and tab refreshes.
// A retry may only send this payload; edited financial data needs a fresh,
// confirmed request. Session storage scopes the draft to this browser tab.
export function orderRequestScope(actorId, action, orderId = '') {
  return `odina:order-request:${actorId || 'unknown'}:${action}:${orderId}`;
}

export function readOrderRequest(scope, storage) {
  try { return JSON.parse((storage || globalThis.sessionStorage).getItem(scope) || 'null'); } catch { return null; }
}

export function retainOrderRequest(scope, payload, storage = globalThis.sessionStorage) {
  const saved = readOrderRequest(scope, storage);
  if (saved) return saved;
  const frozen = JSON.parse(JSON.stringify(payload));
  // If persistence fails, fail before sending a financial mutation.
  storage.setItem(scope, JSON.stringify(frozen));
  return frozen;
}

export function clearOrderRequest(scope, storage = globalThis.sessionStorage) {
  storage.removeItem(scope);
}

export function orderRequestDefinitelyRejected(error) {
  const data = error?.response?.data || error?.data;
  // HTTP status alone does not prove that an earlier financial write failed.
  return data?.request_not_started === true;
}
