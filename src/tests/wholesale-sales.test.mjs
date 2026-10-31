import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from '../../tests/helpers/memory-backend.mjs';
const endpoint = 'base44/functions/wholesaleSales/entry.ts';
const seed = () => ({
  User: [{ id: 'owner', role: 'admin', active: true }],
  Shop: [{ id: 'factory', name: 'Factory', location_type: 'production', active: true }, { id: 'branch', name: 'Branch', location_type: 'shop', active: true }],
  Product: [{ id: 'cake', name: 'Cake', source_type: 'central_produced', production_unit: 'sheet', sheet_price: 200000, price: 15000, pieces_per_sheet: 20, active: true }],
  ProductStock: [{ id: 'stock', location_id: 'factory', product_id: 'cake', unit: 'sheet', quantity: 10 }],
});
const prepare = async (f, extra = {}) => {
  const response = await f.invoke(endpoint, { action: 'prepare', source_id: 'factory', product_id: 'cake', buyer_type: 'external', buyer_name: 'Outside shop', quantity: 0.5, payment_method: 'cash', ...extra });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.sale;
};
const confirm = (f, sale) => f.invoke(endpoint, { action: 'confirm', sale_id: sale.id });

test('list price, not piece price or caller totals; preparing does not sell', async () => {
  const f = memoryBackend(seed());
  const sale = await prepare(f, { unit_price: 1, total: 1 });
  assert.equal(sale.unit_price, 200000); assert.equal(sale.total, 100000);
  assert.equal(f.db.ProductStock[0].quantity, 10);
  assert.equal(sale.status, 'draft');
});
test('external sale decreases half a list once and has no branch transfer', async () => {
  const f = memoryBackend(seed()), sale = await prepare(f);
  assert.equal((await confirm(f, sale)).status, 200);
  assert.equal((await confirm(f, sale)).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 9.5);
  assert.equal(f.db.StockMovement.length, 1);
  assert.equal(f.db.StockTransfer?.length || 0, 0);
  assert.equal(f.db.Sale?.length || 0, 0);
  assert.equal(f.db.WholesaleSale[0].status, 'completed');
});
test('Odina branch sale creates one receivable transfer with frozen conversion', async () => {
  const f = memoryBackend(seed()), sale = await prepare(f, { buyer_type: 'branch', buyer_id: 'branch' });
  assert.equal((await confirm(f, sale)).status, 200);
  await confirm(f, sale);
  assert.equal(f.db.StockTransfer.length, 1);
  assert.equal(f.db.StockTransfer[0].quantity, 0.5);
  assert.equal(f.db.StockTransfer[0].received_quantity, 10);
  assert.equal(f.db.StockTransfer[0].status, 'pending');
  assert.equal(f.db.ProductStock[0].quantity, 9.5);
});
test('branch receives wholesale sheets through existing transfer flow exactly once', async () => {
  const f = memoryBackend(seed()), sale = await prepare(f, { buyer_type: 'branch', buyer_id: 'branch' });
  await confirm(f, sale);
  const result = await f.invoke('base44/functions/stock-transfer/entry.ts', { action: 'receive_transfer_batch', batch_id: `wholesale-${sale.id}` });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(f.db.ProductStock.find(s => s.location_id === 'branch').quantity, 10);
  assert.equal(f.db.ProductStock.find(s => s.location_id === 'factory').quantity, 9.5);
  await f.invoke('base44/functions/stock-transfer/entry.ts', { action: 'receive_transfer_batch', batch_id: `wholesale-${sale.id}` });
  assert.equal(f.db.ProductStock.find(s => s.location_id === 'branch').quantity, 10);
});

test('piece-stock sale freezes piece deduction and receives branch pieces once', async () => {
  const data = seed();
  Object.assign(data.Product[0], { production_unit: 'piece', pieces_per_sheet: 12, sheet_price: 384000 });
  Object.assign(data.ProductStock[0], { unit: 'piece', quantity: 24 });
  const f = memoryBackend(data), sale = await prepare(f, { buyer_type: 'branch', buyer_id: 'branch' });
  assert.equal(sale.total, 192000);
  assert.equal(sale.stock_quantity, 6);
  assert.equal(sale.stock_unit, 'piece');
  f.db.Product[0].pieces_per_sheet = 20;
  assert.equal((await confirm(f, sale)).status, 200);
  assert.equal((await confirm(f, sale)).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 18);
  assert.equal(f.db.StockMovement[0].unit, 'piece');
  assert.equal(f.db.StockMovement[0].quantity_change, -6);
  const result = await f.invoke('base44/functions/stock-transfer/entry.ts', { action: 'receive_transfer_batch', batch_id: `wholesale-${sale.id}` });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(f.db.ProductStock.find(s => s.location_id === 'branch').quantity, 6);
  assert.equal(f.db.ProductStock.find(s => s.location_id === 'factory').quantity, 18);
});

