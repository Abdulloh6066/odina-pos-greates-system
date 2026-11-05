// Render the actual component against memory-only queue and backend doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

const owner = { id: 'owner', role: 'admin', is_owner: true };
const row = { id: 'sale-1', status: 'pending', user_id: 'cashier', shop_id: 'shop', created_at: '2026-11-05T08:00:00Z',
  local_sale: { sale_number: 'OFFLINE-1', user_name: 'Kassir', shop_name: 'Do‘kon', total: 20000 } };
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node) === label);
const input = tree => tree.root.findByType('input');
const enter = (node, value) => node.props.onChange({ target: { value } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup({ cancel, list } = {}) {
  let rows = [structuredClone(row)], listener, calls = [], reads = 0, updates = 0;
  const queue = {
    listPendingSales: async (...args) => { assert.equal(args.length, 0); reads++; return list ? list(reads) : rows; },
    subscribePendingSales: fn => { listener = fn; return () => { listener = null; }; },
    cancelPendingSale: async args => { calls.push(args); if (cancel) return cancel(args); rows = []; return { cancelled: true }; },
    syncErrorMessage: error => error.message,
  };
  const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const require = specifier => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === '@/lib/offline-sales') return queue;
    if (specifier === '@/lib/pos') return { formatUZS: value => `${value} UZS` };
    if (specifier === '@/lib/uzbekistan-time') return { formatUzbekistanDateTime: value => value };
    if (specifier === '@/api/base44Client') return { base44: { functions: { invoke: async () => { throw new Error('Unexpected real invocation'); } } } };
    if (specifier.startsWith('@/components/ui/')) return new Proxy({}, { get: (_, key) => wrapper(key === 'Button' ? 'button' : key === 'Input' ? 'input' : key === 'Textarea' ? 'textarea' : key === 'Dialog' ? 'dialog' : 'div') });
    throw new Error(specifier);
  };
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync('src/components/pos/OwnerPendingSalesDialog.jsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console })(require, module, module.exports);
  const Component = module.exports.default;
  const props = { user: owner, isOnline: true, syncing: false, onCancelled: () => { updates++; } };
  return { Component, props, calls, get reads() { return reads; }, get updates() { return updates; },
    notify: async next => { rows = next; await listener?.(); } };
}
async function mount(fixture, props = {}) {
  let tree;
  await act(async () => { tree = create(React.createElement(fixture.Component, { ...fixture.props, ...props })); });
  return tree;
}
async function open(tree) { await act(async () => button(tree, 'Navbatdagi savdolar').props.onClick()); }
async function select(tree) { await act(async () => button(tree, 'Savdoni bekor qilish').props.onClick()); }
async function fill(tree) { await act(async () => { enter(input(tree), '1234'); enter(tree.root.findByType('textarea'), 'Xato kiritildi'); }); }
async function submit(tree) { await act(async () => { await tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); }); }
async function close(tree) { await act(async () => tree.root.findByType('dialog').props.onOpenChange(false)); }

test('only authenticated admin owner sees device-wide queue action', async () => {
  for (const user of [null, { id: 'cashier', role: 'user', is_owner: true }, { id: 'admin', role: 'admin' }, { id: 'admin', role: 'admin', is_owner: 'true' }]) {
    const f = setup(), tree = await mount(f, { user });
    assert.equal(tree.toJSON(), null); assert.equal(f.reads, 0); tree.unmount();
  }
  const f = setup(), tree = await mount(f, { user: { id: 'owner', role: 'admin', data: { is_owner: true } } });
  await open(tree); assert.ok(text(tree.toJSON()).includes('Kassir')); assert.ok(text(tree.toJSON()).includes('sale-1'));
  assert.equal(f.reads, 1); await act(async () => tree.unmount());
});

test('explicit selected sale, PIN and reason are required; success clears credentials and refreshes stock', async () => {
  const f = setup(), tree = await mount(f); await open(tree); await select(tree);
  assert.equal(button(tree, 'Ha, bekor qilish').props.disabled, true);
  await submit(tree); assert.equal(f.calls.length, 0);
  await fill(tree); await submit(tree);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].recordId, 'sale-1'); assert.equal(f.calls[0].ownerId, 'owner');
  assert.equal(f.calls[0].ownerPin, '1234'); assert.equal(f.calls[0].reason, 'Xato kiritildi');
  assert.equal(f.updates, 1); assert.equal(tree.root.findAllByType('input').length, 0);
  assert.ok(text(tree.toJSON()).includes('Savdo bekor qilindi.')); await act(async () => tree.unmount());
});

