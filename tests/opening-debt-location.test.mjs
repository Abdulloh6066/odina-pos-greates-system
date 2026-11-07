// Offline fixtures only. No production identities or balances.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
const file = 'base44/functions/supplier-ledger/entry.ts';
const original = { id: 'debt', supplier_id: 'supplier', supplier_name_snapshot: 'Mock supplier', debt_amount: 5000,
  remaining_debt: 4000, effective_date: '2020-01-02', status: 'partial', idempotency_key: 'original-key',
  request_fingerprint: 'original-fingerprint', payment_operations_json: '{"saved":true}', created_at: '2020-01-02T00:00:00Z' };
const make = () => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Mock owner', shop_id: 'warehouse' }],
  Shop: [{ id: 'warehouse', name: 'Mock warehouse', active: true, location_type: 'production' }, { id: 'other', name: 'Mock other', active: true }],
  CashRecipient: [{ id: 'supplier', name: 'Mock supplier', active: true, supplier_location_ids: ['warehouse', 'other'] }],
  SupplierOpeningDebt: [structuredClone(original)], SupplierReceipt: [], SupplierPayment: [],
});
const assign = (f, changes={}) => f.invoke(file, { action: 'assign_opening_debt_location', opening_debt_id: 'debt',
  location_id: 'warehouse', idempotency_key: 'assignment-request-1', ...changes });
const list = (f, changes={}) => f.invoke(file, { action: 'list_opening_debts', ...changes });

test('one-time assignment preserves immutable money/date/history and records actor atomically', async () => {
  const f=make(); const result=await assign(f); assert.equal(result.status,200); assert.equal(result.data.already_processed,false);
  const row=f.db.SupplierOpeningDebt[0]; for(const [key,value] of Object.entries(original)) assert.deepEqual(row[key],value,key);
  assert.equal(row.location_id,'warehouse'); assert.equal(row.location_name_snapshot,'Mock warehouse');
  assert.equal(row.location_assigned_by_id,'owner'); assert.equal(row.location_assigned_by_name,'Mock owner');
  assert.equal(row.location_assignment_key,'assignment-request-1'); assert.ok(Date.parse(row.location_assigned_at));
  assert.equal(result.data.opening_debt.request_fingerprint,undefined); assert.equal(result.data.opening_debt.payment_operations_json,undefined);
  assert.equal(f.calls.length,1); assert.deepEqual(f.calls[0].slice(0,2),['SupplierOpeningDebt','updateMany']);
  assert.equal(f.db.SupplierOpeningDebt.length,1); assert.equal(f.db.SupplierReceipt.length,0); assert.equal(f.db.SupplierPayment.length,0);
});

test('same location retries never rewrite original audit; conflicting reassignment rejected', async () => {
  const f=make(); await assign(f); const row=structuredClone(f.db.SupplierOpeningDebt[0]);
  assert.equal((await assign(f)).data.already_processed,true);
  assert.equal((await assign(f,{idempotency_key:'another-request'})).data.already_processed,true);
  assert.equal((await assign(f,{location_id:'other'})).status,409);
  assert.deepEqual(f.db.SupplierOpeningDebt[0],row); assert.equal(f.calls.length,1);
});

test('nonadmins and inactive admin cannot assign or list scoped debt', async () => {
  for(const role of ['manager','cashier','warehouse','accountant','production','admin']) {
    const f=make(); f.db.User[0].role=role; if(role==='admin') f.db.User[0].active=false;
    assert.equal((await assign(f)).status,403); assert.equal((await list(f,{location_id:'warehouse'})).status,403); assert.equal(f.calls.length,0);
  }
});

test('bad location, missing debt and recipient membership reject before writes', async () => {
  for(const change of [{location_id:''},{location_id:12},{opening_debt_id:''},{idempotency_key:''}]) {
    const f=make(); assert.equal((await assign(f,change)).status,400); assert.equal(f.calls.length,0);
  }
  for(const prepare of [f=>f.db.Shop[0].active=false,f=>f.db.Shop.splice(0,1)]) {
    const f=make(); prepare(f); assert.equal((await assign(f)).status,404); assert.equal(f.calls.length,0);
  }
  const f=make(); f.db.CashRecipient[0].supplier_location_ids=['other']; assert.equal((await assign(f)).status,400); assert.equal(f.calls.length,0);
  const missing=make(); missing.db.SupplierOpeningDebt=[]; assert.equal((await assign(missing)).status,404);
});

