import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';

function evaluate(file, dependencies) {
  const module = { exports: {} };
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})', {})(name => {
    if (name === 'react') return { ...React, default: React };
    if (name in dependencies) return dependencies[name];
    throw Error('Unexpected dependency ' + name);
  }, module, module.exports);
  return module.exports;
}
const permissions = evaluate('src/lib/pos.js', { '@/api/base44Client': {}, './uzbekistan-time.js': {} });
const Navigate = () => null;
const manager = { role: 'manager', shop_id: 'a', active: true };
function route(user, key) {
  return evaluate('src/components/RoleRoute.jsx', {
    'react-router-dom': { Navigate }, '@/lib/AuthContext': { useAuth: () => ({ user }) }, '@/lib/pos': permissions,
  }).default({ pageKey: key, children: 'allowed' });
}
test('manager direct routes deny Budget, Settings and owner Security while owner retains access', () => {
  for (const key of ['budget', 'settings', 'security']) {
    assert.equal(permissions.canAccess('manager', key), false);
    assert.equal(route(manager, key).type, Navigate);
    assert.equal(route({ role: 'admin' }, key), 'allowed');
  }
  for (const key of permissions.ROLE_MENU.manager) assert.equal(route(manager, key), 'allowed', key);
  assert.equal(route(manager, 'shifts'), 'allowed');
  assert.notEqual(route({ ...manager, active: false }, 'products'), 'allowed');
  assert.notEqual(route({ ...manager, shop_id: '' }, 'products'), 'allowed');
});
