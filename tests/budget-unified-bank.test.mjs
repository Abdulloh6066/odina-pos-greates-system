// Memory-only tests: no live money, credentials, records or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { memoryBackend } from './helpers/memory-backend.mjs';

const helper = 'base44/shared/supplier-payment-recovery.ts';
const endpoint = 'base44/functions/budget-ledger/entry.ts';
const labels = { bank_all: 'Bank', bank: 'Bank', uzcard: 'Uzcard', humo: 'Humo', cash: 'Naqd pul' };
const fixture = () => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Offline owner' }],
  Settings: [{ id: 'settings' }],
  BudgetBalance: [
    { id: 'bank', account: 'bank', balance: 40 },
    { id: 'uzcard', account: 'uzcard', balance: 50 },
    { id: 'humo', account: 'humo', balance: 30 },
    { id: 'cash', account: 'cash', balance: 1000 },
  ],
  CashRecipient: [{ id: 'supplier', name: 'Offline supplier', recipient_type: 'supplier', active: true }],
  SupplierOpeningDebt: [{ id: 'opening', supplier_id: 'supplier', debt_number: 'OPEN-1',
    debt_amount: 150, remaining_debt: 150, status: 'unpaid', location_id: 'warehouse' }],
  SupplierReceipt: [], BudgetTransaction: [], SupplierPayment: [], ActionHistory: [],
});
const balances = f => Object.fromEntries(f.db.BudgetBalance.map(row => [row.account, row.balance]));
const adjust = (f, change = {}) => f.load(helper).runBudgetAdjustment(f.service, f.db.User[0], {
  key: 'bank-adjustment-one', account: 'bank_all', direction: 'out', amount: 100, description: 'Offline bank withdrawal', ...change,
}, labels);
const pay = (f, change = {}) => f.load(helper).runSupplierPayment(f.service, f.db.User[0], {
  key: 'bank-payment-one', action: 'pay_supplier', account: 'bank_all', supplier_id: 'supplier',
  opening_debt_id: 'opening', location_id: 'warehouse', amount: 100, notes: 'Offline bank debt payment', ...change,
}, labels);
const untouchedCash = f => {
  assert.equal(balances(f).cash, 1000);
  assert.ok(!f.db.BudgetBalance.some(row => row.account === 'bank_all'));
  assert.ok(f.calls.every(([, action]) => action !== 'delete'));
};

test('one Bank withdrawal can spend existing bank, Uzcard and Humo funds once', async () => {
  const f = fixture(); const result = await adjust(f);
  assert.deepEqual(balances(f), { bank: 0, uzcard: 0, humo: 20, cash: 1000 });
  assert.equal(result.balance.balance, 20);
  assert.equal(f.db.BudgetTransaction.length, 1);
  assert.equal(f.db.BudgetTransaction[0].account, 'bank');
  const history = structuredClone(f.db.BudgetTransaction);
  assert.equal((await adjust(f)).already_processed, true);
  assert.deepEqual(f.db.BudgetTransaction, history); untouchedCash(f);
});

test('new Bank deposits credit canonical Bank and report the combined balance', async () => {
  const f = fixture(); const result = await adjust(f, { direction: 'in', amount: 80 });
  assert.deepEqual(balances(f), { bank: 120, uzcard: 50, humo: 30, cash: 1000 });
  assert.equal(result.balance.balance, 200);
  assert.equal(result.transaction.account, 'bank');
  untouchedCash(f);
});

test('selected debt is paid once using one Bank ledger entry across backing balances', async () => {
  const f = fixture(); const result = await pay(f);
  assert.equal(result.paid, true); assert.equal(result.account, 'bank_all');
  assert.equal(result.budget_balance, 20);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 50);
  assert.deepEqual(balances(f), { bank: 0, uzcard: 0, humo: 20, cash: 1000 });
  assert.equal(f.db.SupplierPayment.length, 1);
  assert.equal(f.db.SupplierPayment[0].amount, 100);
  assert.equal(f.db.SupplierPayment[0].budget_account, 'bank');
  assert.equal(f.db.BudgetTransaction.length, 1);
  assert.equal(f.db.BudgetTransaction[0].account, 'bank');
  assert.equal((await pay(f)).already_processed, true);
  assert.equal(f.db.SupplierPayment.length, 1); untouchedCash(f);
});

test('insufficient combined Bank funds never borrow from cash or reduce a debt', async () => {
  for (const run of [adjust, pay]) {
    const f = fixture();
    await assert.rejects(run(f, { amount: 121 }), error => error.operation_reversed === true);
    assert.deepEqual(balances(f), { bank: 40, uzcard: 50, humo: 30, cash: 1000 });
    assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 150);
    assert.equal(f.db.BudgetTransaction.length, 0); untouchedCash(f);
  }
});

