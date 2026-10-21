// Browser-local last attempt metadata only. Never store items, payments or credentials here.
const VERSION = 1;
const OUTCOMES = new Set(['confirmed', 'rechecked', 'queued', 'unconfirmed']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

export function checkoutTimingScope(userId, shopId, shiftId) {
  return [userId, shopId, shiftId].every(validId) ? { userId, shopId, shiftId } : null;
}

function matchesScope(value, scope) {
  return scope && value?.userId === scope.userId && value?.shopId === scope.shopId && value?.shiftId === scope.shiftId;
}

function timingKey(scope) {
  // One last metric per user: moving between shifts cannot grow stored history.
  return `odina:checkout-timing:v${VERSION}:${encodeURIComponent(scope.userId)}`;
}

function validMeasurement(value) {
  return value && Number.isFinite(value.totalMs) && value.totalMs >= 0 && OUTCOMES.has(value.outcome);
}

function storedTiming(value, scope) {
  const checkedScope = checkoutTimingScope(scope?.userId, scope?.shopId, scope?.shiftId);
  if (!checkedScope
    || value?.version !== VERSION || !matchesScope(value, scope) || !validMeasurement(value)
    || typeof value.completedAt !== 'string') return null;
  const date = new Date(value.completedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.completedAt) return null;
  return { version: VERSION, ...checkedScope, totalMs: value.totalMs, outcome: value.outcome, completedAt: value.completedAt,
    ...(validId(value.requestKey) ? { requestKey: value.requestKey } : {}),
    ...(value.durationKnown === false ? { durationKnown: false } : {}) };
}

export function readCheckoutTiming(scope, storage) {
  try {
    if (!checkoutTimingScope(scope?.userId, scope?.shopId, scope?.shiftId)) return null;
    const target = storage === undefined ? globalThis.localStorage : storage;
    const value = storedTiming(JSON.parse(target.getItem(timingKey(scope)) || 'null'), scope);
    return value ? { ...value, persisted: true } : null;
  } catch { return null; }
}

export function saveCheckoutTiming(scope, measurement, storage) {
  let value;
  try {
    const checkedScope = checkoutTimingScope(scope?.userId, scope?.shopId, scope?.shiftId);
    if (!checkedScope || !validMeasurement(measurement)) return null;
    value = { version: VERSION, ...checkedScope, totalMs: measurement.totalMs,
      outcome: measurement.outcome, completedAt: new Date().toISOString(),
      ...(validId(measurement.requestKey) ? { requestKey: measurement.requestKey } : {}),
      ...(measurement.durationKnown === false ? { durationKnown: false } : {}) };
  } catch { return null; }
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    target.setItem(timingKey(value), JSON.stringify(value));
    return { ...value, persisted: true };
  } catch { return { ...value, persisted: false }; }
}
