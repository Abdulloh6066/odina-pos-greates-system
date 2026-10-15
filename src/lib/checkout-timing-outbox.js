// Diagnostics only. This database never opens or changes the pending-sales DB.
const DB_NAME = 'odina-checkout-timing-outbox';
const STORE = 'events';
const OUTCOMES = new Set(['confirmed', 'rechecked', 'queued', 'unconfirmed']);
const KEY = /^[A-Za-z0-9:_-]{16,128}$/;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
let databasePromise;
let fallbackFlush = Promise.resolve();
let sequence = 0;

export function createCheckoutTimingEventId() {
  try { const uuid = globalThis.crypto?.randomUUID?.(); if (uuid) return `ct-${uuid}`; } catch { /* Use a local fallback. */ }
  let stamp = 'local'; let random = 'fallback';
  try { stamp = Date.now().toString(36); random = Math.random().toString(36).slice(2).padEnd(12, '0'); } catch { /* Counter still separates local attempts. */ }
  return `ct-${stamp}-${++sequence}-${random}`;
}

function normalizeEvent(value) {
  if (!value || typeof value.event_id !== 'string' || !KEY.test(value.event_id) || !validId(value.actor_id) || !validId(value.shift_id)
    || typeof value.request_key !== 'string' || !KEY.test(value.request_key) || !OUTCOMES.has(value.outcome)
    || !Number.isInteger(value.total_ms) || value.total_ms < 0 || value.total_ms > 86400000
    || typeof value.client_completed_at !== 'string'
    || new Date(value.client_completed_at).toISOString() !== value.client_completed_at) return null;
  const event = { event_id: value.event_id, actor_id: value.actor_id, shift_id: value.shift_id,
    request_key: value.request_key, total_ms: value.total_ms, outcome: value.outcome, client_completed_at: value.client_completed_at };
  if (value.sale_id != null) {
    if (!validId(value.sale_id) || ['queued', 'unconfirmed'].includes(value.outcome)) return null;
    event.sale_id = value.sale_id;
  }
  if (value.api_round_trip_ms != null) {
    if (!Number.isFinite(value.api_round_trip_ms) || value.api_round_trip_ms < 0 || value.api_round_trip_ms > 86400000) return null;
    event.api_round_trip_ms = value.api_round_trip_ms;
  }
  return event;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let finished = false;
    const request = globalThis.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('actor_id', 'actor_id', { unique: false });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (finished) { db.close(); return; }
      finished = true;
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      resolve(db);
    };
    const failed = () => { finished = true; reject(new Error('Timing storage unavailable')); };
    request.onerror = failed;
    request.onblocked = failed;
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

async function transaction(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode); let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error('Timing storage transaction failed'));
    operation(tx.objectStore(STORE), value => { result = value; });
  });
}

function listEvents(actorId) {
  return transaction('readonly', (store, done) => {
    const request = store.index('actor_id').getAll(actorId);
    request.onsuccess = () => done((request.result || []).filter(row => row.actor_id === actorId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id))));
  });
}

function storedEvent(record, actorId) {
  try {
    const event = normalizeEvent(record.event);
    if (!event || event.actor_id !== actorId || record.actor_id !== actorId
      || record.id !== JSON.stringify([event.actor_id, event.event_id])
      || record.event_json !== JSON.stringify(event)) return null;
    return event;
  } catch { return null; }
}

function quarantineEvent(record, actorId) {
  return transaction('readwrite', store => {
    const request = store.get(record.id);
    request.onsuccess = () => {
      const saved = request.result;
      if (saved && !storedEvent(saved, actorId)) {
        store.put({ ...saved, status: 'rejected', last_error_status: 400, last_error: 'corrupt_event' });
      }
    };
  });
}

function changeEvent(record, rejected) {
  return transaction('readwrite', store => {
    const request = store.get(record.id);
    request.onsuccess = () => {
      const saved = request.result;
      if (!saved || saved.event_json !== record.event_json) return;
      if (rejected) store.put({ ...saved, status: 'rejected', last_error_status: rejected });
      else store.delete(record.id); // Only acknowledged diagnostics; never a sale.
    };
  });
}

