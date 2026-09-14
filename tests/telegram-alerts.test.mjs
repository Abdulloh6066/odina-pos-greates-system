import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
const NOW = Date.parse('2026-09-13T14:00:00Z');
const source = ['base44/shared/user-helpers.ts', 'base44/shared/production-forecast-logic.ts', 'base44/shared/telegram-alert-logic.ts', 'base44/functions/telegram-alerts/entry.ts']
  .map(p => readFileSync(p, 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '')).join('\n');
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
const baseOrder = { id:'o1', order_number:'BO-001', order_status:'qabul_qilindi', required_date:'2026-09-13', required_time:'19:30', shop_name_snapshot:'Odina Main', total:987654321, remaining_balance:123456789, customer_phone:'SECRET_PHONE', notes:'SECRET_NOTES', customer_name:'SECRET_NAME' };

function fixture(opts = {}) {
  let handler, uuid = 0;
  const sent = [], writes = [];
  const db = {
    User:[{ id:'stored-owner', email:'owner@odinatort.uz', role:opts.role || 'admin', active: opts.active !== false }],
    TelegramControl:[{ id:'control', key:'odina-work-group', enabled:opts.enabled !== false, lock_until:0, lock_token:'' }],
    TelegramDelivery:[], CustomerOrder:opts.orders || [{...baseOrder}], Customer:[], BirthdayFollowup:[], Shop:[], Product:[], Recipe:[], RecipeItem:[], CustomerOrderItem:[], IngredientStock:[],
    ...opts.db,
  };
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object') {
      if ('$in' in value) return Array.isArray(row[key]) ? row[key].some(x => value.$in.includes(x)) : value.$in.includes(row[key]);
      if ('$lte' in value) return row[key] <= value.$lte;
    }
    return row[key] === value;
  });
  const entities = Object.fromEntries(Object.keys(db).map(name => [name, {
    get: async id => structuredClone(db[name].find(r => r.id === id)),
    list: async (_sort, limit = 500) => structuredClone(db[name].slice(0, limit)),
    filter: async (query, _sort, limit = 500, skip = 0) => structuredClone(db[name].filter(r => matches(r, query)).slice(skip, skip + limit)),
    create: async values => {
      writes.push(name); const row = { ...structuredClone(values), id:'new-' + db[name].length }; db[name].push(row); return structuredClone(row);
    },
    update: async (id, values) => {
      writes.push(name);
      if (opts.failSave && name === 'TelegramDelivery' && values.status === 'sent') throw new Error('save failure');
      Object.assign(db[name].find(r => r.id === id), structuredClone(values));
    },
    updateMany: async (query, update) => {
      writes.push(name);
      const rows = db[name].filter(r => matches(r, query));
      rows.forEach(r => Object.assign(r, structuredClone(update.$set)));
      return { success:true, updated:rows.length };
    },
  }]));
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [opts.now || NOW])); } static now() { return opts.now || NOW; } }
  const context = { Response, AbortSignal, Date:Clock, crypto:{randomUUID:()=>String(++uuid)},
    createClientFromRequest:()=>({auth:{me:async()=>opts.unauth ? null : ({id:opts.authId || 'stored-owner',email:'owner@odinatort.uz',role:'admin'})},asServiceRole:{entities}}),
    Deno:{env:{get:()=>opts.missing ? undefined : 'PRIVATE_TOKEN'},serve:fn=>{handler=fn;}},
    fetch:async (url, init) => {
      const body=JSON.parse(init.body); sent.push(body);
      if(opts.failSend) throw new Error(url);
      return { ok:!opts.reject, json:async()=>opts.reject ? ({ok:false}) : ({ok:true,result:{message_id:77}}) };
    },
  };
  vm.runInNewContext(js, context);
  return {db,sent,writes,async run(body={}) {
    const response = await handler({json:async()=>body});
    const data = await response.json();
    assert.equal(JSON.stringify(data).includes('PRIVATE_TOKEN'), false);
    return {status:response.status,data};
  }};
}

