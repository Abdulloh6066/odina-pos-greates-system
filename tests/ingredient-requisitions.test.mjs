import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const bundle = buildSync({ entryPoints: ['base44/shared/ingredient-requests.ts'], bundle: true, write: false, format: 'esm', platform: 'node' }).outputFiles[0].text;
const { handleIngredientRequest: handle } = await import('data:text/javascript;base64,' + Buffer.from(bundle).toString('base64'));
const clone = x => x === undefined ? x : structuredClone(x);
function match(row, query) {
  return Object.entries(query).every(([field, value]) => {
    if (field === '$or') return value.some(q => match(row, q));
    if (field === '$and') return value.every(q => match(row, q));
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).every(([op, v]) => {
      if (op === '$exists') return (row[field] !== undefined) === v;
      if (op === '$ne') return row[field] !== v;
      if (op === '$in') return v.includes(row[field]);
      if (op === '$regex') return new RegExp(v, value.$options || '').test(row[field] || '');
      if (op === '$options') return true;
      throw new Error('Unsupported fixture query ' + op);
    });
    return row[field] === value;
  });
}
function fixture() {
  const db = {}, writes = [], faults = []; let sequence = 0;
  const names = ['Shop','Ingredient','IngredientStock','IngredientRequisition','StockMovement','SupplierReceipt','SupplierReceiptItem','CashRecipient','BudgetMovement','CashWithdrawal'];
  const entities = Object.fromEntries(names.map(name => {
    db[name] = [];
    function fault(when, method, data) {
      const index = faults.findIndex(f => f.when === when && f.entity === name && f.method === method && (!f.predicate || f.predicate(data)));
      if (index >= 0) { const f = faults.splice(index, 1)[0]; f.beforeThrow?.(); throw new Error('simulated network failure'); }
    }
    return [name, {
      async get(id) { const row = db[name].find(r => r.id === id); if (!row) throw Object.assign(new Error('404'),{status:404}); return clone(row); },
      async filter(q, sort = 'id', limit = 100, skip = 0) { const rows = db[name].filter(r => match(r,q)); const field=sort.replace(/^-/,''); rows.sort((a,b)=>String(a[field]||'').localeCompare(String(b[field]||''))*(sort.startsWith('-')?-1:1)); return clone(rows.slice(skip,skip+limit)); },
      async create(data) { fault('before','create',data); const row={...clone(data),id:name+'-'+(++sequence)}; db[name].push(row); writes.push({name,method:'create',data:clone(data)}); fault('after','create',data); return clone(row); },
      async updateMany(q, update) { fault('before','updateMany',update); const rows=db[name].filter(r=>match(r,q)); for(const row of rows) Object.assign(row,clone(update.$set)); writes.push({name,method:'updateMany',q:clone(q),data:clone(update),count:rows.length}); fault('after','updateMany',update); return {success:true,updated:rows.length}; }
    }];
  }));
  db.Shop.push({id:'branch',name:'Branch',active:true,location_type:'shop'},{id:'central',name:'Central',active:true,location_type:'production'},{id:'other',name:'Other',active:true,location_type:'shop'});
  db.Ingredient.push({id:'milk',name:'Sut',active:true,base_unit:'ml',purchase_unit:'l',conversion_to_base:1000,category:'food'},{id:'sugar',name:'Shakar',active:true,base_unit:'g',purchase_unit:'kg',conversion_to_base:1000,category:'food'},{id:'cup',name:'Stakan',active:true,base_unit:'piece',purchase_unit:'piece',conversion_to_base:1,category:'packaging'});
  db.CashRecipient.push({id:'vendor',name:'Sut yetkazuvchi',recipient_type:'supplier',active:true});
  const admin={id:'owner',role:'admin',display_name:'Owner'};
  const call=(body,user=admin)=>handle({entities},user,body);
  const create=async(overrides={},user=admin)=> (await call({action:'create',idempotency_key:'create-key-0001',location_id:'branch',source_kind:'purchase',required_date:'2026-10-20',items:[{ingredient_id:'milk',quantity:10},{ingredient_id:'sugar',quantity:5},{ingredient_id:'cup',quantity:100}],...overrides},user)).request;
  const receive=(request,overrides={},user=admin)=>call({action:'receive',request_id:request.id,idempotency_key:'receipt-key-0001',expected_version:request.version,verified:true,supplier_id:'vendor',payment_state:'unpaid',items:[{ingredient_id:'milk',quantity:4,unit_price:18000}],...overrides},user);
  const stock=(id,location='branch')=>db.IngredientStock.find(r=>r.location_id===location&&r.ingredient_id===id)?.quantity||0;
  return {db,writes,faults,call,create,receive,stock,admin};
}

