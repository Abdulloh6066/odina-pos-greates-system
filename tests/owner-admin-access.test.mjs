// In-memory role-management tests. Never reads or mutates live user records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(path, 'utf8');
const clone = (value) => value == null ? value : structuredClone(value);

function fixture({ ignoreDisplayName = false, echoDisplayName = false } = {}) {
  const db = {
    User: [
      { id: 'owner', email: 'owner@example.test', role: 'admin', is_owner: true, active: true },
      { id: 'other', email: 'second-admin@example.test', role: 'admin', active: true },
      { id: 'cashier', email: 'cashier@example.test', role: 'cashier', shop_id: 'center', active: true },
      { id: 'new', email: 'new-admin@example.test', role: 'user', active: true },
      { id: 'disabled', email: 'disabled@example.test', role: 'cashier', active: false },
    ],
    PendingStaffInvite: [],
    ActionHistory: [],
    SecuritySettings: [],
  };
  let currentId = 'owner';
  let authEmailOverride;
  let inviteCalls = 0;
  let userWrites = 0;
  const userPatches = [];
  const rowsMatching = (rows, query) => rows.filter((row) => Object.entries(query || {}).every(([key, val]) => row[key] === val));
  const entities = {
    User: {
      get: async (id) => clone(db.User.find((row) => row.id === id) || null),
      list: async () => clone(db.User),
      filter: async (query) => clone(rowsMatching(db.User, query)),
      update: async (id, patch) => {
        const row = db.User.find((item) => item.id === id);
        if (!row) throw new Error('Unknown user');
        userWrites += 1;
        userPatches.push({ id, patch: clone(patch) });
        // Base44 owns the login profile name: generic entity updates cannot
        // change full_name. Echoed response fields alone do not prove storage.
        const storedPatch = Object.fromEntries(Object.entries(clone(patch)).filter(([key]) => (
          key !== 'full_name' && !(ignoreDisplayName && key === 'display_name')
        )));
        Object.assign(row, storedPatch);
        return clone({ ...row, ...(echoDisplayName && patch.display_name ? { display_name: patch.display_name } : {}) });
      },
    },
    Shop: { get: async (id) => id === 'center' ? { id: 'center', name: 'Center', active: true } : null },
    PendingStaffInvite: {
      filter: async (query) => clone(rowsMatching(db.PendingStaffInvite, query)),
      get: async (id) => clone(db.PendingStaffInvite.find((row) => row.id === id) || null),
      create: async (data) => {
        const row = { ...clone(data), id: `invite-${db.PendingStaffInvite.length + 1}` };
        db.PendingStaffInvite.push(row);
        return clone(row);
      },
      update: async (id, patch) => {
        const row = db.PendingStaffInvite.find((item) => item.id === id);
        Object.assign(row, clone(patch));
        return clone(row);
      },
    },
    SecuritySettings: { filter: async () => [] },
    ActionHistory: {
      list: async () => clone(db.ActionHistory),
      create: async (data) => {
        db.ActionHistory.push(clone(data));
        return clone(data);
      },
    },
  };
  const client = {
    auth: { me: async () => {
      const current = db.User.find((row) => row.id === currentId);
      return current && { id: current.id, email: authEmailOverride || current.email, role: current.role };
    } },
    asServiceRole: { entities },
    users: { inviteUser: async () => { inviteCalls += 1; return { ok: true }; } },
  };
  return {
    db, client, entities,
    as: (id, emailOverride) => { currentId = id; authEmailOverride = emailOverride; },
    get writes() { return userWrites; },
    get patches() { return clone(userPatches); },
    get inviteCalls() { return inviteCalls; },
  };
}

function loadHandler(path, f) {
  let handler;
  const source = read(path).replace(/^import .*;\s*$/gm, '');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInNewContext(code, {
    Deno: { serve: (fn) => { handler = fn; } },
    createClientFromRequest: () => f.client,
    resolveStoredAppUser: async (service, auth) => {
      const direct = await service.entities.User.get(auth.id);
      if (direct) return direct;
      const matches = await service.entities.User.filter({ email: auth.email });
      return matches[0] || null;
    },
    userRole: (row) => row?.role || row?.data?.role || '',
    userShopId: (row) => row?.shop_id || row?.data?.shop_id || '',
    Response, console, Date,
  });
  assert.equal(typeof handler, 'function');
  return async (body) => {
    const response = await handler({ json: async () => body });
    return { status: response.status, data: await response.json() };
  };
}

