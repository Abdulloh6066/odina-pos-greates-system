import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isReportOwner,reportIntent,reportNumber,shiftItemGroups,historicalLineGross,historicalReceiptTotals} from '../lib/ai-report.js';
test('only active stored owner admin can use the page',()=>{assert.equal(isReportOwner({role:'admin',is_owner:true}),true);for(const u of [{role:'admin'},{role:'manager',is_owner:true},{role:'admin',is_owner:true,active:false},null])assert.equal(isReportOwner(u),false);});
test('bounded intent and unknown amounts',()=>{assert.equal(reportIntent('last shift'),'shift');assert.equal(reportIntent('bugun'),'today');assert.equal(reportIntent('delete all sales'),null);assert.equal(reportNumber(null),'noma’lum');assert.equal(reportNumber(undefined),'noma’lum');assert.equal(reportNumber(0),'0');});
test('snapshots, unit separation, category order, cancelled exclusion, incomplete rows',()=>{
 const sales=[{id:'1',status:'completed'},{id:'2',status:'cancelled'},{id:'3',status:'refunded'},{id:'4',status:'completed'}];
 const items=[{sale_id:'1',product_id:'p',product_name_snapshot:'Old cake',quantity:2,line_total:20,discount_amount:0},{sale_id:'1',product_id:'p',product_name_snapshot:'Old cake',sale_unit:'gram',quantity:150,line_total:15,discount_amount:0},{sale_id:'2',quantity:999,line_total:999},{sale_id:'3',category_name_snapshot:'Ichimliklar',quantity:1,line_total:10,discount_amount:0},{sale_id:'1',category_name_snapshot:'Taomlar',quantity:1,line_total:8,discount_amount:0}];
 const result=shiftItemGroups(sales,items,[{id:'p',category_id:'c',name:'New name'}],[{id:'c',name:'Tortlar'}]);
 assert.equal(result.missing,1);assert.deepEqual(result.groups.map(g=>g.name),['Tortlar','Taomlar','Ichimliklar']);assert.equal(result.groups[0].rows.length,2);assert.equal(result.groups[0].subtotal,35);assert.equal(result.groups[0].rows[0].name,'Old cake');assert.equal(result.groups[2].subtotal,10);
 const missing=shiftItemGroups([{id:'1',status:'completed'}],[{sale_id:'1',quantity:1}],[],[]);assert.equal(missing.groups[0].subtotal,null);
});
test('two burgers stay gross 74000, receipt 132000 less 2000 equals 130000',()=>{
 const sales=[{id:'s',status:'completed',subtotal:132000,discount_amount:2000,total:130000}];
 const items=[{sale_id:'s',product_id:'burger',product_name_snapshot:'Burger',quantity:2,unit_price:37000,sale_unit:'piece',line_total:72879,discount_amount:1121},{sale_id:'s',product_id:'other',product_name_snapshot:'Other',quantity:2,sale_unit:'piece',line_total:57121,discount_amount:879}];
 const before=JSON.stringify({sales,items});
 const grouped=shiftItemGroups(sales,items,[],[]);
 assert.equal(grouped.groups[0].rows.find(r=>r.name==='Burger').amount,74000);
 assert.equal(grouped.groups[0].subtotal,132000);
 assert.deepEqual(historicalReceiptTotals(sales),{gross:132000,discount:2000,net:130000});
 assert.equal(JSON.stringify({sales,items}),before);
});
test('legacy and weighed snapshots use genuine gross, never current catalog prices',()=>{
 assert.equal(historicalLineGross({subtotal:74000,line_total:72879,discount_amount:1121}),74000);
 assert.equal(historicalLineGross({unit_price:200000,quantity:350,sale_unit:'gram'}),70000);
 assert.equal(historicalLineGross({price:37000,quantity:2,sale_unit:'piece'}),74000);
 assert.equal(historicalLineGross({line_total:72879}),null);
 assert.equal(historicalLineGross({unit_price:200000,quantity:350}),null);
 assert.equal(historicalLineGross({line_total:0,discount_amount:0}),0);
 const sale={id:'legacy',status:'completed',items:[{product_id:'p',product_name:'Historic',quantity:2,subtotal:74000}]};
 const result=shiftItemGroups([sale],[],[{id:'p',price:999999}],[]);
 assert.equal(result.groups[0].rows[0].amount,74000);
 assert.deepEqual(historicalReceiptTotals([{status:'completed',total:130000}]),{gross:null,discount:null,net:130000});
});
test('refunds retain original receipt and the page keeps shift values separate',()=>{
 assert.deepEqual(historicalReceiptTotals([{status:'refunded',subtotal:132000,discount_amount:2000,total:130000},{status:'cancelled',subtotal:999,discount_amount:999,total:999}]),{gross:132000,discount:2000,net:130000});
 const code=readFileSync(new URL('../pages/AIHisobot.jsx',import.meta.url),'utf8');
 assert.match(code,/n\(shift.total_sales\)/);assert.match(code,/n\(shift.refunds_total\)/);
 assert.match(code,/CHEGIRMADAN OLDIN/);assert.match(code,/qaytarishdan oldin/);
 assert.doesNotMatch(code,/Asia\/Tashkent ·/);
});
test('page uses existing read-only paths, guards and no AI transmission',()=>{
 const code=readFileSync(new URL('../pages/AIHisobot.jsx',import.meta.url),'utf8');
 assert.match(code,/if\(!owner\|\|!scope\?\.ready\|\|!shopId\)return/);
 assert.match(code,/version===request.current/);assert.match(code,/status:'closed'/);
 assert.match(code,/action:'range'/);assert.match(code,/navigator.clipboard.writeText/);
 assert.doesNotMatch(code,/\.create\(|\.update\(|\.delete\(|asServiceRole|integrations|InvokeLLM|fetch\(/);
});
