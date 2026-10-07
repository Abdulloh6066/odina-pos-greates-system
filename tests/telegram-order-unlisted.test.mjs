import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { webcrypto, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { Base44StateStore } from '../base44/shared/order-bot/base44-store.js';

const now = new Date('2026-10-07T07:00:00Z');
class Clock extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return +now; } }
function modules(client) {
  const cache = new Map();
  const context = vm.createContext({ Response, crypto: webcrypto, console, Date: Clock, structuredClone });
  function load(path) {
    path = resolve(path);
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} }; cache.set(path, module);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, allowJs: true },
    }).outputText;
    const require = name => {
      if (name === 'node:crypto') return { randomUUID, webcrypto };
      if (name === 'npm:@base44/sdk') return { createClientFromRequest: () => client };
      if (!name.startsWith('.')) throw new Error('Unexpected offline dependency ' + name);
      return load(resolve(dirname(path), name));
    };
    vm.runInContext('(function(require,module,exports){\n' + code + '\n})', context)(require,module,module.exports);
    return module.exports;
  }
  return load;
}

function fixture(tier = 85000, products = []) {
  const sender = '123456';
  const db = {
    User: [{ id:'owner', role:'admin', is_owner:true, active:true, full_name:'Egasi' }],
    Shop: [{ id:'central', name:'Odina Central', active:true, allows_pos:true, location_type:'shop' },
      { id:'branch', name:'Odina Branch', active:true, allows_pos:true, location_type:'shop' }],
    Product: products, Customer:[], CustomerOrder:[], CustomerOrderItem:[], ActionHistory:[],
    OrderPayment:[], Shift:[], ProductionBatch:[], ProductionBatchItem:[], StockMovement:[],
    ProductStock:[{id:'stock', location_id:'central', product_id:'cake', quantity:10, unit:'piece'}],
    IngredientStock:[{id:'ingredient', quantity:123}], Settings:[{allow_negative_stock:false}],
  };
  let sequence = 0;
  const clone = v => v == null ? v : structuredClone(v);
  const matches = (r,q) => Object.entries(q || {}).every(([k,v]) => {
    if (v && typeof v === 'object') {
      if ('$exists' in v) return Object.hasOwn(r,k) === v.$exists;
      if ('$eq' in v) return JSON.stringify(r[k]) === JSON.stringify(v.$eq);
      if ('$nin' in v) return !v.$nin.includes(r[k]);
    }
    return r[k] === v;
  });
  const entities = Object.fromEntries(Object.keys(db).map(name => {
    const e = {
      get: async id => clone(db[name].find(r=>r.id===id)),
      filter: async q => clone(db[name].filter(r=>matches(r,q))),
      list: async () => clone(db[name]),
      create: async data => { const r={...clone(data),id:name+'-'+(++sequence)}; db[name].push(r); return clone(r); },
      updateMany: async (q,u) => {
        const rows=db[name].filter(r=>matches(r,q));
        for(const r of rows) { Object.assign(r,clone(u.$set||{})); for(const [k,v] of Object.entries(u.$inc||{})) r[k]=(r[k]||0)+v; }
        return {success:true,updated:rows.length,has_more:false};
      },
      delete: async () => { throw new Error('Offline test forbids deletion'); },
    };
    e.bulkCreate = async rows => Promise.all(rows.map(e.create));
    return [name,e];
  }));
  const client={asServiceRole:{entities},auth:{me:async()=>clone(db.User[0])}};
  const load=modules(client);
  const {InternalOrderBridge}=load('base44/shared/order-bot/bridge.js');
  const binding={enabled:true,staff_id:'owner',scope_policy:'owner_choose_shop',owner_shop_ids:['central','branch']};
  const service={entities,approvedPhotoHosts:['base44.app']};
  const bridge=new InternalOrderBridge(service,{bindingForSender:async()=>binding});
  const draft={ id:'ordinary-test', version:4, key:'odina-order-bot:ordinary-test:4', sender,
    staff:'owner', shop:'central', shop_name:'Odina Central', status:'draft',
    name:'abdurahim',phone:'+998919175070',date:'2026-10-07',time:'17:00',tier,
    type:'tugilgan_kun_va_boshqa',fulfilment:'pickup',
    photo:{file_id:'offline-photo'},reference_image:'https://base44.app/offline-cake.png',
    notes:'Tortdagi yozuv: Nazzi san uchun',errors:[] };
  const create = () => bridge.createConfirmed({draft,image:draft.reference_image,staffId:'owner'});
  const handler=load('base44/functions/customer-orders/entry.ts').default;
  const call=async body=>{ const r=await handler({json:async()=>body}); return {status:r.status,data:await r.json()}; };
  const {OrderBot}=load('base44/shared/order-bot/bot.js');
  let row={id:'binding',sender_id:sender,staff_id:'owner',enabled:true,scope_policy:'owner_choose_shop',
    owner_shop_ids:['central','branch'],version:1,phase:'draft',payload_json:JSON.stringify({draft,receipts:[],floor:0})};
  const stateEntity={
    filter:async()=>[clone(row)],
    updateMany:async(q,u)=>{
      if(!matches(row,q)) return {success:true,updated:0,has_more:false};
      Object.assign(row,clone(u.$set));return {success:true,updated:1,has_more:false};
    },
  };
  const store=new Base44StateStore(stateEntity,{canonicalIds:{[sender]:'binding'}});
  const bot=new OrderBot({store,pos:bridge,bindingProvider:async()=>binding,now:()=>now,
    photos:{rehost:async()=>draft.reference_image}});
  let uid=100;
  const callback=()=>bot.handle({update_id:++uid,callback_query:{from:{id:+sender},
    data:'ok:'+draft.id+':'+draft.version,message:{chat:{id:+sender,type:'private'}}}});
  const status=()=>bot.handle({update_id:++uid,message:{from:{id:+sender},chat:{id:+sender,type:'private'},text:'/holat'}});
  return {db,draft,create,bridge,call,callback,status,store,sender,binding,entities};
}
const catalog = (price=200000)=>({id:'cake',name:'TORT '+price,price,active:true,archived:false,
  production_unit:'piece',category_name:'Tortlar',track_stock:true,source_type:'central_produced'});

