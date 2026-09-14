// Offline guardrails for the temporary test-business-data cleanup tool.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const backend = readFileSync('base44/functions/cleanup-test-business-data/entry.ts', 'utf8');
const config = JSON.parse(readFileSync('base44/functions/cleanup-test-business-data/function.jsonc', 'utf8'));
const listStart = backend.indexOf('const CLEANUP_ENTITIES = [');
const listEnd = backend.indexOf('] as const;', listStart);
const cleanupList = backend.slice(listStart, listEnd);

test('cleanup function is private and requires active stored admin plus exact confirmation', () => {
  assert.equal(config.is_public, false);
  assert.match(backend, /resolveStoredAppUser/);
  assert.match(backend, /userRole\(admin\) !== "admin"/);
  assert.match(backend, /admin\.active === false/);
  assert.match(backend, /body\?\.scope !== "test_business_data"/);
  assert.match(backend, /body\?\.confirm !== "TOZALASH"/);
});

test('cleanup includes business data in child-first order', () => {
  for (const name of [
    'SaleItem', 'Payment', 'Sale', 'CustomerOrderItem', 'CustomerOrder',
    'RecipeItem', 'Recipe', 'ProductStock', 'Product', 'IngredientStock',
    'Ingredient', 'Category', 'Shift', 'StockTransfer', 'SupplierReceipt',
    'BirthdayFollowup', 'TelegramDelivery',
  ]) {
    assert.match(cleanupList, new RegExp('"' + name + '"'));
  }
  assert.ok(cleanupList.indexOf('"SaleItem"') < cleanupList.indexOf('"Sale"'));
  assert.ok(cleanupList.indexOf('"RecipeItem"') < cleanupList.indexOf('"Recipe"'));
  assert.ok(cleanupList.indexOf('"CustomerOrderItem"') < cleanupList.indexOf('"CustomerOrder"'));
});

test('cleanup cannot delete identity, shops, settings or security configuration', () => {
  for (const name of [
    'User', 'Shop', 'Settings', 'SecuritySettings', 'TelegramControl',
    'DailyExportConfig', 'PendingStaffInvite', 'CashRecipient', 'ActionHistory',
  ]) {
    assert.doesNotMatch(cleanupList, new RegExp('"' + name + '"'));
  }
  assert.match(backend, /action: "test_business_data_cleared"/);
});
