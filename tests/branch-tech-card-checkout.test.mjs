// Branch tech-card checkout regressions: mocked SDK only, network disabled by harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { memoryBackend } from './helpers/memory-backend.mjs';

const entry = 'base44/functions/complete-sale/entry.ts';
const branch = '6a96f0a4ecc85c2fc57f3174';
function fixture(shopId = branch) {
  const f = memoryBackend({
    User: [{ id: 'cashier', role: 'cashier', shop_id: shopId, active: true }],
    Shop: [{ id: shopId, name: 'Mock Branch', location_type: 'shop', allows_pos: true, active: true }],
    Shift: [{ id: 'shift', user_id: 'cashier', shop_id: shopId, shop_name: 'Mock Branch',
      status: 'open', opened_at: '2026-09-27T06:00:00Z', expected_cash: 0, total_sales: 0, order_count: 0, sale_request_keys: [] }],
    Product: [
      { id: 'coffee', name: 'Mock Latte', source_type: 'shop_prepared', sale_unit: 'piece', price: 1000, track_stock: true, active: true },
      { id: 'tea', name: 'Mock Tea', source_type: 'shop_prepared', sale_unit: 'piece', price: 1000, track_stock: true, active: true },
      { id: 'cake', name: 'Mock Cake', source_type: 'central_produced', price: 1000, track_stock: true, active: true },
    ],
    ProductStock: ['coffee','tea','cake'].map(id => ({ id: id+'-stock', product_id: id, location_id: shopId, quantity: 10 })),
    Recipe: [
      { id: 'coffee-recipe', product_id: 'coffee', active: true, version: 1, output_quantity: 2, output_unit: 'piece' },
      { id: 'tea-recipe', product_id: 'tea', active: true, version: 1, output_quantity: 1, output_unit: 'piece' },
    ],
    RecipeItem: [
      { id: 'milk-line', recipe_id: 'coffee-recipe', ingredient_id: 'milk', ingredient_name_snapshot: 'Mock milk', quantity: 400, unit: 'ml' },
      { id: 'cup-line', recipe_id: 'coffee-recipe', ingredient_id: 'cup', ingredient_name_snapshot: 'Mock cup', quantity: 2, unit: 'piece' },
      { id: 'tea-cup', recipe_id: 'tea-recipe', ingredient_id: 'cup', ingredient_name_snapshot: 'Mock cup', quantity: 1, unit: 'piece' },
    ],
    IngredientStock: [
      { id: 'milk-stock', location_id: shopId, ingredient_id: 'milk', ingredient_name: 'Mock milk', quantity: 2000, unit: 'ml' },
      { id: 'cup-stock', location_id: shopId, ingredient_id: 'cup', ingredient_name: 'Mock cup', quantity: 20, unit: 'piece' },
      { id: 'other-milk', location_id: 'other', ingredient_id: 'milk', quantity: 9000, unit: 'ml' },
    ],
    Settings: [{ id: 'settings', allow_negative_stock: false }],
    SecuritySettings: [{ id: 'mock-pin', key: 'owner_approval_pin', pin_algorithm: 'PBKDF2-SHA256', pin_salt: 'mock-only', pin_iterations: 100000, pin_hash: pbkdf2Sync('2468','mock-only',100000,32,'sha256').toString('hex') }],
    Sale: [], SaleItem: [], Payment: [], Refund: [], StockMovement: [], ActionHistory: [],
  });
  f.request = { action: 'complete_sale', shift_id: 'shift', idempotency_key: 'mock-branch-checkout',
    recorded_at: '2026-09-27T07:00:00Z', items: [{ product_id: 'coffee', quantity: 2 },{ product_id: 'tea', quantity: 1 },{ product_id: 'cake', quantity: 1 }],
    payments: [{ method: 'cash', amount: 4000 }] };
  f.call = body => f.invoke(entry, { owner_pin: '2468', ...(body || f.request) });
  return f;
}
const balance = (f, id) => f.db.IngredientStock.find(row=>row.id===id)?.quantity;
const assertSaleEmpty = f => {
  for (const name of ['Sale','SaleItem','Payment','StockMovement']) assert.equal(f.db[name].length,0,name);
  assert.equal(f.db.Shift[0].expected_cash,0);
  assert.equal(f.db.Shift[0].sale_request_keys.length,0);
};

