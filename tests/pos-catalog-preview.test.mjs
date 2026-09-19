import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { draftPreviewProducts, PREVIEW_PRICE_UZS } from '../src/lib/pos-catalog-preview.js';

test('preview offers only inactive unpriced products, without changing live prices', () => {
  const live = [
    { id: 'existing', active: true, price: 24000 },
    { id: 'draft', active: false, price: 0, archived: false },
    { id: 'priced', active: false, price: 15000 },
    { id: 'archived', active: false, price: 0, archived: true },
  ];
  const preview = draftPreviewProducts(live);
  assert.deepEqual(preview.map(({ id, price }) => ({ id, price })), [
    { id: 'draft', price: PREVIEW_PRICE_UZS },
  ]);
  assert.equal(live[1].price, 0);
  assert.notEqual(preview[0], live[1]);
});

test('preview has no access to normal checkout or mutation handlers', () => {
  const preview = fs.readFileSync(new URL('../src/components/pos/POSCatalogPreview.jsx', import.meta.url), 'utf8');
  const pos = fs.readFileSync(new URL('../src/pages/POS.jsx', import.meta.url), 'utf8');
  assert.match(pos, /user\?\.role !== 'admin'/);
  assert.match(pos, /return <POSCatalogPreview/);
  assert.match(preview, /base44\.entities\.Product\.list/);
  assert.doesNotMatch(preview, /base44\.(?:functions\.invoke|entities\.\w+\.(?:create|update|delete))/);
  assert.doesNotMatch(preview, /PaymentModal|completeSale|enqueueOfflineSale|onCheckout/);
});
