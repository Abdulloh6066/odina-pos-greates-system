// Offline only: real handler and recovery engine, in-memory data, no payments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { memoryBackend } from './helpers/memory-backend.mjs';
const file = 'base44/functions/budget-ledger/entry.ts';
async function fixture() {
  const salt = 'mock-only';
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('2468'), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return memoryBackend({
    User: [{ id: 'owner', role: 'admin', active: true }], Settings: [{ id: 'settings' }],
    BudgetBalance: [{ id: 'cash', account: 'cash', balance: 10000 }, { id: 'uzcard', account: 'uzcard', balance: 600 }, { id: 'humo', account: 'humo', balance: 1000 }],
    BudgetTransaction: [],
    BudgetExpenseCategory: [{ id: 'workers', name: 'Ishchilar uchun xarid' }, { id: 'repairs', name: 'Ta’mirlash' }],
    SecuritySettings: [{ id: 'pin', key: 'owner_approval_pin', pin_hash: Buffer.from(bits).toString('hex'), pin_salt: salt, pin_algorithm: 'PBKDF2-SHA256', pin_iterations: 100000 }],
  });
}
const body = changes => ({ action: 'manual_adjustment', owner_pin: '2468', account: 'cash', direction: 'out', amount: 1000, description: 'Asbob sotib olish', expense_category_id: 'workers', idempotency_key: 'category-test', ...changes });

test('owner creates normalized category, repeats reuse it, and blank/oversized names fail', async () => {
  const f = await fixture();
  const first = await f.invoke(file, { action: 'create_expense_category', name: '  Transport   xarajati ' });
  assert.equal(first.status, 200); assert.equal(first.data.category.name, 'Transport xarajati');
  const again = await f.invoke(file, { action: 'create_expense_category', name: 'transport xarajati' });
  assert.equal(again.data.category.id, first.data.category.id);
  for (const name of ['', '   ', 'x'.repeat(81)]) assert.equal((await f.invoke(file, { action: 'create_expense_category', name })).status, 400);
  assert.equal(f.db.BudgetExpenseCategory.length, 3);
  assert.equal(f.db.BudgetTransaction.length, 0);
});

test('non-owner cannot create/read categories or debit Budget; wrong PIN cannot debit', async () => {
  const f = await fixture(); f.db.User[0].role = 'cashier';
  for (const request of [{ action: 'summary' }, { action: 'create_expense_category', name: 'Secret' }, body()]) assert.equal((await f.invoke(file, request)).status, 403);
  f.db.User[0].role = 'admin';
  assert.equal((await f.invoke(file, body({ owner_pin: '0000' }))).status, 403);
  assert.equal(f.db.BudgetBalance[0].balance, 10000);
});

test('category persisted server-side; retries debit once; changed category is rejected', async () => {
  const f = await fixture();
  const first = await f.invoke(file, body({ expense_category_name: 'FORGED' }));
  assert.equal(first.status, 200); assert.equal(first.data.transaction.expense_category_name, 'Ishchilar uchun xarid');
  f.db.BudgetExpenseCategory[0].name = 'New name';
  const again = await f.invoke(file, body());
  assert.equal(again.status, 200); assert.equal(again.data.transaction.expense_category_name, 'Ishchilar uchun xarid');
  assert.equal((await f.invoke(file, body({ expense_category_id: 'repairs' }))).status, 409);
  assert.equal(f.db.BudgetBalance[0].balance, 9000); assert.equal(f.db.BudgetTransaction.length, 1);
});

test('unknown category and category on deposit are rejected before balance changes', async () => {
  const f = await fixture();
  for (const changes of [{ expense_category_id: 'missing' }, { direction: 'in' }]) assert.equal((await f.invoke(file, body(changes))).status, 400);
  assert.equal(f.db.BudgetBalance[0].balance, 10000);
});

test('legacy uncategorized fingerprint remains byte-for-byte compatible', async () => {
  const f = await fixture();
  const result = await f.invoke(file, body({ expense_category_id: '' }));
  assert.equal(result.status, 200);
  assert.equal(result.data.transaction.request_fingerprint, JSON.stringify(['manual_adjustment', 'owner', 'cash', 'out', 1000, 'Asbob sotib olish']));
  assert.equal((await f.invoke(file, body({ expense_category_id: '' }))).data.already_processed, true);
});

test('combined bank card allocates category to both legs and retries do not duplicate', async () => {
  const f = await fixture();
  const result = await f.invoke(file, body({ account: 'bank_card' }));
  assert.equal(result.status, 200);
  assert.equal(result.data.transactions.length, 2);
  assert.ok(result.data.transactions.every(row => row.expense_category_id === 'workers'));
  assert.equal(result.data.transactions.reduce((sum, row) => sum + row.amount, 0), 1000);
  assert.equal((await f.invoke(file, body({ account: 'bank_card' }))).data.already_processed, true);
  assert.equal((await f.invoke(file, body({ account: 'bank_card', expense_category_id: 'repairs' }))).status, 409);
  assert.equal(f.db.BudgetTransaction.length, 2);
});

test('summary paginates beyond 500 records and includes categories', async () => {
  const f = await fixture();
  f.db.BudgetTransaction = Array.from({ length: 1001 }, (_, id) => ({ id: String(id), amount: 1, created_at: String(id).padStart(5, '0') }));
  const result = await f.invoke(file, { action: 'summary' });
  assert.equal(result.status, 200); assert.equal(result.data.transactions.length, 1001);
  assert.equal(result.data.categories.length, 2);
});


test('a deleted category cannot strand a saved adjustment or bank-card retry', async () => {
  for (const account of ['cash', 'bank_card']) {
    const f = await fixture();
    assert.equal((await f.invoke(file, body({ account }))).status, 200);
    f.db.BudgetExpenseCategory = [];
    const retry = await f.invoke(file, body({ account }));
    assert.equal(retry.status, 200); assert.equal(retry.data.already_processed, true);
    assert.equal(retry.data.transaction.expense_category_name, 'Ishchilar uchun xarid');
  }
});
