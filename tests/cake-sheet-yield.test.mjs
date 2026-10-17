import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isCakeSheetYieldProduct, savedCakeSheetYield, parseCakeSheetYield, saveCakeSheetYield } from '../src/lib/cake-sheet-yield.js';

const clone = value => structuredClone(value);
const baseProduct = () => ({ id: 'cake-a', name: 'Cake A', category_name: '15 somlik', production_unit: 'piece',
  pieces_per_sheet: 1, source_type: 'central_produced', active: true, archived: false, track_stock: true,
  sale_unit: 'piece', price: 20000, sheet_price: 0, shop_prices: { branch: 22000 }, metadata: { keep: 'unchanged' } });
const owner = { id: 'owner', role: 'admin' };

function matches(row, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    const exists = Object.prototype.hasOwnProperty.call(row, field);
    if (expected && typeof expected === 'object') return Object.entries(expected).every(([operator, value]) => {
      if (operator === '$exists') return exists === value;
      if (operator === '$ne') return row[field] !== value;
      if (operator === '$eq') return row[field] === value;
      throw Error('Unexpected query operator ' + operator);
    });
    return row[field] === expected;
  });
}

function fixture(initial = baseProduct(), options = {}) {
  let row = clone(initial); let reads = 0;
  const writes = [];
  const entity = {
    async updateMany(filter, update) {
      writes.push(clone({ filter, update }));
      if (options.rejectBefore) throw options.rejectBefore;
      options.beforeUpdate?.(row);
      if (!matches(row, filter)) return { success: true, updated: 0 };
      Object.assign(row, clone(update.$set));
      if (options.loseResponse) throw new Error('Response lost');
      return options.response || { success: true, updated: 1 };
    },
    async get(id) {
      reads++;
      assert.equal(id, initial.id);
      if (options.readError) throw new Error('Read unavailable');
      options.beforeRead?.(row);
      return clone(row);
    },
  };
  return { entity, writes, row: () => clone(row), reads: () => reads };
}

test('cake category eligibility handles established Uzbek spelling and excludes unrelated inventory', () => {
  for (const category_name of ['15 somlik', '15 so‘mlik', '18 soʻmlik', 'Aralash', 'mini:tart', 'Mini / Tart', 'Tortlar', 'Cakes']) {
    assert.equal(isCakeSheetYieldProduct({ ...baseProduct(), category_name }), true, category_name);
  }
  for (const change of [{ category_name: 'FOOD' }, { category_name: 'Kofe' }, { category_name: 'Pishiriqlar' },
    { active: false }, { archived: true }, { track_stock: false }, { sale_unit: 'gram' }, { source_type: 'shop_prepared' }, { source_type: 'resale' }]) {
    assert.equal(isCakeSheetYieldProduct({ ...baseProduct(), ...change }), false, JSON.stringify(change));
  }
  assert.equal(isCakeSheetYieldProduct({ ...baseProduct(), production_unit: 'sheet', category_name: 'Custom cake' }), true);
  assert.equal(isCakeSheetYieldProduct(null), false);
  const legacy = { ...baseProduct() }; delete legacy.source_type;
  assert.equal(isCakeSheetYieldProduct(legacy), true);
});

test('saved value never invents a default; parser accepts only positive safe whole numbers', () => {
  assert.equal(savedCakeSheetYield({}), '');
  for (const value of [null, undefined, 0, -1, 1.5, '20', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(savedCakeSheetYield({ pieces_per_sheet: value }), '');
  }
  assert.equal(savedCakeSheetYield({ pieces_per_sheet: 24 }), '24');
  for (const value of ['24', ' 24 ', 24, String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(parseCakeSheetYield(value), Number(String(value).trim()));
  }
  for (const value of ['', ' ', '0', '-1', '1.5', '1.0', '1e2', '+2', '02', '9007199254740992', 'NaN', NaN, Infinity, true, null, {}, []]) {
    assert.equal(parseCakeSheetYield(value), null, String(value));
  }
});

test('owner save updates only the cutting metadata and verifies persistent readback', async () => {
  const original = baseProduct(); const f = fixture(original);
  const saved = await saveCakeSheetYield({ entity: f.entity, user: owner, product: clone(original), value: '24' });
  assert.equal(saved.pieces_per_sheet, 24); assert.equal(f.reads(), 1); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].update, { $set: { pieces_per_sheet: 24 } });
  assert.deepEqual(f.row(), { ...original, pieces_per_sheet: 24 });
  assert.equal(saved.production_unit, 'piece'); assert.equal(saved.price, original.price);
  assert.deepEqual(saved.shop_prices, original.shop_prices);
  assert.deepEqual(f.writes[0].filter.production_unit, 'piece'); assert.equal(f.writes[0].filter.pieces_per_sheet, 1);
});

test('accountant can save while workers, inactive admins and sheet products cannot write', async () => {
  const original = baseProduct(); const f = fixture(original);
  await saveCakeSheetYield({ entity: f.entity, user: { role: 'accountant' }, product: original, value: 12 });
  assert.equal(f.row().pieces_per_sheet, 12);
  for (const user of [{ role: 'cashier' }, { role: 'manager' }, { role: 'production' }, { role: 'warehouse' }, { role: 'admin', active: false }, null]) {
    const blocked = fixture();
    await assert.rejects(saveCakeSheetYield({ entity: blocked.entity, user, product: baseProduct(), value: 12 }), { code: 'FORBIDDEN' });
    assert.equal(blocked.writes.length, 0); assert.equal(blocked.reads(), 0);
  }
  const sheet = { ...baseProduct(), production_unit: 'sheet', pieces_per_sheet: 20 };
  const blocked = fixture(sheet);
  await assert.rejects(saveCakeSheetYield({ entity: blocked.entity, user: owner, product: sheet, value: 24 }), { code: 'FORBIDDEN' });
  assert.equal(blocked.writes.length, 0);
});