test('lost update reply reconciles committed location without duplicate mutation', async () => {
  const f=make(),update=f.entities.SupplierOpeningDebt.updateMany;
  f.entities.SupplierOpeningDebt.updateMany=async(...args)=>{await update(...args);throw Error('lost response');};
  assert.equal((await assign(f)).status,200); assert.equal((await assign(f)).status,200); assert.equal(f.calls.length,1);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,4000);
});

test('unknown update with absent result stays pending, retry is safe conditional assignment', async () => {
  const f=make(),update=f.entities.SupplierOpeningDebt.updateMany;
  f.entities.SupplierOpeningDebt.updateMany=async()=>{throw Error('unknown result');};
  const result=await assign(f); assert.equal(result.status,503); assert.equal(result.data.operation_pending,true);
  assert.equal(f.db.SupplierOpeningDebt[0].location_id,undefined);
  f.entities.SupplierOpeningDebt.updateMany=update; assert.equal((await assign(f)).status,200); assert.equal(f.calls.length,1);
});

test('concurrent different targets allow exactly one assignment, same target reconciles', async () => {
  for(const other of [false,true]) {
    const f=make(); const results=await Promise.all([assign(f),assign(f,{location_id:other?'other':'warehouse',idempotency_key:'second-request'})]);
    assert.ok(results.some(r=>r.status===200)); if(other) assert.ok(results.some(r=>r.status===409));
    const successfulWrites=f.calls.filter(c=>c[0]==='SupplierOpeningDebt'); assert.ok(successfulWrites.length<=2);
    assert.equal(f.db.SupplierOpeningDebt.length,1); assert.equal(f.db.SupplierOpeningDebt[0].debt_amount,5000);
    const location=f.db.SupplierOpeningDebt[0].location_id; assert.ok(['warehouse','other'].includes(location));
    assert.equal((await assign(f,{location_id:location})).data.already_processed,true);
  }
});

test('scoped ledger contains only assigned location debts and their matching payments; global totals unchanged', async () => {
  const f=make(); await assign(f);
  f.db.SupplierOpeningDebt.push({...original,id:'other-debt',location_id:'other'}, {...original,id:'unallocated'});
  f.db.SupplierPayment=[
    {id:'ours',opening_debt_id:'debt',debt_type:'opening',payment_source:'budget',amount:1000},
    {id:'theirs',opening_debt_id:'other-debt',debt_type:'opening',payment_source:'budget',amount:1000},
    {id:'unallocated-pay',opening_debt_id:'unallocated',debt_type:'opening',payment_source:'budget',amount:1000},
    {id:'orphan',opening_debt_id:'missing',debt_type:'opening',payment_source:'budget',amount:1000},
  ];
  const scoped=await list(f,{location_id:'warehouse'}); assert.deepEqual(scoped.data.opening_debts.map(r=>r.id),['debt']);
  assert.deepEqual(scoped.data.payments.map(r=>r.id),['ours']);
  const global=await list(f); assert.equal(global.data.opening_debts.length,3);
  assert.equal(global.data.opening_debts.reduce((sum,r)=>sum+r.remaining_debt,0),12000); assert.equal(global.data.payments.length,3);
  assert.equal((await list(f,{location_id:'missing'})).data.opening_debts.length,0);
  assert.equal((await list(f,{location_id:{}})).status,400);
});

test('failed readback after committed assignment reports pending and later reconciles original audit', async () => {
  const f=make(),get=f.entities.SupplierOpeningDebt.get; let reads=0;
  f.entities.SupplierOpeningDebt.get=async(...args)=>{ reads++; if(reads===2) throw Error('readback unavailable'); return get(...args); };
  const result=await assign(f); assert.equal(result.status,503); assert.equal(result.data.operation_pending,true);
  const saved=structuredClone(f.db.SupplierOpeningDebt[0]); assert.equal(saved.location_id,'warehouse');
  assert.equal((await assign(f)).data.already_processed,true); assert.deepEqual(f.db.SupplierOpeningDebt[0],saved); assert.equal(f.calls.length,1);
});

test('assignment supports legacy empty or null attribution without altering a settled balance', async () => {
  for(const empty of ['',null]) {
    const f=make(); f.db.SupplierOpeningDebt[0].location_id=empty; f.db.SupplierOpeningDebt[0].remaining_debt=0; f.db.SupplierOpeningDebt[0].status='paid';
    assert.equal((await assign(f)).status,200); assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,0); assert.equal(f.db.SupplierOpeningDebt[0].status,'paid');
  }
});
