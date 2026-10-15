import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

for (const role of ['production', 'accountant', 'admin']) {
  for (const inactive of [{ active: false }, { active: true, data: { active: false } }]) {
    test(`inactive ${role} cannot change product availability`, async () => {
      const f = memoryBackend({ User: [{ id: 'u', role, email: 'offline@example.test', ...inactive }],
        Product: [{ id: 'p', name: 'Offline product', active: true }] });
      let handler;
      f.load('base44/functions/set-product-availability/index.ts', { Deno: { serve: fn => { handler = fn; } } });
      const response = await handler({ json: async () => ({ product_id: 'p', active: false }) });
      assert.equal(response.status, 403);
      assert.equal(f.db.Product[0].active, true);
      assert.equal(f.calls.length, 0);
    });
  }
}
for (const role of ['accountant', 'admin']) {
  test(`inactive ${role} cannot read profit breakdown`, async () => {
    const f = memoryBackend({ User: [{ id: 'u', role, active: false, email: 'offline@example.test' }] });
    assert.equal((await f.invoke('base44/functions/profit-report/entry.ts', { action: 'product_breakdown', product_id: 'p' })).status, 403);
  });
  test(`active ${role} retains profit breakdown access`, async () => {
    const f = memoryBackend({ User: [{ id: 'u', role, active: true, email: 'offline@example.test' }],
      Product: [{ id: 'p', name: 'Offline product' }] });
    assert.equal((await f.invoke('base44/functions/profit-report/entry.ts', { action: 'product_breakdown', product_id: 'p' })).status, 200);
  });
}
test('inactive cashier cannot use legacy discount validator', async () => {
  const f = memoryBackend({ User: [{ id: 'u', role: 'cashier', active: false, email: 'offline@example.test' }] });
  let handler;
  f.load('base44/functions/validate-discount/index.ts', { Deno: { serve: fn => { handler = fn; } } });
  assert.equal((await handler({ json: async () => ({ code: 'OFFLINE' }) })).status, 403);
});