test('Branch consumes batch-scaled ingredients once, aggregates shared cups and leaves other shops alone', async () => {
  const f=fixture();
  const pre=await f.call({...f.request,action:'check_stock'});
  assert.equal(pre.status,200); assert.equal(f.calls.length,0);
  const r=await f.call(); assert.equal(r.status,200,JSON.stringify(r));
  assert.equal(balance(f,'milk-stock'),1600); assert.equal(balance(f,'cup-stock'),17);
  assert.equal(balance(f,'other-milk'),9000);
  assert.equal(f.db.ProductStock.find(x=>x.product_id==='coffee').quantity,10);
  assert.equal(f.db.ProductStock.find(x=>x.product_id==='tea').quantity,10);
  assert.equal(f.db.ProductStock.find(x=>x.product_id==='cake').quantity,9);
  assert.equal(f.db.SaleItem.find(x=>x.product_id==='coffee').stock_tracked_snapshot,false);
  assert.equal(f.db.StockMovement.filter(x=>x.item_kind==='ingredient').length,2);
  assert.ok(f.db.StockMovement.every(x=>x.reference_id===r.data.sale.id));
  const retry=await f.call(); assert.equal(retry.data.already_processed,true);
  assert.equal(balance(f,'milk-stock'),1600); assert.equal(f.db.Shift[0].expected_cash,4000);
});

test('Central and other shops keep their existing product-stock behavior', async () => {
  const f=fixture('central'); assert.equal((await f.call()).status,200);
  assert.equal(balance(f,'milk-stock'),2000); assert.equal(f.db.ProductStock[0].quantity,8);
  assert.equal(f.db.StockMovement.filter(x=>x.item_kind==='ingredient').length,0);
});

test('missing tech cards retain existing sales until configured; active malformed cards block before writes', async () => {
  const f=fixture(); f.db.Recipe=[];
  assert.equal((await f.call()).status,200); assert.equal(balance(f,'milk-stock'),2000);
  assert.equal(f.db.ProductStock[0].quantity,8);
  for (const damage of [
    g=>{g.db.RecipeItem=g.db.RecipeItem.filter(x=>x.recipe_id!=='coffee-recipe');},
    g=>{g.db.Recipe[0].output_quantity=0;},
    g=>{g.db.RecipeItem[0].quantity=-1;},
    g=>{g.db.RecipeItem[0].unit='kg';},
    g=>{g.db.Recipe.push({...g.db.Recipe[0],id:'duplicate'});},
    g=>{g.db.IngredientStock.push({...g.db.IngredientStock[0],id:'duplicate'});},
  ]) {
    const g=fixture(); damage(g); assert.equal((await g.call()).status,409); assert.equal(g.calls.length,0);
  }
});

test('ingredient shortages use existing negative-stock policy in precheck and checkout', async () => {
  const f=fixture(); f.db.IngredientStock[0].quantity=100;
  const pre=await f.call({...f.request,action:'check_stock'});
  assert.equal(pre.status,409); assert.equal(pre.data.ingredient_shortages[0].missing,300);
  assert.equal((await f.call()).status,409); assert.equal(f.calls.length,0);
  f.db.Settings[0].allow_negative_stock=true;
  const r=await f.call(); assert.equal(r.status,200); assert.equal(balance(f,'milk-stock'),-300);
  assert.equal(r.data.ingredient_warnings.length,1);
});

test('partial ingredient movement failure restores every balance and financial row, then same key safely retries', async () => {
  const f=fixture(); const create=f.entities.StockMovement.create;
  f.entities.StockMovement.create=async row=>{
    if(row.item_kind==='ingredient'&&row.item_id==='cup') throw new Error('Mock second movement failure');
    return create(row);
  };
  assert.equal((await f.call()).status,500); assertSaleEmpty(f);
  assert.equal(balance(f,'milk-stock'),2000); assert.equal(balance(f,'cup-stock'),20);
  assert.equal(f.db.ProductStock[2].quantity,10);
  f.entities.StockMovement.create=create;
  assert.equal((await f.call()).status,200); assert.equal(balance(f,'cup-stock'),17);
});

test('stock changed on another device rolls back earlier ingredient updates without overwriting concurrent stock', async () => {
  const f=fixture(); const update=f.entities.IngredientStock.updateMany;
  f.entities.IngredientStock.updateMany=async(q,ops)=>{
    if(q.id==='milk-stock'&&ops.$set) { f.db.IngredientStock[0].quantity=1990; return {success:true,updated:0}; }
    return update(q,ops);
  };
  assert.equal((await f.call()).status,409); assertSaleEmpty(f);
  assert.equal(balance(f,'milk-stock'),1990); assert.equal(balance(f,'cup-stock'),20);
});

test('rollback covers newly created ingredient balances when negative stock is allowed', async () => {
  const f=fixture(); f.db.IngredientStock=f.db.IngredientStock.filter(x=>x.id!=='milk-stock');
  f.db.Settings[0].allow_negative_stock=true;
  const create=f.entities.StockMovement.create;
  f.entities.StockMovement.create=async row=>{
    if(row.item_kind==='ingredient'&&row.item_id==='milk') throw new Error('Mock movement failure');
    return create(row);
  };
  assert.equal((await f.call()).status,500); assertSaleEmpty(f);
  assert.equal(f.db.IngredientStock.find(x=>x.location_id===branch&&x.ingredient_id==='milk').quantity,0);
  assert.equal(balance(f,'cup-stock'),20);
});

