// Actual React hook/component with controlled offline responses. No live SDK,
// local storage, financial mutations, browser tab, or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { transformSync } from 'esbuild';
import { formatUzbekistanDateTime } from '../src/lib/uzbekistan-time.js';

const row = (id = 'remote-event', extra = {}) => ({
  event_id: id, actor_id: 'remote-worker', actor_name: 'Boshqa qurilmadagi kassir',
  shop_id: 'branch', shop_name: 'Odina do‘koni', shift_id: 'remote-shift',
  total_ms: 1234, api_round_trip_ms: 805, outcome: 'confirmed',
  client_completed_at: '2026-10-15T21:29:55Z', received_at: '2026-10-15T21:30:00Z',
  source: 'browser', ...extra,
});
const page = (records, hasMore = false, nextSkip = null) => ({ data: { records, has_more: hasMore, next_skip: nextSkip } });
const textOf = (node) => node == null ? '' : typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(textOf).join(' ') : textOf(node.children);

function harness({ component = false, initial = {} } = {}) {
  const requests = [], snapshots = [];
  let latest, tree, props = { open: true, userRole: 'admin', ...initial };
  const base44 = { functions: { invoke: (name, body) => new Promise((resolve, reject) => {
    requests.push({ name, body: structuredClone(body), resolve, reject });
  }) } };
  const hookSource = readFileSync('src/hooks/useCheckoutTimingHistory.js', 'utf8')
    .replace(/^import .+\r?\n/gm, '').replace('export default function', 'function').replace(/export const /g, 'const ');
  const hookFactory = vm.runInNewContext(`(function() {
    ${hookSource}
    return { useCheckoutTimingHistory, checkoutTimingRecordKey };
  })`, { ...React, base44 });
  const hooks = hookFactory();
  let View;
  if (component) {
    const source = readFileSync('src/components/pos/CheckoutTimingHistory.jsx', 'utf8')
      .replace(/^import .+\r?\n/gm, '').replace('export default function', 'function');
    const compiled = transformSync(source + '\nglobalThis.View = CheckoutTimingHistory;', { loader: 'jsx', jsx: 'transform' }).code;
    const wrapper = ({ children }) => React.createElement('div', null, children);
    const context = { React, useState: React.useState, ...hooks, formatUzbekistanDateTime,
      Clock: () => React.createElement('span'), RefreshCw: () => React.createElement('span'),
      Dialog: ({ open, children }) => open ? React.createElement('section', null, children) : null,
      DialogContent: wrapper, DialogHeader: wrapper, DialogTitle: wrapper, DialogDescription: wrapper,
      Button: ({ children, variant: _variant, ...rest }) => React.createElement('button', rest, children),
      Input: inputProps => React.createElement('input', inputProps),
      OdinaSelect: selectProps => React.createElement('select', selectProps),
    };
    vm.runInNewContext(compiled, context);
    View = context.View;
  } else {
    View = viewProps => {
      latest = hooks.useCheckoutTimingHistory(viewProps);
      snapshots.push({ props: viewProps, records: [...latest.records], loading: latest.loading });
      return null;
    };
  }
  const render = (next = {}) => {
    props = { ...props, ...next };
    act(() => {
      const element = React.createElement(View, { onOpenChange: () => {}, ...props });
      if (tree) tree.update(element);
      else tree = renderer.create(element);
    });
  };
  const settle = async (index, value, rejected = false) => {
    await act(async () => { requests[index][rejected ? 'reject' : 'resolve'](value); });
  };
  render();
  return { requests, snapshots, render, state: () => latest, tree: () => tree, text: () => textOf(tree.toJSON()),
    resolve: (index, value) => settle(index, value), reject: (index, error) => settle(index, error, true),
    refresh: () => act(() => { void latest.refresh(); }),
    more: () => act(() => { void latest.loadMore(); }), retry: () => act(() => { void latest.retry(); }),
    close: () => act(() => tree.unmount()) };
}

test('closed dialogs and every non-admin role make no history requests and expose no rows', () => {
  for (const userRole of ['cashier', 'manager', 'accountant', 'production', 'warehouse', 'Admin', '', undefined]) {
    const h = harness({ initial: { userRole } });
    assert.equal(h.requests.length, 0);
    assert.equal(h.state().records.length, 0);
    h.refresh(); h.more(); h.retry();
    assert.equal(h.requests.length, 0);
    h.close();
  }
  const h = harness({ initial: { open: false } });
  h.refresh(); h.more();
  assert.equal(h.requests.length, 0);
  h.close();
});

