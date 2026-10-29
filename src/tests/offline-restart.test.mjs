import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { rememberOfflineStaff, readOfflineStaff, clearOfflineRestart, savePosRestart, readPosRestart,
  saveShiftRestart, readShiftRestart, restartRead, restartCatalog, OFFLINE_MAX_AGE } from '../lib/offline-restart.js';
import offlineRestartPlugin from '../offline/build-plugin.js';
const user = { id: 'staff-a', role: 'cashier', shop_id: 'shop-a', active: true };
function storage() {
  const values = {};
  Object.defineProperties(values, {
    getItem: { value: key => values[key] ?? null },
    setItem: { value: (key, value) => { values[key] = String(value); } },
    removeItem: { value: key => { delete values[key]; } },
  });
  globalThis.localStorage = values;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  return values;
}
test('verified staff continuity is app- and token-bound, not a new login', async () => {
  storage().setItem('token', 'local-test-token');
  assert.equal(await rememberOfflineStaff(user, 'app-a'), true);
  assert.equal((await readOfflineStaff('app-a')).id, user.id);
  assert.equal(await readOfflineStaff('app-b'), null);
  localStorage.setItem('token', 'different-test-token');
  assert.equal(await readOfflineStaff('app-a'), null);
});
test('expired continuity is rejected without deleting pending sales', async () => {
  storage(); await rememberOfflineStaff(user, 'app');
  const saved = JSON.parse(localStorage.getItem('odina-restart-v1:staff'));
  saved.savedAt -= OFFLINE_MAX_AGE + 1;
  localStorage.setItem('odina-restart-v1:staff', JSON.stringify(saved));
  assert.equal(await readOfflineStaff('app'), null);
});
test('logout clears restart caches but leaves unrelated durable state intact', async () => {
  storage(); await rememberOfflineStaff(user, 'app');
  localStorage.setItem('pending-test-marker', 'retained');
  savePosRestart(user, { prods: [] }); clearOfflineRestart();
  assert.equal(await readOfflineStaff('app'), null);
  assert.equal(readPosRestart(user), null);
  assert.equal(localStorage.getItem('pending-test-marker'), 'retained');
});
test('catalogs are isolated by cashier, role and assigned shop', () => {
  storage(); savePosRestart(user, { prods: [{ id: 'p' }] });
  assert.equal(readPosRestart(user).prods.length, 1);
  for (const change of [{ id: 'staff-b' }, { shop_id: 'shop-b' }, { role: 'admin' }]) assert.equal(readPosRestart({ ...user, ...change }), null);
});
test('confirmed close invalidates cached open shift', () => {
  storage(); saveShiftRestart(user, { id: 's', user_id: user.id, status: 'open' });
  assert.equal(readShiftRestart(user).shift.id, 's');
  saveShiftRestart(user, null);
  assert.equal(readShiftRestart(user).shift, null);
});
test('disabled staff cannot retain offline access', async () => {
  storage(); await rememberOfflineStaff(user, 'app');
  await rememberOfflineStaff({ ...user, active: false }, 'app');
  assert.equal(await readOfflineStaff('app'), null);
});
test('offline reads do not send requests and online reads have a deadline', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  let calls = 0;
  await assert.rejects(restartRead(() => { calls++; }), { code: 'ERR_NETWORK' });
  assert.equal(calls, 0);
  navigator.onLine = true;
  await assert.rejects(restartRead(() => new Promise(() => {}), 5), { code: 'ETIMEDOUT' });
  assert.equal(await restartRead(() => 42), 42);
});
test('catalog snapshot excludes private shop journals and embedded image data', () => {
  const cached = restartCatalog({ cats: [], prods: [{ image_url: 'data:image/png;base64,xxx' }],
    shopList: [{ id: 's', restaurant_table_orders: [{ customer_name: 'private' }], ingredient_request_creations_json: 'private' }], operationalSettings: {}, stockList: [] });
  assert.equal(cached.prods[0].image_url, '');
  assert.equal(cached.shopList[0].restaurant_table_orders, undefined);
  assert.equal(cached.shopList[0].ingredient_request_creations_json, undefined);
});
test('build emits versioned worker with lazy chunks and styles', () => {
  let emitted;
  offlineRestartPlugin().generateBundle.call({ emitFile: file => { emitted = file; } }, {}, {
    'assets/main-abc.js': {}, 'assets/POS-def.js': {}, 'assets/main-ghi.css': {}, 'index.html': {},
  });
  assert.equal(emitted.fileName, 'odina-sw.js');
  assert.match(emitted.source, /\/assets\/POS-def.js/);
  assert.match(emitted.source, /\/assets\/main-ghi.css/);
  assert.doesNotMatch(emitted.source, /__ODINA_/);
  assert.match(emitted.source, /const ASSETS = \["\/assets\//);
});
test('worker never intercepts API reads, mutations or private media', async () => {
  const handlers = {};
  const cachedShell = new Response('<html>cached</html>');
  const cache = { match: async () => cachedShell };
  const template = readFileSync(new URL('../offline/service-worker.js', import.meta.url), 'utf8')
    .replace('__ODINA_BUILD__', 'test').replace('/* __ODINA_ASSETS__ */ []', '["/assets/main.js"]');
  vm.runInNewContext(template, { self: { location: { origin: 'https://example.test' }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    URL, Response, AbortController, setTimeout, clearTimeout, caches: { open: async () => cache }, fetch: async () => { throw new Error('offline'); } });
  for (const request of [
    { url: 'https://example.test/api/entities/Product', method: 'GET' },
    { url: 'https://example.test/functions/complete-sale', method: 'POST' },
    { url: 'https://example.test/private/image.png', method: 'GET', destination: 'image' },
  ]) handlers.fetch({ request, respondWith: () => assert.fail('private request intercepted') });
  let response;
  handlers.fetch({ request: { url: 'https://example.test/pos?screen=1', method: 'GET', mode: 'navigate' }, respondWith: promise => { response = promise; } });
  assert.equal(await (await response).text(), '<html>cached</html>');
});