test('stored non-admin and inactive admin cannot send', async()=>{
  for(const opts of [{role:'cashier'},{active:false},{unauth:true}]) {
    const f=fixture(opts); const r=await f.run(); assert.ok([401,403].includes(r.status)); assert.equal(f.sent.length,0); assert.equal(f.writes.length,0);
  }
});
test('auth ID mismatch resolves the stored admin by exact email', async()=>{
  const f=fixture({authId:'different-auth-id'}); const r=await f.run({action:'preview'});
  assert.equal(r.status,200); assert.equal(f.sent.length,0); assert.equal(f.writes.length,0);
});
test('preview has no mutations or external sends and strips financial/customer data',async()=>{
  const f=fixture(); const r=await f.run({action:'preview'}); assert.equal(r.status,200);
  assert.equal(f.writes.length,0); assert.equal(f.sent.length,0); assert.match(r.data.text,/BO-001/);
  for(const value of ['987654321','123456789','SECRET_PHONE','SECRET_NAME','SECRET_NOTES']) assert.equal(r.data.text.includes(value),false);
});
test('first run sends; retries and concurrent runs do not duplicate', async()=>{
  const f=fixture(); await Promise.all([f.run(),f.run()]); await f.run();
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].chat_id,'-5570444945');
  assert.equal(f.db.TelegramDelivery[0].status,'sent');
  assert.ok(f.writes.every(n=>['TelegramControl','TelegramDelivery'].includes(n)));
});
test('paused setting and missing token prevent delivery', async()=>{
  for(const opts of [{enabled:false},{missing:true}]) {const f=fixture(opts);await f.run();assert.equal(f.sent.length,0);assert.equal(f.db.TelegramDelivery.length,0);}
});
test('terminal, future and invalid-date orders excluded; overdue first',async()=>{
  const orders=['bekor_qilindi','yakunlandi','yuborildi_olib_ketildi'].map((order_status,i)=>({...baseOrder,id:'closed'+i,order_status}));
  orders.push({...baseOrder,id:'future',required_time:'22:01'}, {...baseOrder,id:'invalid',required_date:'2026-02-31'},
    {...baseOrder,id:'late',order_number:'LATE',required_time:'18:30'}, {...baseOrder});
  const f=fixture({orders});const r=await f.run({action:'preview'});
  assert.equal(r.data.pending,2);assert.ok(r.data.text.indexOf('LATE')<r.data.text.indexOf('BO-001'));
});
test('lost Telegram response is recorded and never auto-retried',async()=>{
  const f=fixture({failSend:true}); await f.run();await f.run();
  assert.equal(f.sent.length,1);assert.equal(f.db.TelegramDelivery[0].status,'uncertain');
});
test('failure saving sent receipt cannot cause duplicate delivery',async()=>{
  const f=fixture({failSave:true});await f.run();await f.run();
  assert.equal(f.sent.length,1);assert.equal(f.db.TelegramDelivery[0].status,'uncertain');
});
test('explicit Telegram rejection is visible and not retried repeatedly',async()=>{
  const f=fixture({reject:true});await f.run();await f.run();
  assert.equal(f.sent.length,1);assert.equal(f.db.TelegramDelivery[0].status,'rejected');
});
test('unknown action and duplicate control fail closed',async()=>{
  const f=fixture(); assert.equal((await f.run({action:'arbitrary'})).status,400);
  f.db.TelegramControl.push({...f.db.TelegramControl[0],id:'duplicate'});
  assert.equal((await f.run()).status,409);assert.equal(f.sent.length,0);
});
test('batch size bounded and remaining orders sent on next run',async()=>{
  const orders=Array.from({length:12},(_,i)=>({...baseOrder,id:'o'+i,order_number:'BO-'+i}));
  const f=fixture({orders});await f.run();await f.run();await f.run();
  assert.equal(f.sent.length,2);assert.ok(f.sent.every(s=>s.text.length<=4096));
});
test('evening forecast reuses recipes and only sends once per date',async()=>{
  const db={
    Shop:[{id:'central',location_type:'production',is_main:true,name:'Central'}],
    Product:[{id:'cake',source_type:'central_produced',production_unit:'piece',name:'Cake'}],
    Recipe:[{id:'recipe',product_id:'cake',active:true,output_quantity:1,output_unit:'piece'}],
    RecipeItem:[{id:'ri',recipe_id:'recipe',ingredient_id:'sugar',ingredient_name_snapshot:'Shakar',quantity:100,unit:'g'}],
    IngredientStock:[{id:'stock',ingredient_id:'sugar',location_id:'central',unit:'g',quantity:50}],
    CustomerOrderItem:[{id:'line',order_id:'tomorrow',product_id:'cake',quantity:2,unit_snapshot:'piece'}],
  };
  const orders=[{...baseOrder,id:'tomorrow',required_date:'2026-09-14'}];
  const morning=fixture({db,orders,now:Date.parse('2026-09-13T12:59:00Z')});await morning.run();assert.equal(morning.sent.length,0);
  const f=fixture({db,orders});await f.run();await f.run();
  assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/150 g yetishmaydi/);assert.match(f.sent[0].text,/2026-09-14/);
});

