const DB_NAME = 'odina-pos-offline-sales';
const DB_VERSION = 1;
const STORE_NAME = 'pending_sales';
const QUEUE_EVENT = 'odina:offline-sales-changed';
const SYNC_LOCK = 'odina-pos-offline-sales-sync';

let databasePromise;
let broadcastChannel;
let fallbackSync = Promise.resolve();

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
    shift_id: String(shift.id),
    items: items.map(({ product_id, quantity }) => ({ product_id, quantity })),
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
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_EVENT));
  channel()?.postMessage({ type: 'changed' });
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
  return Math.max(1000, Math.min(...pending.map((row) => {
    const next = Date.parse(row.next_retry_at || '');
    return Number.isFinite(next) ? next - now : 1000;
  })));
}

// Storage injection is used by memory-only regression tests; production defaults
// remain IndexedDB. Failed records are retained until an explicit manual retry.
export async function syncPendingSales({ userId, send, retryFailed = false,
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
      if (!retryFailed && (record.status === 'failed' || Date.parse(record.next_retry_at || '') > now())) continue;

      await storage.update(record.id, {
        status: 'syncing',
        attempts: Number(record.attempts || 0) + 1,
        last_error: '',
      });

      try {
        const response = await send(record.request);
        const payload = response?.data || response;
        if (!payload?.sale) {
          const error = errorWithCode(
            payload?.error || 'Server savdoni tasdiqlamadi.',
            'SALE_NOT_CONFIRMED',
          );
          error.status = 500;
          throw error;
        }
        await storage.remove(record.id);
        synced += 1;
      } catch (error) {
        const status = Number(error?.response?.status || error?.status || 0);
        const sessionBlocked = status === 401 || status === 403;
        const retryable = isRetryableSyncError(error) || sessionBlocked;
        const message = syncErrorMessage(error);
        const delay = sessionBlocked ? 60000 : Math.min(60000, 5000 * (2 ** Math.min(Number(record.attempts || 0), 4)));
        await storage.update(record.id, {
          status: retryable ? 'pending' : 'failed',
          last_error: message,
          next_retry_at: retryable ? new Date(now() + delay).toISOString() : '',
        });
        failed = failed || { id: record.id, retryable, message };
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
