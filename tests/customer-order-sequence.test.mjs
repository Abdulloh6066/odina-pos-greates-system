import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateCustomerOrderSequence } from '../base44/shared/customer-order-sequence.js';
import { displayOrderNumber } from '../src/lib/orders.js';

function fixture(last = 0) {
  const row = { id: 'settings', customer_order_last_number: last };
  const Settings = {
    list: async () => [structuredClone(row)],
    updateMany: async (query, update) => {
      if (query.id !== row.id || query.customer_order_last_number !== row.customer_order_last_number)
        return { success: true, updated: 0, has_more: false };
      Object.assign(row, update.$set);
      return { success: true, updated: 1, has_more: false };
    },
  };
  return { row, Settings, service: { entities: { Settings } } };
}

test('concurrent orders reserve distinct permanent numbers from the same persisted counter', async () => {
  const f = fixture();
  const numbers = await Promise.all(Array.from({ length: 16 }, () => allocateCustomerOrderSequence(f.service)));
  assert.deepEqual(numbers.sort((a,b) => a-b), Array.from({ length: 16 }, (_,i) => i+1));
  assert.equal(f.row.customer_order_last_number, 16);
  const otherWorker = { entities: { Settings: f.Settings } };
  assert.equal(await allocateCustomerOrderSequence(otherWorker), 17);
});

test('numbering continues through 1000 and unrelated settings updates', async () => {
  const f = fixture(999);
  assert.equal(await allocateCustomerOrderSequence(f.service), 1000);
  f.row.shop_name = 'Updated label';
  assert.equal(await allocateCustomerOrderSequence(f.service), 1001);
});

test('an uncertain counter write consumes its number without reusing it', async () => {
  const f = fixture();
  const original = f.Settings.updateMany;
  f.Settings.updateMany = async (...args) => { await original(...args); throw new Error('reply lost'); };
  await assert.rejects(allocateCustomerOrderSequence(f.service), /reply lost/);
  f.Settings.updateMany = original;
  assert.equal(await allocateCustomerOrderSequence(f.service), 2);
});

test('missing, duplicate, invalid or exhausted settings never guess a number', async () => {
  for (const last of [undefined, null, -1, 0.5, '3', Number.MAX_SAFE_INTEGER])
    await assert.rejects(allocateCustomerOrderSequence(fixture(last).service));
  for (const rows of [[], [{id:'a',customer_order_last_number:0},{id:'b',customer_order_last_number:0}]])
    await assert.rejects(allocateCustomerOrderSequence({entities:{Settings:{list:async()=>rows}}}));
});

test('persistent contention or an untrusted update result fails safely', async () => {
  for (const result of [{success:true,updated:0}, {success:false,updated:0}, {success:true,updated:2}, {success:true,updated:1,has_more:true}]) {
    const f=fixture(); f.Settings.updateMany=async()=>result;
    await assert.rejects(allocateCustomerOrderSequence(f.service));
  }
});

test('display numbers are stable independently of date, sorting, scope and technical snapshots', () => {
  const orders=[{order_sequence:3,order_number:'BO-OLD-3',required_date:'2026-10-07'},
    {order_sequence:1,order_number:'BO-OLD-1',required_date:'2026-10-08'}];
  const snapshot=structuredClone(orders);
  assert.deepEqual(orders.map(displayOrderNumber), ['3','1']);
  assert.deepEqual([...orders].reverse().map(displayOrderNumber), ['1','3']);
  assert.deepEqual(orders,snapshot);
  assert.equal(displayOrderNumber({order_sequence:1000,order_number:'BO-LONG'}),'1000');
  assert.equal(displayOrderNumber({order_number:'BO-HISTORICAL'}),'BO-HISTORICAL');
});
