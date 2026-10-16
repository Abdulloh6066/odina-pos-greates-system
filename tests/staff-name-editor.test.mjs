// Render the real staff page. All identities and writes remain offline in memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node.props.children) === label);
const row = (tree, email) => tree.root.findAll(node => node.type === 'div' && node.props.className?.includes('odina-staff-row'))
  .find(node => text(node).includes(email));
const renameButton = (tree, email) => row(tree, email).findAllByType('button')
  .find(node => text(node.props.children) === ' Ismni o‘zgartirish');
const changeName = async (tree, value) => act(async () => tree.root.findByProps({ id: 'staff-display-name' }).props.onChange({ target: { value } }));
const submit = tree => tree.root.findByType('form').props.onSubmit({ preventDefault() {} });
const workerEmail = 'mahkamsadullayev1@gmail.com';

async function fixture({ canManageAdmins = true, role = 'admin', invoke } = {}) {
  const users = [
    { id: 'owner', full_name: 'Egasi', email: 'owner@example.test', role: 'admin', is_owner: true },
    { id: 'self', full_name: 'O‘zim', email: 'self@example.test', role: 'admin' },
    { id: 'other-admin', full_name: 'Boshqa admin', email: 'admin@example.test', role: 'admin' },
    { id: 'worker', full_name: 'mahkamsadullayev1', email: workerEmail, role: 'cashier', shop_id: 'branch', active: true },
    { id: 'inactive', full_name: 'Dam olayotgan', email: 'inactive@example.test', role: 'production', shop_id: 'central', active: false },
  ];
  const calls = [], alerts = [], logs = [];
  const backend = {
    functions: { invoke: async (name, payload) => {
      calls.push({ name, payload: structuredClone(payload) });
      if (name === 'security-admin' && payload.action === 'status') return { data: { users: structuredClone(users), can_manage_admins: canManageAdmins } };
      if (invoke) return invoke(name, payload);
      if (name === 'security-admin' && payload.action === 'update_user_name') {
        const target = users.find(user => user.id === payload.target_user_id);
        target.full_name = payload.full_name;
        return { data: { ok: true, user: { ...target } } };
      }
      return { data: { ok: true } };
    } },
    entities: { Shop: { list: async () => [
      { id: 'branch', name: 'Odina Branch', active: true },
      { id: 'central', name: 'Odina Central', active: true, location_type: 'production' },
    ] } },
  };
  const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const Dialog = ({ open, children, ...props }) => open ? React.createElement('div', { ...props, 'data-dialog': true }, children) : null;
  const require = specifier => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === 'react-router-dom') return {
      useOutletContext: () => ({ user: { id: 'self', role } }),
      Navigate: ({ to }) => React.createElement('nav', { 'data-redirect': to }),
    };
    if (specifier === '@/api/base44Client') return { base44: backend };
    if (specifier === '@/lib/odina-dialog') return { odinaAlert: async message => alerts.push(message), odinaConfirm: async () => false };
    if (specifier === '@/lib/pos') return { logAction: async (...args) => logs.push(args) };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (specifier === '@/components/PageHeader') return { default: ({ title, subtitle, actions }) => React.createElement('header', {}, title, subtitle, actions) };
    if (specifier.endsWith('/odina-select')) return { default: wrapper('select') };
    if (specifier.endsWith('/dialog')) return { Dialog, DialogContent: wrapper('section'), DialogHeader: wrapper('header'), DialogTitle: wrapper('h2'), DialogDescription: wrapper('p'), DialogFooter: wrapper('footer') };
    if (specifier.endsWith('.css')) return {};
    if (specifier.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, name) => wrapper(({ Button: 'button', Input: 'input', Label: 'label' })[name] || 'div') });
    throw Error('Unexpected dependency: ' + specifier);
  };
  const source = ts.transpileModule(readFileSync('src/pages/Users.jsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', { console })(require, module, module.exports);
  let tree;
  await act(async () => { tree = create(React.createElement(module.exports.default)); });
  return { tree, calls, users, alerts, logs,
    writes: () => calls.filter(call => call.payload.action !== 'status'),
    open: async (email = workerEmail) => act(async () => renameButton(tree, email).props.onClick()),
    close: async () => act(async () => tree.unmount()) };
}