test('owner alone can promote, demote, deactivate and reactivate another admin', async () => {
  const f = fixture();
  const run = loadHandler('base44/functions/security-admin/entry.ts', f);
  const status = await run({ action: 'status' });
  assert.equal(status.data.can_manage_admins, true);
  assert.equal(status.data.users.find((u) => u.id === 'owner').is_owner, true);
  assert.equal(status.data.users.find((u) => u.id === 'other').is_owner, false);

  const promoted = await run({ action: 'update_user_access', target_user_id: 'cashier', role: 'admin' });
  assert.equal(promoted.status, 200, JSON.stringify(promoted));
  assert.equal(f.db.User[2].role, 'admin');
  assert.equal(f.db.User[2].shop_id, '');
  assert.equal(f.db.User[2].shop_name, '');
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'cashier', active: false })).status, 200);
  assert.equal(f.db.User[2].active, false);
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'cashier', active: true })).status, 200);
  assert.equal(f.db.User[2].active, true);
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'other', role: 'cashier' })).status, 400);
  const demoted = await run({ action: 'update_user_access', target_user_id: 'other', role: 'cashier', shop_id: 'center' });
  assert.equal(demoted.status, 200, JSON.stringify(demoted));
  assert.equal(f.db.User[1].role, 'cashier');
  assert.equal(f.db.User[1].shop_id, 'center');
  assert.equal(f.db.ActionHistory.filter((row) => row.action === 'user_access_updated').length, 4);
});

test('second admin cannot alter any admin or grant admin, but can still manage ordinary staff', async () => {
  const f = fixture();
  const run = loadHandler('base44/functions/security-admin/entry.ts', f);
  f.as('other');
  assert.equal((await run({ action: 'status' })).data.can_manage_admins, false);
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'cashier', role: 'admin' })).status, 403);
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'owner', active: false })).status, 403);
  assert.equal(f.writes, 0);
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'cashier', active: false })).status, 200);
  assert.equal(f.db.User[2].active, false);
  f.as('owner');
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'owner', active: false })).status, 400);
  f.as('other', 'owner@example.test'); // forged session email alone is insufficient
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'cashier', role: 'admin' })).status, 403);
});

test('owner saves a chosen employee name without changing login, permissions or historical snapshots', async () => {
  const f = fixture();
  const target = f.db.User.find((row) => row.id === 'cashier');
  Object.assign(target, { full_name: 'mahkamsadullayev1', shop_name: 'Center', is_owner: false, private_note: 'not returned' });
  f.db.Sale = [{ id: 'sale-old', user_id: target.id, user_name: target.full_name, total: 34000 }];
  f.db.Shift = [{ id: 'shift-old', user_id: target.id, user_name: target.full_name }];
  f.db.CheckoutTiming = [{ id: 'timing-old', actor_id: target.id, actor_name: target.full_name, total_ms: 1024 }];
  const beforeUser = clone(target);
  const beforeHistory = clone({ Sale: f.db.Sale, Shift: f.db.Shift, CheckoutTiming: f.db.CheckoutTiming });
  const run = loadHandler('base44/functions/security-admin/entry.ts', f);
  const name = 'Маҳкам O‘g‘li';
  const result = await run({ action: 'update_user_name', target_user_id: target.id, full_name: `  ${name}  ` });

  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.ok, true);
  assert.deepEqual(target, { ...beforeUser, display_name: name });
  assert.deepEqual(f.patches, [{ id: target.id, patch: { display_name: name } }]);
  assert.deepEqual(result.data.user, {
    id: target.id, full_name: name, email: beforeUser.email, is_owner: false,
    role: beforeUser.role, shop_id: beforeUser.shop_id, shop_name: beforeUser.shop_name, active: true,
  });
  assert.deepEqual({ Sale: f.db.Sale, Shift: f.db.Shift, CheckoutTiming: f.db.CheckoutTiming }, beforeHistory);
  assert.equal(f.db.ActionHistory.length, 1);
  const audit = f.db.ActionHistory[0];
  assert.equal(audit.action, 'user_name_updated');
  assert.equal(audit.user_id, 'owner');
  for (const value of [target.id, beforeUser.full_name, name]) assert.ok(audit.details.includes(value), audit.details);

  const reopened = await run({ action: 'status' });
  assert.equal(reopened.data.users.find((row) => row.id === target.id).full_name, name);
  const stored = await f.entities.User.get(target.id);
  assert.equal(stored.display_name, name);
  assert.equal(stored.full_name, beforeUser.full_name);
  assert.equal(f.writes, 1);
});

