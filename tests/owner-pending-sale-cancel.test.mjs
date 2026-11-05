// Real handler + in-memory entities only. No live data or credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pbkdf2Sync } from 'node:crypto';
import { basketCheckoutFixture, checkoutEntry, quiet } from './helpers/basket-checkout.mjs';
import { cancelPendingSale, syncPendingSales, buildPendingSale } from '../src/lib/offline-sales.js';

const pin = '987654'; // Synthetic test fixture, never a real owner code.
function fixture() {
  const f = basketCheckoutFixture('Central', 0, 0);
  const cashier = f.db.User[0];
  const owner = { id: 'test-owner', role: 'admin', is_owner: true, active: true };
  f.db.User.push(owner);
  f.db.SecuritySettings = [{ id: 'pin-setting', key: 'owner_approval_pin', pin_algorithm: 'PBKDF2-SHA256',
    pin_salt: 'mock-salt', pin_iterations: 100000,
    pin_hash: pbkdf2Sync(pin, 'mock-salt', 100000, 32, 'sha256').toString('hex') }];
  // Bind caller before invoking the async handler, so concurrent requests retain their identity.
  f.invokeAs = async (user, body) => {
    f.client.auth.me = async () => structuredClone(user);
    return f.invoke(checkoutEntry, body, { console: quiet });
  };
  f.cashier = cashier; f.owner = owner;
  f.cancelBody = { action: 'cancel_pending_sale', idempotency_key: f.request.idempotency_key,
    shift_id: f.request.shift_id, owner_pin: pin, reason: 'Sinovdagi xato savdo' };
  f.cancel = body => f.invokeAs(owner, body || f.cancelBody);
  return f;
}
const financialState = f => structuredClone({ shift: Object.fromEntries(Object.entries(f.db.Shift[0])
  .filter(([key]) => !['sale_request_keys', 'cancelled_sale_requests'].includes(key))),
  stock: f.db.ProductStock, sales: f.db.Sale, items: f.db.SaleItem, payments: f.db.Payment, movements: f.db.StockMovement });

test('only stored protected owner identity plus existing PIN may cancel; spoofed flags and ordinary admins fail', async () => {
  for (const patch of [{ role: 'cashier', is_owner: true, shop_id: 'mock-central' },
    { role: 'manager', is_owner: true, shop_id: 'mock-central' }, { role: 'admin', is_owner: false }, { active: false }]) {
    const f = fixture(); Object.assign(f.owner, patch);
    const reply = await f.cancel(); assert.equal(reply.status, 403);
    assert.equal(f.db.Shift[0].sale_request_keys.length, 0);
  }
  const f = fixture(); f.owner.is_owner = false;
  const result = await f.invokeAs({ ...f.owner, is_owner: true }, f.cancelBody);
  assert.equal(result.status, 403);
  const authMismatch = fixture();
  const mismatch = await authMismatch.invokeAs({ id: 'wrong-auth-id', email: 'owner@example.invalid', role: 'admin', is_owner: true }, authMismatch.cancelBody);
  assert.equal(mismatch.status, 403);
});

test('wrong, missing or rate-limited PIN leaves queue claim and money unchanged', async () => {
  const f = fixture(), before = financialState(f);
  for (let n = 0; n < 5; n++) assert.equal((await f.cancel({ ...f.cancelBody, owner_pin: '000000' })).status, 403);
  assert.equal((await f.cancel()).status, 403);
  assert.equal(f.db.Shift[0].sale_request_keys.length, 0);
  assert.deepEqual(financialState(f), before);
  assert.equal(f.db.ActionHistory.filter(row => row.action === 'owner_pin_failed').length, 5);
  assert.ok(!JSON.stringify(f.db).includes('000000'));
});

test('owner cancellation stores an immutable reason journal and replay never creates sale/payment/stock changes', async () => {
  const f = fixture(), before = financialState(f);
  const reply = await f.cancel(); assert.equal(reply.status, 200, JSON.stringify(reply));
  assert.equal(reply.data.cancelled, true); assert.equal(reply.data.user_id, f.cashier.id);
  const journal = structuredClone(f.db.Shift[0].cancelled_sale_requests);
  assert.equal(journal.length, 1); assert.equal(journal[0].cancelled_by, f.owner.id);
  assert.equal(journal[0].reason, f.cancelBody.reason);
  assert.ok(!JSON.stringify(f.db).includes(pin));
  const retry = await f.cancel({ ...f.cancelBody, reason: 'Different retry reason' });
  assert.equal(retry.status, 200); assert.deepEqual(f.db.Shift[0].cancelled_sale_requests, journal);
  const saleRetry = await f.invokeAs(f.cashier, f.request);
  assert.equal(saleRetry.status, 200); assert.equal(saleRetry.data.cancelled, true);
  assert.deepEqual(financialState(f), before);
  assert.equal(f.db.ActionHistory.filter(row => row.action === 'pending_sale_cancelled').length, 1);
});

test('closed-shift unsent queue can be cancelled without reopening or rewriting financial totals', async () => {
  const f = fixture(); f.db.Shift[0].status = 'closed';
  const before = financialState(f);
  assert.equal((await f.cancel()).status, 200);
  assert.equal((await f.invokeAs(f.cashier, f.request)).data.cancelled, true);
  assert.deepEqual(financialState(f), before);
});

