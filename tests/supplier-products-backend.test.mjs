// Memory-only supplier assignment checks. No network or live entity operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';

const ledger = 'base44/functions/supplier-ledger/entry.ts';
const requests = 'base44/shared/ingredient-requests.ts';
const plain = value => JSON.parse(JSON.stringify(value));
const supplier = (id, assignment) => ({ id, name: id, active: true, recipient_type: 'supplier',
  ...(assignment === undefined ? {} : { supplied_ingredient_ids: assignment }) });
const ingredients = ['flour', 'sugar'].map(id => ({ id, name: id, category: 'food', active: true,
  base_unit: 'g', purchase_unit: 'kg', conversion_to_base: 1000 }));
const requisition = (id = 'request', sourceKind = 'purchase') => ({
  id, request_number: 'EK-' + id, location_id: 'shop', location_name: 'Shop', source_kind: sourceKind,
  source_location_id: sourceKind === 'warehouse' ? 'warehouse' : '', source_location_name: 'Warehouse',
  required_date: '2026-10-23', notes: '', status: 'waiting', version: 0, history_json: '[]',
  pending_json: '', lease_token: '', lease_until: '', approved_by: sourceKind === 'warehouse' ? 'owner' : '',
  items: ingredients.map(i => ({ ingredient_id: i.id, ingredient_name: i.name, category: i.category,
    base_unit: i.base_unit, purchase_unit: i.purchase_unit, conversion_to_base: i.conversion_to_base,
    requested_quantity: 10 })),
});
function fixture() {
  const f = memoryBackend({
    User: [{ id: 'owner', role: 'admin', active: true, shop_id: 'shop', full_name: 'Owner' }],
    Shop: [{ id: 'shop', name: 'Shop', active: true, location_type: 'shop' },
      { id: 'warehouse', name: 'Warehouse', active: true, location_type: 'production' }],
    CashRecipient: [supplier('flour-supplier', ['flour']), supplier('sugar-supplier', ['sugar']),
      supplier('empty-supplier', []), supplier('legacy-supplier')],
    Ingredient: ingredients,
    IngredientStock: ['shop', 'warehouse'].flatMap(location_id => ingredients.map(i => ({
      id: location_id + '-' + i.id, location_id, ingredient_id: i.id, ingredient_name: i.name,
      unit: 'g', quantity: location_id === 'warehouse' ? 10000 : 0,
    }))),
    IngredientRequisition: [requisition()], SupplierReceipt: [], SupplierReceiptItem: [], StockMovement: [],
    ActionHistory: [], SupplierPayment: [], CashMovement: [], BudgetTransaction: [],
  }, { now: '2026-10-22T10:00:00Z' });
  const handle = body => f.load(requests).handleIngredientRequest(f.service, f.db.User[0], body);
  return { ...f, handle };
}
const receipt = (extra = {}) => ({ action: 'create_receipt', supplier_id: 'flour-supplier', location_id: 'shop',
  items: [{ ingredient_id: 'flour', purchase_quantity: 2, unit_price: 1000 }], ...extra });
const receive = (extra = {}) => ({ action: 'receive', request_id: 'request', expected_version: 0,
  verified: true, idempotency_key: 'receipt-request-first', supplier_id: 'flour-supplier', payment_state: 'unpaid',
  items: [{ ingredient_id: 'flour', quantity: 2, unit_price: 1000 }], ...extra });
const assertNoDeletes = f => assert.equal(f.calls.some(([, action]) => action === 'delete'), false);
const snapshot = f => JSON.stringify(f.db);

test('assignment schema is optional, has no default and retains the existing role permissions', () => {
  const schema = JSON.parse(readFileSync('base44/entities/CashRecipient.jsonc', 'utf8'));
  assert.equal(schema.properties.supplied_ingredient_ids.type, 'array');
  assert.equal(schema.properties.supplied_ingredient_ids.items.type, 'string');
  assert.equal('default' in schema.properties.supplied_ingredient_ids, false);
  assert.equal(schema.required.includes('supplied_ingredient_ids'), false);
  const admin = { user_condition: { role: 'admin' } };
  assert.deepEqual(schema.rls, { create: admin, read: { $or: ['admin', 'manager', 'cashier', 'accountant', 'warehouse']
    .map(role => ({ user_condition: { role } })) }, update: admin, delete: admin });
});

