// Offline-only contract tests. Never access or modify live Base44 records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(name, 'utf8');

test('shop contact fields are optional and only the owner can edit shops', () => {
  const shop = JSON.parse(read('base44/entities/Shop.jsonc'));
  assert.equal(shop.properties.instagram.type, 'string');
  assert.equal(shop.properties.phone.type, 'string');
  assert.equal(shop.properties.address.type, 'string');
  assert.ok(!shop.required.includes('instagram'));
  assert.equal(shop.rls.update.user_condition.role, 'admin');
});

test('completed sale snapshots receipt contacts without replacing old financial fields', () => {
  const sale = JSON.parse(read('base44/entities/Sale.jsonc'));
  for (const field of ['receipt_instagram_snapshot', 'receipt_phone_snapshot', 'receipt_address_snapshot']) {
    assert.equal(sale.properties[field].type, 'string');
    assert.ok(!sale.required.includes(field));
  }
  for (const field of ['total', 'subtotal', 'items', 'shop_id', 'shop_name', 'payments']) {
    assert.ok(sale.properties[field]);
  }
  const backend = read('base44/functions/complete-sale/entry.ts');
  assert.match(backend, /service\.entities\.Shop\.get\(shift\.shop_id\)/);
  assert.match(backend, /receipt_instagram_snapshot: String\(receiptShop\?\.instagram/);
  assert.match(backend, /receipt_phone_snapshot: String\(receiptShop\?\.phone/);
  assert.match(backend, /receipt_address_snapshot: String\(receiptShop\?\.address/);
  assert.doesNotMatch(backend, /receipt_instagram_snapshot:.*body\./);
});

test('admin edits only the selected shop; receipts print stored details and preserve seven wishes', () => {
  const settings = read('src/pages/Settings.jsx');
  assert.match(settings, /user\?\.role !== 'admin'/);
  assert.match(settings, /base44\.entities\.Shop\.update\(shop\.id, contact\)/);
  assert.match(settings, /Instagram, telefon va manzilni pastdagi har bir do‘kon/);
  const receipt = read('src/components/pos/Receipt.jsx');
  assert.match(receipt, /sale\.receipt_instagram_snapshot/);
  assert.match(receipt, /sale\.receipt_phone_snapshot/);
  assert.match(receipt, /sale\.receipt_address_snapshot/);
  assert.match(receipt, /receiptWishForSale\(sale\)/);
  assert.match(receipt, /settings\?\.receipt_footer/);
  assert.doesNotMatch(receipt, /settings\?\.instagram/);
});
