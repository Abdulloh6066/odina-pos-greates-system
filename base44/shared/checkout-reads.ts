// Request-local reads only: no shared role, price, stock, or shift cache.
// A timeout can mean a write committed. Never replay a mutation here.
export const checkoutClock = () => typeof performance === "undefined" ? Date.now() : performance.now();

export function isTransientCheckoutError(error: any): boolean {
  const status = Number(error?.response?.status || error?.status || 0);
  if ([408, 429, 502, 503, 504].includes(status)) return true;
  if (status >= 400 && status < 500) return false;
  const message = String(error?.response?.data?.error || error?.message || "");
  return /timed?\s*out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|server selection|connection pool|network|socket/i.test(message);
}

export function createCheckoutReadTracker(originalService: any) {
  const started = checkoutClock();
  const reads = new Set(["get", "filter", "list"]);
  const writes = new Set(["create", "bulkCreate", "update", "updateMany", "delete", "deleteMany"]);
  const validationEntities = new Set(["User", "Shop", "Shift", "Product"]);
  const cache = new Map<string, Promise<any>>();
  const entities = new Map<string, any>();
  const operations: any[] = [];
  let cachedReads = 0;
  let retriesLeft = 2;
  let retries = 0;

  const entityProxy = new Proxy(originalService.entities, {
    get(target, entityName: string) {
      const entity = target[entityName];
      if (!entity || typeof entityName !== "string") return entity;
      if (entities.has(entityName)) return entities.get(entityName);
      const wrapped = new Proxy(entity, {
        get(record, method: string) {
          const original = record[method];
          if (typeof original !== "function" || (!reads.has(method) && !writes.has(method))) return original;
          return (...args: any[]) => {
            // Every mutation clears the preflight cache, including failed or
            // uncertain writes. Reconciliation always reads the current database.
            if (writes.has(method)) {
              cache.clear();
              return original.apply(record, args);
            }
            const key = method === "get" && validationEntities.has(entityName)
              ? entityName + ":" + String(args[0]) : "";
            if (key && cache.has(key)) { cachedReads++; return cache.get(key); }
            const run = async () => {
              const readStarted = checkoutClock();
              let attempts = 0;
              try {
                for (;;) {
                  attempts++;
                  try { return await original.apply(record, args); }
                  catch (error) {
                    if (attempts > 1 || retriesLeft === 0 || !isTransientCheckoutError(error)) throw error;
                    retriesLeft--; retries++;
                    console.warn("[Odina database read retry]", JSON.stringify({ entity: entityName, method }));
                  }
                }
              } finally {
                if (operations.length < 60) operations.push({
                  entity: entityName, method, ms: Math.round(checkoutClock() - readStarted), attempts,
                });
              }
            };
            const pending = run();
            if (key) {
              cache.set(key, pending);
              pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
            }
            return pending;
          };
        },
      });
      entities.set(entityName, wrapped); return wrapped;
    },
  });
  return {
    service: new Proxy(originalService, { get(target, property) {
      return property === "entities" ? entityProxy : target[property];
    } }),
    snapshot: () => ({ total_ms: Math.round(checkoutClock() - started),
      cached_reads: cachedReads, read_retries: retries, reads: operations.map(row => ({ ...row })) }),
  };
}
