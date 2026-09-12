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
        : method === 'getChat' ? { id: opts.groupId || -5570444945, type: opts.groupType || 'group', title: 'Odina-Ish Jarayoni' }
        : { message_id: 123 };
      return { ok: true, json: async () => ({ ok: true, result }) };
    },
  };
  vm.runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context);
  const response = await handler({ json: async () => opts.body || {} });
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
test('wrong bot stops sending', async () => {
  const r = await run({ bot: 'other_bot', body: { action: 'test' } });
  assert.equal(r.status, 400); assert.equal(r.calls.length, 1);
});
test('inspection checks the fixed group without sending or consuming updates', async () => {
  const r = await run();
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.groups.map(g => g.id), ['-5570444945']);
  assert.equal(r.data.notifications_enabled, false);
  assert.equal(r.data.test_sent, false);
  assert.deepEqual(r.calls.map(c => c.method), ['getMe', 'getChat']);
});
test('test sends only fixed text to the owner-specified group', async () => {
  const r = await run({ body: { action: 'test', chat_id: '-999', text: 'INJECTED FINANCIAL DATA' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.test_sent, true);
  assert.equal(r.data.message_id, 123);
  assert.deepEqual(r.calls.map(c => c.method), ['getMe', 'getChat', 'sendMessage']);
  assert.equal(r.calls[2].body.chat_id, '-5570444945');
  assert.equal(r.calls[2].body.text.includes('INJECTED'), false);
});
test('wrong group or private chat prevents sending', async () => {
  for (const opts of [{ groupId: -999 }, { groupType: 'private' }]) {
    const r = await run({ ...opts, body: { action: 'test' } });
    assert.equal(r.status, 409);
    assert.equal(r.calls.some(c => c.method === 'sendMessage'), false);
  }
});
test('unknown action rejected without contacting Telegram', async () => {
  const r = await run({ body: { action: 'send_all' } });
  assert.equal(r.status, 400); assert.equal(r.calls.length, 0);
});
test('network errors cannot expose secret-bearing URLs', async () => {
  const r = await run({ fail: true }); assert.equal(r.status, 502);
});