test('concurrent confirmations cannot double-sell', async () => {
  const f = memoryBackend(seed()), sale = await prepare(f);
  const results = await Promise.all([confirm(f, sale), confirm(f, sale)]);
  assert.ok(results.some(r => r.status === 200));
  assert.equal(f.db.ProductStock[0].quantity, 9.5);
  assert.equal(f.db.StockMovement.length, 1);
});
test('lost stock-write response resumes with same stock marker', async () => {
  const f = memoryBackend(seed()), sale = await prepare(f);
  const update = f.entities.ProductStock.updateMany;
  f.entities.ProductStock.updateMany = async (...args) => { await update(...args); throw Error('Lost reply'); };
  assert.equal((await confirm(f, sale)).status, 500);
  assert.equal(f.db.ProductStock[0].quantity, 9.5);
  assert.equal((await confirm(f, sale)).status, 409);
  f.entities.ProductStock.updateMany = update;
  f.db.WholesaleSale[0].lock_until = '2000-01-01T00:00:00Z';
  assert.equal((await confirm(f, sale)).status, 200);
  assert.equal(f.db.ProductStock[0].quantity, 9.5);
});
test('lost transfer response resumes without a duplicate or another deduction', async () => {
  const f = memoryBackend(seed()), sale = await prepare(f, { buyer_type: 'branch', buyer_id: 'branch' });
  const create = f.entities.StockTransfer.create;
  f.entities.StockTransfer.create = async data => { await create(data); throw Error('Lost reply'); };
  assert.equal((await confirm(f, sale)).status, 500);
  f.entities.StockTransfer.create = create;
  f.db.WholesaleSale[0].lock_until = '2000-01-01T00:00:00Z';
  assert.equal((await confirm(f, sale)).status, 200);
  assert.equal(f.db.StockTransfer.length, 1); assert.equal(f.db.StockMovement.length, 1);
  assert.equal(f.db.ProductStock[0].quantity, 9.5);
});
test('draft cancellation never changes inventory', async () => {
  const f = memoryBackend(seed()), sale = await prepare(f);
  assert.equal((await f.invoke(endpoint, { action: 'cancel', sale_id: sale.id })).status, 200);
  assert.equal((await confirm(f, sale)).status, 409);
  assert.equal(f.db.ProductStock[0].quantity, 10);
});
test('price and quantity validation fails before any write', async () => {
  for (const changes of [{ quantity: 0.25 }, { quantity: -1 }, { quantity: 10001 }]) {
    const f = memoryBackend(seed());
    const r = await f.invoke(endpoint, { action: 'prepare', source_id: 'factory', product_id: 'cake', buyer_type: 'external', buyer_name: 'Shop', payment_method: 'cash', ...changes });
    assert.equal(r.status, 400); assert.equal(f.calls.length, 0);
  }
  const data = seed(); delete data.Product[0].sheet_price;
  const f = memoryBackend(data);
  const r = await f.invoke(endpoint, { action: 'prepare', source_id: 'factory', product_id: 'cake', quantity: 1, buyer_type: 'external', buyer_name: 'Shop', payment_method: 'cash' });
  assert.equal(r.status, 400); assert.equal(f.calls.length, 0);
});
test('cashier cannot sell and production staff cannot choose another source', async () => {
  for (const actor of [{ role: 'cashier', shop_id: 'factory' }, { role: 'production', shop_id: 'other' }]) {
    const data = seed(); Object.assign(data.User[0], actor);
    const f = memoryBackend(data);
    const r = await f.invoke(endpoint, { action: 'prepare', source_id: 'factory' });
    assert.equal(r.status, 403); assert.equal(f.calls.length, 0);
  }
});
test('insufficient stock prevents confirmation with no deduction', async () => {
  const f = memoryBackend(seed()), sale = await prepare(f);
  f.db.ProductStock[0].quantity = 0;
  assert.equal((await confirm(f, sale)).status, 409);
  assert.equal(f.db.WholesaleSale[0].status, 'draft');
});