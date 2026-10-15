// Local, current-attempt timing only. Never add this to a saved order/request.
export function startOrderActionTiming(clock = globalThis.performance) {
  const readNow = typeof clock?.now === 'function' ? () => clock.now() : () => Date.now();
  const startedAt = readNow();
  return () => (Math.max(0, readNow() - startedAt) / 1000).toFixed(1).replace('.', ',');
}

