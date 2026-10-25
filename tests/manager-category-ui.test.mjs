import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { memoryBackend } from './helpers/memory-backend.mjs';

const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
async function fixture(active = true) {
  const user = { id: 'm', role: 'manager', shop_id: 'a', active };
  const f = memoryBackend({ User: [user], Shop: [{ id: 'a', active: true, location_type: 'shop' }],
    Category: [{ id: 'cake', name: 'Cake', active: true, hidden_shop_ids: ['b'] }] });
  const requests = [], alerts = [];
  const backend = { entities: f.entities, functions: { invoke: async (name, body) => {
    requests.push(structuredClone([name, body]));
    const result = await f.invoke(`base44/functions/${name}/entry.ts`, body);
    if (result.status >= 400) throw Error(result.data.error);
    return { data: result.data };
  } } };
  const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const dependencies = {
    react: { ...React, default: React }, 'react-router-dom': { useOutletContext: () => ({ user }) },
    '@/api/base44Client': { base44: backend }, '@/lib/odina-dialog': { odinaAlert: message => alerts.push(message), odinaConfirm: () => false },
    '@/lib/pos': { logAction: () => { throw Error('Global catalog operation forbidden'); } },
    '@/components/CategoryIcon': { default: () => null }, '@/lib/category-icon': {}, '@/components/PageHeader': { default: wrapper('header') },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync('src/pages/Categories.jsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(name => {
    if (name.endsWith('.css')) return {};
    if (name in dependencies) return dependencies[name];
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, key) => key === 'Dialog'
      ? ({ open, children }) => open ? React.createElement('dialog', {}, children) : null : wrapper('div') });
    throw Error('Unexpected test import ' + name);
  }, module, module.exports);
  let tree; await act(async () => { tree = create(React.createElement(module.exports.default)); });
  return { ...f, tree, requests, alerts, close: async () => act(async () => tree.unmount()) };
}

test('manager category button invokes scoped backend and preserves another shop and global fields', async () => {
  const f = await fixture();
  try {
    const buttons = () => f.tree.root.findAllByType('button');
    assert.ok(!buttons().some(button => /Qo‘shish|Tahrirlash|O‘chirish/.test(text(button))));
    const hide = buttons().find(button => text(button) === 'Do‘konimda yashirish');
    await act(async () => { await hide.props.onClick(); });
    assert.deepEqual(f.requests, [['manager-shop', { action: 'set_category_visibility', category_id: 'cake', hidden: true }]]);
    assert.deepEqual(f.db.Category[0], { id: 'cake', name: 'Cake', active: true, hidden_shop_ids: ['b', 'a'] });
    assert.ok(buttons().some(button => text(button) === 'Do‘konimda ko‘rsatish'), JSON.stringify({ buttons: buttons().map(text), alerts: f.alerts }));
    assert.deepEqual(f.calls, [['Category', 'updateMany']]);
  } finally { await f.close(); }
});

test('failed manager scope validation leaves category display and business data unchanged', async () => {
  const f = await fixture(false);
  try {
    const hide = f.tree.root.findAllByType('button').find(button => text(button) === 'Do‘konimda yashirish');
    await act(async () => { await hide.props.onClick(); });
    assert.deepEqual(f.db.Category[0].hidden_shop_ids, ['b']);
    assert.ok(f.alerts.length > 0); assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});
