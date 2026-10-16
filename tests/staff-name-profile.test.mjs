// Offline profile hydration: no authentication or live data calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function profile(stored) {
  const reads = [];
  const module = { exports: {} };
  const source = readFileSync('src/lib/AuthContext.jsx', 'utf8') + '\nexport { hydrateAppUser };';
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console,
    require: (id) => {
      if (id === 'react') return { createContext: () => ({}) };
      if (id === '@/api/base44Client') return { base44: { entities: { User: { get: async (userId) => {
        reads.push(userId);
        if (stored instanceof Error) throw stored;
        return stored;
      } } } } };
      if (id === '@/lib/app-params') return { appParams: {} };
      if (id === '@base44/sdk/dist/utils/axios-client') return {};
      throw new Error('Unexpected import: ' + id);
    },
  });
  return { hydrate: module.exports.hydrateAppUser, reads };
}

test('reopening uses the saved employee name while retaining session identity and stored access', async () => {
  const p = profile({ full_name: 'Mahkam Sadullayev', role: 'cashier', shop_id: 'branch', active: true });
  const result = await p.hydrate({ id: 'worker', email: 'worker@example.test', full_name: 'old-login-name', role: 'admin' });
  assert.equal(result.full_name, 'Mahkam Sadullayev');
  assert.equal(result.id, 'worker');
  assert.equal(result.email, 'worker@example.test');
  assert.equal(result.role, 'cashier');
  assert.equal(result.shop_id, 'branch');
  assert.equal(result.active, true);
  assert.deepEqual(p.reads, ['worker']);
});

test('legacy profiles without a saved name keep the session name and disabled access remains disabled', async () => {
  const p = profile({ data: { role: 'warehouse', shop_id: 'center', active: false } });
  const result = await p.hydrate({ id: 'worker', email: 'worker@example.test', full_name: 'Legacy worker' });
  assert.equal(result.full_name, 'Legacy worker');
  assert.equal(result.role, 'warehouse');
  assert.equal(result.shop_id, 'center');
  assert.equal(result.active, false);
});
