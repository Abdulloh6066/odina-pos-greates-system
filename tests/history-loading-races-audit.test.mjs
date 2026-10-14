// Exercise the actual hook with controlled promises and timers; no backend/network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { readEntityPage } from '../src/lib/history-pagination.js';

function harness() {
  const timers = new Map(), requests = [];
  let timerId = 0, latest, tree;
  const source = readFileSync('src/hooks/useEntityHistory.js', 'utf8')
    .replace(/^import .+\n/gm, '').replace('export function', 'function');
  const create = vm.runInNewContext(`(function(React, readEntityPage) {
    const { useCallback, useEffect, useRef, useState } = React;
    ${source}
    return useEntityHistory;
  })`, {
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), Date, JSON, Map,
  });
  const useHistory = create(React, readEntityPage);
  const entity = { filter: (query, sort, limit, skip) => new Promise((resolve, reject) => {
    requests.push({ query, sort, limit, skip, resolve, reject });
  }) };
  function Probe({ query }) { latest = useHistory(entity, query, '-created_date'); return null; }
  function render(query) {
    act(() => {
      if (tree) tree.update(React.createElement(Probe, { query }));
      else tree = renderer.create(React.createElement(Probe, { query }));
    });
  }
  function tick() { act(() => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } }); }
  async function resolve(index, rows) { await act(async () => { requests[index].resolve(rows); }); }
  async function reject(index, error) { await act(async () => { requests[index].reject(error); }); }
  return { requests, render, tick, resolve, reject, state: () => latest,
    reload: () => { act(() => { void latest.reload(); }); },
    more: () => { act(() => { void latest.loadMore(); }); },
    close: () => act(() => tree.unmount()) };
}

test('a delayed older filter reply cannot replace the newest history view', async () => {
  const h = harness();
  h.render({ business_date: '2026-10-01' }); h.tick();
  h.render({ business_date: '2026-10-02' }); h.tick();
  await h.resolve(1, [{ id: 'latest' }]);
  await h.resolve(0, [{ id: 'obsolete' }]);
  assert.equal(h.state().rows[0].id, 'latest');
  assert.equal(h.state().loading, false);
  assert.equal(h.state().error, '');
  h.close();
});

test('late page and late errors cannot contaminate a refreshed history query', async () => {
  const h = harness();
  h.render({ shop_id: 'shop' }); h.tick();
  await h.resolve(0, Array.from({ length: 100 }, (_, index) => ({ id: `old-${index}` })));
  h.more();
  h.reload();
  await h.resolve(2, [{ id: 'fresh' }]);
  await h.reject(1, new Error('Obsolete page failure'));
  assert.equal(h.state().rows.length, 1);
  assert.equal(h.state().rows[0].id, 'fresh');
  assert.equal(h.state().error, '');
  assert.equal(h.state().loadingMore, false);
  h.close();
});

test('repeated load-more taps make one request and preserve the frozen read window', async () => {
  const h = harness();
  h.render({}); h.tick();
  await h.resolve(0, Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}` })));
  h.more(); h.more();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].skip, 100);
  assert.deepEqual(h.requests[1].query, h.requests[0].query);
  await h.resolve(1, [{ id: 'oldest' }]);
  assert.equal(h.state().rows.length, 101);
  assert.equal(h.state().hasMore, false);
  h.close();
});

test('a failed older page preserves already loaded rows and can retry the same offset', async () => {
  const h = harness();
  h.render({}); h.tick();
  await h.resolve(0, Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}` })));
  h.more(); await h.reject(1, new Error('Page unavailable'));
  assert.equal(h.state().rows.length, 100);
  assert.equal(h.state().hasMore, true);
  assert.match(h.state().error, /Page unavailable/);
  h.more();
  assert.equal(h.requests[2].skip, 100);
  await h.resolve(2, [{ id: 'last' }]);
  assert.equal(h.state().rows.length, 101);
  assert.equal(h.state().error, '');
  h.close();
});
