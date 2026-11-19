import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isReportOwner,reportIntent,reportNumber,shiftItemGroups} from '../lib/ai-report.js';
test('only active stored owner admin can use the page',()=>{assert.equal(isReportOwner({role:'admin',is_owner:true}),true);for(const u of [{role:'admin'},{role:'manager',is_owner:true},{role:'admin',is_owner:true,active:false},null])assert.equal(isReportOwner(u),false);});
test('bounded intent and unknown amounts',()=>{assert.equal(reportIntent('last shift'),'shift');assert.equal(reportIntent('bugun'),'today');assert.equal(reportIntent('delete all sales'),null);assert.equal(reportNumber(null),'noma’lum');assert.equal(reportNumber(undefined),'noma’lum');assert.equal(reportNumber(0),'0');});
test('snapshots, unit separation, category order, cancelled exclusion, incomplete rows',()=>{
 const sales=[{id:'1',status:'completed'},{id:'2',status:'cancelled'},{id:'3',status:'refunded'},{id:'4',status:'completed'}];
 const items=[{sale_id:'1',product_id:'p',product_name_snapshot:'Old cake',quantity:2,line_total:20},{sale_id:'1',product_id:'p',product_name_snapshot:'Old cake',sale_unit:'gram',quantity:150,line_total:15},{sale_id:'2',quantity:999,line_total:999},{sale_id:'3',category_name_snapshot:'Ichimliklar',quantity:1,line_total:10},{sale_id:'1',category_name_snapshot:'Taomlar',quantity:1,line_total:8}];
 const result=shiftItemGroups(sales,items,[{id:'p',category_id:'c',name:'New name'}],[{id:'c',name:'Tortlar'}]);
 assert.equal(result.missing,1);assert.deepEqual(result.groups.map(g=>g.name),['Tortlar','Taomlar','Ichimliklar']);assert.equal(result.groups[0].rows.length,2);assert.equal(result.groups[0].subtotal,35);assert.equal(result.groups[0].rows[0].name,'Old cake');assert.equal(result.groups[2].subtotal,10);
 const missing=shiftItemGroups([{id:'1',status:'completed'}],[{sale_id:'1',quantity:1}],[],[]);assert.equal(missing.groups[0].subtotal,null);
});
test('page uses existing read-only paths, guards and no AI transmission',()=>{
 const code=readFileSync(new URL('../pages/AIHisobot.jsx',import.meta.url),'utf8');
 assert.match(code,/if\(!owner\|\|!scope\?\.ready\|\|!shopId\)return/);
 assert.match(code,/version===request.current/);assert.match(code,/status:'closed'/);
 assert.match(code,/action:'range'/);assert.match(code,/navigator.clipboard.writeText/);
 assert.doesNotMatch(code,/\.create\(|\.update\(|\.delete\(|asServiceRole|integrations|InvokeLLM|fetch\(/);
});