test('admin can choose a staff name without changing email, access, shop or existing status', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.users);
    await f.open();
    assert.equal(f.tree.root.findByProps({ id: 'staff-name-email' }).props.value, workerEmail);
    assert.equal(f.tree.root.findByProps({ id: 'staff-name-email' }).props.readOnly, true);
    assert.equal(f.tree.root.findByProps({ id: 'staff-display-name' }).props.value, 'mahkamsadullayev1');
    assert.equal(button(f.tree, 'Ismni saqlash').props.disabled, true);
    await changeName(f.tree, '  Mahkam Sadullayev  ');
    assert.equal(button(f.tree, 'Ismni saqlash').props.disabled, false);
    await act(async () => submit(f.tree));
    assert.deepEqual(f.writes(), [{ name: 'security-admin', payload: {
      action: 'update_user_name', target_user_id: 'worker', full_name: 'Mahkam Sadullayev',
    } }]);
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    assert.ok(text(row(f.tree, workerEmail)).includes('Mahkam Sadullayev'));
    assert.equal(f.calls.filter(call => call.payload.action === 'status').length, 1, 'success refreshes the label without reloading all staff');
    assert.deepEqual(f.users, before.map(user => user.id === 'worker' ? { ...user, full_name: 'Mahkam Sadullayev' } : user));
    assert.equal(f.logs.length, 0, 'no unrelated access or invite audit is sent by the browser');
  } finally { await f.close(); }
});

test('cancel discards typed names and reopening starts from the saved name', async () => {
  const f = await fixture();
  try {
    await f.open();
    await changeName(f.tree, 'Saqlanmagan ism');
    await act(async () => button(f.tree, 'Bekor qilish').props.onClick());
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    assert.equal(f.writes().length, 0);
    await f.open();
    assert.equal(f.tree.root.findByProps({ id: 'staff-display-name' }).props.value, 'mahkamsadullayev1');
  } finally { await f.close(); }
});

test('blank, unchanged, overlong and embedded control names never send mutations', async () => {
  const f = await fixture();
  try {
    await f.open();
    for (const name of ['   ', '  mahkamsadullayev1  ', 'x'.repeat(121), 'Mahkam\nSadullayev', 'Mahkam\u007FSadullayev']) {
      await changeName(f.tree, name);
      assert.equal(button(f.tree, 'Ismni saqlash').props.disabled, true);
      await act(async () => submit(f.tree));
      assert.equal(f.writes().length, 0);
      if (name.trim() !== 'mahkamsadullayev1') {
        const input = f.tree.root.findByProps({ id: 'staff-display-name' });
        assert.equal(input.props['aria-invalid'], true);
        assert.equal(input.props['aria-describedby'], 'staff-name-error');
        assert.ok(text(f.tree.root.findByProps({ role: 'alert' })));
      }
    }
  } finally { await f.close(); }
});

test('in-flight duplicate submissions and dismissals cannot create a second name write', async () => {
  let resolve;
  const f = await fixture({ invoke: () => new Promise(done => { resolve = done; }) });
  try {
    await f.open();
    await changeName(f.tree, 'Mahkam');
    const handler = f.tree.root.findByType('form').props.onSubmit;
    let first;
    await act(async () => { first = handler({ preventDefault() {} }); await handler({ preventDefault() {} }); });
    assert.equal(f.writes().length, 1);
    assert.equal(button(f.tree, 'Saqlanmoqda…').props.disabled, true);
    assert.equal(button(f.tree, 'Bekor qilish').props.disabled, true);
    assert.equal(f.tree.root.findByProps({ id: 'staff-display-name' }).props.disabled, true);
    await act(async () => f.tree.root.findByProps({ 'data-dialog': true }).props.onOpenChange(false));
    assert.equal(f.tree.root.findAllByType('form').length, 1);
    await act(async () => {
      resolve({ data: { ok: true, user: { id: 'worker', full_name: 'Mahkam', email: workerEmail, role: 'cashier', shop_id: 'branch', active: true } } });
      await first;
    });
    assert.equal(f.writes().length, 1);
    assert.equal(f.tree.root.findAllByType('form').length, 0);
  } finally { await f.close(); }
});

