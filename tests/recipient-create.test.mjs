// Offline mock fixtures only. No production identities or amounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';
const file='base44/functions/supplier-ledger/entry.ts';
const make=()=>memoryBackend({User:[{id:'owner',role:'admin',active:true,full_name:'Mock owner'}],Settings:[{id:'settings'}],
 Shop:[{id:'warehouse',name:'Mock warehouse',active:true,location_type:'production'},{id:'shop',name:'Mock shop',active:true,location_type:'shop'}],
 CashRecipient:[],RecipientCreationRequest:[],SupplierOpeningDebt:[],SupplierReceipt:[],SupplierPayment:[]});
const body=(changes={})=>({action:'create_recipient',recipient:{name:'Mock supplier',recipient_type:'company',notes:'Ordinary note',active:true,supplier_location_ids:['warehouse']},
 opening_debt:{amount:1234,effective_date:'2026-01-02',location_id:'warehouse'},idempotency_key:'recipient-request-1',...changes});
const create=(f,changes)=>f.invoke(file,body(changes));
const counts=f=>[f.db.CashRecipient.length,f.db.SupplierOpeningDebt.length];

test('new recipient plus allocated opening balance saves once with no cash, purchase or stock writes',async()=>{
 const f=make();const r=await create(f);assert.equal(r.status,200);assert.equal(r.data.recipient.name,'Mock supplier');
 assert.equal(r.data.opening_debt.debt_amount,1234);assert.equal(r.data.opening_debt.location_id,'warehouse');assert.deepEqual(counts(f),[1,1]);
assert.equal(f.db.RecipientCreationRequest[0].completed,true);
 assert.ok(f.calls.every(c=>['Settings','RecipientCreationRequest','CashRecipient','SupplierOpeningDebt'].includes(c[0])));
 const exposed=JSON.stringify([f.db.Settings,f.db.CashRecipient]);assert.doesNotMatch(exposed,/1234|2026-01-02|request_fingerprint/);
 const before=structuredClone(f.db);const again=await create(f);assert.equal(again.status,200);assert.equal(again.data.already_processed,true);assert.deepEqual(counts(f),[1,1]);
 assert.deepEqual(f.db.CashRecipient,before.CashRecipient);assert.deepEqual(f.db.SupplierOpeningDebt,before.SupplierOpeningDebt);
});

test('no-debt path retains existing recipient fields and creates no balance',async()=>{
 const f=make();const r=await create(f,{opening_debt:null});assert.equal(r.status,200);assert.equal(r.data.opening_debt,null);assert.deepEqual(counts(f),[1,0]);
 assert.equal((await create(f,{opening_debt:null})).data.already_processed,true);assert.deepEqual(counts(f),[1,0]);
 const inactive=make();const input=body();input.recipient.active=false;input.recipient.supplier_location_ids=[];input.opening_debt=null;
 assert.equal((await inactive.invoke(file,input)).status,200);
});

test('prevalidation rejects permissions, malformed debt and unassigned/inactive/nonwarehouse locations without writes',async()=>{
 for(const role of ['manager','warehouse','accountant','cashier']){const f=make();f.db.User[0].role=role;assert.equal((await create(f)).status,403);assert.equal(f.calls.length,0);}
 for(const debt of [false,[],{}, {amount:0,effective_date:'2026-01-02',location_id:'warehouse'}, {amount:1.5,effective_date:'2026-01-02',location_id:'warehouse'},
 {amount:1,effective_date:'2026-02-30',location_id:'warehouse'}, {amount:1,effective_date:'2026-01-02',location_id:'shop'}]){
 const f=make();assert.equal((await create(f,{opening_debt:debt})).status,400);assert.equal(f.calls.length,0);}
 for(const property of ['active']){const f=make();f.db.Shop[0][property]=property==='active'?false:'shop';assert.equal((await create(f)).status,400);assert.equal(f.calls.length,0);}
});

test('same key cannot alter recipient or opening intent after completion',async()=>{
 const f=make();await create(f);
 for(const change of [{opening_debt:null},{opening_debt:{amount:2222,effective_date:'2026-01-02',location_id:'warehouse'}},{recipient:{...body().recipient,name:'Changed'}}]){
 const r=await create(f,change);assert.equal(r.status,409);assert.equal(r.data.operation_pending,true);}
 assert.deepEqual(counts(f),[1,1]);
});

test('concurrent identical requests produce one recipient and one debt',async()=>{
 const f=make();await Promise.all([create(f),create(f)]);assert.equal((await create(f)).status,200);assert.deepEqual(counts(f),[1,1]);
});

test('lost recipient response reconciles opaque saved recipient; no duplicate',async()=>{
 const f=make(),save=f.entities.CashRecipient.create;f.entities.CashRecipient.create=async data=>{await save(data);throw Error('lost response');};
 assert.equal((await create(f)).status,200);assert.equal((await create(f)).status,200);assert.deepEqual(counts(f),[1,1]);
});

test('uncertain recipient create with no visible record never replays the same token',async()=>{
 const f=make();let attempts=0;f.entities.CashRecipient.create=async()=>{attempts++;throw Error('unknown response');};
 for(const changes of [{},{}]){const r=await create(f,changes);assert.equal(r.data.operation_pending,true);}
 assert.equal(attempts,1);assert.deepEqual(counts(f),[0,0]);
});

