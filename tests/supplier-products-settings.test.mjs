// The real assignment dialog runs entirely against in-memory records and SDK stubs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const button = (tree, label) => tree.root.findAllByType('button').find(node => text(node) === label);
const ingredientRow = (tree, name) => tree.root.findAllByType('label').find(node => text(node).startsWith(name));
const checkbox = (tree, name) => ingredientRow(tree, name).findByType('input');
const saveLabel = 'Mahsulotlarni saqlash';

async function fixture({ role = 'admin', ingredients = [], suppliedIds = [], configured = true, failLoad = false, failSave = false, responseWithoutFields = false, pendingSave = false } = {}) {
  const reads = [], writes = [], saved = [], closed = [];
  let loadFailure = failLoad, saveFailure = failSave;
  let finishSave;
  const supplier = { id: 'supplier-one', name: 'Oziq savdo', recipient_type: 'supplier', active: true, notes: 'Mavjud izoh', ...(configured ? { supplied_ingredient_ids: suppliedIds } : {}) };
  let stored = structuredClone(supplier);
  const backend = { entities: {
    Ingredient: { list: async (...args) => {
      reads.push(structuredClone(args));
      if (loadFailure) throw new Error('Katalog yuklanmadi');
      return structuredClone(ingredients.slice(args[2], args[2] + args[1]));
    } },
    CashRecipient: { update: async (id, payload) => {
      writes.push({ id, payload: structuredClone(payload) });
      if (saveFailure) throw new Error('Saqlash rad etildi');
      if (pendingSave) await new Promise(resolve => { finishSave = resolve; });
      assert.equal(id, stored.id);
      stored = { ...stored, ...structuredClone(payload) };
      return responseWithoutFields ? { id } : structuredClone(stored);
    } },
  } };
  const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const Dialog = ({ open, children, ...props }) => open ? React.createElement('div', { ...props, 'data-dialog': true }, children) : null;
  const require = specifier => {
    if (specifier === 'react') return { ...React, default: React };
    if (specifier === '@/api/base44Client') return { base44: backend };
    if (specifier === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (specifier.endsWith('/button')) return { Button: wrapper('button') };
    if (specifier.endsWith('/input')) return { Input: wrapper('input') };
    if (specifier.endsWith('/dialog')) return { Dialog, DialogContent: wrapper('section'), DialogHeader: wrapper('header'), DialogTitle: wrapper('h2'), DialogDescription: wrapper('p'), DialogFooter: wrapper('footer') };
    throw new Error('Unexpected dependency: ' + specifier);
  };
  const source = ts.transpileModule(readFileSync('src/components/warehouse/SupplierProductsDialog.jsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', { console })(require, module, module.exports);
  const props = target => ({ supplier: target, user: { id: 'viewer', role }, onClose: () => closed.push(true), onSaved: value => saved.push(structuredClone(value)) });
  let tree;
  await act(async () => { tree = create(React.createElement(module.exports.default, props(supplier))); });
  return {
    tree, reads, writes, saved, closed,
    allowLoad: () => { loadFailure = false; }, allowSave: () => { saveFailure = false; },
    finishSave: () => finishSave?.(),
    stored: () => structuredClone(stored),
    toggle: async name => act(async () => checkbox(tree, name).props.onChange()),
    save: async () => act(async () => button(tree, saveLabel).props.onClick()),
    search: async value => act(async () => tree.root.findByProps({ 'aria-label': 'Yetkazib beruvchi mahsulotlarini qidirish' }).props.onChange({ target: { value } })),
    reopen: async () => {
      await act(async () => tree.update(React.createElement(module.exports.default, props(null))));
      await act(async () => tree.update(React.createElement(module.exports.default, props(structuredClone(stored)))));
    },
    close: async () => act(async () => tree.unmount()),
  };
}

test('admin searches beyond the first catalog page and saves only the assignment field; it stays on reopen', async () => {
  const ingredients = Array.from({ length: 501 }, (_, index) => ({ id: `i${index}`, name: `Masalliq ${String(index).padStart(3, '0')}`, category: 'food', active: true }));
  const f = await fixture({ ingredients });
  try {
    assert.deepEqual(f.reads, [['id', 500, 0], ['id', 500, 500]]);
    assert.equal(f.tree.root.findAllByType('input').filter(input => input.props.type === 'checkbox').length, 501);
    assert.equal(button(f.tree, saveLabel).props.disabled, true);
    await f.search('Masalliq 500');
    assert.equal(f.tree.root.findAllByType('label').length, 1);
    await f.toggle('Masalliq 500');
    assert.match(text(f.tree.toJSON()), /1 ta mahsulot tanlangan/);
    await f.save();
    assert.deepEqual(f.writes, [{ id: 'supplier-one', payload: { supplied_ingredient_ids: ['i500'] } }]);
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].name, 'Oziq savdo');
    assert.equal(f.saved[0].notes, 'Mavjud izoh');
    assert.equal(f.saved[0].recipient_type, 'supplier');
    assert.equal(f.saved[0].active, true);
    assert.deepEqual(f.saved[0].supplied_ingredient_ids, ['i500']);
    await f.reopen();
    assert.equal(checkbox(f.tree, 'Masalliq 500').props.checked, true);
    assert.equal(button(f.tree, saveLabel).props.disabled, true);
    assert.equal(f.writes.length, 1, 'opening and searching never autosave');
  } finally { await f.close(); }
});

