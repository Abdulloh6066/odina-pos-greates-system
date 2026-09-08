import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/test-catalog-cleanup.js', import.meta.url), 'utf8');
const { deleteTestCatalog, MANIFEST } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { MANIFEST };').toString('base64'));

function fixture(role = 'admin') {
  const data = Object.fromEntries(Object.entries(MANIFEST).map(([name, rows]) => [name, rows.map(row => ({ ...row,
    ...(name === 'Product' ? { archived: true, active: false } : {}),
    ...(name === 'Recipe' ? { active: false } : {}),
  }))]));
  for (const name of Object.keys(data)) data[name].push({ id: 'new-' + name, active: true });
  const calls = [];
  let failId;
  const client = { auth: { me: async () => ({ role, active: true }) }, entities: {} };
  for (const name of Object.keys(data)) client.entities[name] = {
    filter: async (query) => data[name].filter(row => query.id.$in.includes(row.id)),
    delete: async (id) => {
      calls.push([name, id]);
      if (id === failId) throw new Error('simulated failure');
      data[name] = data[name].filter(row => row.id !== id);
    }
  };
  return { data, client, calls, fail: (id) => { failId = id; } };
}

test('deletes only fixed test records, preserving new records and unrelated entities', async () => {
  const f = fixture();
  const result = await deleteTestCatalog(f.client);
  for (const [name, rows] of Object.entries(MANIFEST)) {
    assert.equal(result[name], rows.length);
    assert.deepEqual(f.data[name].map(row => row.id), ['new-' + name]);
  }
  assert.equal(f.calls.length, 215);
  assert.deepEqual([...new Set(f.calls.map(([name]) => name))], ['RecipeItem', 'Recipe', 'ProductStock', 'Product']);
  const again = await deleteTestCatalog(f.client);
  assert.equal(Object.values(again).reduce((a,b) => a+b,0), 0);
});

for (const role of ['cashier', 'manager']) test(role + ' cannot delete', async () => {
  const f = fixture(role);
  await assert.rejects(deleteTestCatalog(f.client), /Faqat faol admin/);
  assert.equal(f.calls.length, 0);
});

test('reactivated product blocks all writes during preflight', async () => {
  const f = fixture();
  f.data.Product[0].active = true;
  await assert.rejects(deleteTestCatalog(f.client), /qayta faollashtirilgan/);
  assert.equal(f.calls.length, 0);
});

test('changed relationship blocks all writes', async () => {
  const f = fixture();
  f.data.RecipeItem[0].product_id = 'new-Product';
  await assert.rejects(deleteTestCatalog(f.client), /o‘zgargan/);
  assert.equal(f.calls.length, 0);
});

test('partial deletion retries only remaining records', async () => {
  const f = fixture();
  f.fail(MANIFEST.RecipeItem[2].id);
  await assert.rejects(deleteTestCatalog(f.client), /Jarayon to‘xtadi/);
  assert.equal(f.data.Product.length, 28);
  const deleted = f.calls.filter(([, id]) => id !== MANIFEST.RecipeItem[2].id).map(([, id]) => id);
  f.fail(undefined);
  await deleteTestCatalog(f.client);
  for (const id of deleted) assert.equal(f.calls.filter(([, called]) => called === id).length, 1);
  assert.deepEqual(f.data.Product.map(row => row.id), ['new-Product']);
});