test('lost request journal response reconciles; absent journal fails closed',async()=>{
 for(const saved of [false,true]){const f=make(),write=f.entities.RecipientCreationRequest.create;let attempts=0;
 f.entities.RecipientCreationRequest.create=async data=>{attempts++;if(saved)await write(data);throw Error('lost request response');};
 const r=await create(f);assert.equal(r.status,saved?200:503);await create(f);assert.equal(attempts,1);assert.deepEqual(counts(f),saved?[1,1]:[0,0]);}
});

test('debt rejection after recipient save remains pending and retries same recipient and frozen debt',async()=>{
 const f=make(),write=f.entities.SupplierOpeningDebt.create;let rejected=false;
 f.entities.SupplierOpeningDebt.create=async data=>{if(!rejected){rejected=true;throw Object.assign(Error('definite mock rejection'),{status:422});}return write(data);};
 const r=await create(f);assert.equal(r.data.operation_pending,true);assert.equal(r.data.request_not_started,false);assert.deepEqual(counts(f),[1,0]);
 assert.equal((await create(f)).status,200);assert.deepEqual(counts(f),[1,1]);
});

test('assignment failure after saved debt resumes same debt without duplicates',async()=>{
 const f=make(),update=f.entities.SupplierOpeningDebt.updateMany;let failed=false;
 f.entities.SupplierOpeningDebt.updateMany=async(q,ops)=>{if(ops.$set?.location_id&&!failed){failed=true;throw Error('mock assignment failure');}return update(q,ops);};
 assert.equal((await create(f)).data.operation_pending,true);assert.deepEqual(counts(f),[1,1]);
 assert.equal((await create(f)).status,200);assert.deepEqual(counts(f),[1,1]);assert.equal(f.db.SupplierOpeningDebt[0].location_id,'warehouse');
});

test('unknown recipient-stage CAS never authorizes a blind recipient create',async()=>{
 const f=make(),update=f.entities.RecipientCreationRequest.updateMany;
 f.entities.RecipientCreationRequest.updateMany=async(q,ops)=>{if(ops.$set?.recipient_state){await update(q,ops);throw Error('lost CAS reply');}return update(q,ops);};
 assert.equal((await create(f)).data.operation_pending,true);assert.equal((await create(f)).data.operation_pending,true);assert.deepEqual(counts(f),[0,0]);
});

test('new journal is owner-read/backend-write only',()=>{
 const schema=JSON.parse(readFileSync('base44/entities/RecipientCreationRequest.jsonc','utf8'));
 assert.deepEqual(schema.rls,{read:{user_condition:{role:'admin'}},create:false,update:false,delete:false});
});

test('ambiguous initial claim or journal does not block an independent new request',async()=>{
 for(const stage of ['claim','journal']){
 const f=make();let failed=false;
 if(stage==='claim'){const update=f.entities.Settings.updateMany;f.entities.Settings.updateMany=async(...args)=>{const r=await update(...args);if(!failed){failed=true;throw Error('lost claim reply');}return r;};}
 else {const write=f.entities.RecipientCreationRequest.create;f.entities.RecipientCreationRequest.create=async data=>{if(!failed){failed=true;throw Error('unknown journal write');}return write(data);};}
 assert.equal((await create(f)).data.operation_pending,true);assert.equal((await create(f)).data.operation_pending,true);
 const separate=await create(f,{idempotency_key:'independent-request',recipient:{...body().recipient,name:'Another mock supplier'}});
 assert.equal(separate.status,200);assert.deepEqual(counts(f),[1,1]);assert.equal(f.db.CashRecipient[0].name,'Another mock supplier');
 assert.equal((await create(f)).data.operation_pending,true);assert.deepEqual(counts(f),[1,1]);
 }
});

test('definite recipient-create rejection retries the frozen request without duplicating records',async()=>{
 const f=make(),write=f.entities.CashRecipient.create;let rejected=false;
 f.entities.CashRecipient.create=async data=>{if(!rejected){rejected=true;throw Object.assign(Error('mock rejection'),{status:422});}return write(data);};
 assert.equal((await create(f)).data.operation_pending,true);assert.deepEqual(counts(f),[0,0]);
 assert.equal((await create(f)).status,200);assert.deepEqual(counts(f),[1,1]);
});

test('active linked retail locations can carry opening debt just like existing assignment',async()=>{
 const f=make();const r=await create(f,{recipient:{...body().recipient,supplier_location_ids:['shop']},opening_debt:{amount:1234,effective_date:'2026-01-02',location_id:'shop'}});
 assert.equal(r.status,200);assert.equal(r.data.opening_debt.location_id,'shop');
});

test('settings count change after partial creation retains pending intent',async()=>{
 const f=make();f.entities.SupplierOpeningDebt.create=async()=>{throw Object.assign(Error('mock rejection'),{status:422});};
 assert.equal((await create(f)).data.operation_pending,true);assert.deepEqual(counts(f),[1,0]);
 f.db.Settings.push({id:'second-settings'});const result=await create(f);
 assert.equal(result.data.operation_pending,true);assert.equal(result.data.request_not_started,false);assert.deepEqual(counts(f),[1,0]);
});
