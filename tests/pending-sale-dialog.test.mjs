// Render the actual dialog with memory doubles; no browser storage or live SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : (node.children || []).map(text).join('');
const record = () => ({ id: 'pos-central-000001', user_id: 'staff', shift_id: 'shift', status: 'failed',
  attempts: 3, created_at: '2026-11-07T05:00:00Z',
  last_error: 'To‘lovlar savdo summasiga teng bo‘lishi kerak. Kutilgan: 75000, kiritilgan: 65000.',
  request: { shift_id: 'shift', idempotency_key: 'pos-central-000001', items: [{ product_id: 'cake', quantity: 1 }],
    payments: [{ method: 'cash', amount: 65000 }] },
  local_sale: { sale_number: 'OD-TEST', shop_name: 'Central', total: 65000, subtotal: 75000,
    items: [{ product_name: 'Cake', quantity: 1, subtotal: 75000 }] } });
async function fixture({ state = 'pending', shiftStatus = 'open', online = true, records = [record()] } = {}) {
  const retries = [], resolutions = [], bulkResolutions = [], reads = [];
  const Wrapper = ({ children }) => React.createElement('div', null, children);
  const Icon = () => React.createElement('svg');
  const deps = {
    react: React, 'lucide-react': new Proxy({}, { get: () => Icon }),
    '@/api/base44Client': { base44: { functions: { invoke: async (name, payload) => {
      reads.push(payload); return { data: { state, shift_status: shiftStatus, subtotal: 75000, paid_total: 65000 } };
    } } } },
    '@/lib/pos': { formatUZS: value => value + ' UZS' },
    '@/lib/uzbekistan-time': { formatUzbekistanDateTime: value => value },
    '@/lib/offline-sales': { syncErrorMessage: error => error.message },
    '@/components/ui/button': { Button: props => React.createElement('button', props) },
    '@/components/ui/input': { Input: props => React.createElement('input', props) },
    '@/components/ui/textarea': { Textarea: props => React.createElement('textarea', props) },
    '@/components/ui/label': { Label: props => React.createElement('label', props) },
    '@/components/ui/dialog': { Dialog: Wrapper, DialogContent: Wrapper, DialogHeader: Wrapper, DialogTitle: Wrapper },
  };
  const module = { exports: {} };
  const js = transformSync(readFileSync('src/components/pos/PendingSalesDialog.jsx', 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})', {})(name => {
    assert.ok(deps[name], 'Unexpected dependency ' + name); return deps[name];
  }, module, module.exports);
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(module.exports.default, {
    records, online, syncing: false, onRetry: async payload => { retries.push(payload); return { synced: 1 }; },
    onResolve: async (...args) => { resolutions.push(args); return { state: args[1]?.operation === 'cancel' ? 'cancelled' : 'edited' }; }, onClose: () => {},
    onResolveAll: async (ids, options) => { bulkResolutions.push([ids, options]); return {
      results: ids.map(original_key => ({ original_key, state: 'cancelled' })), errors: [],
    }; },
  })); });
  const button = label => renderer.root.findAllByType('button').find(node => text(node) === label);
  const click = async label => { const node = button(label); assert.ok(node, label); assert.ok(!node.props.disabled, label + ' disabled');
    await act(async () => { node.props.onClick(); }); };
  const edit = (id, value) => act(() => renderer.root.findByProps({ id }).props.onChange({ target: { value } }));
  return { renderer, button, click, edit, retries, resolutions, bulkResolutions, reads, unmount: () => act(() => renderer.unmount()) };
}
test('staff sees the full rejection, 65000 amount and can retry just that sale without PIN', async () => {
  const f = await fixture();
  try {
    assert.ok(text(f.renderer.toJSON()).includes(record().last_error));
    assert.ok(text(f.renderer.toJSON()).includes('65000 UZS'));
    assert.equal(f.reads[0].action, 'inspect_pending_sale');
    await f.click('Qayta yuborish');
    assert.deepEqual(structuredClone(f.retries[0]), { retryFailed: true, recordId: record().id });
    assert.equal(f.resolutions.length, 0);
  } finally { f.unmount(); }
});
test('edit starts with 65000 and requires a reason and PIN before submission', async () => {
  const f = await fixture();
  try {
    await f.click('Tahrirlash');
    assert.equal(f.renderer.root.findByProps({ id: 'pending-sale-total' }).props.value, '65000');
    assert.ok(f.button('PIN bilan saqlash').props.disabled);
    f.edit('pending-sale-reason', 'Chegirma yo‘qolgan'); f.edit('pending-sale-pin', '1234');
    assert.equal(f.button('PIN bilan saqlash').props.disabled, false);
    await act(async () => { f.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    assert.equal(f.resolutions[0][1].finalTotal, 65000);
    assert.equal(f.resolutions[0][1].pin, '1234');
    assert.equal(f.retries.length, 0);
  } finally { f.unmount(); }
});
test('closed shift keeps review and PIN cancellation available but blocks editing', async () => {
  const f = await fixture({ shiftStatus: 'closed' });
  try {
    assert.ok(f.button('Tahrirlash').props.disabled);
    assert.equal(f.button('Bekor qilish').props.disabled, false);
    await f.click('Bekor qilish');
    assert.ok(f.button('PIN bilan bekor qilish').props.disabled);
  } finally { f.unmount(); }
});
test('in-flight server sale is inspectable but cannot be edited or cancelled', async () => {
  const f = await fixture({ state: 'processing' });
  try { assert.ok(f.button('Tahrirlash').props.disabled); assert.ok(f.button('Bekor qilish').props.disabled); }
  finally { f.unmount(); }
});
test('offline staff can read retained error but cannot retry or approve an edit', async () => {
  const f = await fixture({ online: false });
  try {
    assert.equal(f.reads.length, 0);
    assert.ok(text(f.renderer.toJSON()).includes(record().last_error));
    assert.ok(f.button('Qayta yuborish').props.disabled);
    assert.ok(f.button('Bekor qilish').props.disabled);
  } finally { f.unmount(); }
});
test('bulk cancellation shows the selected count and requires owner PIN before submitting', async () => {
  const records = [record(), { ...record(), id: 'pos-central-000002' }];
  const f = await fixture({ records });
  try {
    await f.click('Hammasini bekor qilish (2)');
    assert.ok(text(f.renderer.toJSON()).includes('2 ta savdoni bekor qilish'));
    assert.ok(f.button('Hammasini PIN bilan bekor qilish').props.disabled);
    assert.equal(f.bulkResolutions.length, 0);
    f.edit('pending-sale-reason', 'Navbatni tekshirish'); f.edit('pending-sale-pin', '1234');
    await act(async () => { f.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    assert.deepEqual(Array.from(f.bulkResolutions[0][0]), records.map(row => row.id));
    assert.equal(f.bulkResolutions[0][1].pin, '1234');
    assert.equal(f.resolutions.length, 0);
    assert.equal(f.retries.length, 0);
  } finally { f.unmount(); }
});