test('name-only action refuses email and privilege fields without any mutation', async () => {
  for (const [key, value] of Object.entries({
    email: 'different@example.test', role: 'admin', shop_id: 'other-shop', shop_name: 'Other',
    active: false, is_owner: true, id: 'owner', display_name: 'Bypass', data: { role: 'admin' }, unexpected: 'value',
  })) {
    const f = fixture();
    const before = clone(f.db);
    const run = loadHandler('base44/functions/security-admin/entry.ts', f);
    const result = await run({ action: 'update_user_name', target_user_id: 'cashier', full_name: 'Mahkam', [key]: value });
    assert.equal(result.status, 400, key + ': ' + JSON.stringify(result));
    assert.equal(f.writes, 0, key);
    assert.deepEqual(f.db, before, key);
  }
});

test('employee names reject invalid values and internal controls while accepting the length limit', async () => {
  const invalid = [undefined, null, false, 17, {}, [], '', '   ', 'a'.repeat(121),
    'Mah\u0000kam', 'Mah\u0001kam', 'Mah\tkam', 'Mah\nkam', 'Mah\rkam', 'Mah\u001fkam', 'Mah\u007fkam'];
  for (const full_name of invalid) {
    const f = fixture();
    const before = clone(f.db);
    const run = loadHandler('base44/functions/security-admin/entry.ts', f);
    const result = await run({ action: 'update_user_name', target_user_id: 'cashier', full_name });
    assert.equal(result.status, 400, JSON.stringify(full_name) + ': ' + JSON.stringify(result));
    assert.equal(f.writes, 0);
    assert.deepEqual(f.db, before);
  }
  const f = fixture();
  const run = loadHandler('base44/functions/security-admin/entry.ts', f);
  const name = 'O'.repeat(120);
  const result = await run({ action: 'update_user_name', target_user_id: 'cashier', full_name: name });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.user.full_name, name);
  assert.deepEqual(f.patches, [{ id: 'cashier', patch: { display_name: name } }]);
});

test('name changes require an active stored admin and preserve protected-account rules', async () => {
  const f = fixture();
  f.db.User.push(
    { id: 'manager', email: 'manager@example.test', role: 'manager', shop_id: 'center', active: true },
    { id: 'disabled-admin', email: 'disabled-admin@example.test', role: 'admin', active: false },
    { id: 'nested-disabled-admin', email: 'nested-disabled@example.test', role: 'admin', data: { active: false } },
    { id: 'nested-owner', email: 'nested-owner@example.test', role: 'admin', data: { is_owner: true } },
  );
  const run = loadHandler('base44/functions/security-admin/entry.ts', f);
  const rename = (target_user_id = 'cashier') => run({ action: 'update_user_name', target_user_id, full_name: 'Mahkam' });
  for (const actor of ['cashier', 'disabled', 'disabled-admin', 'nested-disabled-admin']) {
    f.as(actor);
    assert.equal((await rename()).status, 403, actor);
  }
  // A shop manager may rename his own shop's cashier, but never an admin/owner.
  f.as('manager');
  assert.equal((await rename('other')).status, 403, 'manager cannot touch an admin');
  assert.equal((await rename('owner')).status, 403, 'manager cannot touch the owner');
  f.as('missing');
  assert.equal((await rename()).status, 401);
  f.as('cashier');
  const authenticated = f.client.auth.me;
  f.client.auth.me = async () => ({ id: 'cashier', email: 'cashier@example.test', role: 'admin', is_owner: true });
  assert.equal((await rename('other')).status, 403, 'session claims cannot override stored staff role');
  f.client.auth.me = authenticated;
  f.as('owner');
  assert.equal((await rename('owner')).status, 400, 'self remains protected');
  assert.equal((await rename('nested-owner')).status, 403, 'nested owner remains protected');
  f.as('other');
  assert.equal((await rename('other')).status, 400, 'another admin cannot rename self here');
  assert.equal((await rename('owner')).status, 403, 'owner remains protected');
  f.db.User.push({ id: 'third-admin', email: 'third@example.test', role: 'admin', active: true });
  assert.equal((await rename('third-admin')).status, 403);
  assert.equal(f.writes, 0);
  assert.equal(f.db.ActionHistory.length, 0);

  f.as('owner');
  assert.equal((await rename('other')).status, 200, 'owner may manage another admin');
  assert.deepEqual(f.patches, [{ id: 'other', patch: { display_name: 'Mahkam' } }]);
});

