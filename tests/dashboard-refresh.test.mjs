// Offline lifecycle regression: executes the actual dashboard refresh effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/pages/Dashboard.jsx', 'utf8');
const start = source.indexOf('  useEffect(() => {', source.indexOf('// One preview'));
const end = source.indexOf('  }, [role, user?.id, assignedShopId]);', start);
const effect = source.slice(start, end + '  }, [role, user?.id, assignedShopId]);'.length);
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(time = '2026-10-06T12:00:00Z') {
  let now = Date.parse(time), cleanup, nextId = 0;
  const timers = new Map(), listeners = new Map(), requests = [], state = {};
  const target = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  const doc = { ...target, visibilityState: 'visible' }, nav = { onLine: true };
  const dateKey = () => new Date(now + 5 * 3600000).toISOString().slice(0, 10);
  function open(role = 'admin', id = 'first') {
    cleanup?.();
    vm.runInNewContext(effect, {
      role, user: { id }, assignedShopId: id, document: doc, navigator: nav, window: target,
      Date: { now: () => now, parse: Date.parse }, tashkentDateKey: dateKey,
      setBusinessDate: v => { state.day = v; }, setDailyReports: v => { state.reports = v; },
      setReportError: v => { state.error = v; }, useEffect: cb => { cleanup = cb(); },
      setTimeout: (cb, ms) => { const id = ++nextId; timers.set(id, { cb, at: now + ms }); return id; },
      clearTimeout: id => timers.delete(id),
      base44: { functions: { invoke: (name, args) => new Promise((resolve, reject) => requests.push({ name, args, resolve, reject })) } },
    });
  }
  async function tick(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.cb(); }
    await flush();
  }
  return { open, state, requests, doc, nav, timers, listeners, tick,
    event: name => { listeners.get(name)?.(); }, close: () => cleanup?.(),
    resolve: async (i, count = 123) => { requests[i].resolve({ data: { reports: [{ shop_id: 'branch', sale_count: count, total_revenue: count * 100, collections_total: count * 120 }] } }); await flush(); },
  };
}
test('initial and 60-second refresh publish count and money from the same preview', async () => {
  const h = harness(); h.open(); await h.resolve(0); await h.tick(59999);
  assert.equal(h.requests.length, 1); await h.tick(1); assert.equal(h.requests.length, 2);
  assert.equal(h.state.reports[0].sale_count, 123); await h.resolve(1,127);
  assert.equal(h.state.reports[0].sale_count,127); assert.equal(h.state.reports[0].collections_total,15240);
  assert.equal(h.requests[1].name,'daily-sales-export'); assert.equal(h.requests[1].args.action,'preview');
});
test('hidden/offline pages pause; resume/focus are throttled and single flight', async () => {
  const h = harness(); h.open(); await h.resolve(0); h.doc.visibilityState='hidden'; await h.tick(60000);
  assert.equal(h.requests.length,1); h.doc.visibilityState='visible'; h.nav.onLine=false; h.event('visibilitychange');
  assert.equal(h.requests.length,1); h.nav.onLine=true; h.event('online'); h.event('focus'); h.event('visibilitychange');
  assert.equal(h.requests.length,2); await h.tick(60000); assert.equal(h.requests.length,2); await h.resolve(1);
  h.event('focus'); assert.equal(h.requests.length,3); await h.resolve(2); h.event('focus'); assert.equal(h.requests.length,3);
});
test('failure keeps good data, honors 429 Retry-After, and recovers', async () => {
  const h = harness(); h.open(); await h.resolve(0); await h.tick(60000);
  h.requests[1].reject({ response: { status:429, headers:{ 'retry-after':'180' } }, message:'Rate limited' }); await flush();
  assert.equal(h.state.reports[0].sale_count,123); assert.equal(h.state.error,'Rate limited');
  await h.tick(60000); h.event('focus'); assert.equal(h.requests.length,2);
  await h.tick(120000); assert.equal(h.requests.length,3); await h.resolve(2,127); assert.equal(h.state.error,'');
});
test('scope changes and cleanup reject delayed results and remove all listeners', async () => {
  const h = harness(); h.open(); h.open('manager','second'); await h.resolve(1,7); await h.resolve(0,999);
  assert.equal(h.state.reports[0].sale_count,7); await h.tick(60000); h.close(); await h.resolve(2,888);
  assert.equal(h.state.reports[0].sale_count,7); assert.equal(h.timers.size,0); assert.equal(h.listeners.size,0);
});
test('Tashkent midnight clears old totals, changes request date and rejects a crossing response', async () => {
  const h = harness('2026-10-06T18:59:40Z'); h.open(); await h.resolve(0); await h.tick(15000); h.event('focus');
  await h.tick(5000); await h.resolve(1,999);
  assert.equal(h.state.day,'2026-10-07'); assert.equal(h.state.reports,null);
  await h.tick(60000); assert.equal(h.requests[2].args.business_date,'2026-10-07'); await h.resolve(2,0);
  assert.equal(h.state.reports[0].sale_count,0);
});
test('malformed responses preserve successful values; cashiers never poll', async () => {
  const h = harness(); h.open(); await h.resolve(0); await h.tick(60000); h.requests[1].resolve({data:{error:'Unavailable'}}); await flush();
  assert.equal(h.state.reports[0].sale_count,123); assert.equal(h.state.error,'Unavailable');
  h.open('cashier'); assert.equal(h.timers.size,0); assert.equal(h.listeners.size,0);
});
test('background refresh does not reset loading/selection or change report arithmetic', () => {
  assert.doesNotMatch(effect,/setLoading|setSelectedShopId/);
  assert.match(source,/sales: totals.sales \+ Number\(row.sale_count \|\| 0\)/);
  assert.match(source,/collections: totals.collections \+ Number\(row.collections_total \?\? row.total_revenue \?\? 0\)/);
  assert.match(source,/\[sales, shopId, businessDate\]/);
});
test('initial failure retries with exponential backoff without focus bypass', async () => {
  const h = harness(); h.open(); h.requests[0].reject(new Error('offline')); await flush();
  assert.equal(h.state.reports,null); await h.tick(60000); assert.equal(h.requests.length,2);
  h.requests[1].reject(new Error('still unavailable')); await flush(); await h.tick(60000); h.event('focus');
  assert.equal(h.requests.length,2); await h.tick(60000); assert.equal(h.requests.length,3);
  await h.resolve(2,127); assert.equal(h.state.reports[0].sale_count,127);
});