for (const account of ['bank', 'uzcard', 'humo']) {
  test(`lost ${account} balance update reply cannot duplicate a Bank debit`, async () => {
    const f = fixture(); const update = f.entities.BudgetBalance.updateMany; let lost = false;
    f.entities.BudgetBalance.updateMany = async (query, ops) => {
      const result = await update(query, ops);
      if (!lost && query.id === account && ops.$inc?.balance < 0 && result.updated === 1) {
        lost = true; throw new Error('Offline lost saved reply');
      }
      return result;
    };
    await pay(f); await pay(f);
    assert.equal(lost, true);
    assert.deepEqual(balances(f), { bank: 0, uzcard: 0, humo: 20, cash: 1000 });
    assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 50);
    assert.equal(f.db.BudgetTransaction.length, 1); untouchedCash(f);
  });
}

test('definite debt ledger rejection reverses all Bank parts and preserves unrelated deposits', async () => {
  const f = fixture();
  f.entities.BudgetTransaction.create = async () => {
    f.db.BudgetBalance.find(row => row.account === 'humo').balance += 7;
    throw Object.assign(new Error('Offline definite ledger rejection'), { status: 400 });
  };
  await assert.rejects(pay(f), error => error.operation_reversed === true);
  assert.deepEqual(balances(f), { bank: 40, uzcard: 50, humo: 37, cash: 1000 });
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt, 150);
  assert.equal(f.db.SupplierPayment.length, 0); untouchedCash(f);
});

test('failure after the first backing debit reverses only parts that actually applied', async () => {
  const f = fixture(); const update = f.entities.BudgetBalance.updateMany;
  f.entities.BudgetBalance.updateMany = async (query, ops) => {
    if (query.id === 'uzcard' && ops.$inc?.balance < 0) {
      throw Object.assign(new Error('Offline backing debit rejected'), { status: 400 });
    }
    return update(query, ops);
  };
  await assert.rejects(adjust(f), error => error.operation_reversed === true);
  assert.deepEqual(balances(f), { bank: 40, uzcard: 50, humo: 30, cash: 1000 });
  assert.equal(f.db.BudgetTransaction.length, 0); untouchedCash(f);
});

test('a reversed Bank part fences a delayed debit even after a shift credit restores the old balance', async () => {
  const f = fixture(); const user = f.db.User[0]; const when = '2026-09-27T07:00:00Z';
  const settlement = f.load('base44/shared/shift-settlement-recovery.ts');
  f.db.BudgetBalance.find(row => row.account === 'uzcard').balance = 40;
  const oldCredit = await settlement.creditShiftBudget(f.service, 'uzcard', 10, 'Uzcard', user, when, 'old-shift-credit');
  const update = f.entities.BudgetBalance.updateMany; let lateApply;
  f.entities.BudgetBalance.updateMany = async (query, ops) => {
    if (!lateApply && query.id === 'uzcard' && ops.$inc?.balance === -50) {
      lateApply = () => update(query, ops);
      await settlement.reverseShiftBudget(f.service, oldCredit, user);
      throw new Error('Offline timed-out conditional write still queued');
    }
    return update(query, ops);
  };
  await assert.rejects(adjust(f), error => error.operation_reversed === true);
  await settlement.creditShiftBudget(f.service, 'uzcard', 10, 'Uzcard', user, when, 'new-shift-credit');
  assert.equal((await lateApply()).updated, 0);
  assert.deepEqual(balances(f), { bank: 40, uzcard: 50, humo: 30, cash: 1000 });
  assert.equal(f.db.BudgetTransaction.length, 0); untouchedCash(f);
});

for (const interrupted of [false, true]) {
  test(`missing Bank parent cannot repeat ${interrupted ? 'a pending' : 'a completed'} backing debit`, async () => {
    for (const missingRow of [false, true]) {
      const f = fixture();
      f.db.BudgetBalance.find(row => row.account === 'bank').balance = 0;
      f.db.BudgetBalance.find(row => row.account === 'uzcard').balance = 100;
      f.db.BudgetBalance.find(row => row.account === 'humo').balance = 0;
      let creates = 0;
      if (interrupted) {
        f.entities.BudgetTransaction.create = async () => { creates++; throw new Error('Offline ambiguous history write'); };
        await assert.rejects(adjust(f, { amount: 25 }), error => error.operation_pending === true);
      } else await adjust(f, { amount: 25 });
      if (missingRow) f.db.BudgetBalance = f.db.BudgetBalance.filter(row => row.account !== 'bank');
      else f.db.BudgetBalance.find(row => row.account === 'bank').financial_operations_json = '{}';
      await assert.rejects(adjust(f, { amount: 25 }), error => error.operation_pending === true);
      assert.equal(balances(f).uzcard, 75);
      assert.equal(f.db.BudgetTransaction.length, interrupted ? 0 : 1);
      assert.equal(creates, interrupted ? 1 : 0); untouchedCash(f);
    }
  });
}

