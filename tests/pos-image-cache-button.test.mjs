import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React from 'react';
import { create, act } from 'react-test-renderer';

const source = transformSync(readFileSync('src/components/pos/PosImageCacheButton.jsx', 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
function fixture(extra = {}) {
  const requests = [], notices = [], gate = deferred();
  const probes = [];
  const imageBox = { getBoundingClientRect: () => ({ width: 130, height: 107 }) };
  const root = { getBoundingClientRect: () => ({ width: 130, height: 108 }),
    querySelector: selector => selector.includes('product-scroll') ? { clientWidth: 800 }
      : extra.emptyView ? null : { firstElementChild: imageBox, getBoundingClientRect: () => ({ width: 130, height: 108 }) },
    append: probe => probes.push(probe) };
  const dependencies = {
    react: React,
    'lucide-react': new Proxy({}, { get: () => () => React.createElement('svg') }),
    '@/components/ui/button': { Button: props => React.createElement('button', props) },
    '@/components/ui/use-toast': { toast: value => notices.push(value) },
    '@/lib/pos-image-cache': { cachePosImages: (products, options) => { requests.push({ products, options }); return gate.promise; } },
  };
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {
    window: { isSecureContext: true, caches: {}, location: { origin: 'https://offline.test' },
      getComputedStyle: () => ({ paddingLeft: '20px', paddingRight: '20px' }) },
    document: { querySelector: () => root, createElement: () => ({ style: {}, setAttribute() {}, append() {},
      getBoundingClientRect: imageBox.getBoundingClientRect, remove() { this.removed = true; } }) }, AbortController,
  })(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  const Component = module.exports.default;
  let tree;
  let props = { products: [{ id: 'a', image_url: '/images/a.webp' }], scopeKey: 'owner:branch', online: true, disabled: false, ...extra };
  act(() => { tree = create(React.createElement(Component, props)); });
  return { tree, requests, notices, gate, probes,
    button: () => tree.root.findByType('button'),
    update: next => act(() => { props = { ...props, ...next }; tree.update(React.createElement(Component, props)); }),
    close: () => act(() => tree.unmount()) };
}
const completed = { total: 2, downloaded: 1, cached: 1, failed: [], skipped: 0, cancelled: false };

test('button shows download progress, keeps card dimensions, and marks only a complete result as stored', async () => {
  const f = fixture();
  try {
    act(() => f.button().props.onClick());
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].options.width, 130); assert.equal(f.requests[0].options.height, 107);
    act(() => f.requests[0].options.onProgress({ ...completed, downloaded: 0 }));
    assert.equal(f.button().props['aria-busy'], true);
    await act(async () => { f.gate.resolve(completed); });
    assert.equal(f.button().props['aria-label'], 'Rasmlar saqlandi');
    assert.equal(f.notices.length, 1);
  } finally { f.close(); }
});

test('an empty view measures a hidden grid probe rather than warming an unrelated 512px size', async () => {
  const f = fixture({ emptyView: true });
  try {
    act(() => f.button().props.onClick());
    assert.equal(f.probes.length, 1);
    assert.equal(f.probes[0].style.width, '760px');
    assert.equal(f.probes[0].removed, true);
    assert.equal(f.requests[0].options.width, 130);
    assert.equal(f.requests[0].options.height, 107);
    await act(async () => f.gate.resolve(completed));
  } finally { f.close(); }
});

test('second click cancels work and completed partial downloads remain distinguishable from full success', async () => {
  const f = fixture();
  try {
    act(() => f.button().props.onClick());
    act(() => f.button().props.onClick());
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.signal.aborted, true);
    await act(async () => { f.gate.resolve({ ...completed, total: 200, downloaded: 1, cached: 0, cancelled: true }); });
    assert.equal(f.button().props['aria-label'], 'Rasmlarni saqlash');
    assert.equal(f.button().props['aria-busy'], false);
    assert.match(f.notices[0].description, /Saqlanmagan: 199/);
  } finally { f.close(); }
});

test('changing shop cancels the old batch and ignores late progress and completion', async () => {
  const f = fixture();
  try {
    act(() => f.button().props.onClick());
    f.update({ scopeKey: 'owner:other' });
    assert.equal(f.requests[0].options.signal.aborted, true);
    act(() => f.requests[0].options.onProgress(completed));
    await act(async () => { f.gate.resolve(completed); });
    assert.equal(f.button().props['aria-label'], 'Rasmlarni saqlash');
    assert.equal(f.notices.length, 0);
  } finally { f.close(); }
});

test('offline state blocks a new batch and per-file failures never claim all images are saved', async () => {
  const f = fixture({ online: false });
  try {
    assert.equal(f.button().props.disabled, true);
    act(() => f.button().props.onClick()); assert.equal(f.requests.length, 0);
    f.update({ online: true }); act(() => f.button().props.onClick());
    await act(async () => { f.gate.resolve({ ...completed, downloaded: 0, failed: [{ url: '/images/b.webp' }] }); });
    assert.equal(f.button().props['aria-label'], 'Rasmlarni saqlash');
    assert.match(f.notices[0].description, /Saqlanmagan: 1/);
  } finally { f.close(); }
});