test('invalid values, unrelated and inactive products are rejected before any SDK call', async () => {
  for (const value of ['', '0', '1.5', '1e2', Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    await assert.rejects(saveCakeSheetYield({ entity: f.entity, user: owner, product: baseProduct(), value }), { code: 'VALIDATION' });
    assert.equal(f.writes.length, 0);
  }
  for (const change of [{ active: false }, { archived: true }, { category_name: 'FOOD' }, { track_stock: false }, { sale_unit: 'gram' }]) {
    const product = { ...baseProduct(), ...change }; const f = fixture(product);
    await assert.rejects(saveCakeSheetYield({ entity: f.entity, user: owner, product, value: 24 }), { code: 'VALIDATION' });
    assert.equal(f.writes.length, 0);
  }
});

test('legacy missing production unit and yield use existence checks without converting units', async () => {
  const original = baseProduct(); delete original.production_unit; delete original.pieces_per_sheet;
  const f = fixture(original);
  const saved = await saveCakeSheetYield({ entity: f.entity, user: owner, product: original, value: 18 });
  assert.deepEqual(f.writes[0].filter.production_unit, { $exists: false });
  assert.deepEqual(f.writes[0].filter.pieces_per_sheet, { $exists: false });
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'production_unit'), false);
  assert.equal(saved.pieces_per_sheet, 18);
});

test('same saved value is verified without a redundant write', async () => {
  const product = { ...baseProduct(), pieces_per_sheet: 24 }; const f = fixture(product);
  assert.equal((await saveCakeSheetYield({ entity: f.entity, user: owner, product, value: 24 })).pieces_per_sheet, 24);
  assert.equal(f.writes.length, 0); assert.equal(f.reads(), 1);
});

test('concurrent yield edit causes conflict rather than overwriting another operator', async () => {
  const product = baseProduct(); const f = fixture(product, { beforeUpdate: row => { row.pieces_per_sheet = 30; } });
  await assert.rejects(saveCakeSheetYield({ entity: f.entity, user: owner, product, value: 24 }), { code: 'CONFLICT' });
  assert.equal(f.row().pieces_per_sheet, 30); assert.equal(f.writes.length, 1); assert.equal(f.reads(), 0);
});

test('atomic eligibility filters reject concurrent unit, availability, archive and category changes', async () => {
  for (const change of [{ production_unit: 'sheet' }, { active: false }, { archived: true }, { track_stock: false },
    { sale_unit: 'gram' }, { source_type: 'shop_prepared' }, { category_name: 'FOOD' }]) {
    const product = baseProduct(); const f = fixture(product, { beforeUpdate: row => Object.assign(row, change) });
    await assert.rejects(saveCakeSheetYield({ entity: f.entity, user: owner, product, value: 24 }), { code: 'CONFLICT' });
    assert.equal(f.row().pieces_per_sheet, 1, JSON.stringify(change));
  }
});

test('lost response after commit is recovered by reading once without repeating the write', async () => {
  const product = baseProduct(); const f = fixture(product, { loseResponse: true });
  const saved = await saveCakeSheetYield({ entity: f.entity, user: owner, product, value: 24 });
  assert.equal(saved.pieces_per_sheet, 24); assert.equal(f.writes.length, 1); assert.equal(f.reads(), 1);
});

test('uncertain writes are not reported as saved unless desired value and eligible piece state persist', async () => {
  for (const options of [{ rejectBefore: new Error('Disconnected') },
    { loseResponse: true, beforeRead: row => { row.production_unit = 'sheet'; } },
    { loseResponse: true, beforeRead: row => { row.category_name = 'FOOD'; } },
    { loseResponse: true, readError: true }]) {
    const product = baseProduct(); const f = fixture(product, options);
    await assert.rejects(saveCakeSheetYield({ entity: f.entity, user: owner, product, value: 24 }), { code: 'UNCONFIRMED' });
    assert.equal(f.writes.length, 1); assert.equal(f.reads(), 1);
  }
});

test('an acknowledged write still requires readback and rejects subsequent concurrent changes', async () => {
  for (const options of [{ readError: true }, { beforeRead: row => { row.pieces_per_sheet = 32; } }, { beforeRead: row => { row.active = false; } }]) {
    const product = baseProduct(); const f = fixture(product, options);
    await assert.rejects(saveCakeSheetYield({ entity: f.entity, user: owner, product, value: 24 }),
      { code: options.readError ? 'UNCONFIRMED' : 'CONFLICT' });
    assert.equal(f.writes.length, 1); assert.equal(f.reads(), 1);
  }
});

test('explicit authorization rejection never starts recovery or retries', async () => {
  const product = baseProduct(); const error = Object.assign(new Error('Forbidden'), { status: 403 });
  const f = fixture(product, { rejectBefore: error });
  await assert.rejects(saveCakeSheetYield({ entity: f.entity, user: owner, product, value: 24 }), { code: 'FORBIDDEN' });
  assert.equal(f.writes.length, 1); assert.equal(f.reads(), 0);
});

test('existing server Product schema enforces positive integer and admin/accountant updates', () => {
  const schema = JSON.parse(readFileSync(new URL('../base44/entities/Product.jsonc', import.meta.url), 'utf8'));
  assert.equal(schema.properties.pieces_per_sheet.type, 'integer');
  assert.equal(schema.properties.pieces_per_sheet.minimum, 1);
  const allowed = schema.rls.update.$or.map(rule => rule.user_condition.role).sort();
  assert.deepEqual(allowed, ['accountant', 'admin']);
});