test('refund restores actual ingredient movements despite recipe changes; repeating refund cannot add stock twice', async () => {
  const f=fixture(); const sale=await f.call(); assert.equal(sale.status,200);
  f.db.User[0].role='admin';
  f.db.Recipe=[]; f.db.RecipeItem=[]; // Historical quantities must come from movement snapshots.
  const request={action:'refund_sale',sale_id:sale.data.sale.id,reason:'Mock refund'};
  const refund=await f.call(request); assert.equal(refund.status,200,JSON.stringify(refund));
  assert.equal(balance(f,'milk-stock'),2000); assert.equal(balance(f,'cup-stock'),20);
  assert.equal(f.db.ProductStock[0].quantity,10); assert.equal(f.db.ProductStock[2].quantity,10);
  assert.equal(f.db.Shift[0].expected_cash,0);
  assert.equal((await f.call(request)).status,409); assert.equal(balance(f,'milk-stock'),2000);
});

test('a failed partial refund rolls back restored ingredients, product stock and shift; retry succeeds', async () => {
  const f=fixture(); const sale=await f.call(); f.db.User[0].role='admin';
  const create=f.entities.StockMovement.create;
  f.entities.StockMovement.create=async row=>{
    if(row.item_kind==='ingredient'&&row.movement_type==='refund'&&row.item_id==='milk') throw new Error('Mock refund movement failure');
    return create(row);
  };
  const request={action:'refund_sale',sale_id:sale.data.sale.id,reason:'Mock refund'};
  assert.equal((await f.call(request)).status,500);
  assert.equal(balance(f,'milk-stock'),1600); assert.equal(balance(f,'cup-stock'),17);
  assert.equal(f.db.ProductStock[2].quantity,9); assert.equal(f.db.Shift[0].expected_cash,4000);
  assert.equal(f.db.Sale[0].status,'completed'); assert.equal(f.db.Refund.length,0);
  assert.equal(f.db.StockMovement.filter(x=>x.movement_type==='refund').length,0);
  f.entities.StockMovement.create=create;
  assert.equal((await f.call(request)).status,200); assert.equal(balance(f,'milk-stock'),2000);
});

test('legacy sale with no ingredient movements never creates a retroactive deduction or refund', async () => {
  const f=fixture(); f.db.Recipe=[]; const sale=await f.call(); assert.equal(sale.status,200);
  f.db.User[0].role='admin';
  assert.equal((await f.call({action:'refund_sale',sale_id:sale.data.sale.id,reason:'Mock legacy refund'})).status,200);
  assert.equal(balance(f,'milk-stock'),2000);
  assert.equal(f.db.StockMovement.filter(x=>x.item_kind==='ingredient').length,0);
});

test('frozen table orders also consume Branch recipe ingredients at payment', async () => {
  const f=fixture(); const shop=f.db.Shop[0];
  Object.assign(shop,{restaurant_table_count:2,restaurant_table_orders_version:1,restaurant_table_orders:[
    {id:'table-order',number:1,state:'occupied',revision:1,items:f.request.items.map(x=>{
      const p=f.db.Product.find(p=>p.id===x.product_id);
      return {...p,product_id:p.id,product_name:p.name,quantity:x.quantity,stock_tracked:true};
    })},
  ]});
  Object.assign(f.request,{table_number:1,table_shop_id:branch,table_order_id:'table-order',table_order_revision:1});
  const pre=await f.call({...f.request,action:'check_stock'}); assert.equal(pre.status,200,JSON.stringify(pre));
  const r=await f.call(); assert.equal(r.status,200,JSON.stringify(r));
  assert.equal(balance(f,'milk-stock'),1600); assert.equal(f.db.ProductStock[0].quantity,10);
  assert.equal(f.db.Shop[0].restaurant_table_orders.length,0);
});

test('uncertain ingredient rollback retains the checkout claim and prevents a second deduction', async () => {
  const f=fixture(); const create=f.entities.StockMovement.create;
  f.entities.StockMovement.create=async row=>{
    if(row.item_kind==='ingredient'&&row.item_id==='milk') throw new Error('Mock movement failure');
    return create(row);
  };
  const update=f.entities.IngredientStock.updateMany;
  f.entities.IngredientStock.updateMany=async(q,ops)=>{
    if(ops.$inc) throw new Error('Mock unavailable rollback');
    return update(q,ops);
  };
  assert.equal((await f.call()).status,500);
  assert.ok(f.db.Shift[0].sale_request_keys.includes(f.request.idempotency_key));
  const after=balance(f,'milk-stock');
  assert.equal((await f.call()).status,503);
  assert.equal(balance(f,'milk-stock'),after);
});