test('owner opening history reads server records from any worker/device, without requiring an active shift', async () => {
  const h = harness({ initial: { open: false } });
  h.render({ open: true });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].name, 'checkout-timing');
  assert.deepEqual(h.requests[0].body, { action: 'list', limit: 50, skip: 0 });
  assert.equal(h.state().loading, true);
  await h.resolve(0, page([row()]));
  assert.equal(h.state().records[0].actor_id, 'remote-worker');
  assert.equal(h.state().records[0].shift_id, 'remote-shift');
  assert.equal(h.state().loading, false);
  h.close();
});

test('pages stay bounded and duplicate event ids from different staff remain distinct', async () => {
  const h = harness();
  await h.resolve(0, page(Array.from({ length: 50 }, (_, index) => row(String(index))), true, 50));
  h.more(); h.more();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.limit, 50);
  assert.equal(h.requests[1].body.skip, 50);
  await h.resolve(1, page([row('0'), row('0', { actor_id: 'another-worker', actor_name: 'Ikkinchi kassir' }), row('50')]));
  assert.equal(h.state().records.length, 52);
  assert.equal(h.state().records.filter(record => record.event_id === '0').length, 2);
  assert.equal(h.state().hasMore, false);
  h.more();
  assert.equal(h.requests.length, 2);
  h.close();
});

test('initial-page deduplication uses actor and event together, matching backend event identity', async () => {
  const h = harness();
  await h.resolve(0, page([row('same'), row('same'), row('same', { actor_id: 'second-worker' })]));
  assert.equal(h.state().records.length, 2);
  assert.deepEqual([...h.state().records].map(record => record.actor_id), ['remote-worker', 'second-worker']);
  h.close();
});

test('shop and date filters hide previous rows during render and use the backend filter names', async () => {
  const h = harness();
  await h.resolve(0, page([row('old-shop')]));
  const previousRenders = h.snapshots.length;
  h.render({ shopId: 'second-shop', fromDate: '2026-10-01', toDate: '2026-10-16' });
  assert.equal(h.state().records.length, 0);
  assert.ok(h.snapshots.slice(previousRenders).every(snapshot => !snapshot.records.some(record => record.event_id === 'old-shop')));
  assert.deepEqual(h.requests[1].body, { action: 'list', limit: 50, skip: 0, shop_id: 'second-shop', from_date: '2026-10-01', to_date: '2026-10-16' });
  await h.resolve(1, page([row('new-shop', { shop_id: 'second-shop' })]));
  assert.equal(h.state().records[0].event_id, 'new-shop');
  h.close();
});

test('out-of-order filter replies cannot overwrite the latest filter results', async () => {
  const h = harness();
  h.render({ shopId: 'new-shop' });
  await h.resolve(1, page([row('new')]));
  await h.resolve(0, page([row('old')]));
  assert.equal(h.state().records[0].event_id, 'new');
  assert.equal(h.state().error, '');
  h.close();
});

test('closing, reopening, and losing admin access invalidate outstanding requests immediately', async () => {
  const h = harness();
  h.render({ open: false });
  await h.resolve(0, page([row('closed-dialog-result')]));
  assert.equal(h.state().records.length, 0);
  h.render({ open: true });
  assert.equal(h.requests.length, 2);
  await h.resolve(1, page([row('visible-only-to-owner')]));
  h.render({ userRole: 'cashier' });
  assert.equal(h.state().records.length, 0);
  h.refresh();
  assert.equal(h.requests.length, 2);
  h.render({ userRole: 'admin' });
  assert.equal(h.state().records.length, 0);
  assert.equal(h.requests.length, 3);
  await h.resolve(2, page([row('new-owner-read')]));
  assert.equal(h.state().records[0].event_id, 'new-owner-read');
  const refresh = h.state().refresh;
  h.close();
  await refresh();
  assert.equal(h.requests.length, 3);
});

test('same-filter refresh beats older requests and stale errors never replace a fresh success', async () => {
  const h = harness();
  h.refresh();
  await h.resolve(1, page([row('latest-refresh')]));
  await h.reject(0, new Error('Old request failed'));
  assert.equal(h.state().records[0].event_id, 'latest-refresh');
  assert.equal(h.state().error, '');
  assert.equal(h.state().loading, false);
  h.close();
});

test('refresh cancels an older load-more result without mixing pages', async () => {
  const h = harness();
  await h.resolve(0, page([row('first')], true, 50));
  h.more();
  h.refresh();
  assert.equal(h.state().records.length, 0);
  await h.resolve(2, page([row('refreshed-first')]));
  await h.resolve(1, page([row('obsolete-next')]));
  assert.equal(h.state().records.length, 1);
  assert.equal(h.state().records[0].event_id, 'refreshed-first');
  h.close();
});

test('a failed next page preserves loaded records and retry uses the same offset', async () => {
  const h = harness();
  await h.resolve(0, page([row('first')], true, 50));
  h.more(); await h.reject(1, new Error('Sahifa yuklanmadi'));
  assert.equal(h.state().records[0].event_id, 'first');
  assert.match(h.state().error, /Sahifa yuklanmadi/);
  h.retry();
  assert.equal(h.requests[2].body.skip, 50);
  await h.resolve(2, page([row('next')]));
  assert.equal(h.state().records.length, 2);
  assert.equal(h.state().error, '');
  h.close();
});

