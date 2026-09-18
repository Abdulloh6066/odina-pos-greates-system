// Offline-only navigation tests. No browser, Base44 database, or network calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(path, 'utf8');
const source = read('src/lib/route-preload.js');

// Use the actual route mapping/guard functions with a mock permission predicate.
// Do not invoke dynamic page imports (no browser/network calls in tests).
const permissions = {
  admin: new Set(['dashboard', 'pos', 'orders', 'warehouse', 'users', 'security', 'reports', 'sales']),
  cashier: new Set(['pos', 'orders', 'warehouse', 'sales']),
  warehouse: new Set(['warehouse']),
};
const compiled = source
  .replace("import { canAccess } from './pos.js';", 'const canAccess = (role, key) => permissions[role]?.has(key) === true;')
  .replace(/^export /gm, '');
const sandbox = { permissions };
vm.runInNewContext(compiled + '\nglobalThis.routeTools = { getPreloadKey, likelyRoutesForRole, PAGE_LOADERS };', sandbox);
const { getPreloadKey, likelyRoutesForRole, PAGE_LOADERS } = sandbox.routeTools;

test('navigation preload respects route roles including warehouse query tabs and screens', () => {
  assert.equal(getPreloadKey('/warehouse?tab=transfers', 'cashier'), 'warehouse');
  assert.equal(getPreloadKey('/pos?screen=1', 'cashier'), 'pos');
  assert.equal(getPreloadKey('/security', 'cashier'), null);
  assert.equal(getPreloadKey('/users', 'cashier'), null);
  assert.equal(getPreloadKey('/reports', 'warehouse'), null);
  assert.equal(getPreloadKey('/warehouse', 'warehouse'), 'warehouse');
  assert.equal(getPreloadKey('/made-up', 'admin'), null);
  assert.equal(getPreloadKey('/login', 'admin'), null);
});

test('idle warming chooses only permitted likely pages, not all 22 route chunks', () => {
  for (const role of Object.keys(permissions)) {
    const paths = likelyRoutesForRole(role);
    assert.ok(paths.length <= 5);
    for (const path of paths) assert.ok(getPreloadKey(path, role));
    assert.ok(!paths.includes('/reports')); // large reports bundle is loaded on intent only
  }
  assert.equal(Object.keys(PAGE_LOADERS).length, 22);
  assert.equal(likelyRoutesForRole('warehouse').length, 0);
});

test('React uses one shared cached loader; sidebar warms only on intent/idle, no business requests', () => {
  const app = read('src/App.jsx');
  const sidebar = read('src/components/Sidebar.jsx');
  const layout = read('src/components/Layout.jsx');
  assert.equal((app.match(/lazy\(\(\) => preloadPage\('/g) || []).length, 22);
  assert.match(source, /if \(!inFlight\.has\(key\)\)/);
  assert.match(source, /inFlight\.delete\(key\)/);
  assert.match(source, /return key \? preloadPage\(key\) : Promise\.resolve\(null\)/);
  assert.doesNotMatch(source, /base44|entities\.|functions\.invoke|\.create\(|\.update\(|\.delete\(/);
  assert.match(sidebar, /requestIdleCallback/);
  assert.match(sidebar, /onPointerEnter=\{\(\) => warmNavigation\(item\.path\)\}/);
  assert.match(sidebar, /onTouchStart=\{\(\) => warmNavigation\(child\.path\)\}/);
  assert.equal((layout.match(/<Suspense fallback=\{pageFallback\}>/g) || []).length, 2);
  assert.match(layout, /<Sidebar/);
});

test('order entrance is no longer delayed by a 0.65s animation plus staged waits', () => {
  const css = read('src/styles/orders-premium-ledger.css');
  assert.match(css, /animation:opl-rise \.18s/);
  assert.doesNotMatch(css, /animation-delay:\.(?:08|16|24)s/);
  assert.doesNotMatch(css, /animation:opl-rise \.65s/);
});