test('an unconfigured supplier can explicitly save an empty assignment list and it stays empty on reopen', async () => {
  const f = await fixture({ configured: false, ingredients: [{ id: 'flour', name: 'Un', active: true }] });
  try {
    assert.equal(Object.hasOwn(f.stored(), 'supplied_ingredient_ids'), false);
    assert.equal(button(f.tree, saveLabel).props.disabled, false, 'unset and an intentionally empty configuration are different');
    await f.save();
    assert.deepEqual(f.writes, [{ id: 'supplier-one', payload: { supplied_ingredient_ids: [] } }]);
    assert.deepEqual(f.saved[0].supplied_ingredient_ids, []);
    assert.deepEqual(f.stored().supplied_ingredient_ids, []);
    await f.reopen();
    assert.equal(checkbox(f.tree, 'Un').props.checked, false);
    assert.equal(button(f.tree, saveLabel).props.disabled, true);
    assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

test('inactive assignments and IDs absent from the catalog survive adding a product; new inactive assignments stay blocked', async () => {
  const f = await fixture({ suppliedIds: ['old', 'missing'], ingredients: [
    { id: 'flour', name: 'Un', category: 'food' },
    { id: 'box', name: 'Quti', category: 'packaging', active: true },
    { id: 'old', name: 'Eski masalliq', category: 'food', active: false },
    { id: 'inactive', name: 'Yopiq masalliq', category: 'food', active: false },
  ] });
  try {
    assert.equal(checkbox(f.tree, 'Eski masalliq').props.checked, true);
    assert.equal(checkbox(f.tree, 'Eski masalliq').props.disabled, false);
    assert.match(text(ingredientRow(f.tree, 'Eski masalliq')), /Faol emas/);
    assert.equal(checkbox(f.tree, 'Yopiq masalliq').props.disabled, true);
    await f.toggle('Yopiq masalliq');
    assert.equal(checkbox(f.tree, 'Yopiq masalliq').props.checked, false);
    assert.match(text(f.tree.toJSON()), /1 ta oldingi bog‘lanish katalogda topilmadi/);
    await f.search('qadoq');
    assert.equal(f.tree.root.findAllByType('label').length, 1);
    await f.toggle('Quti');
    await f.save();
    assert.deepEqual(f.writes[0].payload, { supplied_ingredient_ids: ['old', 'missing', 'box'] });
    await f.reopen();
    assert.equal(checkbox(f.tree, 'Quti').props.checked, true);
    assert.equal(checkbox(f.tree, 'Eski masalliq').props.checked, true);
    await f.toggle('Eski masalliq');
    assert.equal(checkbox(f.tree, 'Eski masalliq').props.disabled, true);
    await f.save();
    assert.deepEqual(f.writes[1].payload, { supplied_ingredient_ids: ['missing', 'box'] }, 'only explicit removal clears an old inactive selection');
  } finally { await f.close(); }
});

test('catalog load failure prevents saving and offers a safe retry without losing existing assignments', async () => {
  const f = await fixture({ failLoad: true, suppliedIds: ['missing'], ingredients: [{ id: 'flour', name: 'Un', active: true }] });
  try {
    assert.match(text(f.tree.root.findByProps({ role: 'alert' })), /Katalog yuklanmadi/);
    assert.equal(button(f.tree, saveLabel).props.disabled, true);
    await f.save();
    assert.equal(f.writes.length, 0);
    f.allowLoad();
    await act(async () => button(f.tree, 'Qayta yuklash').props.onClick());
    await f.toggle('Un');
    await f.save();
    assert.deepEqual(f.writes[0].payload, { supplied_ingredient_ids: ['missing', 'flour'] });
  } finally { await f.close(); }
});

test('save errors retain selection for retry, and a partial acknowledgement preserves supplier details', async () => {
  const f = await fixture({ failSave: true, responseWithoutFields: true, ingredients: [{ id: 'flour', name: 'Un', active: true }] });
  try {
    await f.toggle('Un');
    await f.save();
    assert.match(text(f.tree.root.findByProps({ role: 'alert' })), /Saqlash rad etildi/);
    assert.equal(f.saved.length, 0);
    assert.equal(checkbox(f.tree, 'Un').props.checked, true);
    assert.equal(button(f.tree, saveLabel).props.disabled, false);
    f.allowSave();
    await f.save();
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.writes[1].payload, { supplied_ingredient_ids: ['flour'] });
    assert.deepEqual(f.saved[0].supplied_ingredient_ids, ['flour']);
    assert.equal(f.saved[0].name, 'Oziq savdo');
    assert.equal(f.saved[0].notes, 'Mavjud izoh');
  } finally { await f.close(); }
});

test('a repeated pagination row fails closed instead of silently saving an incomplete catalog', async () => {
  const ingredients = Array.from({ length: 501 }, (_, index) => ({ id: index === 500 ? 'i0' : `i${index}`, name: `Masalliq ${index}`, active: true }));
  const f = await fixture({ ingredients, suppliedIds: ['old'] });
  try {
    assert.equal(f.reads.length, 2);
    assert.match(text(f.tree.root.findByProps({ role: 'alert' })), /takrorlandi/);
    assert.equal(button(f.tree, saveLabel).props.disabled, true);
    await f.save();
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.stored().supplied_ingredient_ids, ['old']);
  } finally { await f.close(); }
});

test('a pending save cannot be duplicated or dismissed, and checkboxes stay locked until it completes', async () => {
  const f = await fixture({ pendingSave: true, ingredients: [{ id: 'flour', name: 'Un', active: true }] });
  try {
    await f.toggle('Un');
    let pending;
    const handler = button(f.tree, saveLabel).props.onClick;
    await act(async () => { pending = handler(); await handler(); });
    assert.equal(f.writes.length, 1);
    assert.equal(button(f.tree, 'Saqlanmoqda…').props.disabled, true);
    assert.equal(button(f.tree, 'Bekor qilish').props.disabled, true);
    assert.equal(checkbox(f.tree, 'Un').props.disabled, true);
    await act(async () => {
      f.tree.root.findByProps({ 'data-dialog': true }).props.onOpenChange(false);
      button(f.tree, 'Bekor qilish').props.onClick();
    });
    assert.deepEqual(f.closed, []);
    await act(async () => { f.finishSave(); await pending; });
    assert.equal(f.saved.length, 1);
    assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

for (const role of ['manager', 'cashier', 'accountant', 'warehouse']) {
  test(role + ' cannot load or edit supplier assignments', async () => {
    const f = await fixture({ role, ingredients: [{ id: 'flour', name: 'Un', active: true }] });
    try {
      assert.equal(f.tree.toJSON(), null);
      assert.deepEqual(f.reads, []);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.saved, []);
    } finally { await f.close(); }
  });
}