test('85000 missing from catalog saves an ordinary unpaid order, line, customer, photo and audit',async()=>{
  const f=fixture(); const result=await f.create();
  assert.equal(result.complete,true); assert.equal(result.catalog_missing,true);
  assert.equal(f.db.CustomerOrder.length,1); assert.equal(f.db.CustomerOrderItem.length,1);
  const o=f.db.CustomerOrder[0],i=f.db.CustomerOrderItem[0];
  assert.equal(o.total,85000); assert.equal(o.remaining_balance,85000);assert.equal(o.paid_amount,0);
  assert.equal(o.payment_status,'unpaid');assert.equal(o.reference_image,f.draft.reference_image);
  assert.equal(o.customer_name,'abdurahim');assert.equal(o.required_time,'17:00');assert.equal(o.notes,f.draft.notes);
  assert.equal(i.product_id,'');assert.equal(i.item_type,'custom');
  assert.equal(i.product_name_snapshot,'Oddiy buyurtma (tort)');assert.equal(i.line_total,85000);
  assert.equal(i.customization_note,f.draft.notes);assert.equal(f.db.Product.length,0);
  assert.equal(f.db.OrderPayment.length,0);assert.equal(f.db.StockMovement.length,0);
  assert.ok(o.customer_id);assert.equal(f.db.Customer.length,1);
  assert.ok(f.db.ActionHistory.some(a=>a.action==='order_created'));
});

test('a matching catalog cake keeps its product and has no missing-product warning',async()=>{
  const f=fixture(200000,[catalog()]); const r=await f.create();
  assert.equal(r.catalog_missing,false);assert.equal(f.db.CustomerOrderItem[0].product_id,'cake');
  assert.equal(f.db.CustomerOrderItem[0].product_name_snapshot,'TORT 200000');
});

test('inactive, wrong-price or sheet products never get incorrectly linked',async()=>{
  for(const p of [{...catalog(85000),active:false},{...catalog(85000),archived:true},
    {...catalog(85000),price:100000},{...catalog(85000),production_unit:'sheet'}]){
    const f=fixture(85000,[p]);assert.equal((await f.create()).catalog_missing,true);
    assert.equal(f.db.CustomerOrderItem[0].product_id,'');
  }
});

test('duplicate eligible catalog products block instead of silently choosing one',async()=>{
  const f=fixture(85000,[catalog(85000),{...catalog(85000),id:'other'}]);
  await assert.rejects(f.create(),/ambiguity/);assert.equal(f.db.CustomerOrder.length,0);
});

