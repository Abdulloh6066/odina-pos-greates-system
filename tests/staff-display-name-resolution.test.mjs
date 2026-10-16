// Real shared helpers with in-memory profiles only. No authentication or live data calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
const source = readFileSync('base44/shared/user-helpers.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
vm.runInNewContext(code, { module, exports: module.exports });
const { userLabel, resolveAppUser, resolveStoredAppUser, assertManagerLocation } = module.exports;

function fixture(rows, shops = [{ id: 'branch', name: 'Odina Branch', active: true }]) {
  const reads = [];
  const service = { entities: {
    User: {
      get: async (id) => { reads.push(['get', id]); return structuredClone(rows.find((row) => row.id === id) || null); },
      filter: async (query, sort, limit) => {
        reads.push(['filter', structuredClone(query), sort, limit]);
        return structuredClone(rows.filter((row) => String(row.email || '').trim().toLowerCase() === query.email));
      },
    },
    Shop: { get: async (id) => { reads.push(['shop', id]); return structuredClone(shops.find((shop) => shop.id === id) || null); } },
  } };
  return { service, reads };
}

test('future actor labels prefer owner-chosen root or nested names over provider names', () => {
  assert.equal(userLabel({ display_name: 'Mahkam', full_name: 'mahkamsadullayev1', email: 'worker@example.test' }), 'Mahkam');
  assert.equal(userLabel({ data: { display_name: 'Mahkam' }, full_name: 'mahkamsadullayev1' }), 'Mahkam');
  assert.equal(userLabel({ display_name: 'Root name', data: { display_name: 'Nested name' }, full_name: 'Provider name' }), 'Root name');
});

test('legacy actor labels retain full-name, email and unknown-worker fallbacks', () => {
  assert.equal(userLabel({ display_name: '', data: { display_name: '' }, full_name: 'Legacy worker', email: 'worker@example.test' }), 'Legacy worker');
  assert.equal(userLabel({ email: 'worker@example.test' }), 'worker@example.test');
  assert.equal(userLabel({}), 'Noma’lum xodim');
  assert.equal(userLabel(null), 'Noma’lum xodim');
});

for (const nested of [false, true]) {
  test('stored ' + (nested ? 'nested' : 'root') + ' custom name is used without changing identity or access', async () => {
    const row = {
      id: 'worker', email: 'worker@example.test', full_name: 'Provider worker', role: 'cashier',
      shop_id: 'branch', shop_name: 'Odina Branch', active: true, is_owner: false,
      ...(nested ? { data: { display_name: 'Mahkam' } } : { display_name: 'Mahkam' }),
    };
    const original = structuredClone(row);
    const f = fixture([row]);
    const result = await resolveAppUser(f.service, {
      id: 'worker', email: 'worker@example.test', full_name: 'Session provider name',
      display_name: 'Untrusted session name', role: 'admin', shop_id: 'other-shop', is_owner: true,
    });
    assert.equal(result.full_name, 'Mahkam');
    assert.equal(userLabel(result), 'Mahkam');
    assert.equal(result.id, row.id);
    assert.equal(result.email, row.email);
    assert.equal(result.role, 'cashier');
    assert.equal(result.shop_id, 'branch');
    assert.equal(result.shop_name, 'Odina Branch');
    assert.equal(result.active, true);
    assert.equal(result.is_owner, false);
    assert.deepEqual(f.reads, [['get', 'worker']]);
    assert.deepEqual(row, original, 'resolving a label never writes the stored profile');
  });
}

test('legacy resolution retains stored name or authenticated-name fallback', async () => {
  for (const [stored, expected] of [
    [{ full_name: 'Stored legacy worker' }, 'Stored legacy worker'],
    [{ display_name: '', data: { display_name: '' } }, 'Authenticated legacy worker'],
  ]) {
    const f = fixture([{ id: 'worker', role: 'cashier', shop_id: 'branch', active: true, ...stored }]);
    const result = await resolveAppUser(f.service, { id: 'worker', full_name: 'Authenticated legacy worker' });
    assert.equal(result.full_name, expected);
    assert.equal(result.role, 'cashier');
    assert.equal(result.shop_id, 'branch');
  }
});

test('exact normalized email fallback keeps stored identity and permissions with custom names', async () => {
  const row = {
    id: 'stored-worker', email: 'worker@example.test', full_name: 'Provider worker',
    data: { display_name: 'Mahkam', role: 'warehouse', shop_id: 'branch', shop_name: 'Odina Branch', active: true },
  };
  const f = fixture([row]);
  const auth = { id: 'auth-worker', email: ' WORKER@EXAMPLE.TEST ', role: 'admin', full_name: 'Session worker' };
  assert.equal((await resolveStoredAppUser(f.service, auth)).id, 'stored-worker');
  const result = await resolveAppUser(f.service, auth);
  assert.equal(result.id, 'stored-worker');
  assert.equal(result.email, 'worker@example.test');
  assert.equal(result.full_name, 'Mahkam');
  assert.equal(result.role, 'warehouse');
  assert.equal(result.shop_id, 'branch');
  assert.equal(result.shop_name, 'Odina Branch');
  assert.equal(result.is_owner, false);
  assert.deepEqual(f.reads.slice(0, 2), [
    ['get', 'auth-worker'], ['filter', { email: 'worker@example.test' }, '-updated_date', 5],
  ]);
});

test('custom names do not bypass disabled-worker or unknown-role protections', async () => {
  for (const access of [{ active: false }, { data: { active: false, display_name: 'Nested Mahkam' } }, { role: 'user' }]) {
    const f = fixture([{ id: 'worker', role: 'cashier', active: true, display_name: 'Mahkam', ...access }]);
    await assert.rejects(resolveAppUser(f.service, { id: 'worker', role: 'admin' }), (error) => error.status === 403);
  }
});

test('custom names preserve manager location checks and stored owner protection', async () => {
  const row = { id: 'manager', role: 'manager', shop_id: 'branch', active: true, display_name: 'Mahkam' };
  const f = fixture([row]);
  const result = await resolveAppUser(f.service, { id: 'manager', role: 'admin', is_owner: true });
  assert.equal(result.full_name, 'Mahkam');
  assert.equal(result.is_owner, false);
  assert.doesNotThrow(() => assertManagerLocation(result, 'branch'));
  assert.throws(() => assertManagerLocation(result, 'other-shop'), (error) => error.status === 403);
  await assert.rejects(resolveAppUser(fixture([row], [{ id: 'branch', active: false }]).service, { id: 'manager' }), (error) => error.status === 403);
  const owner = await resolveAppUser(fixture([{ id: 'owner', role: 'admin', is_owner: true, display_name: 'Egasi' }]).service, { id: 'owner' });
  assert.equal(owner.is_owner, true);
  assert.equal(owner.full_name, 'Egasi');
});

test('new actor labels use custom names without mutating previous financial snapshots', async () => {
  const historical = Object.freeze({
    Sale: Object.freeze({ user_id: 'worker', user_name: 'Provider worker', total: 34000 }),
    Shift: Object.freeze({ user_id: 'worker', user_name: 'Provider worker' }),
    CheckoutTiming: Object.freeze({ actor_id: 'worker', actor_name: 'Provider worker', total_ms: 1024 }),
  });
  const before = structuredClone(historical);
  const f = fixture([{ id: 'worker', role: 'cashier', shop_id: 'branch', full_name: 'Provider worker', display_name: 'Mahkam' }]);
  const actor = await resolveAppUser(f.service, { id: 'worker', full_name: 'Provider worker' });
  const futureActor = { user_id: actor.id, user_name: userLabel(actor) };
  assert.deepEqual(futureActor, { user_id: 'worker', user_name: 'Mahkam' });
  assert.deepEqual(historical, before);
});

test('checkout actor resolution uses custom names while preserving its existing identity and access fields', async () => {
  // Evaluate only the real resolver declarations, never the checkout handler.
  const checkout = readFileSync('base44/functions/complete-sale/index.ts', 'utf8');
  const start = checkout.indexOf('const APP_ROLES =');
  const end = checkout.indexOf('const stockNumber =');
  assert.ok(start >= 0 && end > start, 'checkout resolver section must exist');
  const checkoutModule = { exports: {} };
  const resolverCode = ts.transpileModule(checkout.slice(start, end) + '\nexport { resolveAppUser };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(resolverCode, { module: checkoutModule, exports: checkoutModule.exports });
  const resolveCheckoutActor = checkoutModule.exports.resolveAppUser;
  for (const [storedName, expected] of [
    [{ display_name: 'Mahkam' }, 'Mahkam'],
    [{ data: { display_name: 'Mahkam' } }, 'Mahkam'],
    [{}, 'Provider worker'],
  ]) {
    const stored = {
      id: 'stored-worker', email: 'worker@example.test', role: 'cashier',
      shop_id: 'branch', shop_name: 'Odina Branch', active: false,
      full_name: 'Provider worker', ...storedName,
    };
    const before = structuredClone(stored);
    const f = fixture([stored]);
    const result = await resolveCheckoutActor(f.service, {
      id: 'auth-worker', email: 'worker@example.test', full_name: 'Session provider name',
      role: 'admin', shop_id: 'other-shop', active: true,
    });
    assert.equal(result.full_name, expected);
    assert.equal(result.id, 'auth-worker', 'existing checkout session-ID behavior is preserved');
    assert.equal(result.email, 'worker@example.test');
    assert.equal(result.role, 'cashier');
    assert.equal(result.shop_id, 'branch');
    assert.equal(result.shop_name, 'Odina Branch');
    assert.equal(result.active, false);
    assert.deepEqual(stored, before);
  }
});