test('catalog retains the difference between assigned, explicitly empty and legacy suppliers', async () => {
  const f = fixture(), before = snapshot(f);
  const result = await f.handle({ action: 'catalog', location_id: 'shop' });
  const rows = Object.fromEntries(plain(result.suppliers).map(row => [row.id, row]));
  assert.deepEqual(rows['flour-supplier'].supplied_ingredient_ids, ['flour']);
  assert.deepEqual(rows['empty-supplier'].supplied_ingredient_ids, []);
  assert.equal('supplied_ingredient_ids' in rows['legacy-supplier'], false);
  assert.equal(snapshot(f), before);
  assert.equal(f.calls.length, 0);
});

for (const [name, supplierId, ids] of [
  ['ingredient assigned only to another supplier', 'flour-supplier', ['sugar']],
  ['mixed allowed and nonassigned ingredients', 'flour-supplier', ['flour', 'sugar']],
  ['explicit empty assignment', 'empty-supplier', ['flour']],
]) {
  test(`both purchase paths reject ${name} before any write`, async () => {
    for (const path of ['ledger', 'requisition']) {
      const f = fixture(), before = snapshot(f);
      if (path === 'ledger') {
        const r = await f.invoke(ledger, receipt({ supplier_id: supplierId,
          supplied_ingredient_ids: ids, items: ids.map(ingredient_id => ({ ingredient_id, purchase_quantity: 1, unit_price: 1000 })) }));
        assert.equal(r.status, 400, JSON.stringify(r.data));
      } else {
        await assert.rejects(f.handle(receive({ supplier_id: supplierId, supplied_ingredient_ids: ids,
          items: ids.map(ingredient_id => ({ ingredient_id, quantity: 1, unit_price: 1000 })) })),
        e => e.status === 400 && e.request_not_started === true);
      }
      assert.equal(snapshot(f), before);
      assert.equal(f.calls.length, 0);
    }
  });
}