test('ordinary admin can rename staff independently of missing or obsolete shop assignments', async () => {
  for (const [role, shop_id] of [['cashier', ''], ['manager', 'obsolete-shop'], ['warehouse', 'center']]) {
    const f = fixture();
    f.as('other');
    const target = f.db.User.find((row) => row.id === 'cashier');
    Object.assign(target, { role, shop_id, full_name: 'Old name', active: false });
    const before = clone(target);
    const run = loadHandler('base44/functions/security-admin/entry.ts', f);
    const result = await run({ action: 'update_user_name', target_user_id: target.id, full_name: 'Yangi ism' });
    assert.equal(result.status, 200, JSON.stringify({ role, shop_id, result }));
    assert.deepEqual(target, { ...before, display_name: 'Yangi ism' });
    assert.deepEqual(f.patches, [{ id: target.id, patch: { display_name: 'Yangi ism' } }]);
  }
});

test('saving an unchanged trimmed name is a successful no-op without duplicate audit entries', async () => {
  for (const names of [
    { full_name: 'login-name', display_name: 'Mahkam Sadullayev' },
    { full_name: 'login-name', data: { display_name: 'Mahkam Sadullayev' } },
    { full_name: 'Mahkam Sadullayev' },
  ]) {
    const f = fixture();
    Object.assign(f.db.User.find((row) => row.id === 'cashier'), names);
    const before = clone(f.db);
    const run = loadHandler('base44/functions/security-admin/entry.ts', f);
    for (const full_name of ['Mahkam Sadullayev', '  Mahkam Sadullayev  ']) {
      const result = await run({ action: 'update_user_name', target_user_id: 'cashier', full_name });
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.data.ok, true);
      assert.equal(result.data.user.full_name, 'Mahkam Sadullayev');
    }
    assert.equal(f.writes, 0);
    assert.deepEqual(f.patches, []);
    assert.deepEqual(f.db, before);
  }
});

test('generic User update models platform-owned full_name as immutable', async () => {
  const f = fixture();
  const target = f.db.User.find((row) => row.id === 'cashier');
  target.full_name = 'platform-login-name';
  const result = await f.entities.User.update(target.id, { full_name: 'Ignored login rename', display_name: 'Mahkam' });
  assert.equal(result.full_name, 'platform-login-name');
  assert.equal((await f.entities.User.get(target.id)).full_name, 'platform-login-name');
  assert.equal((await f.entities.User.get(target.id)).display_name, 'Mahkam');
});

test('name save requires a fresh stored custom display_name before success or audit', async () => {
  for (const mode of ['ignored custom field with misleading update response', 'stale readback', 'unavailable readback']) {
    const f = fixture({ ignoreDisplayName: mode.startsWith('ignored'), echoDisplayName: true });
    const target = f.db.User.find((row) => row.id === 'cashier');
    Object.assign(target, { full_name: 'login-name', display_name: 'Old chosen name' });
    const original = clone(target);
    const get = f.entities.User.get;
    f.entities.User.get = async (id) => {
      if (id === target.id && f.writes > 0) {
        if (mode === 'stale readback') return clone(original);
        if (mode === 'unavailable readback') throw new Error('Offline readback failure');
      }
      return get(id);
    };
    const run = loadHandler('base44/functions/security-admin/entry.ts', f);
    const result = await run({ action: 'update_user_name', target_user_id: target.id, full_name: 'Mahkam' });
    assert.ok(result.status >= 400, mode + ': ' + JSON.stringify(result));
    assert.notEqual(result.data.ok, true, mode);
    assert.equal(f.db.ActionHistory.length, 0, mode);
    assert.equal(target.full_name, original.full_name, mode);
    assert.deepEqual(f.patches, [{ id: target.id, patch: { display_name: 'Mahkam' } }], mode);
    if (mode.startsWith('ignored')) assert.deepEqual(target, original);
  }
});

