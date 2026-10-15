// Offline only: handlers run against in-memory entities with networking disabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const handler = 'base44/functions/stock-transfer/entry.ts';
const body = { action: 'receive_transfer', transfer_id: 'transfer' };
function fixture({ newStock = false } = {}) {
  const f = memoryBackend({
    User: [{ id: 'cashier', role: 'cashier', active: true, shop_id: 'shop', full_name: 'Kassir' }],
    Shop: [{ id: 'shop', name: 'Do‘kon', active: true, location_type: 'shop' }],
    Product: [{ id: 'product', name: 'Non', active: true, unit: 'piece' }],
    ProductStock: newStock ? [] : [{ id: 'stock', location_id: 'shop', product_id: 'product', quantity: 10, unit: 'piece' }],
    StockTransfer: [{ id: 'transfer', transfer_number: 'TR-1', source_location_id: 'central', source_location_name: 'Markaz',
      destination_location_id: 'shop', destination_location_name: 'Do‘kon', product_id: 'product',
      product_name_snapshot: 'Tarixiy non', unit: 'piece', quantity: 5, status: 'pending' }],
    StockMovement: [], ActionHistory: [],
  });
  f.receive = () => f.invoke(handler, body);
  return f;
}
function failMovementOnce(f, { sale = 0, persist = false } = {}) {
  const create = f.entities.StockMovement.create;
  let failed = false;
  f.entities.StockMovement.create = async data => {
    if (!failed && data.movement_type === 'transfer_in') {
      failed = true;
      if (sale) f.db.ProductStock[0].quantity -= sale;
      if (persist) await create(data);
      throw new Error('Offline movement failure');
    }
    return create(data);
  };
}

test('receipt failure reverses only its quantity after a concurrent sale; retry cannot add twice', async () => {
  const f = fixture();
  failMovementOnce(f, { sale: 2 });
  const failed = await f.receive();
  assert.equal(failed.status, 500);
  assert.equal(f.db.ProductStock[0].quantity, 8);
  assert.equal(f.db.StockTransfer[0].status, 'pending');
  const retry = await f.receive();
  assert.equal(retry.status, 200, JSON.stringify(retry));
  assert.equal(f.db.ProductStock[0].quantity, 13);
  assert.equal(f.db.StockTransfer[0].status, 'received');
  assert.equal(f.db.StockMovement.reduce((sum, row) => sum + row.quantity_change, 0), 5);
  assert.ok(!f.calls.some(([, operation]) => operation === 'delete'));
});

test('new stock survives recovery and a concurrent sale; its row is never deleted', async () => {
  const f = fixture({ newStock: true });
  failMovementOnce(f, { sale: 2 });
  assert.equal((await f.receive()).status, 500);
  const stockId = f.db.ProductStock[0].id;
  assert.equal(f.db.ProductStock[0].quantity, -2);
  assert.equal((await f.receive()).status, 200);
  assert.equal(f.db.ProductStock.length, 1);
  assert.equal(f.db.ProductStock[0].id, stockId);
  assert.equal(f.db.ProductStock[0].quantity, 3);
  assert.ok(!f.calls.some(([, operation]) => operation === 'delete'));
});

test('lost stock delta reply is confirmed by marker and does not reapply quantity', async () => {
  const f = fixture();
  const update = f.entities.ProductStock.updateMany;
  let lost = false;
  f.entities.ProductStock.updateMany = async (query, ops) => {
    const result = await update(query, ops);
    if (!lost && ops.$inc?.quantity === 5) { lost = true; throw new Error('Reply lost'); }
    return result;
  };
  assert.equal((await f.receive()).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 15);
  assert.equal(f.db.StockMovement.length, 1);
});

test('lost initial receipt claim reply is reconciled before adding any quantity', async () => {
  const f = fixture();
  const update = f.entities.StockTransfer.updateMany;
  let lost = false;
  f.entities.StockTransfer.updateMany = async (query, ops) => {
    const result = await update(query, ops);
    if (!lost && ops.$set?.status === 'receiving') { lost = true; throw new Error('Claim reply lost'); }
    return result;
  };
  assert.equal((await f.receive()).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 15);
  assert.equal(f.db.StockMovement.length, 1);
});

test('lost new-stock create reply resolves the operation-owned row', async () => {
  const f = fixture({ newStock: true });
  const create = f.entities.ProductStock.create;
  f.entities.ProductStock.create = async data => { await create(data); throw new Error('Reply lost'); };
  assert.equal((await f.receive()).status, 200);
  assert.equal(f.db.ProductStock.length, 1);
  assert.equal(f.db.ProductStock[0].quantity, 5);
});

test('lost movement and completion replies preserve the completed transfer', async () => {
  const f = fixture();
  failMovementOnce(f, { persist: true });
  const update = f.entities.StockTransfer.updateMany;
  f.entities.StockTransfer.updateMany = async (query, ops) => {
    const result = await update(query, ops);
    if (ops.$set?.status === 'received') throw new Error('Completion reply lost');
    return result;
  };
  assert.equal((await f.receive()).status, 200);
  assert.equal(f.db.StockTransfer[0].status, 'received');
  assert.equal(f.db.ProductStock[0].quantity, 15);
  assert.equal(f.db.StockMovement.length, 1);
  assert.equal((await f.receive()).status, 409);
  assert.equal(f.db.ProductStock[0].quantity, 15);
});