test('a server authorization denial clears earlier owner rows even before the cached role changes', async () => {
  const h = harness();
  await h.resolve(0, page([row('previous-owner-read')], true, 50));
  h.more();
  await h.reject(1, { response: { status: 403, data: { error: 'Faqat egasi uchun ochiq.' } } });
  assert.equal(h.state().records.length, 0);
  assert.equal(h.state().hasMore, false);
  assert.match(h.state().error, /Faqat egasi/);
  h.retry();
  assert.equal(h.requests[2].body.skip, 0);
  await h.resolve(2, page([row('fresh-authorized-read')]));
  assert.equal(h.state().records[0].event_id, 'fresh-authorized-read');
  h.close();
});

test('invalid date ranges are explicit errors and never issue a backend read', () => {
  const h = harness({ initial: { fromDate: '2026-10-16', toDate: '2026-10-15' } });
  assert.equal(h.requests.length, 0);
  assert.match(h.state().error, /Boshlanish sanasi/);
  assert.equal(h.state().loading, false);
  h.close();
});

test('malformed metrics, outcomes, oversized pages and invalid cursors never appear as real history', async () => {
  const malformed = [
    page([row('bad', { total_ms: '1234' })]), page([row('bad', { total_ms: NaN })]),
    page([row('bad', { total_ms: Infinity })]), page([row('bad', { total_ms: -1 })]),
    page([row('bad', { total_ms: null })]), page([row('bad', { outcome: 'saved' })]),
    page([row('bad', { actor_id: '' })]), page([row('bad', { api_round_trip_ms: '805' })]),
    page(Array.from({ length: 51 }, (_, index) => row(String(index)))),
    page([row()], true, 0), { data: { records: [], next_skip: null } },
  ];
  for (const response of malformed) {
    const h = harness();
    await h.resolve(0, response);
    assert.equal(h.state().records.length, 0);
    assert.ok(h.state().error);
    assert.equal(h.state().loading, false);
    h.close();
  }
});

test('dialog shows loading and retryable errors before a genuine empty result', async () => {
  const h = harness({ component: true });
  assert.match(h.text(), /yuklanmoqda/);
  assert.doesNotMatch(h.text(), /o‘lchov topilmadi/);
  await h.reject(0, new Error('Tarix yuklanmadi'));
  assert.match(h.text(), /Tarix yuklanmadi/);
  assert.match(h.text(), /Qayta urinish/);
  assert.doesNotMatch(h.text(), /o‘lchov topilmadi/);
  const retry = h.tree().root.findAllByType('button').find(button => textOf(button.toJSON?.()) === 'Qayta urinish'
    || button.props.children === 'Qayta urinish');
  act(() => { retry.props.onClick(); });
  await h.resolve(1, page([]));
  assert.match(h.text(), /o‘lchov topilmadi/);
  assert.doesNotMatch(h.text(), /Tarix yuklanmadi/);
  h.close();
});

test('real dialog labels queued/unconfirmed outcomes distinctly and formats received time in Tashkent', async () => {
  const h = harness({ component: true });
  await h.resolve(0, page([
    row('saved', { outcome: 'confirmed' }), row('checked', { outcome: 'rechecked' }),
    row('queued', { outcome: 'queued' }), row('unknown', { outcome: 'unconfirmed' }),
  ]));
  const articles = h.tree().root.findAllByType('article');
  const queued = textOf(articles[2]);
  const unknown = textOf(articles[3]);
  assert.match(queued, /Qurilmaga saqlash qaydi/);
  assert.doesNotMatch(queued, /1,2\s+soniya/, 'local handoff duration cannot be displayed as server confirmation time');
  assert.doesNotMatch(queued, /Savdo tasdiqlandi|saqlandi/i);
  assert.match(unknown, /Yakunlash tasdiqlanmadi/);
  assert.doesNotMatch(unknown, /Savdo tasdiqlandi|saqlandi/i);
  assert.match(h.text(), /1,2 soniya/);
  assert.match(h.text(), /So‘rov va javob:.*0,8 soniya/);
  assert.match(h.text(), /02:30:00/);
  assert.doesNotMatch(h.text(), /21:30:00/);
  assert.match(h.text(), /Boshqa qurilmadagi kassir/);
  assert.match(h.text(), /Odina do‘koni/);
  h.close();
});

test('a worker cannot render owner timing history even when open is forced true', () => {
  const h = harness({ component: true, initial: { userRole: 'cashier', open: true } });
  assert.equal(h.tree().toJSON(), null);
  assert.equal(h.requests.length, 0);
  h.close();
});