test('concurrent successful Bank withdrawals never record planning totals as running history', async () => {
  const f = fixture();
  f.db.BudgetBalance.find(row => row.account === 'bank').balance = 100;
  f.db.BudgetBalance.find(row => row.account === 'uzcard').balance = 0;
  f.db.BudgetBalance.find(row => row.account === 'humo').balance = 0;
  await Promise.all([adjust(f, { amount: 25 }), adjust(f, { amount: 25, key: 'bank-adjustment-two' })]);
  assert.equal(balances(f).bank, 50);
  assert.equal(f.db.BudgetTransaction.length, 2);
  for (const row of f.db.BudgetTransaction) {
    assert.equal(row.amount, 25); assert.equal(row.account, 'bank');
    assert.equal(row.balance_before, undefined); assert.equal(row.balance_after, undefined);
  }
});

test('pooled records satisfy the production BudgetTransaction required fields', async () => {
  const schema = JSON.parse(readFileSync(new URL('../base44/entities/BudgetTransaction.jsonc', import.meta.url), 'utf8'));
  const f = fixture(); const create = f.entities.BudgetTransaction.create;
  f.entities.BudgetTransaction.create = async row => {
    const missing = schema.required.filter(key => row[key] == null);
    if (missing.length) throw Object.assign(new Error(`Schema requires ${missing.join(', ')}`), { status: 400 });
    return create(row);
  };
  await adjust(f, { amount: 10 }); await pay(f);
  assert.equal(f.db.BudgetTransaction.length, 2);
});

test('a copied pending Bank journal cannot confirm money from a replacement anchor', async () => {
  const f = fixture(); const filter = f.entities.BudgetTransaction.filter; let failed = false;
  f.entities.BudgetTransaction.filter = async (...args) => {
    if (!failed) { failed = true; throw new Error('Offline history lookup unavailable'); }
    return filter(...args);
  };
  await assert.rejects(adjust(f, { amount: 25 }), error => error.operation_pending === true);
  const bank = f.db.BudgetBalance.find(row => row.account === 'bank');
  bank.id = 'replacement-bank'; bank.balance = 40;
  await assert.rejects(adjust(f, { amount: 25 }), error => error.operation_pending === true);
  assert.equal(f.db.BudgetTransaction.length, 0);
  assert.deepEqual(balances(f), { bank: 40, uzcard: 50, humo: 30, cash: 1000 });
});

test('an uncertain ledger create stays pending and never retries a new create or debit', async () => {
  const f = fixture(); let creates = 0;
  f.entities.BudgetTransaction.create = async () => { creates++; throw new Error('Offline uncertain create'); };
  await assert.rejects(adjust(f), error => error.operation_pending === true);
  await assert.rejects(adjust(f), error => error.operation_pending === true);
  assert.equal(creates, 1);
  assert.deepEqual(balances(f), { bank: 0, uzcard: 0, humo: 20, cash: 1000 }); untouchedCash(f);
});

test('concurrent Bank requests cannot spend more than the combined available funds', async () => {
  const f = fixture();
  const results = await Promise.allSettled([adjust(f), adjust(f, { key: 'bank-adjustment-two' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.db.BudgetTransaction.length, 1);
  assert.equal(balances(f).bank + balances(f).uzcard + balances(f).humo, 20);
  assert.ok(f.db.BudgetBalance.every(row => row.balance >= 0)); untouchedCash(f);
});

test('legacy requests keep their original identity and cannot be replayed as a new Bank wallet', async () => {
  const f = fixture(); await adjust(f, { account: 'uzcard', amount: 20 });
  assert.equal((await adjust(f, { account: 'uzcard', amount: 20 })).already_processed, true);
  await assert.rejects(adjust(f, { amount: 20 }), error => error.status === 409);
  assert.deepEqual(balances(f), { bank: 40, uzcard: 30, humo: 30, cash: 1000 });
  assert.equal(f.db.BudgetTransaction.length, 1); untouchedCash(f);
});

test('missing old card balances do not require creating extra physical accounts', async () => {
  const f = fixture(); f.db.BudgetBalance = f.db.BudgetBalance.filter(row => row.account === 'cash');
  const result = await adjust(f, { direction: 'in', amount: 80 });
  assert.equal(result.balance.balance, 80);
  assert.deepEqual(balances(f), { cash: 1000, bank: 80 }); untouchedCash(f);
});

async function pin(f) {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('2468'), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('offline-salt'), iterations: 100000 }, key, 256);
  f.db.SecuritySettings = [{ id: 'security', key: 'owner_approval_pin', pin_hash: Buffer.from(bits).toString('hex'),
    pin_salt: 'offline-salt', pin_algorithm: 'PBKDF2-SHA256', pin_iterations: 100000 }];
}
test('owner endpoint accepts the logical Bank only with the existing valid PIN', async () => {
  const f = fixture(); await pin(f);
  const body = { action: 'manual_adjustment', account: 'bank_all', direction: 'out', amount: 100,
    description: 'Offline bank withdrawal', idempotency_key: 'bank-endpoint-one', owner_pin: '0000' };
  assert.equal((await f.invoke(endpoint, body)).status, 403);
  assert.equal(f.db.BudgetTransaction.length, 0);
  const response = await f.invoke(endpoint, { ...body, owner_pin: '2468' });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.balance.balance, 20);
  f.db.User[0].role = 'cashier';
  assert.equal((await f.invoke(endpoint, { action: 'summary' })).status, 403); untouchedCash(f);
});

