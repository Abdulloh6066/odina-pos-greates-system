// Offline regression: execute the actual production screen reads and refresh lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readAllEntityPages } from '../src/lib/history-pagination.js';

const source = fs.readFileSync('src/pages/ProductionScreen.jsx', 'utf8');
const lifecycle = source.slice(source.indexOf('  const loadOrders = async'), source.indexOf('  const doAction = async'));
const grouping = source.slice(source.indexOf('  const visibleDays = useMemo'), source.indexOf('  const logout =', source.indexOf('  const visibleDays = useMemo')));
const flush = () => new Promise(resolve => setImmediate(resolve));
const order = (id, status = 'qabul_qilindi', time = '12:00') => ({
  id, order_sequence: Number(id), order_status: status, required_date: '2026-10-08', required_time: time,
});
function harness() {
  const state = { items: {}, active: [], shipped: [] };
  const requests = [], intervals = new Map(), timeouts = new Map(), subscriptions = new Map();
  const windowListeners = new Map(), documentListeners = new Map();
  let cleanup, nextId = 0, forecastCalls = 0, failItems = false;
  const doc = { visibilityState: 'visible',
    addEventListener: (key, cb) => documentListeners.set(key, cb),
    removeEventListener: (key, cb) => { if (documentListeners.get(key) === cb) documentListeners.delete(key); },
  };
  const nav = { onLine: true };
  const context = vm.createContext({
    active: [], scopedActive: [], clock: '', document: doc, navigator: nav, readAllEntityPages,
    loadedOrders: { current: [] },
    window: {
      addEventListener: (key, cb) => windowListeners.set(key, cb),
      removeEventListener: (key, cb) => { if (windowListeners.get(key) === cb) windowListeners.delete(key); },
    },
    ACTIVE_STATUSES: ['qabul_qilindi', 'tayyorlanmoqda', 'tayyor'],
    loadedOnce: { current: false }, refreshInFlight: { current: null },
    refreshQueued: { current: false }, forecastQueued: { current: false },
    todayStr: () => '2026-10-08', dateOffsetStr: n => n < 0 ? '2026-10-07' : n ? '2026-10-09' : '2026-10-08',
    clockStr: () => '08.10.2026 · 02:40',
    uzbekistanDateKey: value => value?.slice(0,10) || '',
    setActive: value => { state.active = value; context.active = value; context.scopedActive = value; },
    setShippedToday: value => { state.shipped = value; },
    setItemsByOrder: value => { state.items = value; },
    setRefreshing: value => { state.refreshing = value; },
    setRefreshError: value => { state.refreshError = value; },
    setError: value => { state.error = value; },
    setLoading: value => { state.loading = value; },
    setForecast: value => { state.forecast = value; },
    setForecastError: value => { state.forecastError = value; },
    setForecastLoading: () => {},
    setClock: value => { context.clock = value; },
    useEffect: cb => { cleanup = cb(); }, useMemo: cb => cb(),
    setInterval: (cb, ms) => { const id = ++nextId; intervals.set(id, { cb, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (cb, ms) => { const id = ++nextId; timeouts.set(id, { cb, ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    base44: {
      entities: Object.fromEntries(['CustomerOrder','CustomerOrderItem','IngredientStock','Recipe','RecipeItem'].map(name => [
        name, {
          subscribe: cb => { subscriptions.set(name, cb); return () => subscriptions.delete(name); },
          filter: name === 'CustomerOrder'
            ? (query, sort, limit, skip) => new Promise((resolve,reject) => requests.push({ resolve,reject,query,sort,limit,skip }))
            : async query => { if (failItems) throw Error('connection'); return query.order_id.$in.includes('1') ? [{ id:'item-1', order_id:'1', product_name_snapshot:'Tort', quantity:1 }] : []; },
        },
      ])),
      functions: { invoke: async name => { assert.equal(name,'production-run'); forecastCalls++; return { data:{ products:[] } }; } },
    },
  });
  vm.runInContext(lifecycle + '\nthis.loadForTest = load;', context);
  return {
    state, requests, doc, nav, intervals, timeouts, subscriptions, windowListeners, documentListeners,
    forecastCalls: () => forecastCalls,
    poll: () => [...intervals.values()].find(t => t.ms === 15000).cb(),
    event: name => (windowListeners.get(name) || documentListeners.get(name))?.(),
    refresh: () => context.loadForTest(false),
    resolve: async (index, rows) => { requests[index].resolve(rows); await flush(); },
    reject: async index => { requests[index].reject(Error('connection')); await flush(); },
    failItems: () => { failItems = true; },
    days: () => vm.runInContext(grouping + '\nvisibleDays;', context),
    close: () => cleanup(),
  };
}

test('missed subscription: pending and ready orders appear together on the next poll without status actions', async () => {
  const h = harness();
  await h.resolve(0,[order('1')]);
  h.poll();
  await h.resolve(1,[order('1'), order('2','tayyor','16:00'), order('3','tayyorlanmoqda','14:00')]);
  assert.deepEqual(Array.from(h.days()[0].orders, o => o.id), ['1','3','2']);
  assert.equal(h.state.active.length,3);
  assert.equal(h.forecastCalls(),1, 'polling does not repeatedly run ingredient forecasts');
});

test('refreshes serialize, and an event during a read queues a fresh follow-up', async () => {
  const h = harness();
  h.event('focus'); h.event('online'); h.refresh();
  assert.equal(h.requests.length,1);
  await h.resolve(0,[order('1')]);
  assert.equal(h.requests.length,2);
  await h.resolve(1,[order('1'),order('2')]);
  assert.equal(h.state.active.length,2);
  assert.equal(h.state.refreshing,false);
});

test('hidden and offline screens pause reads and refresh when visible or reconnected', async () => {
  const h = harness(); await h.resolve(0,[order('1')]);
  h.doc.visibilityState='hidden'; h.poll(); h.event('focus');
  assert.equal(h.requests.length,1);
  h.doc.visibilityState='visible'; h.nav.onLine=false; h.poll(); h.event('visibilitychange');
  assert.equal(h.requests.length,1);
  h.nav.onLine=true; h.event('online');
  assert.equal(h.requests.length,2);
  await h.resolve(1,[order('1'),order('2')]);
  assert.equal(h.state.active.length,2);
});

test('connection failure keeps the last orders and product details, then a later poll recovers', async () => {
  const h = harness(); await h.resolve(0,[order('1'),order('2','tayyor')]);
  h.failItems(); h.poll(); await h.reject(1);
  assert.equal(h.state.active.length,2);
  assert.equal(h.state.items['1'][0].product_name_snapshot,'Tort');
  assert.match(h.state.refreshError,/yangilanmadi/);
  h.poll(); await h.resolve(2,[order('1'),order('2','tayyor'),order('3')]);
  assert.equal(h.state.active.length,3);
  assert.equal(h.state.refreshError,'');
});

test('shipping one order keeps the other pending and ready orders visible', async () => {
  const h = harness(); await h.resolve(0,[order('1','tayyor'),order('2'),order('3','tayyor')]);
  h.poll();
  await h.resolve(1,[{...order('1','yuborildi_olib_ketildi'),shipped_at:'2026-10-08T02:39:00+05:00'},order('2'),order('3','tayyor')]);
  assert.deepEqual(Array.from(h.state.active,o=>o.id),['2','3']);
  assert.deepEqual(Array.from(h.state.shipped,o=>o.id),['1']);
});

test('malformed responses do not silently empty the successful list', async () => {
  const h = harness(); await h.resolve(0,[order('1')]);
  h.poll(); await h.resolve(1,null);
  assert.equal(h.state.active.length,1);
  assert.match(h.state.refreshError,/yangilanmadi/);
});

test('initial failures stay explicit until the first successful order read', async () => {
  const h = harness(); await h.reject(0);
  assert.match(h.state.error,/connection/);
  h.poll(); await h.reject(1);
  assert.match(h.state.error,/connection/);
  h.poll(); await h.resolve(2,[order('1'),order('2')]);
  assert.equal(h.state.error,'');
  assert.equal(h.state.active.length,2);
});

test('cleanup removes polling, subscriptions and reconnect listeners', async () => {
  const h = harness(); await h.resolve(0,[order('1')]); h.close();
  assert.equal(h.intervals.size,0); assert.equal(h.timeouts.size,0);
  assert.equal(h.subscriptions.size,0); assert.equal(h.windowListeners.size,0); assert.equal(h.documentListeners.size,0);
  h.poll = () => {}; h.event('focus');
  assert.equal(h.requests.length,1);
});


test('warehouse reads every active page beyond the old 200-order ceiling', async () => {
  const h = harness();
  const rows = Array.from({length: 251}, (_, i) => order(String(i+1)));
  await h.resolve(0, rows.slice(0,100));
  assert.equal(h.requests[1].skip,100);
  await h.resolve(1, rows.slice(100,200));
  assert.equal(h.requests[2].skip,200);
  await h.resolve(2, rows.slice(200));
  assert.equal(h.state.active.length,251);
  assert.equal(h.days()[0].orders.length,251);
  assert.equal(h.requests[0].query.creation_state.$ne,'pending');
  h.close();
});

test('overdue and later-date orders remain visible alongside today and tomorrow', async () => {
  const h = harness();
  await h.resolve(0,[order('1'), {...order('2'),required_date:'2026-10-07'},
    {...order('3'),required_date:'2026-10-09'}, {...order('4'),required_date:'2026-11-10'}]);
  assert.deepEqual(Array.from(h.days().flatMap(day => day.orders), row => row.id),['2','1','3','4']);
  assert.equal(h.days()[0].key,'overdue');
  h.close();
});