test('completed, in-flight and ambiguous claimed sales cannot be cancelled', async () => {
  const f = fixture(); assert.equal((await f.invokeAs(f.cashier, f.request)).status, 200);
  const before = financialState(f);
  assert.equal((await f.cancel()).status, 409); assert.deepEqual(financialState(f), before);
  for (const status of ['open', 'closed', 'closing']) {
    const pending = fixture(); pending.db.Shift[0].status = status;
    pending.db.Shift[0].sale_request_keys.push(pending.request.idempotency_key);
    assert.equal((await pending.cancel()).status, 409);
    assert.equal(pending.db.Shift[0].cancelled_sale_requests, undefined);
  }
});

test('lost atomic write response reconciles by reading the durable cancellation, not repeating/removing data', async () => {
  const f = fixture(); const update = f.entities.Shift.updateMany;
  f.entities.Shift.updateMany = async (...args) => { await update(...args); throw new Error('Lost response'); };
  assert.equal((await f.cancel()).status, 200);
  assert.equal(f.db.Shift[0].cancelled_sale_requests.length, 1);
  assert.equal(f.db.Sale.length, 0);
});

test('checkout winning the atomic key claim causes racing cancellation to fail safely', async () => {
  const f = fixture(); const update = f.entities.Shift.updateMany;
  f.entities.Shift.updateMany = async (query, patch) => {
    if (patch.$push?.cancelled_sale_requests) f.db.Shift[0].sale_request_keys.push(f.request.idempotency_key);
    return update(query, patch);
  };
  assert.equal((await f.cancel()).status, 409);
  assert.equal(f.db.Shift[0].cancelled_sale_requests, undefined);
});

test('cancellation winning immediately before checkout claim returns cancellation and makes no financial changes', async () => {
  const f = fixture(); const update = f.entities.Shift.updateMany; let inserted = false;
  f.entities.Shift.updateMany = async (query, patch) => {
    if (!inserted && patch.$push?.sale_request_keys === f.request.idempotency_key && !patch.$push?.cancelled_sale_requests) {
      inserted = true;
      assert.equal((await f.cancel()).status, 200);
    }
    return update(query, patch);
  };
  const before = financialState(f);
  const reply = await f.invokeAs(f.cashier, f.request);
  assert.equal(reply.status, 200); assert.equal(reply.data.cancelled, true);
  assert.deepEqual(financialState(f), before);
});

function queue() {
  let rows = [buildPendingSale({ idempotencyKey: 'pos-cancel-test-00001', user: { id: 'cashier' },
    shift: { id: 'shift', shop_id: 'shop' }, cart: [{ product_id: 'cake', quantity: 1, price: 1000 }],
    payments: [{ method: 'cash', amount: 1000 }] })];
  const original = structuredClone(rows[0]);
  return { original, rows: () => rows, storage: {
    list: async userId => structuredClone(rows.filter(row => !userId || row.user_id === userId)),
    remove: async id => { rows = rows.filter(row => row.id !== id); },
    update: async (id, patch) => Object.assign(rows.find(row => row.id === id), patch),
  }, ack: { cancelled: true, idempotency_key: original.id, user_id: original.user_id,
    shift_id: original.shift_id, shop_id: original.shop_id } };
}
function cancelOptions(q, extra = {}) {
  return { recordId: q.original.id, ownerId: 'owner', ownerPin: pin, reason: 'Xato savdo',
    storage: q.storage, lock: work => work(), send: async () => q.ack, ...extra };
}

test('local record is retained on denial, lost response, malformed ACK and local removal failure', async () => {
  for (const send of [async () => { throw new Error('Network Error'); }, async () => ({ error: 'PIN noto‘g‘ri' }),
    async () => ({ cancelled: true }), async () => ({ cancelled: true, idempotency_key: 'other-key' })]) {
    const q = queue(); await assert.rejects(cancelPendingSale(cancelOptions(q, { send })));
    assert.deepEqual(q.rows(), [q.original]);
  }
  const q = queue(); q.storage.remove = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(cancelPendingSale(cancelOptions(q))); assert.deepEqual(q.rows(), [q.original]);
});

test('successful cancellation sends transient PIN only and removes exactly one matching queue row', async () => {
  const q = queue(); let request;
  const result = await cancelPendingSale(cancelOptions(q, { send: async body => { request = body; return { data: q.ack }; } }));
  assert.equal(result.cancelled, true); assert.equal(q.rows().length, 0);
  assert.equal(request.action, 'cancel_pending_sale'); assert.equal(request.owner_pin, pin);
  assert.ok(!JSON.stringify(q.original).includes(pin));
});

test('busy cross-tab lock skips without sending or removing a sale', async () => {
  const q = queue(); let sends = 0;
  const result = await cancelPendingSale(cancelOptions(q, { lock: async () => ({ skipped: true }), send: async () => { sends++; } }));
  assert.equal(result.skipped, true); assert.equal(sends, 0); assert.deepEqual(q.rows(), [q.original]);
});

test('cashier queue replay consumes only a cancellation ACK bound to the saved sale without showing a receipt', async () => {
  const q = queue(); let receipts = 0;
  const result = await syncPendingSales({ userId: 'cashier', storage: q.storage, lock: work => work(),
    send: async () => q.ack, onConfirmed: () => receipts++ });
  assert.equal(result.synced, 0); assert.equal(result.remaining, 0); assert.equal(receipts, 0);
  const bad = queue(); const retained = await syncPendingSales({ userId: 'cashier', storage: bad.storage, lock: work => work(),
    send: async () => ({ ...bad.ack, shop_id: 'different-shop' }) });
  assert.equal(retained.remaining, 1);
});