test('saving/replaying and printing a request never changes stock or money',async()=>{
 const f=fixture(); const request=await f.create(); const replay=await f.create();
 assert.equal(request.id,replay.id); assert.equal(f.db.IngredientRequisition.length,1);
 assert.equal(f.db.IngredientStock.length,0); assert.equal(f.db.StockMovement.length,0); assert.equal(f.db.SupplierReceipt.length,0);
 const ticket=readFileSync('src/components/warehouse/IngredientRequisitionTicket.jsx','utf8');
 assert.ok(!ticket.includes('functions.invoke')); assert.ok(ticket.includes('ir-write-cell')); assert.ok(ticket.includes('colSpan={3}'));
 await assert.rejects(f.create({items:[{ingredient_id:'milk',quantity:11}]}),/kaliti/);
});
test('parallel creation has one durable request',async()=>{
 const f=fixture(); const results=await Promise.allSettled([f.create(),f.create()]);
 assert.ok(results.some(r=>r.status==='fulfilled')); assert.equal(f.db.IngredientRequisition.length,1); assert.equal((await f.create()).id,f.db.IngredientRequisition[0].id);
});
test('partial purchase uses base units and one supplier debt, retries have no duplicate effects',async()=>{
 const f=fixture(); const request=await f.create(); const result=await f.receive(request);
 assert.equal(result.request.status,'partial'); assert.equal(result.request.items[0].received_quantity,4); assert.equal(result.request.items[0].remaining_quantity,6);
 assert.equal(f.stock('milk'),4000); assert.equal(f.db.StockMovement.length,1); assert.equal(f.db.SupplierReceipt[0].remaining_debt,72000);
 assert.equal(f.db.SupplierReceiptItem[0].base_quantity,4000); assert.equal(f.db.SupplierReceiptItem[0].line_total,72000);
 assert.equal((await f.receive(request)).already_processed,true); assert.equal(f.stock('milk'),4000); assert.equal(f.db.SupplierReceipt.length,1);
 await assert.rejects(f.receive(request,{items:[{ingredient_id:'milk',quantity:3,unit_price:18000}]}),/kaliti/);
 assert.equal(f.db.BudgetMovement.length,0); assert.equal(f.db.CashWithdrawal.length,0);
});
test('the remaining delivery closes the request and already-paid goods do not withdraw cash',async()=>{
 const f=fixture(); const first=await f.receive(await f.create());
 const second=await f.receive(first.request,{idempotency_key:'receipt-key-0002',payment_state:'paid_external',items:[{ingredient_id:'milk',quantity:6,unit_price:18000},{ingredient_id:'sugar',quantity:5,unit_price:14000},{ingredient_id:'cup',quantity:100,unit_price:1000}]});
 assert.equal(second.request.status,'received'); assert.equal(f.stock('milk'),10000); assert.equal(f.stock('sugar'),5000); assert.equal(f.stock('cup'),100);
 assert.equal(f.db.SupplierReceipt[1].status,'paid'); assert.equal(f.db.SupplierReceipt[1].remaining_debt,0); assert.equal(f.db.SupplierReceipt[1].paid_at_receipt,278000);
 assert.equal(f.db.BudgetMovement.length,0); assert.equal(f.db.CashWithdrawal.length,0);
});
test('lost stock/movement acknowledgements are recovered by durable markers',async()=>{
 const f=fixture(); const request=await f.create();
 f.faults.push({entity:'IngredientStock',method:'create',when:'after'},{entity:'StockMovement',method:'create',when:'after'});
 await f.receive(request); assert.equal(f.stock('milk'),4000); assert.equal(f.db.StockMovement.length,1); assert.equal(f.db.SupplierReceipt.length,1);
});
test('interrupted financial rows resume without repeating stock and preserve intervening sales',async()=>{
 const f=fixture(); const request=await f.create();
 f.faults.push({entity:'SupplierReceiptItem',method:'create',when:'before'});
 await assert.rejects(f.receive(request),e=>e.operation_pending===true);
 assert.equal(f.stock('milk'),4000); assert.equal(f.db.SupplierReceipt[0].status,'receiving'); assert.equal(f.db.SupplierReceipt[0].remaining_debt,0);
 f.db.IngredientStock[0].quantity-=500;
 const pending=(await f.call({action:'get',request_id:request.id})).request; assert.ok(pending.pending_receipt);
 const done=await f.call({action:'resume',request_id:request.id});
 assert.equal(f.stock('milk'),3500); assert.equal(done.request.status,'partial'); assert.equal(done.request.pending_receipt,null);
 assert.equal(f.db.StockMovement.length,1); assert.equal(f.db.SupplierReceiptItem.length,1); assert.equal(f.db.SupplierReceipt[0].remaining_debt,72000);
});
test('lost final acknowledgment and concurrent confirmation apply the batch once',async()=>{
 const f=fixture(); const request=await f.create();
 f.faults.push({entity:'IngredientRequisition',method:'updateMany',when:'after',predicate:u=>Boolean(u.$set.history_json)});
 const results=await Promise.allSettled([f.receive(request),f.receive(request)]);
 assert.ok(results.some(r=>r.status==='fulfilled')); await f.receive(request);
 assert.equal(f.stock('milk'),4000); assert.equal(f.db.StockMovement.length,1); assert.equal(f.db.SupplierReceipt.length,1);
});
test('warehouse approval precedes receiving and transfers conserve goods',async()=>{
 const f=fixture(); f.db.IngredientStock.push({id:'central-stock',ingredient_id:'milk',location_id:'central',quantity:8000,unit:'ml'});
 const request=await f.create({source_kind:'warehouse',source_location_id:'central',items:[{ingredient_id:'milk',quantity:5}]});
 const cashier={id:'cashier',role:'cashier',shop_id:'branch'};
 await assert.rejects(f.receive(request,{},cashier),/tasdiqlashi/);
 await assert.rejects(f.call({action:'approve',request_id:request.id,expected_version:0},{id:'manager',role:'manager',shop_id:'branch'}),/biriktirilgan/);
 const approved=(await f.call({action:'approve',request_id:request.id,expected_version:0},{id:'warehouse',role:'warehouse',shop_id:'central'})).request;
 assert.equal(f.stock('milk','central'),8000);
 const result=await f.receive(approved,{items:[{ingredient_id:'milk',quantity:5}]},cashier);
 assert.equal(result.request.status,'received'); assert.equal(f.stock('milk','central'),3000); assert.equal(f.stock('milk'),5000); assert.equal(f.db.SupplierReceipt.length,0);
 assert.deepEqual(f.db.StockMovement.map(m=>m.quantity_change),[-5000,5000]);
});
test('source shortage is rejected before mutation, interrupted transfers recover forward',async()=>{
 const f=fixture(); f.db.IngredientStock.push({id:'central-stock',ingredient_id:'milk',location_id:'central',quantity:2000,unit:'ml'});
 let request=await f.create({source_kind:'warehouse',source_location_id:'central',items:[{ingredient_id:'milk',quantity:5}]});
 request=(await f.call({action:'approve',request_id:request.id,expected_version:0})).request;
 await assert.rejects(f.receive(request,{items:[{ingredient_id:'milk',quantity:5}]}),/yetarli emas/); assert.equal(f.db.StockMovement.length,0);
 f.db.IngredientStock[0].quantity=6000;
 f.faults.push({entity:'StockMovement',method:'create',when:'before'});
 await assert.rejects(f.receive(request,{items:[{ingredient_id:'milk',quantity:5}]}),e=>e.operation_pending);
 assert.equal(f.stock('milk','central'),1000); assert.equal(f.stock('milk'),0);
 await f.call({action:'resume',request_id:request.id});
 assert.equal(f.stock('milk','central'),1000); assert.equal(f.stock('milk'),5000); assert.equal(f.db.StockMovement.length,2);
});
test('permissions prevent cross-location access and cashier purchase receipts',async()=>{
 const f=fixture(); const request=await f.create();
 const cashier={id:'cashier',role:'cashier',shop_id:'branch'};
 await assert.rejects(f.receive(request,{},cashier),e=>e.status===403);
 await assert.rejects(f.call({action:'get',request_id:request.id},{id:'other-user',role:'manager',shop_id:'other'}),e=>e.status===404);
 await assert.rejects(f.create({location_id:'other',idempotency_key:'another-key-0001'},cashier),e=>e.status===403);
 await f.receive(request);
 const safe=(await f.call({action:'get',request_id:request.id},cashier)).request;
 assert.equal(safe.history[0].total_amount,undefined); assert.equal(safe.history[0].items[0].unit_price,undefined); assert.equal(safe.history_json,undefined); assert.equal(safe.pending_json,undefined);
});
test('invalid quantity, price, verification and versions have no stock effects',async()=>{
 const f=fixture(); const request=await f.create();
 for(const items of [[{ingredient_id:'milk',quantity:11,unit_price:10}],[{ingredient_id:'cup',quantity:1.5,unit_price:10}],[{ingredient_id:'milk',quantity:-1,unit_price:10}],[{ingredient_id:'milk',quantity:1,unit_price:''}],[{ingredient_id:'milk',quantity:1,unit_price:false}],[{ingredient_id:'milk',quantity:1,unit_price:'1e3'}]]) await assert.rejects(f.receive(request,{items}));
 await assert.rejects(f.receive(request,{verified:false})); await assert.rejects(f.receive(request,{expected_version:5}));
 assert.equal(f.db.IngredientStock.length,0); assert.equal(f.db.SupplierReceipt.length,0); assert.equal(f.db.IngredientRequisition[0].pending_json,'');
});
test('cancelled supplier receipts reopen outstanding quantities without replaying old receipts',async()=>{
 const f=fixture(); const request=await f.create({items:[{ingredient_id:'milk',quantity:4}]}); await f.receive(request);
 f.db.SupplierReceipt[0].status='cancelled'; f.db.IngredientStock[0].quantity=0;
 const reopened=(await f.call({action:'get',request_id:request.id})).request;
 assert.equal(reopened.status,'waiting'); assert.equal(reopened.items[0].remaining_quantity,4);
 assert.equal((await f.receive(request)).already_processed,true); assert.equal(f.stock('milk'),0);
 await f.receive(reopened,{idempotency_key:'replacement-key-0001'}); assert.equal(f.stock('milk'),4000); assert.equal(f.db.SupplierReceipt.length,2);
});