test('staff names prefer root or nested custom display_name and fall back to the platform name', async () => {
  const f = fixture();
  const names = [
    { id: 'name-root', full_name: 'root-login', display_name: 'Root chosen', data: { display_name: 'Nested old' } },
    { id: 'name-nested', full_name: 'nested-login', data: { display_name: 'Nested chosen' } },
    { id: 'name-fallback', full_name: 'Platform name' },
    { id: 'name-empty-custom', full_name: 'Fallback name', display_name: '', data: { display_name: '' } },
  ];
  f.db.User.push(...names.map((name) => ({ ...name, role: 'cashier', active: true })));
  const run = loadHandler('base44/functions/security-admin/entry.ts', f);
  const result = await run({ action: 'status' });
  assert.equal(result.status, 200);
  const users = new Map(result.data.users.map((row) => [row.id, row]));
  for (const [id, name] of [
    ['name-root', 'Root chosen'], ['name-nested', 'Nested chosen'],
    ['name-fallback', 'Platform name'], ['name-empty-custom', 'Fallback name'],
  ]) assert.equal(users.get(id).full_name, name);
  assert.equal(f.writes, 0);
});

test('owner can invite admin; admin claim requires owner-issued invite; disabled user cannot reclaim', async () => {
  const f = fixture();
  const run = loadHandler('base44/functions/staff-invite/entry.ts', f);
  f.as('other');
  const refused = await run({ action: 'invite', email: 'new-admin@example.test', role: 'admin' });
  assert.equal(refused.status, 403);
  assert.equal(f.inviteCalls, 0);
  f.as('owner');
  const invited = await run({ action: 'invite', email: 'new-admin@example.test', role: 'admin' });
  assert.equal(invited.status, 200, JSON.stringify(invited));
  assert.equal(f.db.PendingStaffInvite[0].invited_by_id, 'owner');
  assert.equal(f.inviteCalls, 1);
  f.as('new');
  const claimed = await run({ action: 'claim' });
  assert.equal(claimed.status, 200, JSON.stringify(claimed));
  assert.equal(f.db.User.find((row) => row.id === 'new').role, 'admin');
  assert.equal(f.db.PendingStaffInvite[0].status, 'applied');

  f.db.PendingStaffInvite.push({ id: 'forged', email: 'disabled@example.test', desired_role: 'admin', status: 'pending', invited_by_id: 'other' });
  f.as('disabled');
  assert.equal((await run({ action: 'claim' })).status, 403);
  assert.equal(f.db.User.find((row) => row.id === 'disabled').role, 'cashier');
  f.db.User.find((row) => row.id === 'disabled').active = true;
  assert.equal((await run({ action: 'claim' })).status, 403);
  assert.equal(f.db.User.find((row) => row.id === 'disabled').role, 'cashier');
});

test('RLS blocks direct admin privilege edits; UI obtains owner flag from authenticated backend', () => {
  const user = JSON.parse(read('base44/entities/User.jsonc'));
  const backend = read('base44/functions/security-admin/entry.ts');
  assert.equal(user.properties.display_name.type, 'string');
  assert.equal(user.properties.display_name.maxLength, 120);
  assert.ok(!(user.required || []).includes('display_name'), 'existing accounts need no backfill');
  assert.match(backend, /is_owner === true/);
  for (const operation of ['update', 'delete']) {
    assert.equal(user.rls[operation].user_condition.is_owner, true);
    assert.equal(user.rls[operation].user_condition.role, undefined);
  }
  for (const path of ['base44/entities/PendingStaffInvite.jsonc', 'base44/entities/pending-staff-invite.jsonc']) {
    const schema = JSON.parse(read(path));
    // Invites now use the stricter server-only policy, including for owners.
    for (const action of ['create', 'update', 'delete']) assert.equal(schema.rls[action], false);
  }
  const users = read('src/pages/Users.jsx');
  assert.match(users, /can_manage_admins/);
  assert.match(users, /u\.is_owner/);
  assert.match(users, /pendingDemotion/);
  assert.doesNotMatch(users, /OWNER_EMAIL/);
  const security = read('src/pages/Security.jsx');
  assert.match(security, /can_manage_admins/);
  assert.match(read('src/components/security/StaffAccessPanel.jsx'), /protectedAccount/);
});