test('uncatalogued orders show the warning only after complete reconciliation and repeated callbacks do not duplicate',async()=>{
  const f=fixture();const r=await f.callback();
  assert.match(r.text,/Buyurtma saqlandi/);assert.match(r.text,/mos mahsulot topilmadi/);
  assert.match(r.text,/Oddiy buyurtma sifatida saqlandi/);assert.match(r.text,/Qoldiq: 85000/);
  const before=f.db.CustomerOrder.length;
  await f.callback();const status=await f.status();
  assert.match(status.text,/mos mahsulot topilmadi/);
  assert.equal(f.db.CustomerOrder.length,before);assert.equal(f.db.CustomerOrderItem.length,1);
});

test('partial order creation is never reported as success or blindly retried',async()=>{
  const f=fixture();f.entities.CustomerOrderItem.bulkCreate=async()=>{throw Error('Unknown item write');};
  const r=await f.callback();assert.match(r.text,/Natija tekshirilmoqda/);
  assert.equal(f.db.CustomerOrder.length,1);assert.equal(f.db.CustomerOrderItem.length,0);
  await f.callback();await f.status();assert.equal(f.db.CustomerOrder.length,1);
});

test('ordinary orders can be ready, shipped and completed without recipes or stock deductions',async()=>{
  const f=fixture();await f.create();
  const before=structuredClone({products:f.db.ProductStock,ingredients:f.db.IngredientStock});
  const id=f.db.CustomerOrder[0].id;
  assert.equal((await f.call({action:'update_production_status',order_id:id,step:'ready'})).status,200);
  assert.equal((await f.call({action:'update_production_status',order_id:id,step:'shipped'})).status,200);
  // A paid snapshot simulates payment outside this test; no real payment records.
  Object.assign(f.db.CustomerOrder[0],{paid_amount:85000,remaining_balance:0,payment_status:'paid'});
  const result=await f.call({action:'complete_order',order_id:id,idempotency_key:'finish-ordinary'});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.order.order_status,'yakunlandi');
  assert.deepEqual({products:f.db.ProductStock,ingredients:f.db.IngredientStock},before);
  assert.equal(f.db.StockMovement.length,0);assert.equal(f.db.ProductionBatch.length,0);
});

test('public request data cannot enable custom pricing or override a catalog price',async()=>{
  const f=fixture(200000,[catalog()]);
  const body={action:'create_order',idempotency_key:'browser-create',shop_id:'central',order_type:f.draft.type,
    customer_name:f.draft.name,customer_phone:f.draft.phone,required_date:f.draft.date,required_time:f.draft.time,
    fulfilment_type:'pickup',allowUnlistedCake:true,expectedTotal:1,botGuard:{allowUnlistedCake:true},
    items:[{product_id:'',quantity:1,unit_price:1,item_type:'custom'}]};
  const bad=await f.call(body);assert.equal(bad.status,400);assert.equal(f.db.CustomerOrder.length,0);
  body.items=[{product_id:'cake',quantity:1,unit_price:1,item_type:'custom'}];
  const normal=await f.call(body);assert.equal(normal.status,200,JSON.stringify(normal));
  assert.equal(f.db.CustomerOrder[0].total,200000);
});

test('scope, disabled staff and unapproved photos still block unlisted cakes',async()=>{
  for(const setup of [
    f=>{f.db.User[0].active=false;},f=>{f.draft.shop='unknown';},
    f=>{f.draft.reference_image='https://api.telegram.org/file/secret';}
  ]){
    const f=fixture();setup(f);await assert.rejects(f.create());assert.equal(f.db.CustomerOrder.length,0);
  }
});

test('reconciliation rejects tampered ordinary line metadata and does not rely on current catalog',async()=>{
  const f=fixture();await f.create();f.db.Product.push(catalog(85000));
  assert.equal((await f.bridge.reconcile(f.draft)).catalog_missing,true);
  f.db.CustomerOrderItem[0].line_total=1;assert.equal(await f.bridge.reconcile(f.draft),null);
});

test('recovering a confirmed catalog failure keeps its original idempotency key',async()=>{
  const f=fixture();await f.store.transaction(f.sender,tx=>{const d=tx.get(f.sender);d.version++;tx.put(f.sender,d);});
  const d=await f.store.get(f.sender);f.draft.version=d.version;
  assert.match((await f.callback()).text,/Buyurtma saqlandi/);
  assert.equal(f.db.CustomerOrder[0].idempotency_key,'odina-order-bot:ordinary-test:4');
});
