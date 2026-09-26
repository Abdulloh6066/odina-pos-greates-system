// Full webhook offline smoke tests. No real Telegram HTTP or database changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import vm from 'node:vm';

function load(path, imports = {}, globals = {}) {
  const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports:{} };
  vm.runInNewContext('(function(require,module,exports){'+js+'\n})', globals)(name => {
    assert.ok(name in imports, 'unexpected import: '+name);
    return imports[name];
  }, mod, mod.exports);
  return mod.exports;
}
const daily=load('base44/shared/daily-report-logic.ts');
const reports=load('base44/shared/private-telegram-report-logic.ts', {'./daily-report-logic.ts':daily});
const activity=load('base44/shared/report-activity.ts');
const stage=load('base44/shared/private-telegram-webhook-stage.ts', {'./private-telegram-report-logic.ts':reports, './report-activity.ts':activity});
const telegramLogic=load('base44/shared/telegram-alert-logic.ts');
const token='OFFLINE_SECRET_TOKEN_NOT_TO_EXPOSE';
const secret=Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
const id='123456789';
const incoming=(text='/id',sender=id,chat=sender,type='private')=>({message:{text,from:{id:sender},chat:{id:chat,type}}});
function fixture({owner='',staffIds='',sdkThrows=false,sendFails=false,secretHeader=secret}={}) {
  let handler;let sdkCalls=0;
  const calls=[]; const logs=[]; const updates=[];
  const globals={Response,AbortSignal,Date,TextEncoder,crypto:webcrypto,console:{error:(...args)=>logs.push(args)},
    Deno:{env:{get:key=>key==='TELEGRAM_BOT_TOKEN'?token:key==='TELEGRAM_OWNER_USER_ID'?owner:key==='TELEGRAM_BIRTHDAY_STAFF_IDS'?staffIds:undefined},serve:fn=>{handler=fn;}},
    fetch:async(url,init)=>{
      const method=url.split('/').at(-1);const data=JSON.parse(init.body);
      calls.push({method,data});
      if(sendFails) throw Error('secret '+token);
      return {ok:true,json:async()=>({ok:true,result:{message_id:2}})};
    },
  };
  load('base44/functions/telegram-webhook/entry.ts',{
    'npm:@base44/sdk': { createClientFromRequest: () => {
      sdkCalls++;
      if (sdkThrows) throw Error('No Base44 session');
      return { asServiceRole: { entities: {
        Shop: { filter: async () => [] },
        BirthdayFollowup: {
          get: async () => ({ id:'followup-1', customer_name_snapshot:'Customer', contact_status:'hali_aloqa_qilinmadi' }),
          update: async (id,data) => { updates.push({id,data}); return {id,...data}; },
        },
        ActionHistory: { create: async (data) => { updates.push({audit:data}); } },
      } } };
    } },
    '../../shared/telegram-alert-logic.ts':telegramLogic,
    '../../shared/private-telegram-webhook-stage.ts':stage,
  },globals);
  return {calls,logs,updates,get sdkCalls(){return sdkCalls;},async run(update,header=secretHeader){
    const response=await handler({headers:{get:()=>header},json:async()=>update});
    assert.equal(response.status,200);
    return response;
  }};
}
test('/id replies to sender without SDK session, owner binding or DB reads',async()=>{
  const f=fixture({sdkThrows:true}); await f.run(incoming());
  assert.equal(f.sdkCalls,0);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].method,'sendMessage');assert.equal(String(f.calls[0].data.chat_id),id);
  assert.match(f.calls[0].data.text,/User ID: 123456789/);
  assert.doesNotMatch(JSON.stringify(f.calls),/OFFLINE_SECRET_TOKEN|Tushum|150,000/);
});
test('malformed webhook secret, groups, forwarded/mismatched ID cannot get any /id response',async()=>{
  const wrong=fixture({secretHeader:'incorrect'});await wrong.run(incoming());assert.equal(wrong.calls.length,0);
  const f=fixture();
  await f.run(incoming('/id',id,'-99','group'));
  await f.run(incoming('/id',id,'888'));
  await f.run({message:{text:'/id',chat:{id,type:'private'}}});
  assert.equal(f.calls.length,0);assert.equal(f.sdkCalls,0);
});
test('unbound /hisobot never opens SDK or sends; owner bound can show menu',async()=>{
  const unbound=fixture({sdkThrows:true});await unbound.run(incoming('/hisobot'));
  assert.equal(unbound.calls.length,0);assert.equal(unbound.sdkCalls,0);
  const bound=fixture({owner:id});await bound.run(incoming('/hisobot'));
  assert.equal(bound.sdkCalls,1);assert.equal(bound.calls.length,1);
  assert.match(bound.calls[0].data.text,/do‘konni tanlang/);
});
const birthday=(sender,chat=telegramLogic.TELEGRAM_GROUP_ID)=>({callback_query:{id:'callback-1',data:'bd:followup-1:ok',from:{id:sender,first_name:'Staff'},message:{chat:{id:chat,type:'supergroup'},message_id:42,text:'Birthday reminder'}}});
test('birthday group button refuses unauthorized users before DB read/write',async()=>{
  const f=fixture({owner:id,staffIds:'555, 666'});
  await f.run(birthday('999'));
  assert.equal(f.sdkCalls,0);assert.equal(f.updates.length,0);
  assert.equal(f.calls[0].method,'answerCallbackQuery');
  assert.match(f.calls[0].data.text,/ruxsat berilmagan/);
});
test('birthday group button allows verified owner and approved staff only',async()=>{
  for(const sender of [id,'555','666']) {
    const f=fixture({owner:id,staffIds:'555, 666, bad, 0'});
    await f.run(birthday(sender));
    assert.equal(f.sdkCalls,1);
    assert.equal(f.updates.filter(x=>x.id==='followup-1').length,1);
    assert.equal(f.updates.find(x=>x.id==='followup-1').data.contacted_by_id,sender);
  }
});
test('birthday button fails closed when no IDs, wrong group or bot sender',async()=>{
  const f=fixture();await f.run(birthday(id));assert.equal(f.sdkCalls,0);assert.equal(f.updates.length,0);
  const outside=fixture({owner:id});await outside.run(birthday(id,'-999'));assert.equal(outside.sdkCalls,0);
  const bot=fixture({owner:id});const update=birthday(id);update.callback_query.from.is_bot=true;
  await bot.run(update);assert.equal(bot.sdkCalls,0);assert.equal(bot.updates.length,0);
});
test('send failure logged as fixed error code only; never exposes bot token',async()=>{
  const f=fixture({sendFails:true,sdkThrows:true});await f.run(incoming());
  assert.equal(f.sdkCalls,0);assert.equal(f.calls.length,1);
  assert.deepEqual(f.logs.flat(),['ODINA_TELEGRAM_PRIVATE_HANDLER_FAILED']);
  assert.doesNotMatch(JSON.stringify(f.logs),/OFFLINE_SECRET_TOKEN/);
});