test('wrong PIN or role refusal retains sale and reason but clears PIN; close/reopen re-reads queue', async () => {
  for (const message of ['PIN noto‘g‘ri.', 'Faqat egasi bekor qilishi mumkin.']) {
    const f = setup({ cancel: async () => { throw new Error(message); } }), tree = await mount(f);
    await open(tree); await select(tree); await fill(tree); await submit(tree);
    assert.ok(text(tree.toJSON()).includes(message)); assert.equal(input(tree).props.value, '');
    assert.equal(tree.root.findByType('textarea').props.value, 'Xato kiritildi'); assert.equal(f.updates, 0);
    await close(tree); await open(tree); assert.equal(f.reads, 2); assert.equal(tree.root.findAllByType('form').length, 0);
    await select(tree); assert.equal(input(tree).props.value, ''); assert.equal(tree.root.findByType('textarea').props.value, '');
    await act(async () => tree.unmount());
  }
});

test('offline/syncing disables cancellation; busy lock refusal keeps row', async () => {
  for (const props of [{ isOnline: false }, { syncing: true }]) {
    const f = setup(), tree = await mount(f, props); await open(tree);
    assert.equal(button(tree, 'Savdoni bekor qilish').props.disabled, true); assert.equal(f.calls.length, 0);
    await act(async () => tree.unmount());
  }
  const f = setup({ cancel: async () => ({ skipped: true }) }), tree = await mount(f);
  await open(tree); await select(tree); await fill(tree); await submit(tree);
  assert.ok(text(tree.toJSON()).includes('Savdo hozir yuborilmoqda.')); assert.equal(input(tree).props.value, '');
  assert.equal(tree.root.findAllByType('form').length, 1); await act(async () => tree.unmount());
});

test('repeat clicks submit once and completion after dismissal cannot alter reopened dialog', async () => {
  const wait = deferred(), f = setup({ cancel: () => wait.promise }), tree = await mount(f);
  await open(tree); await select(tree); await fill(tree);
  let first;
  act(() => { const send = tree.root.findByType('form').props.onSubmit; first = send({ preventDefault() {} }); void send({ preventDefault() {} }); });
  assert.equal(f.calls.length, 1); assert.equal(input(tree).props.value, '');
  await close(tree); await open(tree); await select(tree); await fill(tree);
  await act(async () => { wait.resolve({ cancelled: true }); await first; });
  assert.equal(f.updates, 0); assert.equal(input(tree).props.value, '1234'); assert.ok(!text(tree.toJSON()).includes('Savdo bekor qilindi.'));
  await act(async () => tree.unmount());
});

test('account switch drops queue and credentials and ignores stale completion', async () => {
  const wait = deferred(), f = setup({ cancel: () => wait.promise }), tree = await mount(f);
  await open(tree); await select(tree); await fill(tree);
  let first; act(() => { first = tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  await act(async () => tree.update(React.createElement(f.Component, { ...f.props, user: { id: 'new-owner', role: 'admin', is_owner: true } })));
  assert.equal(tree.root.findAllByType('input').length, 0);
  await act(async () => { wait.resolve({ cancelled: true }); await first; });
  assert.equal(f.updates, 0); assert.ok(!text(tree.toJSON()).includes('Savdo bekor qilindi.'));
  await act(async () => tree.unmount());
});

test('queue notification removes stale selection and credentials', async () => {
  const f = setup(), tree = await mount(f); await open(tree); await select(tree); await fill(tree);
  await act(async () => f.notify([])); assert.equal(tree.root.findAllByType('input').length, 0);
  assert.ok(text(tree.toJSON()).includes('navbatdagi savdo yo‘q')); await act(async () => tree.unmount());
});

test('cancellation journals and key claims are protected from client writes', () => {
  const schema = JSON.parse(readFileSync('base44/entities/Shift.jsonc', 'utf8'));
  for (const field of ['sale_request_keys', 'cancelled_sale_requests']) {
    assert.equal(schema.properties[field].rls.write, false);
  }
});

test('POS clears only exact matching offline receipts and handles direct cancellation before generic failure', () => {
  const source = readFileSync('src/pages/POS.jsx', 'utf8');
  assert.match(source, /receipt\?\.offline_pending === true[\s\S]*?receipt.user_id === user\?\.id && keys.includes\(receipt.idempotency_key\)/);
  assert.match(source, /presentCompletedSale\(\{ \.\.\.record.local_sale, idempotency_key: record.id \}, printReceipt\)/);
  assert.ok(source.indexOf('isPendingSaleCancellation(pendingRecord, payload)') < source.indexOf("throw Object.assign(new Error(payload?.error || 'Savdoni yakunlab bo‘lmadi.')"));
});