test('malformed configured assignments fail closed rather than enabling legacy fallback', async () => {
  for (const assignment of [null, 'flour', [null], [' flour']]) {
    for (const path of ['ledger', 'requisition']) {
      const f = fixture(); f.db.CashRecipient[0].supplied_ingredient_ids = assignment;
      if (path === 'ledger') assert.equal((await f.invoke(ledger, receipt())).status, 409);
      else await assert.rejects(f.handle(receive()), e => e.status === 409 && e.request_not_started === true);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('each supplier may provide its assigned ingredient, including a shared ingredient', async () => {
  for (const path of ['ledger', 'requisition']) {
    const f = fixture();
    f.db.CashRecipient[1].supplied_ingredient_ids.push('flour');
    f.db.IngredientRequisition.push(requisition('second-request'));
    for (const [index, supplier_id] of ['flour-supplier', 'sugar-supplier'].entries()) {
      if (path === 'ledger') assert.equal((await f.invoke(ledger, receipt({ supplier_id }))).status, 200);
      else await f.handle(receive({ supplier_id, request_id: index ? 'second-request' : 'request' }));
    }
    assert.equal(f.db.SupplierReceipt.length, 2);
    assert.deepEqual(f.db.SupplierReceipt.map(r => r.supplier_id), ['flour-supplier', 'sugar-supplier']);
    assert.equal(f.db.IngredientStock.find(s => s.id === 'shop-flour').quantity, 4000);
    assert.equal(f.db.SupplierReceiptItem.length, 2);
    assertNoDeletes(f);
  }
});

test('absent legacy assignment preserves both existing purchase paths without backfilling the master', async () => {
  for (const path of ['ledger', 'requisition']) {
    const f = fixture(), masters = JSON.stringify(f.db.CashRecipient);
    if (path === 'ledger') assert.equal((await f.invoke(ledger, receipt({ supplier_id: 'legacy-supplier' }))).status, 200);
    else await f.handle(receive({ supplier_id: 'legacy-supplier' }));
    assert.equal(f.db.SupplierReceipt.length, 1);
    assert.equal(f.db.SupplierReceipt[0].total_amount, 2000);
    assert.equal(f.db.IngredientStock.find(s => s.id === 'shop-flour').quantity, 2000);
    assert.equal(JSON.stringify(f.db.CashRecipient), masters);
    assertNoDeletes(f);
  }
});

test('assignments cannot make an inactive supplier or ingredient authoritative', async () => {
  for (const change of ['supplier', 'ingredient', 'supplier-type', 'missing-ingredient']) {
    for (const path of ['ledger', 'requisition']) {
      const f = fixture();
      if (change === 'supplier') f.db.CashRecipient[0].active = false;
      if (change === 'ingredient') f.db.Ingredient[0].active = false;
      if (change === 'supplier-type') f.db.CashRecipient[0].recipient_type = 'employee';
      if (change === 'missing-ingredient') f.db.Ingredient = f.db.Ingredient.filter(i => i.id !== 'flour');
      if (path === 'ledger') assert.notEqual((await f.invoke(ledger, receipt())).status, 200);
      else await assert.rejects(f.handle(receive()));
      assert.equal(f.calls.length, 0, change + '/' + path);
    }
  }
});

for (const resumeAction of ['receive', 'resume']) {
  test(`a durable partial purchase can ${resumeAction} after assignment and master changes`, async () => {
    const f = fixture(), create = f.entities.SupplierReceiptItem.create;
    f.entities.SupplierReceiptItem.create = async () => { throw new Error('Mock temporary write outage'); };
    await assert.rejects(f.handle(receive()), e => e.operation_pending === true);
    assert.ok(f.db.IngredientRequisition[0].pending_json);
    assert.equal(f.db.IngredientStock.find(s => s.id === 'shop-flour').quantity, 2000);
    f.db.CashRecipient[0].supplied_ingredient_ids = [];
    f.db.CashRecipient[0].active = false;
    f.db.Ingredient[0].active = false;
    f.entities.SupplierReceiptItem.create = create;
    const result = await f.handle(resumeAction === 'receive' ? receive() : { action: 'resume', request_id: 'request' });
    assert.equal(result.request.status, 'partial');
    assert.equal(f.db.IngredientRequisition[0].pending_json, '');
    assert.equal(f.db.IngredientStock.find(s => s.id === 'shop-flour').quantity, 2000);
    assert.equal(f.db.StockMovement.length, 1);
    assert.equal(f.db.SupplierReceipt.length, 1);
    assert.equal(f.db.SupplierReceiptItem.length, 1);
    assert.equal(f.db.SupplierReceipt[0].remaining_debt, 2000);
    const saved = snapshot(f), calls = f.calls.length;
    assert.equal((await f.handle(receive())).already_processed, true);
    assert.equal(snapshot(f), saved);
    assert.equal(f.calls.length, calls);
    assertNoDeletes(f);
  });
}

test('new receives after partial completion use the current assignment without rewriting prior receipts', async () => {
  const f = fixture(); await f.handle(receive());
  const priorReceipt = JSON.stringify(f.db.SupplierReceipt), priorItems = JSON.stringify(f.db.SupplierReceiptItem);
  f.db.CashRecipient[0].supplied_ingredient_ids = [];
  const before = snapshot(f), calls = f.calls.length;
  await assert.rejects(f.handle(receive({ expected_version: f.db.IngredientRequisition[0].version,
    idempotency_key: 'receipt-request-second' })), e => e.status === 400 && e.request_not_started === true);
  assert.equal(snapshot(f), before);
  assert.equal(f.calls.length, calls);
  assert.equal(JSON.stringify(f.db.SupplierReceipt), priorReceipt);
  assert.equal(JSON.stringify(f.db.SupplierReceiptItem), priorItems);
});

test('lost receipt-item reply reconciles once; a completed replay ignores later assignment edits', async () => {
  const f = fixture(), create = f.entities.SupplierReceiptItem.create;
  f.entities.SupplierReceiptItem.create = async data => { await create(data); throw new Error('Mock lost reply after save'); };
  await f.handle(receive());
  f.db.CashRecipient[0].supplied_ingredient_ids = [];
  const before = snapshot(f), calls = f.calls.length;
  assert.equal((await f.handle(receive())).already_processed, true);
  await assert.rejects(f.handle(receive({ items: [{ ingredient_id: 'flour', quantity: 3, unit_price: 1000 }] })), e => e.status === 409);
  assert.equal(snapshot(f), before);
  assert.equal(f.calls.length, calls);
  assert.equal(f.db.SupplierReceiptItem.length, 1);
  assertNoDeletes(f);
});

test('warehouse transfer receipt does not query or apply purchase-supplier assignments', async () => {
  const f = fixture(); f.db.IngredientRequisition[0] = requisition('request', 'warehouse');
  f.entities.CashRecipient.get = async () => { throw new Error('A transfer must not read supplier configuration'); };
  await f.handle(receive({ supplier_id: 'empty-supplier', payment_state: undefined }));
  assert.equal(f.db.IngredientStock.find(s => s.id === 'warehouse-flour').quantity, 8000);
  assert.equal(f.db.IngredientStock.find(s => s.id === 'shop-flour').quantity, 2000);
  assert.equal(f.db.StockMovement.length, 2);
  assert.equal(f.db.SupplierReceipt.length, 0);
  assert.equal(f.db.SupplierReceiptItem.length, 0);
  assertNoDeletes(f);
});
