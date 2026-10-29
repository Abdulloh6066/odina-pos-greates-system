import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// Resolve Deno's npm: specifiers for Node while executing the actual backend source.
const helperUrl = new URL('../../base44/shared/admin-panel.ts', import.meta.url);
const source = readFileSync(helperUrl, 'utf8')
  .replace('"./user-helpers.ts"', JSON.stringify(new URL('./user-helpers.ts', helperUrl).href))
  .replaceAll('"npm:@noble/hashes@2.4.0/pbkdf2.js"', JSON.stringify(import.meta.resolve('@noble/hashes/pbkdf2.js')))
  .replaceAll('"npm:@noble/hashes@2.4.0/sha2.js"', JSON.stringify(import.meta.resolve('@noble/hashes/sha2.js')));
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { handleAdminPanel } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const testPassword = 'isolated-test-password';
const salt = '12'.repeat(32);
const passwordConfig = JSON.stringify({ algorithm: 'PBKDF2-SHA256', salt, iterations: 100000,
  hash: pbkdf2Sync(testPassword, salt, 100000, 32, 'sha256').toString('hex') });
function fixture() {
  const now = Date.now();
  const history = [];
  const context = { auth: { id: 'auth-owner' }, admin: { id: 'owner', role: 'admin', active: true },
    passwordConfig, signingSecret: 'a'.repeat(96), now,
    service: { entities: { ActionHistory: {
      filter: async query => history.filter(row => row.user_id === query.user_id && row.action === query.action).reverse().slice(0, 5),
      create: async row => { history.push({ ...row, created_date: new Date(context.now).toISOString() }); },
    } } } };
  return { context, history, call: (body, patch = {}) => handleAdminPanel({ ...context, ...patch, body }),
    unlock: () => handleAdminPanel({ ...context, body: { action: 'admin_panel_unlock', password: testPassword } }) };
}

test('correct password creates an identity-bound expiring session without leaking password material', async () => {
  const f = fixture(); const response = await f.unlock(); const data = await response.json();
  assert.equal(response.status, 200); assert.ok(data.token); assert.equal(data.expires_at, f.context.now + 900000);
  assert.equal(JSON.stringify(data).includes(testPassword), false);
  assert.equal(JSON.stringify(f.history).includes(testPassword), false);
  assert.equal(f.history[0].action, 'admin_panel_unlocked');
  assert.equal((await f.call({ action: 'admin_panel_session', token: data.token })).status, 200);
});

test('wrong password is rejected and audited without recording the password', async () => {
  const f = fixture(); const response = await f.call({ action: 'admin_panel_unlock', password: 'wrong' });
  assert.equal(response.status, 401); assert.equal(f.history[0].action, 'admin_panel_password_failed');
  assert.equal(f.history[0].details.includes('wrong'), false);
});

test('five failed attempts trigger a durable cooldown, which expires after ten minutes', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) assert.equal((await f.call({ action: 'admin_panel_unlock', password: 'wrong' })).status, 401);
  assert.equal((await f.unlock()).status, 429);
  f.context.now += 600001;
  assert.equal((await f.unlock()).status, 200);
});

test('anonymous, cashier, manager, and disabled accounts cannot unlock even with the correct password', async () => {
  const f = fixture(); const body = { action: 'admin_panel_unlock', password: testPassword };
  assert.equal((await f.call(body, { auth: null })).status, 401);
  for (const role of ['cashier', 'manager', 'accountant', 'production', 'warehouse']) {
    assert.equal((await f.call(body, { admin: { id: role, role, active: true } })).status, 403);
  }
  assert.equal((await f.call(body, { admin: { id: 'owner', role: 'admin', active: false } })).status, 403);
  assert.equal(f.history.length, 0);
});

test('nested stored roles follow the existing user-role resolver', async () => {
  const f = fixture();
  assert.equal((await f.call({ action: 'admin_panel_unlock', password: testPassword }, {
    admin: { id: 'nested-owner', role: 'user', data: { role: 'admin' } },
  })).status, 200);
});

test('session cannot be reused by another identity or with a changed signing secret', async () => {
  const f = fixture(); const { token } = await (await f.unlock()).json();
  const body = { action: 'admin_panel_session', token };
  assert.equal((await f.call(body, { auth: { id: 'different-auth' } })).status, 401);
  assert.equal((await f.call(body, { admin: { id: 'other-owner', role: 'admin' } })).status, 401);
  assert.equal((await f.call(body, { signingSecret: 'b'.repeat(96) })).status, 401);
  assert.equal((await f.call(body, { admin: { id: 'owner', role: 'cashier' } })).status, 403);
});

test('expired, modified, unsigned, oversized, and malformed session tokens fail closed', async () => {
  const f = fixture(); const { token } = await (await f.unlock()).json();
  for (const bad of ['', 'unsigned', 'abc.def', token + '.extra', 'x'.repeat(3000), 'A' + token.slice(1)]) {
    assert.equal((await f.call({ action: 'admin_panel_session', token: bad })).status, 401);
  }
  f.context.now += 900000;
  assert.equal((await f.call({ action: 'admin_panel_session', token })).status, 401);
});

test('unconfigured secrets and unavailable audit storage fail closed', async () => {
  const f = fixture(); const body = { action: 'admin_panel_unlock', password: testPassword };
  for (const patch of [{ passwordConfig: '' }, { passwordConfig: 'invalid-json' }, { signingSecret: '' },
    { service: { entities: { ActionHistory: { filter: async () => { throw new Error('unavailable'); } } } } }]) {
    assert.equal((await f.call(body, patch)).status, 503);
  }
});

test('malformed password requests are rejected before hashing or audit reads', async () => {
  const f = fixture();
  for (const password of [null, '', 123, 'x'.repeat(257)]) {
    assert.equal((await f.call({ action: 'admin_panel_unlock', password })).status, 400);
  }
  assert.equal(f.history.length, 0);
});

test('simultaneous unlock requests are bounded per identity', async () => {
  const f = fixture(); const first = f.unlock(); const second = await f.unlock();
  assert.equal(second.status, 429); assert.equal((await first).status, 200);
});
