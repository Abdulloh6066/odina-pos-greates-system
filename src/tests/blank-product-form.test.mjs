import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validRowCount, formWriter } from '../lib/blank-product-form.js';
test('only bounded whole row counts can print', () => {
  for (const value of ['', ' ', 'abc', 0, -1, 31, 1.5, Infinity]) assert.equal(validRowCount(value), false);
  for (const value of [1, '10', 30]) assert.equal(validRowCount(value), true);
});
test('writer comes from current staff profile, never invented', () => {
  assert.equal(formWriter({ name: 'Abdulloh', full_name: 'Other' }), 'Abdulloh');
  assert.equal(formWriter({ full_name: 'Malika' }), 'Malika');
  assert.equal(formWriter(null), '');
});
