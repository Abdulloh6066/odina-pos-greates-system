// In-memory role-management tests. Never reads or mutates live user records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(path, 'utf8');
const clone = (value) => value == null ? value : structuredClone(value);

function fixture() {
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
        Object.assign(row, clone(patch));
        return clone(row);
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
  f.as('other', 'dota26066@gmail.com'); // forged session email alone is insufficient
  assert.equal((await run({ action: 'update_user_access', target_user_id: 'cashier', role: 'admin' })).status, 403);
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
  assert.match(backend, /is_owner === true/);
  for (const operation of ['update', 'delete']) {
    assert.equal(user.rls[operation].user_condition.is_owner, true);
    assert.equal(user.rls[operation].user_condition.role, undefined);
  }
  for (const path of ['base44/entities/PendingStaffInvite.jsonc', 'base44/entities/pending-staff-invite.jsonc']) {
    const schema = JSON.parse(read(path));
    for (const action of ['create', 'update', 'delete']) assert.equal(schema.rls[action].user_condition.is_owner, true);
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
