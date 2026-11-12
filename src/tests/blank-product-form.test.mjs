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

import { rowCountKey } from '../lib/blank-product-form.js';
test('keypad replaces on first digit and appends, deletes and clears', () => {
  assert.equal(rowCountKey('10', '2', true), '2');
  assert.equal(rowCountKey('2', '5'), '25');
  assert.equal(rowCountKey('25', '7'), '25');
  assert.equal(rowCountKey('25', 'backspace'), '2');
  assert.equal(rowCountKey('2', 'clear'), '');
  assert.equal(rowCountKey('', 'backspace'), '');
  assert.equal(rowCountKey('2', '.'), '2');
  assert.equal(validRowCount(rowCountKey('3', '1')), false);
});