test('3h then 1h then overdue each sent once across repeated checks', async()=>{
  const due=Date.parse('2026-09-13T14:30:00Z');
  const opts={now:due-3*3600000-1};
  const f=fixture(opts);
  await f.run();assert.equal(f.sent.length,0);
  opts.now=due-3*3600000;await f.run();await f.run();
  assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/3 soat/);
  opts.now=due-3600000;await f.run();await f.run();
  assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/Shoshiling/);
  assert.match(f.db.TelegramDelivery[1].keys[0],/:due_soon$/);
  opts.now=due+1;await f.run();await f.run();
  assert.equal(f.sent.length,3);assert.match(f.sent[2].text,/kechikdi/);
});
test('late first check skips stale 3h alert and prioritizes urgent orders',async()=>{
  const f=fixture({orders:[{...baseOrder,id:'three',order_number:'THREE',required_time:'22:00'}, {...baseOrder,id:'soon',order_number:'SOON'}, {...baseOrder,id:'late',order_number:'LATE',required_time:'18:00'}]});
  await f.run();const text=f.sent[0].text;
  assert.ok(text.indexOf('LATE')<text.indexOf('SOON'));
  assert.ok(text.indexOf('SOON')<text.indexOf('THREE'));
  const keys=f.db.TelegramDelivery[0].keys;
  assert.equal(keys.filter(k=>k.includes(':soon:')).length,1);
  assert.ok(keys.find(k=>k.includes(':soon:')).endsWith(':due_soon'));
});

test('birthday reminder includes 0-3 day window, excludes aloqa_chiqildi, dedups per day', async()=>{
  const customers=[
    {id:'today',first_name:'Bugun',last_name:'Kun',phone:'+998900000001',birth_date:'1990-09-13'},
    {id:'tomorrow',first_name:'Ertaga',last_name:'Kun',phone:'+998900000002',birth_date:'1992-09-14'},
    {id:'twoDays',first_name:'Ikki',phone:'+998900000003',birth_date:'1994-09-15'},
    {id:'threeDays',first_name:'Dilnoza',last_name:'Test',phone:'+998900000004',birth_date:'1990-09-16'},
    {id:'fourDays',first_name:'Keyin',phone:'+998900000005',birth_date:'1994-09-17'},
  ];
  const f=fixture({db:{Customer:customers}});
  await f.run({action:'birthdays'});
  await f.run({action:'birthdays'});
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].chat_id,'-5570444945');
  assert.match(f.sent[0].text,/Bugun Kun/);
  assert.match(f.sent[0].text,/Ertaga Kun/);
  assert.match(f.sent[0].text,/Ikki/);
  assert.match(f.sent[0].text,/Dilnoza Test/);
  assert.equal(f.sent[0].text.includes('Keyin'),false);
  assert.match(f.sent[0].text,/Jami bog'lanish kerak: 4/);
  assert.deepEqual(f.db.TelegramDelivery[0].keys.sort(),
    ['birthday:today:2026-09-13','birthday:tomorrow:2026-09-14','birthday:twoDays:2026-09-15','birthday:threeDays:2026-09-16'].sort());
  // Follow-ups were created with default status
  assert.equal(f.db.BirthdayFollowup.length,4);
  assert.equal(f.db.BirthdayFollowup[0].contact_status,'hali_aloqa_qilinmadi');
  // Inline keyboard attached: one row per customer, callback_data encodes followup id + action
  const kb = f.sent[0].reply_markup?.inline_keyboard;
  assert.ok(Array.isArray(kb) && kb.length === 4);
  assert.equal(kb[0].length, 2);
  assert.match(kb[0][0].callback_data, /^bd:new-\d+:no$/);
  assert.match(kb[0][1].callback_data, /^bd:new-\d+:ok$/);
  assert.match(kb[0][0].text, /Javob yo'q/);
  assert.match(kb[0][1].text, /Aloqa/);
});

