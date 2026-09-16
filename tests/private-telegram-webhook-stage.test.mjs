// Staged integration: completely offline, no HTTP/Telegram, no live Base44 writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
function mod(path, imports = {}) {
  const js = ts.transpileModule(readFileSync(path, 'utf8'), {compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const module = {exports:{}};
  vm.runInNewContext('(function(require,module,exports){'+js+'\n})', {})(key => {
    assert.ok(key in imports, 'Unexpected import '+key); return imports[key];
  }, module, module.exports);
  return module.exports;
}
const daily = mod('base44/shared/daily-report-logic.ts');
const logic = mod('base44/shared/private-telegram-report-logic.ts', {'./daily-report-logic.ts':daily});
const stageSource = readFileSync('base44/shared/private-telegram-webhook-stage.ts','utf8');
const stage = mod('base44/shared/private-telegram-webhook-stage.ts', {'./private-telegram-report-logic.ts':logic});
const owner = '123456789';
const now = Date.parse('2026-09-16T11:00:00Z');
const shops = [
  {id:'central',name:'Odina Central',location_type:'shop',allows_pos:true,active:true},
  {id:'branch',name:'Odina Branch',location_type:'shop',allows_pos:true,active:true},
  {id:'warehouse',name:'Warehouse',location_type:'production',allows_pos:false,active:true},
];
const sales = [
  {id:'saleA',shop_id:'central',business_date:'2026-09-16',status:'completed',total:150000,payments:[{method:'cash',amount:150000}]},
  {id:'saleB',shop_id:'branch',business_date:'2026-09-16',status:'completed',total:900000,payments:[]},
  {id:'saleOld',shop_id:'central',business_date:'2026-09-15',status:'completed',total:999999,payments:[]},
];
function fixture() {
  const reads=[]; const writes=[];
  const data={Shop:shops,Sale:sales,SaleItem:[{id:'itemA',sale_id:'saleA',total_cost_at_sale:50000}]};
  const matches=(row,q)=>Object.entries(q).every(([key,val])=>val && typeof val==='object' ?
    ('$in' in val ? val.$in.includes(row[key]) : ('$gte' in val && '$lte' in val && row[key]>=val.$gte && row[key]<=val.$lte)) : row[key]===val);
  const service={entities:Object.fromEntries(Object.keys(data).map(key=>[key,{
    filter:async(query,sort,limit,skip)=>{reads.push({key,query}); return structuredClone(data[key].filter(row=>matches(row,query)).slice(skip,skip+limit));},
    create:async()=>{writes.push(key);throw Error('unexpected write');},update:async()=>{writes.push(key);throw Error('unexpected write');}
  }]))};
  return {reads,writes,run:(update,id=owner)=>stage.preparePrivateTelegramReply(update,{ownerId:id,service,now})};
}
const message=(id=owner,chat=id,type='private',text='/hisobot')=>({message:{from:{id},chat:{id:chat,type},text}});
const callback=(data,id=owner,chat=id,type='private')=>({callback_query:{id:'callback-1',data,from:{id},message:{chat:{id:chat,type}}}});
test('missing owner binding, group and foreign user do not even read shops',async()=>{
  for(const [update,id] of [[message(),null],[message(owner,'-5','supergroup'),owner],[message('888'),owner],[callback('pr:p:central:today',owner,'-5','group'),owner],[message(owner,'111'),owner]]) {
    const f=fixture(); assert.equal((await f.run(update,id)).kind,'ignore'); assert.equal(f.reads.length,0); assert.equal(f.writes.length,0);
  }
});
test('start and report command return only POS shop options in owner private chat',async()=>{
  for(const command of ['/start','/hisobot']) {
    const f=fixture(); const r=await f.run(message(owner,owner,'private',command));
    assert.equal(r.kind,'message'); assert.equal(r.chatId,owner);
    assert.deepEqual(Array.from(r.replyMarkup.inline_keyboard.flat().map(b=>b.callback_data)),['pr:s:central','pr:s:branch','pr:s:all']);
    assert.equal(f.reads.length,1); assert.equal(f.writes.length,0);
  }
});
test('private shop button offers period; unknown callback never fetches sales',async()=>{
  const f=fixture(); const r=await f.run(callback('pr:s:branch'));
  assert.equal(r.kind,'message');assert.match(r.text,/davr/);assert.equal(r.callbackId,'callback-1');
  assert.equal(f.reads.filter(r=>r.key==='Sale').length,0);
  const bad=fixture();assert.equal((await bad.run(callback('pr:s:warehouse'))).kind,'ignore');
  assert.equal(bad.reads.filter(r=>r.key==='Sale').length,0);
});
test('owner private report fetches only selected shop/date and renders existing metrics',async()=>{
  const f=fixture();const r=await f.run(callback('pr:p:central:today'));
  assert.equal(r.kind,'message');assert.equal(r.chatId,owner);
  assert.match(r.text,/150,000 so‘m/);assert.match(r.text,/100,000 so‘m/);
  assert.doesNotMatch(r.text,/900,000|999,999|Warehouse|Odina Branch/);
  const saleQuery=f.reads.find(x=>x.key==='Sale').query;
  assert.equal(saleQuery.business_date.$gte,'2026-09-16'); assert.equal(saleQuery.business_date.$lte,'2026-09-16');
  assert.deepEqual(Array.from(saleQuery.shop_id.$in),['central']);
  assert.deepEqual(Array.from(f.reads.find(x=>x.key==='SaleItem').query.sale_id.$in),['saleA']);
  assert.equal(f.writes.length,0);
});
test('no sender from forwarded/group messages may leak data and staged code has no live side effects',async()=>{
  const f=fixture();const forged={message:{chat:{id:owner,type:'private'},text:'/hisobot'}};
  assert.equal((await f.run(forged)).kind,'ignore');assert.equal(f.reads.length,0);
  assert.doesNotMatch(stageSource,/\b(?:fetch|Deno\.serve|setWebhook|sendMessage)\s*\(/);
  const webhook=readFileSync('base44/functions/telegram-webhook/entry.ts','utf8');
  assert.match(webhook,/preparePrivateTelegramReply/);
  assert.match(webhook,/if \(privateChat\)/);
  assert.match(webhook,/String\(cb\.message\?\.chat\?\.id \|\| ""\) !== String\(TELEGRAM_GROUP_ID\)/);
  const setup=readFileSync('base44/functions/telegram-setup/entry.ts','utf8');
  assert.match(setup,/allowed_updates: \["callback_query", "message"\]/);
  const alerts=readFileSync('base44/functions/telegram-alerts/entry.ts','utf8');
  assert.match(alerts,/allowed_updates: \["callback_query", "message"\]/);
});
test('/id reveals only the requester own numeric ID in a private chat, never authorizes reports',async()=>{
  const f=fixture();
  const r=await f.run(message('888','888','private','/id'),null);
  assert.equal(r.kind,'message');assert.equal(r.chatId,'888');assert.match(r.text,/User ID: 888/);
  assert.doesNotMatch(r.text,/Odina Central|Tushum|150,000/);
  assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
  assert.equal((await f.run(message('888','-5','group','/id'),null)).kind,'ignore');
  assert.equal((await f.run(message('888','999','private','/id'),null)).kind,'ignore');
  assert.equal((await f.run({message:{chat:{id:'888',type:'private'},text:'/id'}},null)).kind,'ignore');
  assert.equal((await f.run(message('888','888','private','/hisobot'),null)).kind,'ignore');
});
