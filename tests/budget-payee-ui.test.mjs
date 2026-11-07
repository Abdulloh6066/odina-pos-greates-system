// Render the real Budget page with a memory-only ledger. No live services or writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';
import * as retry from '../src/lib/order-request-retry.js';
import * as dates from '../src/lib/uzbekistan-time.js';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const wrapper = tag => ({ children, ...props }) => React.createElement(tag, props, children);
const rows = tree => tree.root.findAll(node => node.type === 'div'
  && node.props.className?.split(' ').includes('odina-budget-row'));
const payeeLabels = row => row.findAllByType('p').map(text).filter(value => value.startsWith('Qabul qiluvchi:'));

function budgetComponent(backend, alerts) {
  const module = { exports: {} };
  const require = name => {
    if (name === 'react') return { ...React, default: React };
    if (name === 'react-router-dom') return { useOutletContext: () => ({ user: { id: 'mock-owner', role: 'admin' } }) };
    if (name === '@/api/base44Client') return { base44: backend };
    if (name === '@/lib/odina-dialog') return { odinaAlert: async message => { alerts.push(message); } };
    if (name === '@/lib/pos') return { formatUZS: value => `${value} UZS` };
    if (name === '@/lib/uzbekistan-time') return dates;
    if (name === '@/lib/order-request-retry') return { ...retry, readOrderRequest: () => null,
      retainOrderRequest: () => assert.fail('History cannot retain a financial request'),
      clearOrderRequest: () => assert.fail('History cannot clear a financial request'),
    };
    if (name === '@/components/PageHeader') return { default: wrapper('header') };
    if (name.endsWith('/odina-select')) return { default: wrapper('select') };
    if (name === 'lucide-react') return new Proxy({}, { get: () => wrapper('svg') });
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/components/ui/')) return new Proxy({}, { get: (_target, exported) => exported === 'Dialog'
      ? ({ open, children }) => open ? React.createElement('dialog', {}, children) : null
      : wrapper(({ Button: 'button', Input: 'input', Label: 'label', Textarea: 'textarea' })[exported] || 'div') });
    throw Error(`Unexpected Budget dependency: ${name}`);
  };
  const result = ts.transpileModule(readFileSync('src/pages/Budget.jsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.length || 0, 0);
  vm.runInNewContext('(function(require,module,exports){' + result.outputText + '\n})', { console })(require, module, module.exports);
  return module.exports.default;
}

const transaction = (id, extra = {}) => ({
  id, transaction_number: `MOCK-${id}`, type: 'supplier_payment', direction: 'out', account: 'cash',
  amount: 40000, balance_before: 100000, balance_after: 60000,
  supplier_id: 'mock-supplier', supplier_name: 'Mock recipient',
  description: 'Un uchun qarz to‘lovi', performed_by_name: 'Mock owner', shop_name: 'Mock shop',
  created_at: '2026-11-07T10:30:00.000Z', ...extra,
});

async function fixture(transactions) {
  const calls = [], alerts = [];
  const backend = { functions: { invoke: async (name, payload) => {
    calls.push(structuredClone({ name, payload }));
    assert.equal(name, 'budget-ledger');
    assert.deepEqual({ ...payload }, { action: 'summary' }, 'History only reads the ledger summary');
    return { data: { balances: [{ account: 'cash', balance: 60000 }], transactions: structuredClone(transactions) } };
  } } };
  const Component = budgetComponent(backend, alerts);
  let tree;
  await act(async () => { tree = create(React.createElement(Component)); });
  return {
    tree,
    async search(value) {
      await act(async () => tree.root.findByType('input').props.onChange({ target: { value } }));
    },
    async close() {
      await act(async () => tree.unmount());
      assert.deepEqual(alerts, [], 'Rendering history must not produce a load or mutation error');
      assert.deepEqual(calls, [{ name: 'budget-ledger', payload: { action: 'summary' } }]);
    },
  };
}

test('Budget supplier payments explicitly show the stored payee separately from actor and notes', async () => {
  const f = await fixture([transaction('named', {
    supplier_name: '  Aziz Un Yetkazib Beruvchi  ',
    performed_by_name: 'Dilshod Egasi',
    description: 'Transport xarajati, izohdagi boshqa ism: Sardor',
  })]);
  try {
    assert.equal(rows(f.tree).length, 1);
    const row = rows(f.tree)[0];
    assert.deepEqual(payeeLabels(row), ['Qabul qiluvchi: Aziz Un Yetkazib Beruvchi']);
    assert.match(text(row), /Dilshod Egasi/);
    assert.match(text(row), /Transport xarajati, izohdagi boshqa ism: Sardor/);
    assert.match(text(row), /Yetkazib beruvchi qarzi/);
    assert.match(text(row), /−40000 UZS/);
    assert.match(text(row), /Qoldiq: 100000 UZS → 60000 UZS/);
  } finally { await f.close(); }
});

test('legacy supplier payments with absent or blank names truthfully show an unknown payee', async () => {
  const legacy = transaction('absent');
  delete legacy.supplier_name;
  const transactions = [legacy, ...[null, '', ' \t\n '].map((supplier_name, index) => transaction(`blank-${index}`, { supplier_name }))];
  const f = await fixture(transactions);
  try {
    assert.equal(rows(f.tree).length, 4);
    for (const row of rows(f.tree)) {
      assert.deepEqual(payeeLabels(row), ['Qabul qiluvchi: Noma’lum']);
      assert.match(text(row), /Mock owner/, 'The actor remains separate, not a substitute payee');
      assert.match(text(row), /Un uchun qarz to‘lovi/, 'Legacy notes remain intact');
    }
  } finally { await f.close(); }
});

test('non-supplier Budget rows never label the actor or an incidental supplier field as a payee', async () => {
  const types = ['shift_deposit', 'manual_deposit', 'manual_withdrawal'];
  const f = await fixture(types.map(type => transaction(type, {
    type, direction: type === 'manual_withdrawal' ? 'out' : 'in', supplier_name: 'Incidental supplier',
  })));
  try {
    assert.equal(rows(f.tree).length, types.length);
    for (const row of rows(f.tree)) assert.deepEqual(payeeLabels(row), []);
    assert.doesNotMatch(text(f.tree.toJSON()), /Qabul qiluvchi:/);
  } finally { await f.close(); }
});

test('Budget search finds the stored recipient name and clearing search restores history without writes', async () => {
  const f = await fixture([
    transaction('recipient', { supplier_name: 'Zarafshon Don Mahsulotlari' }),
    transaction('other', { supplier_name: 'Boshqa Yetkazib Beruvchi' }),
    transaction('manual', { type: 'manual_withdrawal', supplier_name: undefined }),
  ]);
  try {
    assert.equal(rows(f.tree).length, 3);
    await f.search('  ZARAFSHON DON  ');
    assert.equal(rows(f.tree).length, 1);
    assert.deepEqual(payeeLabels(rows(f.tree)[0]), ['Qabul qiluvchi: Zarafshon Don Mahsulotlari']);
    assert.match(text(rows(f.tree)[0]), /MOCK-recipient/);
    await f.search('no-matching-recipient');
    assert.equal(rows(f.tree).length, 0);
    assert.match(text(f.tree.toJSON()), /Hozircha Budget harakati yo‘q/);
    await f.search('');
    assert.equal(rows(f.tree).length, 3);
  } finally { await f.close(); }
});