test('birthday send excludes aloqa_chiqildi and includes hali + qongiroq', async()=>{
  const customers=[
    {id:'a',first_name:'Ali',phone:'+998900000001',birth_date:'1990-09-13'},
    {id:'b',first_name:'B',phone:'+998900000002',birth_date:'1990-09-13'},
  ];
  const f=fixture({db:{Customer:customers, BirthdayFollowup:[
    {id:'fu1',customer_id:'a',campaign_year:2026,contact_status:'aloqa_chiqildi',contacted_at:'2026-09-13T10:00:00Z',contacted_by_name:'Owner'},
    {id:'fu2',customer_id:'b',campaign_year:2026,contact_status:'qongiroq_javob_bolmadi',contacted_at:'2026-09-13T10:00:00Z',contacted_by_name:'Owner'},
  ]}});
  await f.run({action:'birthdays'});
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].text.includes('Ali'),false);
  assert.match(f.sent[0].text,/B/);
  assert.match(f.sent[0].text,/Qo'ng'iroq qilindi, javob bo'lmadi/);
  assert.match(f.sent[0].text,/Jami bog'lanish kerak: 1/);
});

test('birthday no eligible customers returns non-error message', async()=>{
  const f=fixture({db:{Customer:[{id:'far',first_name:'Far',phone:'+998900',birth_date:'1990-09-20'}]}});
  const r=await f.run({action:'birthdays'});
  assert.equal(r.status,200);
  assert.equal(f.sent.length,0);
  assert.equal(r.data.sent,false);
  assert.match(r.data.message,/Yaqin 3 kun ichida bog'lanish kerak bo'lgan mijoz topilmadi/);
});

test('birthday telegram failure returns safe error without secrets', async()=>{
  const f=fixture({reject:true});
  f.db.Customer=[{id:'a',first_name:'Ali',phone:'+998900',birth_date:'1990-09-13'}];
  const r=await f.run({action:'birthdaySend'});
  assert.equal(r.status,502);
  assert.equal(JSON.stringify(r.data).includes('PRIVATE_TOKEN'),false);
  assert.equal(r.data.error.includes('chat_id'),false);
  assert.equal(r.data.error.includes('-5570444945'),false);
});

test('birthdayList creates followups and returns counters', async()=>{
  const customers=[
    {id:'a',first_name:'Ali',phone:'+998900000001',birth_date:'1990-09-13'},
    {id:'b',first_name:'B',phone:'+998900000002',birth_date:'1990-09-14'},
  ];
  const f=fixture({db:{Customer:customers}});
  const r=await f.run({action:'birthdayList'});
  assert.equal(r.status,200);
  assert.equal(r.data.counters.total,2);
  assert.equal(r.data.counters.need_contact,2);
  assert.equal(f.db.BirthdayFollowup.length,2);
});

test('birthdayContact admin-only upserts status and records who/when', async()=>{
  const customers=[{id:'a',first_name:'Ali',phone:'+998900000001',birth_date:'1990-09-13'}];
  const f=fixture({db:{Customer:customers}});
  const r=await f.run({action:'birthdayContact',customer_id:'a',campaign_year:2026,contact_status:'aloqa_chiqildi'});
  assert.equal(r.status,200);
  assert.equal(f.db.BirthdayFollowup[0].contact_status,'aloqa_chiqildi');
  assert.equal(f.db.BirthdayFollowup[0].contacted_by_id,'stored-owner');
  assert.ok(f.db.BirthdayFollowup[0].contacted_at);
});

test('birthdayContact is rejected for non-admin', async()=>{
  const f=fixture({role:'cashier'});
  f.db.Customer=[{id:'a',first_name:'Ali',phone:'+998900',birth_date:'1990-09-13'}];
  const r=await f.run({action:'birthdayContact',customer_id:'a',campaign_year:2026,contact_status:'aloqa_chiqildi'});
  assert.equal(r.status,403);
  assert.equal(f.db.BirthdayFollowup.length,0);
});

test('existing order and production alerts remain unchanged', async()=>{
  const f=fixture();
  const r=await f.run({action:'preview'});
  assert.equal(r.status,200);
  assert.match(r.data.text,/BO-001/);
  assert.equal(f.sent.length,0);
});

test('birthday workflow stays daily at 09:00 and UI has the renamed manual send button',()=>{
  const workflow=JSON.parse(readFileSync('base44/workflows/Birthday Telegram.jsonc','utf8'));
  assert.equal(workflow.trigger.config.cron_expression,'0 9 * * *');
  assert.equal(workflow.trigger.config.timezone,'Asia/Tashkent');
  const ui=readFileSync('src/components/TelegramAlerts.jsx','utf8');
  assert.match(ui,/request\('birthdaySend'\)/);
  assert.match(ui,/Tug‘ilgan kunlarni tekshirish va Telegramga yuborish/);
});