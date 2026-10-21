import { friesOptionFields } from './burger-fries.js';
import { isPosNetworkError } from './pos-network.js';

const DB_NAME = 'odina-pos-offline-sales';
const DB_VERSION = 1;
const STORE_NAME = 'pending_sales';
const QUEUE_EVENT = 'odina:offline-sales-changed';
const SYNC_LOCK = 'odina-pos-offline-sales-sync';

let databasePromise;
let broadcastChannel;
let fallbackSync = Promise.resolve();

// This deadline changes presentation only. The original write is never aborted,
// and its exact request is retained for the durable queue or an explicit retry.
export const POS_CHECKOUT_RESPONSE_BUDGET_MS = 1000;
export const POS_PROTECTED_CHECKOUT_RESPONSE_BUDGET_MS = 2500;
export const POS_QUEUE_RESPONSE_BUDGET_MS = 15000;
const saleRequests = new Map();

export function startSaleRequest(request, send, { userId = '' } = {}) {
  const key = String(request.idempotency_key || '');
  if (!key) throw Object.assign(new Error('Savdo so‘rov kaliti yo‘q.'), { status: 400 });
  const cacheKey = JSON.stringify([String(userId), key]);
  const fingerprint = JSON.stringify(request);
  const existing = saleRequests.get(cacheKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error('Avvalgi to‘lov natijasini o‘sha mahsulot va to‘lov usullari bilan tekshiring.');
    }
    if (existing.status !== 'rejected') return existing;
  }
  const snapshot = JSON.parse(fingerprint);
  const startedAt = Date.now();
  const startedMonotonic = globalThis.performance?.now?.();
  const flight = { cacheKey, fingerprint, request: snapshot, status: 'pending', response: null, error: null };
  // Invoke synchronously, preserving the immediate double-submit guard in POS.
  const sent = new Promise((resolve, reject) => {
    try { resolve(send(snapshot)); } catch (error) { reject(error); }
  });
  flight.promise = sent.then((response) => {
    flight.status = 'fulfilled';
    flight.response = response;
    // Capture receipt of the actual acknowledgment, even when the cashier
    // has already continued and the queue consumes this response much later.
    try {
      flight.receivedAt = Date.now();
      flight.roundTripMs = Math.max(0, Math.round(Number.isFinite(startedMonotonic)
        ? globalThis.performance.now() - startedMonotonic : flight.receivedAt - startedAt));
    } catch { /* Diagnostic clocks cannot invalidate a server acknowledgment. */ }
    return response;
  }, (error) => {
    flight.status = 'rejected';
    flight.error = error;
    releaseSaleRequest(key, flight);
    throw error;
  });
  // A timed-out presentation may have no active caller until the next drain.
  void flight.promise.catch(() => {});
  // This is only an optimization for same-page retries; IndexedDB owns recovery.
  // Eviction may cause a same-key replay, never a different sale or lost record.
  if (saleRequests.size >= 128) saleRequests.delete(saleRequests.keys().next().value);
  saleRequests.set(cacheKey, flight);
  return flight;
}

export function releaseSaleRequest(key, flight) {
  if (flight && String(flight.request.idempotency_key) === String(key)
    && saleRequests.get(flight.cacheKey) === flight) saleRequests.delete(flight.cacheKey);
}

export async function waitForSaleResponse(flight, {
  timeoutMs = POS_CHECKOUT_RESPONSE_BUDGET_MS, timers = globalThis,
} = {}) {
  let timer;
  try {
    return await Promise.race([
      flight.promise.then((response) => ({ pending: false, response })),
      new Promise((resolve) => {
        timer = timers.setTimeout(() => resolve({ pending: true }), timeoutMs);
      }),
    ]);
  } finally {
    timers.clearTimeout(timer);
  }
}

const numberValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const errorWithCode = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

