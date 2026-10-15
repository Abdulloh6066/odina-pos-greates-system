// Real handlers with isolated memory storage. No live sales, stock or printing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';
import { buildPendingSale, syncPendingSales } from '../src/lib/offline-sales.js';

const branch = '6a96f0a4ecc85c2fc57f3174';
const entry = 'base44/functions/complete-sale/entry.ts';
function fixture() {
  const ids = [['beans',10000,'g',380],['milk',10000,'ml',18],['juice',10000,'ml',1],
    ['hot-cup',10,'piece',1000],['cold-cup',10,'piece',1500],['lid',10,'piece',500]];
  const rows = [['hot','beans',18,'g',false],['hot','milk',200,'ml',false],['hot','hot-cup',1,'piece',true],
    ['cold','juice',500,'ml',false],['cold','cold-cup',1,'piece',true],['cold','lid',1,'piece',true]];
  const f = memoryBackend({
    User: [{ id:'owner',role:'admin',active:true,shop_id:branch,is_owner:true }],
    Shop: [{ id:branch,name:'Mock Branch',location_type:'shop',active:true,allows_pos:true }],
    Shift: [{ id:'shift',user_id:'owner',shop_id:branch,shop_name:'Mock Branch',status:'open',
      opened_at:'2026-10-15T04:00:00Z',expected_cash:0,total_sales:0,order_count:0,sale_request_keys:[] }],
    Product: [{id:'hot',name:'Mock hot coffee',price:28000},{id:'cold',name:'Mock cold drink',price:25000}]
      .map(p=>({...p,active:true,source_type:'shop_prepared',track_stock:true})),
    Ingredient: ids.map(([id,,base_unit])=>({id,name:id,base_unit,purchase_unit:base_unit,
      conversion_to_base:1,category:['hot-cup','cold-cup','lid'].includes(id)?'packaging':'food',active:true})),
    IngredientStock: ids.map(([ingredient_id,quantity,unit])=>({id:ingredient_id+'-stock',ingredient_id,
      ingredient_name:ingredient_id,location_id:branch,quantity,unit})),
    Recipe: ['hot','cold'].map(id=>({id:id+'-recipe',product_id:id,active:true,version:1,output_quantity:1,output_unit:'piece'})),
    RecipeItem: rows.map(([product_id,ingredient_id,quantity,unit,takeaway_only],position)=>({
      id:ingredient_id+'-row',recipe_id:product_id+'-recipe',product_id,ingredient_id,
      ingredient_name_snapshot:ingredient_id,quantity,unit,position,takeaway_only})),
    SupplierReceipt:[{id:'receipt',status:'confirmed'}],
    SupplierReceiptItem:ids.map(([ingredient_id,,,price])=>({id:ingredient_id+'-price',
      receipt_id:'receipt',ingredient_id,base_quantity:1000,line_total:price*1000})),
    Settings:[{allow_negative_stock:false}], Sale:[],SaleItem:[],Payment:[],StockMovement:[],ActionHistory:[],
  },{now:'2026-10-15T10:00:00Z'});
  const handlers=new Map();
  async function invoke(file,body){
    if(!handlers.has(file)){let registered;const m=f.load(file,{Deno:{serve:fn=>{registered=fn;},env:{get:()=>undefined}},
      setTimeout,clearTimeout,performance});handlers.set(file,m.default||registered);}
    const response=await handlers.get(file)({json:async()=>structuredClone(body)});
    return {status:response.status,data:await response.json()};
  }
  const request={action:'complete_sale',shift_id:'shift',idempotency_key:'packaging-sale-test-0001',
    recorded_at:'2026-10-15T09:00:00Z',items:[{product_id:'hot',quantity:2},{product_id:'cold',quantity:3}],
    payments:[{method:'cash',amount:131000}]};
  return {...f,request,invoke,sale:body=>invoke(entry,body||request),
    order:body=>invoke('base44/functions/restaurant-tables/entry.ts',body),
    stock:id=>f.db.IngredientStock.find(s=>s.ingredient_id===id).quantity};
}
test('ordinary checkout uses base ingredients only and retains the original prices',async()=>{
  const f=fixture(),r=await f.sale();
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(f.stock('hot-cup'),10);assert.equal(f.stock('cold-cup'),10);assert.equal(f.stock('lid'),10);
  assert.equal(f.stock('beans'),9964);assert.equal(f.stock('milk'),9600);assert.equal(f.stock('juice'),8500);
  assert.equal(r.data.sale.total,131000);
  assert.equal(f.db.SaleItem.find(i=>i.product_id==='hot').unit_cost_at_sale,10440);
  assert.equal(f.db.SaleItem.find(i=>i.product_id==='cold').unit_cost_at_sale,500);
});
test('delivery consumes one hot cup and one cold cup/lid per portion and includes them in cost snapshots',async()=>{
  const f=fixture(),r=await f.sale({...f.request,is_delivery:true});
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(f.stock('hot-cup'),8);assert.equal(f.stock('cold-cup'),7);assert.equal(f.stock('lid'),7);
  assert.equal(f.db.SaleItem.find(i=>i.product_id==='hot').unit_cost_at_sale,11440);
  assert.equal(f.db.SaleItem.find(i=>i.product_id==='cold').unit_cost_at_sale,2500);
  assert.equal(r.data.sale.total,131000);assert.equal(f.db.Payment[0].amount,131000);
  const again=await f.sale({...f.request,is_delivery:true});
  assert.equal(again.status,200);assert.equal(again.data.sale.id,r.data.sale.id);
  assert.equal(f.stock('hot-cup'),8);assert.equal(f.stock('lid'),7);
  assert.equal(f.db.Sale.length,1);assert.equal(f.db.Payment.length,1);
});
test('saved Soboy and combined Soboy/Dostavka deduct once at payment, never at save or service-ticket reads',async()=>{
  for(const is_delivery of [false,true]){
    const f=fixture();
    const body={action:'save_takeaway_order',shop_id:branch,shift_id:'shift',order_id:'packaging-takeaway-0001',
      expected_revision:0,is_delivery,items:f.request.items};
    const saved=await f.order(body);assert.equal(saved.status,200,JSON.stringify(saved.data));
    assert.equal(f.stock('hot-cup'),10);assert.equal(f.stock('lid'),10);
    for(let i=0;i<3;i++)await f.order({action:'get_takeaway_order',shop_id:branch,order_id:body.order_id});
    assert.equal(f.stock('hot-cup'),10);assert.equal(f.db.Sale.length,0);
    const request={...f.request,is_delivery,takeaway_order_id:body.order_id,takeaway_order_revision:saved.data.order.revision};
    const paid=await f.sale(request);assert.equal(paid.status,200,JSON.stringify(paid.data));
    assert.equal(f.stock('hot-cup'),8);assert.equal(f.stock('cold-cup'),7);assert.equal(f.stock('lid'),7);
    await f.sale(request);
    assert.equal(f.stock('hot-cup'),8);assert.equal(f.stock('lid'),7);assert.equal(f.db.Payment.length,1);
  }
});
test('precheck and final checkout both block missing packaging before changing money or stock',async()=>{
  const f=fixture();f.db.IngredientStock.find(i=>i.ingredient_id==='lid').quantity=0;
  const check={action:'check_stock',shift_id:'shift',items:f.request.items};
  assert.equal((await f.sale(check)).status,200,'ordinary drinks do not need takeaway packaging');
  assert.equal((await f.sale({...check,is_delivery:true})).status,409);
  assert.equal((await f.sale({...f.request,is_delivery:true})).status,409);
  assert.equal(f.db.Sale.length,0);assert.equal(f.db.Payment.length,0);assert.equal(f.stock('hot-cup'),10);
});
test('failed financial writes roll packaging back; a successful retry deducts it once',async()=>{
  const f=fixture(),create=f.entities.Payment.create;
  f.entities.Payment.create=async()=>{throw Error('Simulated payment save failure');};
  const request={...f.request,is_delivery:true};
  assert.notEqual((await f.sale(request)).status,200);
  assert.equal(f.stock('hot-cup'),10);assert.equal(f.stock('cold-cup'),10);assert.equal(f.stock('lid'),10);
  assert.equal(f.db.Sale.length,0);
  f.entities.Payment.create=create;
  const paid=await f.sale(request);assert.equal(paid.status,200,JSON.stringify(paid.data));
  assert.equal(f.stock('hot-cup'),8);assert.equal(f.stock('lid'),7);
});
test('offline delivery synchronized after a lost acknowledgment consumes packaging once',async()=>{
  const f=fixture();
  const pending=buildPendingSale({isDelivery:true,idempotencyKey:'packaging-offline-test-0001',
    recordedAt:f.request.recorded_at,shift:f.db.Shift[0],user:f.db.User[0],
    cart:[{product_id:'hot',product_name:'Hot',price:28000,quantity:2}],
    payments:[{method:'cash',amount:56000}]});
  let rows=[structuredClone(pending)],lost=true;
  const storage={list:async()=>structuredClone(rows),update:async(id,patch)=>Object.assign(rows.find(r=>r.id===id),patch),
    remove:async id=>{rows=rows.filter(r=>r.id!==id);}};
  const send=async body=>{const reply=await f.sale(body);assert.equal(reply.status,200,JSON.stringify(reply.data));
    if(lost){lost=false;throw Object.assign(new Error('Network Error'),{code:'ERR_NETWORK'});}return reply.data;};
  const run=extra=>syncPendingSales({userId:'owner',storage,send,lock:work=>work(),...extra});
  await run();assert.equal(rows.length,1);assert.equal(f.stock('hot-cup'),8);
  await run({retryFailed:true});assert.equal(rows.length,0);assert.equal(f.stock('hot-cup'),8);
  assert.equal(f.db.Sale.length,1);assert.equal(f.db.Payment.length,1);
});
test('recipe edits retain the condition from older editors and validate packaging-only usage',async()=>{
  const f=fixture(),items=f.db.RecipeItem.filter(i=>i.product_id==='hot').map(i=>({
    ingredient_id:i.ingredient_id,quantity:i.quantity}));
  const request={action:'save_recipe',product_id:'hot',output_quantity:1,items};
  const saved=await f.invoke('base44/functions/production-run/entry.ts',request);
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.items.find(i=>i.ingredient_id==='hot-cup').takeaway_only,true);
  assert.equal(saved.data.items.find(i=>i.ingredient_id==='beans').takeaway_only,false);
  const bad=await f.invoke('base44/functions/production-run/entry.ts',{
    ...request,items:[{ingredient_id:'beans',quantity:18,takeaway_only:true}]});
  assert.equal(bad.status,400);
  assert.equal(f.db.Recipe.filter(r=>r.active).find(r=>r.product_id==='hot').id,saved.data.recipe.id);
});
test('the full migration maps all 47 drinks, preserves base quantities and replaces the two legacy fresh cups',()=>{
  const m=JSON.parse(readFileSync('base44/migrations/drink-takeaway-packaging-20261015.json','utf8'));
  assert.equal(m.plan.length,47);assert.equal(new Set(m.plan.map(p=>p.product_id)).size,47);
  assert.equal(m.plan.filter(p=>p.type==='hot').length,16);assert.equal(m.plan.filter(p=>p.type==='cold').length,31);
  assert.equal(m.previous_items.filter(i=>i.ingredient_id===m.packaging_ids.legacy).length,2);
  assert.equal(m.plan.find(p=>p.name==='Ays latte').type,'cold');
  assert.equal(m.plan.find(p=>p.name==='Issiq shokolad').type,'hot');
  for(const p of m.plan){
    assert.equal(p.output,1);
    assert.deepEqual(p.packaging.map(i=>i.ingredient_id),p.type==='hot'
      ?[m.packaging_ids.hot]:[m.packaging_ids.cold,m.packaging_ids.lid]);
    for(const i of p.packaging){assert.equal(i.quantity,1);assert.equal(i.unit,'piece');assert.equal(i.takeaway_only,true);}
  }
});
