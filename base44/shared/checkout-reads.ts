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

// Match only identical, plain SDK arguments. Keep types and array ordering;
// unsupported/circular arguments simply bypass request-local deduplication.
function checkoutReadKey(entityName: string, method: string, args: any[]): string {
  const seen = new Set<any>();
  const encode = (value: any): any => {
    if (value === null) return ["null"];
    const type = typeof value;
    if (type === "undefined") return [type];
    if (type === "string" || type === "boolean") return [type, value];
    if (type === "number" && Number.isFinite(value)) return [type, value];
    if (type !== "object" || seen.has(value)
      || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null)) throw new Error("Uncacheable read arguments");
    seen.add(value);
    const encoded = Array.isArray(value)
      ? ["array", value.map(encode)]
      : ["object", Object.keys(value).sort().map(key => [key, encode(value[key])])];
    seen.delete(value);
    return encoded;
  };
  try { return JSON.stringify([entityName, method, encode(args)]); }
  catch { return ""; }
}

export function createCheckoutReadTracker(originalService: any) {
  const started = checkoutClock();
  const reads = new Set(["get", "filter", "list"]);
  const writes = new Set(["create", "bulkCreate", "update", "updateMany", "delete", "deleteMany"]);
  const validationEntities = new Set(["User", "Shop", "Shift", "Product"]);
  const cache = new Map<string, Promise<any>>();
  const inFlight = new Map<string, Promise<any>>();
  const entities = new Map<string, any>();
  const operations: any[] = [];
  let cachedReads = 0;
  let retriesLeft = 2;
  let retries = 0;
  let mutationsInFlight = 0;
  const clearReads = () => { cache.clear(); inFlight.clear(); };

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
            // No cached/in-flight result can cross a mutation boundary, including
            // failed or uncertain writes. Reads during a write also bypass reuse.
            if (writes.has(method)) {
              clearReads();
              mutationsInFlight++;
              try {
                return Promise.resolve(original.apply(record, args)).finally(() => {
                  mutationsInFlight--; clearReads();
                });
              } catch (error) {
                mutationsInFlight--; clearReads(); throw error;
              }
            }
            const key = mutationsInFlight === 0 ? checkoutReadKey(entityName, method, args) : "";
            const reusable = key && (cache.get(key) || inFlight.get(key));
            if (reusable) { cachedReads++; return reusable; }
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
            if (key && mutationsInFlight === 0) {
              inFlight.set(key, pending);
              // Only preflight metadata GETs persist for this request. Stock and
              // filtered/list reads are fresh again as soon as the read settles.
              if (method === "get" && validationEntities.has(entityName)) cache.set(key, pending);
              pending.then(() => {
                if (inFlight.get(key) === pending) inFlight.delete(key);
              }, () => {
                if (inFlight.get(key) === pending) inFlight.delete(key);
                if (cache.get(key) === pending) cache.delete(key);
              });
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