test('failed reversal stays receiving; persistent recovery resumes before retrying receipt', async () => {
  const f = fixture();
  failMovementOnce(f, { sale: 2 });
  const update = f.entities.ProductStock.updateMany;
  let blocked = true;
  f.entities.ProductStock.updateMany = async (query, ops) => {
    if (blocked && ops.$inc?.quantity === -5) return { success: true, updated: 0 };
    return update(query, ops);
  };
  assert.equal((await f.receive()).status, 500);
  assert.equal(f.db.StockTransfer[0].status, 'receiving');
  assert.equal(f.db.StockTransfer[0].receipt_phase, 'recovering');
  assert.equal(f.db.ProductStock[0].quantity, 13);
  blocked = false;
  assert.equal((await f.receive()).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 13);
  assert.equal(f.db.StockTransfer[0].status, 'received');
});

test('lost reversal reply is confirmed once and preserves a concurrent sale', async () => {
  const f = fixture();
  failMovementOnce(f, { sale: 2 });
  const update = f.entities.ProductStock.updateMany;
  f.entities.ProductStock.updateMany = async (query, ops) => {
    const result = await update(query, ops);
    if (ops.$inc?.quantity === -5) throw new Error('Reversal reply lost');
    return result;
  };
  assert.equal((await f.receive()).status, 500);
  assert.equal(f.db.ProductStock[0].quantity, 8);
  assert.equal((await f.receive()).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 13);
});

test('recovery movement failure stays receiving until the immutable reversal is saved', async () => {
  const f = fixture();
  failMovementOnce(f, { sale: 2 });
  const create = f.entities.StockMovement.create;
  let blocked = true;
  f.entities.StockMovement.create = async data => {
    if (blocked && data.movement_type === 'adjustment') throw new Error('Recovery movement unavailable');
    return create(data);
  };
  assert.equal((await f.receive()).status, 500);
  assert.equal(f.db.StockTransfer[0].status, 'receiving');
  assert.equal(f.db.ProductStock[0].quantity, 8);
  blocked = false;
  assert.equal((await f.receive()).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 13);
  assert.equal(f.db.StockMovement.reduce((sum, row) => sum + row.quantity_change, 0), 5);
  assert.equal(f.db.StockMovement.filter(row => row.movement_type === 'adjustment').length, 1);
});

test('concurrent devices cannot both claim the same receipt', async () => {
  const f = fixture();
  const results = await Promise.all([f.receive(), f.receive()]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(f.db.ProductStock[0].quantity, 15);
  assert.equal(f.db.StockMovement.length, 1);
});

test('an active or legacy receiving operation cannot be taken over by another device', async () => {
  for (const metadata of [{}, { receipt_token: 'active-op', receipt_phase: 'applying', receipt_claim_token: 'active-device' }]) {
    const f = fixture();
    Object.assign(f.db.StockTransfer[0], { status: 'receiving', ...metadata });
    const before = structuredClone(f.db.ProductStock);
    assert.equal((await f.receive()).status, 409);
    assert.deepEqual(f.db.ProductStock, before);
    assert.equal(f.db.StockMovement.length, 0);
  }
});

test('partial completion keeps all stock intact and never resets a committed batch line', async () => {
  const f = fixture();
  Object.assign(f.db.StockTransfer[0], { batch_id: 'batch', batch_item_count: 2, line_number: 1 });
  f.db.StockTransfer.push({ ...structuredClone(f.db.StockTransfer[0]), id: 'second-transfer', product_id: 'second', line_number: 2 });
  f.db.Product.push({ id: 'second', name: 'Ikkinchi non', active: true });
  f.db.ProductStock.push({ id: 'second-stock', location_id: 'shop', product_id: 'second', quantity: 20, unit: 'piece' });
  const update = f.entities.StockTransfer.updateMany;
  f.entities.StockTransfer.updateMany = async (query, ops) => {
    if (ops.$set?.status === 'received') return update({ ...query, id: 'transfer' }, ops);
    return update(query, ops);
  };
  assert.equal((await f.receive()).status, 500);
  assert.equal(f.db.StockTransfer[0].status, 'received');
  assert.equal(f.db.StockTransfer[1].status, 'receiving');
  assert.equal(f.db.ProductStock[0].quantity, 15);
  assert.equal(f.db.ProductStock[1].quantity, 25);
  assert.equal((await f.receive()).status, 409);
  assert.equal(f.db.ProductStock[0].quantity, 15);
  assert.equal(f.db.ProductStock[1].quantity, 25);
  assert.ok(!f.calls.some(([, operation]) => operation === 'delete'));
});

test('concurrent new-stock creation never deletes another operation or exposes a duplicate receipt retry', async () => {
  const f = fixture({ newStock: true });
  const create = f.entities.ProductStock.create;
  f.entities.ProductStock.create = async data => {
    const mine = await create(data);
    f.db.ProductStock.push({ id: 'other-operation-stock', location_id: 'shop', product_id: 'product',
      quantity: 7, unit: 'piece', transfer_receipts_applied: ['other-operation'] });
    return mine;
  };
  assert.equal((await f.receive()).status, 500);
  assert.equal(f.db.StockTransfer[0].status, 'receiving');
  assert.equal(f.db.ProductStock.find(row => row.id === 'other-operation-stock').quantity, 7);
  assert.ok(!f.calls.some(([, operation]) => operation === 'delete'));
  assert.equal((await f.receive()).status, 500);
  assert.equal(f.db.ProductStock.reduce((sum, row) => sum + row.quantity, 0), 12);
});
