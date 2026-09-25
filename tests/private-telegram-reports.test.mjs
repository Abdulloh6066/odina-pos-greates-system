// Offline-only regression checks: no Telegram/network, no Base44 data writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

const file = readFileSync('base44/shared/private-telegram-report-logic.ts', 'utf8');
const daily = readFileSync('base44/shared/daily-report-logic.ts', 'utf8');
function moduleFrom(source, dependencies = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})', {})(name => {
    if (!(name in dependencies)) throw Error('Unexpected import ' + name);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const report = moduleFrom(file, { './daily-report-logic.ts': moduleFrom(daily) });
const shops = [
  { id: 'center1', name: 'Odina Central', active: true, allows_pos: true, location_type: 'shop' },
  { id: 'branch2', name: 'Odina Branch', active: true, allows_pos: true, location_type: 'shop' },
  { id: 'factory3', name: 'Production', active: true, allows_pos: false, location_type: 'production' },
];
const owner = '123456789';
const now = Date.parse('2026-09-16T20:30:00Z'); // 17 Sep 01:30 in Uzbekistan
const message = (id, chatId = id, type = 'private', text = '/hisobot') => ({ message: { from: { id }, chat: { id: chatId, type }, text } });
const callback = (id, data, chatId = id, type = 'private') => ({ callback_query: { id: 'cb1', from: { id }, data, message: { chat: { id: chatId, type } } } });

 test('no numeric owner binding fails closed even in a private chat', () => {
  for (const invalid of [undefined, '', 'admin', '@owner', '0', '-1']) {
    assert.equal(report.routePrivateReport(message(owner), invalid, shops, now).kind, 'ignore');
  }
});
test('only matching owner AND private chat may access menu; group always ignored', () => {
  assert.equal(report.routePrivateReport(message(owner), owner, shops, now).kind, 'choose_shop');
  assert.equal(report.routePrivateReport(message(owner, '-99', 'supergroup'), owner, shops, now).kind, 'ignore');
  assert.equal(report.routePrivateReport(message(owner, '99'), owner, shops, now).kind, 'deny');
  assert.equal(report.routePrivateReport(message('7'), owner, shops, now).kind, 'deny');
  assert.equal(report.routePrivateReport(callback(owner, 'pr:p:all:today', '-99', 'group'), owner, shops, now).kind, 'ignore');
});
test('shop keyboard excludes production and uses stored IDs, not guesses', () => {
  const r = report.routePrivateReport(message(owner), owner, shops, now);
  const data = r.keyboard.inline_keyboard.flat().map(x => x.callback_data);
  assert.deepEqual(Array.from(data), ['pr:s:center1', 'pr:s:branch2', 'pr:s:all']);
});
test('shop then period actions are bounded, invalid shop/period are ignored', () => {
  const r = report.routePrivateReport(callback(owner, 'pr:s:center1'), owner, shops, now);
  assert.equal(r.kind, 'choose_period');
  assert.equal(r.keyboard.inline_keyboard.flat().length, 4);
  assert.equal(report.routePrivateReport(callback(owner, 'pr:p:factory3:today'), owner, shops, now).kind, 'ignore');
  assert.equal(report.routePrivateReport(callback(owner, 'pr:p:center1:year'), owner, shops, now).kind, 'ignore');
  assert.equal(report.routePrivateReport(callback(owner, 'pr:s:injected'), owner, shops, now).kind, 'ignore');
  assert.equal(report.routePrivateReport(callback('77', 'pr:p:center1:today'), owner, shops, now).kind, 'deny');
});
test('date range uses Uzbekistan calendar and Monday week start', () => {
  assert.equal(report.periodDates('today', now).from, '2026-09-17');
  assert.equal(report.periodDates('yesterday', now).from, '2026-09-16');
  assert.deepEqual(JSON.parse(JSON.stringify(report.periodDates('week', now))), { from: '2026-09-14', to: '2026-09-17' });
  assert.equal(report.periodDates('month', now).from, '2026-09-01');
});
test('report plan never exposes financial data until authorized selection', () => {
  const r = report.routePrivateReport(callback(owner, 'pr:p:center1:today'), owner, shops, now);
  assert.equal(r.kind, 'report');
  assert.equal(r.shopId, 'center1');
  assert.equal(r.from, '2026-09-17');
});
test('report isolates shop and date, aggregates payment methods and refunds via existing logic', () => {
  const plan = { kind:'report', chatId:owner, shopId:'center1', from:'2026-09-17', to:'2026-09-17', period:'today' };
  const sales = [
    { id:'s1', shop_id:'center1', business_date:'2026-09-17', status:'completed', total:100000, payments:[{method:'cash',amount:60000},{method:'uzcard',amount:40000}] },
    { id:'s2', shop_id:'center1', business_date:'2026-09-17', status:'refunded', total:20000, payments:[{method:'cash',amount:20000}] },
    { id:'s3', shop_id:'branch2', business_date:'2026-09-17', status:'completed', total:800000, payments:[] },
    { id:'s4', shop_id:'center1', business_date:'2026-09-16', status:'completed', total:999999, payments:[] },
  ];
  const items = [{sale_id:'s1',total_cost_at_sale:20000},{sale_id:'s2',total_cost_at_sale:5000},{sale_id:'s3',total_cost_at_sale:1}];
  const text = report.renderPrivateReport(plan, shops, sales, items);
  assert.match(text, /80,000 so‘m/);
  assert.match(text, /40,000 so‘m/);
  assert.match(text, /65,000 so‘m/);
  assert.match(text, /Qaytarishlar: 1/);
  assert.doesNotMatch(text, /800,000|999,999|Production|Odina Branch/);
  assert.match(text, /Bu sof foyda emas/);
});
test('Bank card and Online appear in the owner report without losing split payment totals', () => {
  const plan = { kind:'report', chatId:owner, shopId:'center1', from:'2026-09-17', to:'2026-09-17', period:'today' };
  const sales = [{
    id:'new-payment', shop_id:'center1', business_date:'2026-09-17',
    status:'completed', total:100000,
    payments:[{method:'bank_card',amount:60000},{method:'online',amount:40000}],
  }];
  const text = report.renderPrivateReport(plan, shops, sales, []);
  assert.match(text, /Bank card\/Uzcard: 60,000 so‘m/);
  assert.match(text, /Online: 40,000 so‘m/);
  assert.match(text, /Tushum: 100,000 so‘m/);
});

test('all-shop report totals only POS shops; no live network or writes exist in module', () => {
  const plan = { kind:'report', chatId:owner, shopId:'all', from:'2026-09-17', to:'2026-09-17', period:'today' };
  const sales = [
    { id:'s1', shop_id:'center1', business_date:'2026-09-17', status:'completed', total:100, payments:[] },
    { id:'s2', shop_id:'branch2', business_date:'2026-09-17', status:'completed', total:200, payments:[] },
    { id:'s3', shop_id:'factory3', business_date:'2026-09-17', status:'completed', total:9000, payments:[] },
  ];
  const text = report.renderPrivateReport(plan, shops, sales, []);
  assert.match(text, /JAMI: 300 so‘m · 2 ta savdo/);
  assert.doesNotMatch(text, /Production|9,000/);
  assert.doesNotMatch(file, /(?:\bfetch\s*\(|Deno\.serve|\.create\(|\.update\(|setWebhook)/);
});
