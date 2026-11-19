import test from 'node:test';
import assert from 'node:assert/strict';
import {conciseShiftReport} from '../lib/concise-ai-report.js';
import {readFileSync} from 'node:fs';
const receipt={id:'s',shop_id:'a',status:'completed',total:130000,payments:[{method:'cash',amount:80000},{method:'uzcard',amount:30000},{method:'online',amount:20000}],sale_items_count:2};
const items=[{sale_id:'s',product_id:'b',product_name_snapshot:'Burger classic, frisiz',quantity:2,sale_unit:'piece',line_total:72879,category_name_snapshot:'FOOD'},{sale_id:'s',product_id:'c',product_name_snapshot:'Kapuchino',quantity:2,sale_unit:'piece',line_total:57121,category_name_snapshot:'Kofe'}];
test('copy body uses discounted lines and reconciles categories, counts and payments',()=>{
 const before=JSON.stringify({receipt,items}),r=conciseShiftReport({sales:[receipt],items});
 assert.equal(r.total,130000);assert.equal(r.receipts,1);assert.equal(r.pieces,4);
 assert.deepEqual(r.payments,{cash:80000,card:30000,online:20000,other:0});
 assert.ok(r.text.startsWith('Jami savdo: 130 000 so‘m\n1 ta chek · 4 ta mahsulot'));
 assert.match(r.text,/Burger classic, frisiz — 2 ta · 72 879/);
 assert.match(r.text,/Jami: 2 ta · 57 121/);assert.match(r.text,/Karta — 30 000 so‘m/);
 assert.doesNotMatch(r.text,/Asia|So‘rov|taxmin|2026/);assert.equal(JSON.stringify({receipt,items}),before);
});
test('all stored card/online aliases and other payments remain accounted for',()=>{
 const methods=['cash','bank_card','uzcard','humo','online','click','payme','bank_transfer','other'];
 const sales=methods.map((method,i)=>({id:String(i),status:'completed',total:10,payments:[{method,amount:10}],items:[{product_name:method,quantity:1,subtotal:10}],discount_amount:0}));
 const r=conciseShiftReport({sales,items:[]});
 assert.deepEqual(r.payments,{cash:10,card:30,online:30,other:20});assert.equal(r.receipts,9);assert.equal(r.pieces,9);
});
test('missing rows/discount basis/payment mismatch do not produce a plausible total',()=>{
 assert.throws(()=>conciseShiftReport({sales:[receipt],items:items.slice(0,1)}));
 assert.throws(()=>conciseShiftReport({sales:[{...receipt,payments:[{method:'cash',amount:1}]}],items}));
 assert.throws(()=>conciseShiftReport({sales:[{...receipt,total:999}],items}));
 assert.throws(()=>conciseShiftReport({sales:[{id:'l',status:'completed',total:10,payments:[],items:[{quantity:1,subtotal:12}],discount_amount:2}],items:[]}));
});
test('weighed quantity is not mixed into piece count; refunds not silently allocated',()=>{
 const r=conciseShiftReport({sales:[{id:'g',status:'refunded',total:20000,payments:[{method:'cash',amount:20000}]}],items:[{sale_id:'g',product_name_snapshot:'Cake',quantity:250,sale_unit:'gram',line_total:20000}],refunds:[{amount:10000}]});
 assert.equal(r.pieces,0);assert.equal(r.grams,250);assert.match(r.text,/250 g/);
 assert.match(r.text,/Qaytarishlar — 10 000 so‘m/);assert.match(r.text,/sof savdo — 10 000 so‘m/);assert.equal(r.payments.cash,20000);
});
test('zero sales, no category clutter, no guessed test exclusions',()=>{
 const r=conciseShiftReport({sales:[],items:[]});assert.equal(r.total,0);assert.equal(r.receipts,0);assert.doesNotMatch(r.text,/FOOD|Kofe/);
 assert.equal(conciseShiftReport({sales:[{...receipt,is_test:true}],items}).receipts,1);
});
test('owner scope, live selection, copy and response guards stay read-only',()=>{
 const code=readFileSync(new URL('../pages/AIHisobot.jsx',import.meta.url),'utf8');
 assert.match(code,/if\(!owner\|\|!scope\?\.ready\|\|!shopId\)return/);
 assert.match(code,/shop_id:shopId,status/);assert.match(code,/s.shop_id===shopId/);assert.match(code,/version===request.current/);
 assert.match(code,/setText\(''\)/);assert.match(code,/created_date:\{\$lte:cutoffISO\}/);
 assert.equal((code.match(/clipboard.writeText/g)||[]).length,1);
 assert.doesNotMatch(code,/\.create\(|\.update\(|\.delete\(|asServiceRole|InvokeLLM/);
});
