import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function run(opts = {}) {
  let handler;
  const calls = [];
  const source = readFileSync('base44/functions/telegram-setup/entry.ts', 'utf8').replace(/^import .*;$/gm, '');
  const token = 'TEST_SECRET_DO_NOT_RETURN';
  const context = {
    Response, AbortSignal, Map, Date, Number,
    createClientFromRequest: () => ({
      auth: { me: async () => opts.auth === false ? null : ({ id: 'owner', role: 'admin' }) },
      asServiceRole: { entities: { User: { get: async () => ({ role: opts.role || 'admin', active: opts.active !== false }) } } },
    }),
    userRole: u => u.role,
    Deno: { env: { get: () => opts.missing ? undefined : token }, serve: fn => { handler = fn; } },
    fetch: async (url, init) => {
      const method = url.split('/').at(-1);
      calls.push({ method, body: JSON.parse(init.body) });
      if (opts.fail) throw new Error(url);
      const result = method === 'getMe' ? { username: opts.bot || 'Odina_nazorat_bot' }
        : method === 'getWebhookInfo' ? { url: opts.webhook ? 'https://example.com/hook' : '' }
        : opts.updates || [];
      return { ok: true, json: async () => ({ ok: true, result }) };
    },
  };
  vm.runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context);
  const response = await handler({});
  const data = await response.json();
  assert.equal(JSON.stringify(data).includes(token), false);
  return { status: response.status, data, calls };
}

test('unauthenticated request never contacts Telegram', async () => {
  const r = await run({ auth: false }); assert.equal(r.status, 401); assert.equal(r.calls.length, 0);
});
test('stored cashier role overrides admin token claim', async () => {
  const r = await run({ role: 'cashier' }); assert.equal(r.status, 403); assert.equal(r.calls.length, 0);
});
test('disabled admin rejected', async () => {
  const r = await run({ active: false }); assert.equal(r.status, 403); assert.equal(r.calls.length, 0);
});
test('missing secret gets useful error', async () => {
  const r = await run({ missing: true }); assert.equal(r.status, 400); assert.equal(r.calls.length, 0);
});
test('wrong bot and existing webhook stop discovery', async () => {
  assert.equal((await run({ bot: 'other_bot' })).calls.length, 1);
  const r = await run({ webhook: true }); assert.equal(r.status, 409); assert.equal(r.calls.length, 2);
});
test('only addressed group commands returned, without consuming updates', async () => {
  const msg = (id, type, text, title = 'Odina-Ish Jarayoni') => ({ message: { chat: { id, type, title }, text, date: 1789200000 } });
  const r = await run({ updates: [
    msg(-1001, 'supergroup', '/start@Odina_nazorat_bot'),
    msg(-1001, 'supergroup', '/start@Odina_nazorat_bot'),
    msg(12, 'private', '/start@Odina_nazorat_bot'),
    msg(-22, 'group', 'private conversation text'),
    msg(-33, 'group', '/start@another_bot'),
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.groups.map(g => g.id), ['-1001']);
  assert.equal(r.data.notifications_enabled, false);
  assert.deepEqual(r.calls.map(c => c.method), ['getMe', 'getWebhookInfo', 'getUpdates']);
  assert.equal('offset' in r.calls[2].body, false);
  assert.equal('allowed_updates' in r.calls[2].body, false);
});
test('network errors cannot expose secret-bearing URLs', async () => {
  const r = await run({ fail: true }); assert.equal(r.status, 502);
});