export function tashkentDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function createSaleIdempotencyKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `pos-${uuid}`;
  return `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function saleNumberFromKey(idempotencyKey, recordedAt) {
  const suffix = String(idempotencyKey || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-8)
    .toUpperCase()
    .padStart(8, '0');
  return `OD-${tashkentDateKey(recordedAt).replaceAll('-', '')}-${suffix}`;
}

export function buildPendingSale({
  idempotencyKey = createSaleIdempotencyKey(),
  recordedAt = new Date().toISOString(),
  shift,
  user,
  shop,
  cart,
  payments,
  isDelivery = false,
}) {
  if (!shift?.id || !shift?.shop_id || !user?.id) {
    throw errorWithCode('Offline savdo uchun ochiq smena kerak.', 'SHIFT_REQUIRED');
  }

  const timestamp = new Date(recordedAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw errorWithCode('Savdo vaqti noto‘g‘ri.', 'INVALID_RECORDED_AT');
  }

  const items = (cart || []).map((item) => {
    const quantity = Math.floor(numberValue(item?.quantity));
    const price = numberValue(item?.price);
    if (!item?.product_id || quantity <= 0 || price < 0) {
      throw errorWithCode('Mahsulot ma’lumoti noto‘g‘ri.', 'INVALID_ITEM');
    }
    return {
      product_id: String(item.product_id),
      ...friesOptionFields(item),
      product_name: String(item.product_name || ''),
      image_url: String(item.image_url || ''),
      price,
      quantity,
      sale_unit: item.sale_unit === 'gram' ? 'gram' : 'piece',
      subtotal: Math.round(price * quantity / (item.sale_unit === 'gram' ? 1000 : 1)),
    };
  });

  if (!items.length) {
    throw errorWithCode('Savdo uchun mahsulot kiriting.', 'ITEMS_REQUIRED');
  }

  const normalizedPayments = (payments || [])
    .map((payment) => ({
      method: String(payment?.method || ''),
      amount: numberValue(payment?.amount),
      reference: String(payment?.reference || ''),
    }))
    .filter((payment) => payment.amount > 0);

  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  const total = Math.round(subtotal * 100) / 100;
  const paid = normalizedPayments.reduce((sum, payment) => sum + payment.amount, 0);
  if (total > 0 && (!normalizedPayments.length || paid !== total)) {
    throw errorWithCode('To‘lov summasi savdo summasiga teng bo‘lishi kerak.', 'INVALID_PAYMENT_TOTAL');
  }

  const recordedIso = timestamp.toISOString();
  // Offline receipt is printed immediately; freeze only the assigned shop's
  // currently cached public contact details. The server independently reads
  // its own authoritative shop data when the queued sale is synchronized.
  const receiptShop = shop?.id === shift.shop_id ? shop : null;
  const request = {
    action: 'complete_sale',
    is_delivery: isDelivery === true,
    shift_id: String(shift.id),
    items: items.map((item) => ({ product_id: item.product_id, quantity: item.quantity, ...friesOptionFields(item) })),
    payments: normalizedPayments,
    idempotency_key: String(idempotencyKey),
    recorded_at: recordedIso,
  };

  return {
    id: String(idempotencyKey),
    schema_version: 1,
    status: 'pending',
    attempts: 0,
    last_error: '',
    created_at: recordedIso,
    updated_at: recordedIso,
    user_id: String(user.id),
    shift_id: String(shift.id),
    shop_id: String(shift.shop_id),
    request,
    local_sale: {
      is_delivery: isDelivery === true,
      sale_number: saleNumberFromKey(idempotencyKey, recordedIso),
      sold_at: recordedIso,
      business_date: tashkentDateKey(recordedIso),
      user_id: String(user.id),
      user_name: String(user.full_name || user.email || ''),
      shift_id: String(shift.id),
      shop_id: String(shift.shop_id),
      shop_name: String(shift.shop_name || ''),
      receipt_instagram_snapshot: String(receiptShop?.instagram || '').trim().replace(/^@/, ''),
      receipt_phone_snapshot: String(receiptShop?.phone || '').trim(),
      receipt_address_snapshot: String(receiptShop?.address || '').trim(),
      items,
      subtotal,
      discount_amount: 0,
      total,
      payments: normalizedPayments.map(({ method, amount }) => ({ method, amount })),
      payment_methods_summary: normalizedPayments.map((payment) => payment.method).join(' + '),
      status: 'completed',
      offline_pending: true,
    },
  };
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(errorWithCode(
      'Bu brauzer offline savdoni saqlashni qo‘llamaydi.',
      'INDEXED_DB_UNAVAILABLE',
    ));
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('user_id', 'user_id', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error || errorWithCode('Offline xotirani ochib bo‘lmadi.', 'INDEXED_DB_OPEN_FAILED'));
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(errorWithCode('Offline xotira boshqa oynada band.', 'INDEXED_DB_BLOCKED'));
    };
  });

  return databasePromise;
}

function channel() {
  if (broadcastChannel || typeof BroadcastChannel === 'undefined') return broadcastChannel;
  broadcastChannel = new BroadcastChannel(QUEUE_EVENT);
  return broadcastChannel;
}

function notifyQueueChanged() {
  // Notifications cannot turn a completed durable transaction into a failure.
  try { if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_EVENT)); } catch { /* Refresh on the next queue operation. */ }
  try { channel()?.postMessage({ type: 'changed' }); } catch { /* A closed channel does not undo the stored sale. */ }
}

export function subscribePendingSales(listener) {
  if (typeof listener !== 'function') return () => {};
  const localListener = () => listener();
  const sharedChannel = channel();

  if (typeof window !== 'undefined') window.addEventListener(QUEUE_EVENT, localListener);
  sharedChannel?.addEventListener('message', localListener);

  return () => {
    if (typeof window !== 'undefined') window.removeEventListener(QUEUE_EVENT, localListener);
    sharedChannel?.removeEventListener('message', localListener);
  };
}

export async function listPendingSales(userId) {
  const database = await openDatabase();
  const rows = await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error('Offline savdolarni o‘qib bo‘lmadi.'));
  });

  return rows
    .filter((row) => !userId || row.user_id === userId)
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
}

export async function savePendingSale(record) {
  if (!record?.id || record.id !== record.request?.idempotency_key) {
    throw Object.assign(new Error('Offline savdo kaliti mos kelmadi.'), { status: 400 });
  }
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Offline savdoni saqlab bo‘lmadi.'));
    transaction.onabort = () => reject(transaction.error || new Error('Offline savdo saqlanmadi.'));
  });
  notifyQueueChanged();
  return record;
}

async function updatePendingSale(id, patch) {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) return;
      store.put({ ...request.result, ...patch, updated_at: new Date().toISOString() });
    };
    request.onerror = () => reject(request.error || new Error('Offline savdoni yangilab bo‘lmadi.'));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Offline savdoni yangilab bo‘lmadi.'));
    transaction.onabort = () => reject(transaction.error || new Error('Offline savdo yangilanmadi.'));
  });
  notifyQueueChanged();
}

async function removePendingSale(id) {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Offline savdoni navbatdan olib bo‘lmadi.'));
    transaction.onabort = () => reject(transaction.error || new Error('Offline savdo navbatda qoldi.'));
  });
  notifyQueueChanged();
}

export function syncErrorMessage(error) {
  return String(
    error?.response?.data?.error
      || error?.data?.error
      || error?.message
      || 'Serverga yuborib bo‘lmadi.',
  );
}

export function isRetryableSyncError(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  return !status || status === 408 || status === 429 || status >= 500;
}

async function withSyncLock(work) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(
      SYNC_LOCK,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => lock ? work() : { skipped: true },
    );
  }

  const run = fallbackSync.then(work, work);
  fallbackSync = run.catch(() => {});
  return run;
}

export function pendingSaleRetryDelay(records, now = Date.now()) {
  const pending = (records || []).filter((row) => row.status !== 'failed');
  if (!pending.length) return null;
  // Keep temporary outages ordered: a newer sale must not defeat the oldest
  // pending request's backoff and cause repeated server calls every second.
  const next = Date.parse(pending[0].next_retry_at || '');
  return Math.max(1000, Number.isFinite(next) ? next - now : 1000);
}

// Storage injection is used by memory-only regression tests; production defaults
// remain IndexedDB. Failed records are retained until an explicit manual retry.
export async function syncPendingSales({ userId, send, retryFailed = false, onConfirmed,
  storage = { list: listPendingSales, update: updatePendingSale, remove: removePendingSale },
  lock = withSyncLock, now = () => Date.now(),
}) {
  if (!userId || typeof send !== 'function') {
    return { synced: 0, remaining: 0, failed: null };
  }

  const result = await lock(async () => {
    const records = await storage.list(userId);
    let synced = 0;
    const priorFailure = records.find((row) => row.status === 'failed');
    let failed = priorFailure && !retryFailed
      ? { id: priorFailure.id, retryable: false, message: priorFailure.last_error } : null;

    for (const record of records) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      if (!retryFailed && record.status === 'failed') continue;
      if (!retryFailed && Date.parse(record.next_retry_at || '') > now()) break;

      await storage.update(record.id, {
        status: 'syncing',
        attempts: Number(record.attempts || 0) + 1,
        last_error: '',
      });

      let flight;
      try {
        if (String(record.id) !== String(record.request?.idempotency_key || '')) {
          throw Object.assign(new Error('Saqlangan savdo so‘rov kaliti mos emas.'), { status: 400 });
        }
        flight = startSaleRequest(record.request, send, { userId });
        const outcome = await waitForSaleResponse(flight, { timeoutMs: POS_QUEUE_RESPONSE_BUDGET_MS });
        if (outcome.pending) {
          // Reuse the original flight for this drain. A later bounded retry may
          // send the same key again; server idempotency owns any in-flight work.
          releaseSaleRequest(record.id, flight);
          throw Object.assign(new Error('Server javobi hali tasdiqlanmadi.'), { code: 'ETIMEDOUT' });
        }
        const response = outcome.response;
        const payload = response?.data || response;
        if (!payload?.sale?.id) {
          releaseSaleRequest(record.id, flight);
          const error = errorWithCode(
            payload?.error || 'Server savdoni tasdiqlamadi.',
            'SALE_NOT_CONFIRMED',
          );
          error.status = 500;
          throw error;
        }
        await storage.remove(record.id);
        releaseSaleRequest(record.id, flight);
        synced += 1;
        // Reconcile only after the saved sale and queue removal are confirmed.
        // A presentation failure must never requeue an acknowledged payment.
        let confirmationTiming = null;
        try {
          const checkoutStartedAt = Date.parse(record.checkout_started_at || '');
          confirmationTiming = {
            totalMs: Number.isFinite(checkoutStartedAt) && flight.receivedAt >= checkoutStartedAt
              ? flight.receivedAt - checkoutStartedAt : null,
            apiRoundTripMs: flight.roundTripMs,
            completedAt: new Date(flight.receivedAt).toISOString(),
          };
        } catch { /* Timing cannot requeue or invalidate an acknowledged sale. */ }
        try { void Promise.resolve(onConfirmed?.({ id: record.id, request: record.request, record, payload, confirmationTiming })).catch(() => {}); } catch { /* onSynced can refresh authoritative state. */ }
      } catch (error) {
        const status = Number(error?.response?.status || error?.status || 0);
        const sessionBlocked = status === 401 || status === 403;
        const retryable = isRetryableSyncError(error) || sessionBlocked;
        const message = syncErrorMessage(error);
        const delay = sessionBlocked ? 60000 : Math.min(60000, 5000 * (2 ** Math.min(Number(record.attempts || 0), 4)));
        await storage.update(record.id, {
          status: retryable ? 'pending' : 'failed',
          last_error: message,
          last_error_status: status,
          next_retry_at: retryable ? new Date(now() + delay).toISOString() : '',
        });
        failed = failed || { id: record.id, retryable, message, status, network: isPosNetworkError(error) };
        // Connection, throttling and session errors affect the whole queue.
        // A permanently rejected independent POS sale must not block the rest.
        if (retryable) break;
      }
    }

    const remaining = (await storage.list(userId)).length;
    return { synced, remaining, failed };
  });

  if (result?.skipped) {
    return { synced: 0, remaining: (await storage.list(userId)).length, failed: null, skipped: true };
  }
  return result;
}