test('owner supplier endpoint pays from Bank while legacy Bank card requests remain recoverable', async () => {
  const f = fixture(); await pin(f);
  const result = await f.invoke(endpoint, { action: 'pay_supplier', account: 'bank_all', amount: 100,
    supplier_id: 'supplier', opening_debt_id: 'opening', location_id: 'warehouse', notes: 'Offline selected bank payment',
    idempotency_key: 'bank-debt-endpoint', owner_pin: '2468' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.account, 'bank_all'); assert.equal(result.data.budget_balance, 20);
  const g = fixture(); await pin(g);
  const body = { action: 'manual_adjustment', account: 'bank_card', direction: 'out', amount: 80,
    description: 'Offline old card request', idempotency_key: 'legacy-card-endpoint', owner_pin: '2468' };
  assert.equal((await g.invoke(endpoint, body)).status, 200);
  assert.equal((await g.invoke(endpoint, body)).status, 200);
  assert.deepEqual(balances(g), { bank: 40, uzcard: 0, humo: 0, cash: 1000 });
  assert.equal(g.db.BudgetTransaction.length, 2); untouchedCash(g);
});

test('an interrupted Bank reversal resumes remaining parts without refunding a part twice', async () => {
  const f = fixture(); const update = f.entities.BudgetBalance.updateMany;
  f.entities.BudgetTransaction.create = async () => { throw Object.assign(new Error('Offline rejection'), { status: 400 }); };
  f.entities.BudgetBalance.updateMany = async (query, ops) => {
    if (query.id === 'uzcard' && ops.$inc?.balance > 0) throw new Error('Offline reversal unavailable');
    return update(query, ops);
  };
  await assert.rejects(adjust(f), error => error.operation_pending === true);
  assert.deepEqual(balances(f), { bank: 0, uzcard: 0, humo: 30, cash: 1000 });
  f.entities.BudgetBalance.updateMany = update;
  await assert.rejects(adjust(f), error => error.operation_reversed === true);
  assert.deepEqual(balances(f), { bank: 40, uzcard: 50, humo: 30, cash: 1000 });
  await assert.rejects(adjust(f), error => error.operation_reversed === true);
  assert.equal(f.db.BudgetTransaction.length, 0); untouchedCash(f);
});

for (const closeEndpoint of ['base44/functions/shift-close-v2/entry.ts', 'base44/functions/complete-sale/entry.ts']) {
  test(`${closeEndpoint}: future card settlements are spendable from Bank with original shift history intact`, async () => {
    const f = fixture(); f.db.User[0].role = 'cashier'; f.db.User[0].shop_id = 'shop';
    f.db.Shop = [{ id: 'shop', name: 'Offline shop', active: true, location_type: 'shop', allows_pos: true }];
    f.db.Shift = [{ id: 'shift', user_id: 'owner', shop_id: 'shop', shop_name: 'Offline shop', status: 'open',
      opened_at: '2026-09-27T06:00:00Z', expected_cash: 0, uzcard_sales: 20, humo_sales: 30, bank_transfer_sales: 40 }];
    const response = await f.invoke(closeEndpoint, { action: 'close_shift', shift_id: 'shift', actual_cash: 0,
      budget_cash_submitted: 0, cash_left_for_next_shift: 0 });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(balances(f), { bank: 80, uzcard: 70, humo: 60, cash: 1000 });
    const history = structuredClone(f.db.BudgetTransaction);
    assert.equal(history.length, 3);
    f.db.User[0].role = 'admin';
    const spent = await adjust(f, { amount: 200 });
    assert.equal(spent.balance.balance, 10);
    assert.equal(spent.transaction.amount, 200); assert.equal(spent.transaction.account, 'bank');
    assert.deepEqual(f.db.BudgetTransaction.slice(0, 3), history);
    assert.equal(f.db.Shift[0].uzcard_sales, 20); assert.equal(f.db.Shift[0].humo_sales, 30); untouchedCash(f);
  });
}
