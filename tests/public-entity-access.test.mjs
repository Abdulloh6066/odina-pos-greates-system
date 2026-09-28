// Offline permission regression matrix; never writes live business records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const baseline = JSON.parse(readFileSync('checkpoints/public-entity-rls-before-2026-09-28.json', 'utf8'));
const roles = baseline.roles;
const explicitRole = rule => rule && typeof rule === 'object' && (
  Boolean(rule.user_condition?.role) ||
  Boolean(rule.$and?.some(explicitRole)) ||
  Boolean(rule.$or?.length && rule.$or.every(explicitRole))
);
const strengthen = rule => rule === false || explicitRole(rule) ? rule : {
  $and: [{ $or: roles.map(role => ({ user_condition: { role } })) }, rule],
};
function permits(rule, user = {}, row = {}) {
  if (typeof rule === 'boolean') return rule;
  if (!rule || typeof rule !== 'object') throw Error('Missing or invalid RLS rule');
  return Object.entries(rule).every(([key, value]) => {
    if (key === '$or') return value.some(r => permits(r, user, row));
    if (key === '$and') return value.every(r => permits(r, user, row));
    if (key === '$nor') return !value.some(r => permits(r, user, row));
    if (key === 'user_condition') return Object.entries(value).every(([k, v]) => user[k] === v);
    const actual = row[key.startsWith('data.') ? key.slice(5) : key];
    if (value && typeof value === 'object') return Object.entries(value).every(([op, values]) => {
      if (op === '$nin') return !values.includes(actual ?? null);
      if (op === '$in') return values.includes(actual ?? null);
      if (op === '$ne') return actual !== values;
      throw Error('Unhandled RLS operator: ' + op);
    });
    const expected = value === '{{user.data.shop_id}}' ? user.shop_id : value === '{{user.id}}' ? user.id : value;
    return actual === expected;
  });
}
const schemas = Object.entries(baseline.entities).map(([name, original]) => {
  const schema = JSON.parse(readFileSync(original.path, 'utf8'));
  const rules = process.env.SECURITY_RULE_CANDIDATE === '1'
    ? Object.fromEntries(Object.entries(schema.rls).map(([op, rule]) => [op, strengthen(rule)]))
    : schema.rls;
  return { name, original, schema, rules };
});
const rowFixtures = [];
for (const shop of ['shop-a', 'shop-b', '', null, undefined]) {
  for (const owner of ['person-a', 'person-b', '', null, undefined]) {
    for (const source of ['shop', 'budget', undefined]) {
      rowFixtures.push({ id: shop, shop_id: shop, location_id: shop,
        source_location_id: shop, destination_location_id: shop === 'shop-a' ? 'shop-b' : shop,
        user_id: owner, cashier_id: owner, payment_source: source });
    }
  }
}
test('all 25 reported schemas are covered and all operations have an explicit role requirement or denial', () => {
  assert.equal(schemas.length, 25);
  for (const { name, rules } of schemas) {
    for (const op of ['create', 'read', 'update', 'delete']) {
      assert.ok(rules[op] === false || explicitRole(rules[op]), name + '.' + op);
    }
  }
});
test('anonymous and non-staff accounts cannot access any reported entity even with matching/empty IDs', () => {
  for (const { name, rules } of schemas) {
    for (const user of [{}, { id: null, shop_id: null }, { id: '', shop_id: '' },
      { id: 'person-a', shop_id: 'shop-a', role: 'user' },
      { id: 'person-a', shop_id: 'shop-a', role: 'visitor', active: true }]) {
      for (const row of rowFixtures) for (const [op, rule] of Object.entries(rules)) {
        assert.equal(permits(rule, user, row), false, name + '.' + op + ': ' + JSON.stringify(user));
      }
    }
  }
});
test('every existing staff-role decision is preserved for own/foreign/missing shops, IDs and budget payments', () => {
  for (const { name, original, rules } of schemas) {
    for (const role of roles) for (const active of [true, false, undefined]) {
      for (const shop_id of ['shop-a', 'shop-b', '', null, undefined]) {
        for (const id of ['person-a', 'person-b']) {
          const user = { id, role, shop_id, active };
          for (const row of rowFixtures) for (const [op, rule] of Object.entries(rules)) {
            assert.equal(permits(rule, user, row), permits(original.rls[op], user, row),
              name + '.' + op + ': staff access changed ' + JSON.stringify({ user, row }));
          }
        }
      }
    }
  }
});
test('schema fields, historical snapshot definitions and update/delete permissions are untouched', () => {
  for (const { name, original, schema, rules } of schemas) {
    const { rls, ...rest } = schema;
    assert.equal(createHash('sha256').update(JSON.stringify(rest)).digest('hex'), original.non_rls_sha256, name);
    assert.deepEqual(rules.update, original.rls.update, name);
    assert.deepEqual(rules.delete, original.rls.delete, name);
  }
});
test('manager foreign-shop reads stay blocked, and budget remains admin-only', () => {
  const user = { id: 'person-a', role: 'manager', active: true, shop_id: 'shop-a' };
  for (const { name, rules } of schemas) {
    const foreign = { id: 'shop-b', shop_id: 'shop-b', location_id: 'shop-b',
      source_location_id: 'shop-b', destination_location_id: 'shop-b',
      user_id: user.id, cashier_id: user.id, payment_source: 'shop' };
    assert.equal(permits(rules.read, user, foreign), false, name);
  }
  for (const name of ['BudgetBalance', 'BudgetTransaction']) {
    const rls = JSON.parse(readFileSync('base44/entities/' + name + '.jsonc', 'utf8')).rls;
    for (const rule of Object.values(rls)) {
      assert.equal(permits(rule, user, {}), false, name);
      assert.equal(permits(rule, { role: 'admin' }, {}), true, name);
    }
  }
});
