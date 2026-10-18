import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { requisitionReceiptLines, requisitionReceiptTotal, tomorrowRequisitionDate } from '../src/lib/ingredient-requisitions.js';
const require=createRequire(import.meta.url);
const source=buildSync({entryPoints:['src/components/warehouse/IngredientRequisitionTicket.jsx'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react-dom'],alias:{'@':resolve('src')}}).outputFiles[0].text;
const mod={exports:{}}; new Function('require','module','exports',source)(require,mod,mod.exports);
const {IngredientRequisitionTicketContent}=mod.exports;
const request={request_number:'EK-20261019-ABC12345',location_name:'Branch',required_date:'2026-10-20',source_kind:'purchase',created_by_name:'Owner',notes:'Ertalab',items:[{ingredient_id:'milk',ingredient_name:'Sut',purchase_unit:'l',category:'food',requested_quantity:10},{ingredient_id:'cup',ingredient_name:'Stakan',purchase_unit:'piece',category:'packaging',requested_quantity:100},{ingredient_id:'other',ingredient_name:'Boshqa masalliq',purchase_unit:'g',category:'unknown',requested_quantity:250}]};
test('thermal ticket contains all requested goods, units and blank ruled money cells',()=>{
 const html=renderToStaticMarkup(React.createElement(IngredientRequisitionTicketContent,{request}));
 for(const text of ['ERTAGA KERAK','Branch','EK-20261019-ABC12345','20.10.2026','Sut','litr','Stakan','dona','Boshqa masalliq','UMUMIY PUL'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/class="ir-write-cell"/g)||[]).length,6);
 assert.equal((html.match(/class="ir-paper-check"/g)||[]).length,3);
 const css=readFileSync('src/components/warehouse/ingredient-requisitions.css','utf8');
 assert.ok(css.includes('width:80mm !important')); assert.ok(css.includes('border:1px solid black')); assert.ok(css.includes('break-inside:avoid'));
});
test('only actual positive quantities are sent and totals use the entered unit price',()=>{
 const values={milk:{quantity:'3.2',unit_price:'18000'},cup:{quantity:'0',unit_price:'1000'},other:{quantity:'',unit_price:''}};
 assert.deepEqual(requisitionReceiptLines(request,values),[{ingredient_id:'milk',quantity:'3.2',unit_price:'18000'}]);
 assert.equal(requisitionReceiptTotal(request,values),57600);
 assert.equal(requisitionReceiptTotal({...request,source_kind:'warehouse'},values),0);
});
test('tomorrow uses Uzbekistan date at the UTC day boundary',()=>{
 assert.equal(tomorrowRequisitionDate(Date.parse('2026-10-18T20:00:00Z')),'2026-10-20');
 assert.equal(tomorrowRequisitionDate(Date.parse('2026-10-18T18:00:00Z')),'2026-10-19');
});