export async function enqueueCheckoutTiming(value) {
  try {
    const event = normalizeEvent(value);
    if (!event) return { queued: false, persisted: false, error: 'invalid_event' };
    const id = JSON.stringify([event.actor_id, event.event_id]);
    const eventJson = JSON.stringify(event);
    return await transaction('readwrite', (store, done) => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) {
          done(request.result.event_json === eventJson
            ? { queued: true, persisted: true } : { queued: false, persisted: false, error: 'event_conflict' });
          return;
        }
        store.put({ id, actor_id: event.actor_id, event, event_json: eventJson, status: 'pending', created_at: new Date().toISOString() });
        done({ queued: true, persisted: true });
      };
    });
  } catch { return { queued: false, persisted: false, error: 'storage_unavailable' }; }
}

function currentUser(check, userId) {
  try { return typeof check !== 'function' || check(userId) === true; } catch { return false; }
}

function reportBody(event) {
  const { actor_id: _actorId, ...body } = event;
  return { action: 'record', ...body };
}

function acknowledged(response, eventId) {
  const payload = response?.data || response;
  return payload?.saved === true && payload.event_id === eventId;
}

async function withFlushLock(userId, work) {
  try {
    if (globalThis.navigator?.locks?.request) {
      return await globalThis.navigator.locks.request(`odina:checkout-timing:${userId}`, { mode: 'exclusive', ifAvailable: true },
        lock => lock ? work() : { sent: 0, remaining: null, hasMore: false, skipped: true });
    }
  } catch { return { sent: 0, remaining: null, hasMore: false, failed: { reason: 'lock_unavailable' } }; }
  const pending = fallbackFlush.then(work, work);
  fallbackFlush = pending.catch(() => {});
  return pending;
}

export async function flushCheckoutTimings(options) {
  try {
    const { userId, send, isCurrentUser } = options || {};
    if (!validId(userId) || typeof send !== 'function' || !currentUser(isCurrentUser, userId)) {
      return { sent: 0, remaining: null, hasMore: false, skipped: true };
    }
    return await withFlushLock(userId, async () => {
      let sent = 0; let failed = null; let stopped = false;
      const records = (await listEvents(userId)).filter(row => row.status !== 'rejected').slice(0, 50);
      for (const record of records) {
        if (!currentUser(isCurrentUser, userId) || globalThis.navigator?.onLine === false) { stopped = true; break; }
        const event = storedEvent(record, userId);
        if (!event) {
          await quarantineEvent(record, userId);
          failed ||= { status: 400, retryable: false, reason: 'corrupt_event' };
          continue;
        }
        try {
          const response = await send(reportBody(event));
          if (!acknowledged(response, event.event_id)) throw new Error('Timing acknowledgment missing');
          await changeEvent(record, 0);
          sent++;
        } catch (error) {
          const status = Number(error?.response?.status || error?.status || 0);
          const retryable = !status || [401, 404, 408, 425, 429].includes(status) || status >= 500;
          failed ||= { event_id: record.event.event_id, status, retryable };
          if (retryable) { stopped = true; break; }
          await changeEvent(record, status);
        }
      }
      const remaining = await listEvents(userId);
      return { sent, remaining: remaining.length, failed,
        hasMore: !stopped && remaining.some(row => row.status !== 'rejected') };
    });
  } catch { return { sent: 0, remaining: null, hasMore: false, failed: { reason: 'storage_unavailable' } }; }
}

export async function reportCheckoutTiming(event, options) {
  try {
    const snapshot = normalizeEvent(event);
    if (!snapshot) return { queued: false, persisted: false, error: 'invalid_event' };
    const actorId = snapshot.actor_id;
    const result = await enqueueCheckoutTiming(snapshot);
    const { send, isCurrentUser } = options || {};
    if (!result.queued && result.error === 'storage_unavailable' && typeof send === 'function'
      && currentUser(isCurrentUser, actorId) && globalThis.navigator?.onLine !== false) {
      try {
        if (!acknowledged(await send(reportBody(snapshot)), snapshot.event_id)) throw new Error('Timing acknowledgment missing');
        return { ...result, sent: 1, remaining: null, hasMore: false };
      } catch { return { ...result, sent: 0, remaining: null, hasMore: false, failed: { reason: 'direct_report_failed' } }; }
    }
    if (!result.queued || typeof send !== 'function') return result;
    let flushed;
    do { flushed = await flushCheckoutTimings({ userId: actorId, send, isCurrentUser }); } while (flushed.hasMore);
    return { ...result, ...flushed };
  } catch { return { queued: false, persisted: false, error: 'report_unavailable' }; }
}