test('backend failure keeps the typed name and email visible for retry', async () => {
  let failures = 0;
  const f = await fixture({ invoke: async () => {
    if (failures++ === 0) throw { response: { data: { error: 'Ismni saqlashga ruxsat yo‘q.' } } };
    return { data: { ok: true, user: { id: 'worker', full_name: 'Mahkam', email: workerEmail } } };
  } });
  try {
    await f.open();
    await changeName(f.tree, 'Mahkam');
    await act(async () => submit(f.tree));
    assert.equal(f.tree.root.findByProps({ id: 'staff-display-name' }).props.value, 'Mahkam');
    assert.equal(f.tree.root.findByProps({ id: 'staff-name-email' }).props.value, workerEmail);
    assert.equal(text(f.tree.root.findByProps({ role: 'alert' })), 'Ismni saqlashga ruxsat yo‘q.');
    assert.equal(button(f.tree, 'Ismni saqlash').props.disabled, false);
    assert.ok(text(row(f.tree, workerEmail)).includes('mahkamsadullayev1'));
    await act(async () => submit(f.tree));
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    assert.ok(text(row(f.tree, workerEmail)).includes('Mahkam'));
  } finally { await f.close(); }
});

test('malformed success response cannot replace a different staff row', async () => {
  const f = await fixture({ invoke: async () => ({ data: { ok: true, user: { id: 'other-admin', full_name: 'Mahkam' } } }) });
  try {
    await f.open();
    await changeName(f.tree, 'Mahkam');
    await act(async () => submit(f.tree));
    assert.ok(text(f.tree.root.findByProps({ role: 'alert' })).includes('Ism saqlanmadi'));
    assert.ok(text(row(f.tree, workerEmail)).includes('mahkamsadullayev1'));
    assert.ok(text(row(f.tree, 'admin@example.test')).includes('Boshqa admin'));
  } finally { await f.close(); }
});

test('success with the old name keeps the dialog open until the saved name is confirmed', async () => {
  let attempts = 0;
  const f = await fixture({ invoke: async (_name, payload) => ({ data: { ok: true, user: {
    id: 'worker', email: workerEmail, role: 'cashier', shop_id: 'branch', active: true,
    full_name: attempts++ === 0 ? 'mahkamsadullayev1' : payload.full_name,
  } } }) });
  try {
    await f.open();
    await changeName(f.tree, '  Mahkam Sadullayev  ');
    await act(async () => submit(f.tree));
    assert.equal(f.tree.root.findAllByType('form').length, 1, 'unconfirmed writes do not close the editor');
    assert.equal(f.tree.root.findByProps({ id: 'staff-display-name' }).props.value, '  Mahkam Sadullayev  ');
    assert.equal(f.tree.root.findByProps({ id: 'staff-name-email' }).props.value, workerEmail);
    assert.equal(text(f.tree.root.findByProps({ role: 'alert' })), 'Yangi ism saqlanganligi tasdiqlanmadi. Qayta urinib ko‘ring.');
    assert.equal(button(f.tree, 'Ismni saqlash').props.disabled, false);
    assert.ok(text(row(f.tree, workerEmail)).includes('mahkamsadullayev1'), 'the row keeps the previous confirmed name');
    assert.equal(text(row(f.tree, workerEmail)).includes('Mahkam Sadullayev'), false);

    await act(async () => submit(f.tree));
    assert.equal(f.writes().length, 2);
    assert.ok(f.writes().every(call => call.payload.full_name === 'Mahkam Sadullayev'));
    assert.equal(f.tree.root.findAllByType('form').length, 0);
    assert.ok(text(row(f.tree, workerEmail)).includes('Mahkam Sadullayev'));
    await f.open();
    assert.equal(f.tree.root.findByProps({ id: 'staff-display-name' }).props.value, 'Mahkam Sadullayev');
    assert.equal(button(f.tree, 'Ismni saqlash').props.disabled, true);
    assert.equal(f.tree.root.findAllByProps({ role: 'alert' }).length, 0);
  } finally { await f.close(); }
});

for (const canManageAdmins of [false, true]) {
  test('rename controls preserve owner/self/admin protections with can_manage_admins=' + canManageAdmins, async () => {
    const f = await fixture({ canManageAdmins });
    try {
      assert.equal(renameButton(f.tree, 'owner@example.test'), undefined);
      assert.equal(renameButton(f.tree, 'self@example.test'), undefined);
      assert.equal(Boolean(renameButton(f.tree, 'admin@example.test')), canManageAdmins);
      assert.ok(renameButton(f.tree, workerEmail));
      assert.ok(renameButton(f.tree, 'inactive@example.test'));
      assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
  });
}

test('workers cannot see the staff management page or rename dialog', async () => {
  const f = await fixture({ role: 'cashier' });
  try {
    assert.equal(f.tree.root.findByProps({ 'data-redirect': '/' }).type, 'nav');
    assert.equal(f.tree.root.findAllByType('button').length, 0);
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});
