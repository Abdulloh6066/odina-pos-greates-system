// Financial safety regressions execute real handlers against memory only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const handlers = ['shift-close-v2', 'complete-sale'];
const body = { action: 'close_shift', shift_id: 'shift', actual_cash: 1000, budget_cash_submitted: 500, cash_left_for_next_shift: 500 };
function fixture(name) {
  const f = memoryBackend({
    User: [{ id: 'cashier', role: 'cashier', active: true, shop_id: 'shop', full_name: 'Kassir' }],
    Shop: [{ id: 'shop', name: 'Do‘kon', active: true, location_type: 'shop' }],
    Shift: [{ id: 'shift', user_id: 'cashier', user_name: 'Kassir', shop_id: 'shop', shop_name: 'Do‘kon',
      status: 'open', opened_at: '2026-09-27T01:00:00Z', expected_cash: 1000, cash_sales: 1000,
      uzcard_sales: 0, humo_sales: 0, online_sales: 0, bank_transfer_sales: 0, total_sales: 1000, order_count: 1 }],
    Product: [], ProductStock: [], StockMovement: [], ShiftProductSnapshot: [],
    BudgetBalance: [{ id: 'cash', account: 'cash', balance: 100 }, { id: 'uzcard', account: 'uzcard', balance: 20 }],
    BudgetTransaction: [], ActionHistory: [],
  });
  f.close = () => f.invoke(`base44/functions/${name}/entry.ts`, body);
  return f;
}
const cash = f => f.db.BudgetBalance.find(row => row.account === 'cash').balance;
const noDeletes = f => assert.ok(!f.calls.some(([, action]) => action === 'delete'));

for (const name of handlers) {
  test(`${name}: unfinished supplier and order payment journals reject closing before any settlement`, async () => {
    for (const [field, operation] of [
      ['supplier_payment_operations_json', { status: 'processing' }],
      ['supplier_payment_operations_json', { status: 'reversing' }],
      ['order_payment_operations_json', { state: 'pending' }],
      ['order_payment_operations_json', { state: 'applying' }],
    ]) {
      const f = fixture(name);
      f.db.Shift[0][field] = JSON.stringify({ 'saved-request': operation });
      const result = await f.close();
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.equal(f.db.Shift[0].status, 'open');
      assert.equal(cash(f), 100);
      assert.equal(f.db.BudgetTransaction.length, 0);
      assert.ok(!f.calls.some(([entity, action]) => entity === 'BudgetBalance' && ['create', 'update', 'updateMany'].includes(action)));
      noDeletes(f);
    }
  });

  test(`${name}: completed supplier and applied order journals retain normal closing behavior`, async () => {
    for (const supplierState of ['completed', 'reversed']) {
      const f = fixture(name);
      f.db.Shift[0].supplier_payment_operations_json = JSON.stringify({ supplier: { status: supplierState } });
      f.db.Shift[0].order_payment_operations_json = JSON.stringify({ order: { state: 'applied' } });
      const before = [f.db.Shift[0].supplier_payment_operations_json, f.db.Shift[0].order_payment_operations_json];
      const result = await f.close();
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(f.db.Shift[0].status, 'closed');
      assert.equal(cash(f), 600);
      assert.equal(f.db.BudgetTransaction.length, 1);
      assert.deepEqual([f.db.Shift[0].supplier_payment_operations_json, f.db.Shift[0].order_payment_operations_json], before);
      noDeletes(f);
    }
  });

  test(`${name}: a journal claim interleaving before close CAS leaves the shift open without deposits`, async () => {
    for (const [field, operation] of [
      ['supplier_payment_operations_json', { status: 'processing' }],
      ['order_payment_operations_json', { state: 'pending' }],
    ]) {
      const f = fixture(name), update = f.entities.Shift.updateMany;
      let inserted = false;
      f.entities.Shift.updateMany = async (query, ops) => {
        if (!inserted && ops.$set?.status === 'closing') {
          inserted = true;
          await update({ id: 'shift', status: 'open' }, { $set: { [field]: JSON.stringify({ interleaved: operation }) } });
        }
        return update(query, ops);
      };
      const result = await f.close();
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.equal(f.db.Shift[0].status, 'open');
      assert.equal(cash(f), 100);
      assert.equal(f.db.BudgetTransaction.length, 0);
      noDeletes(f);
    }
  });

  test(`${name}: malformed journals fail closed without financial writes`, async () => {
    for (const field of ['supplier_payment_operations_json', 'order_payment_operations_json']) {
      for (const malformed of ['not-json', '[]', 'null', '"text"', '{"broken":null}', 0, false, {}]) {
        const f = fixture(name);
        f.db.Shift[0][field] = malformed;
        const result = await f.close();
        assert.equal(result.status, 409, `${field} ${JSON.stringify(malformed)}: ${JSON.stringify(result)}`);
        assert.equal(f.db.Shift[0].status, 'open');
        assert.equal(cash(f), 100);
        assert.equal(f.db.BudgetTransaction.length, 0);
        noDeletes(f);
      }
    }
  });

  test(`${name}: card payment committed before claim is included in the final settlement`, async () => {
    const f = fixture(name);
    const update = f.entities.Shift.updateMany;
    let inserted = false;
    f.entities.Shift.updateMany = async (query, ops) => {
      if (!inserted && ops.$set?.status === 'closing') {
        inserted = true;
        // This is the same atomic increment used by a card POS sale/order payment.
        await update({ id: 'shift', status: 'open' }, { $inc: { uzcard_sales: 1200, total_sales: 1200, order_count: 1 } });
      }
      return update(query, ops);
    };
    const result = await f.close();
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(f.db.Shift[0].budget_settled, true);
    assert.equal(f.db.BudgetBalance.find(row => row.account === 'uzcard').balance, 1220);
    assert.equal(f.db.BudgetTransaction.find(row => row.account === 'uzcard').amount, 1200);
    assert.equal(result.data.shift.uzcard_sales, 1200);
    assert.equal(result.data.shift.total_sales, 2200);
    assert.equal(cash(f), 600);
    noDeletes(f);
  });

  test(`${name}: lost initial claim reply is reconciled before settlement`, async () => {
    const f = fixture(name), update = f.entities.Shift.updateMany;
    let lost = false;
    f.entities.Shift.updateMany = async (query, ops) => {
      const result = await update(query, ops);
      if (!lost && ops.$set?.status === 'closing') { lost = true; throw new Error('Claim reply lost'); }
      return result;
    };
    assert.equal((await f.close()).status, 200);
    assert.equal(cash(f), 600);
    assert.equal(f.db.BudgetTransaction.length, 1);
    assert.equal(f.db.Shift[0].status, 'closed');
    noDeletes(f);
  });

  test(`${name}: lost Budget credit reply preserves unrelated concurrent deposits`, async () => {
    const f = fixture(name), update = f.entities.BudgetBalance.updateMany;
    let lost = false;
    f.entities.BudgetBalance.updateMany = async (query, ops) => {
      const result = await update(query, ops);
      if (!lost && ops.$inc?.balance === 500) {
        lost = true;
        await update({ id: 'cash' }, { $inc: { balance: 700 } });
        throw new Error('Credit reply lost');
      }
      return result;
    };
    assert.equal((await f.close()).status, 200);
    assert.equal(cash(f), 1300);
    assert.equal(f.db.BudgetTransaction.length, 1);
    assert.equal(f.db.BudgetTransaction[0].balance_before, 100);
    assert.equal(f.db.BudgetTransaction[0].balance_after, 600);
    noDeletes(f);
  });

  test(`${name}: lost ledger reply finds the existing transaction and finalizes once`, async () => {
    const f = fixture(name), create = f.entities.BudgetTransaction.create;
    f.entities.BudgetTransaction.create = async data => { await create(data); throw new Error('Ledger reply lost'); };
    assert.equal((await f.close()).status, 200);
    assert.equal((await f.close()).status, 200);
    assert.equal(cash(f), 600);
    assert.equal(f.db.BudgetTransaction.length, 1);
    noDeletes(f);
  });

  test(`${name}: lost finalization reply never compensates a completed closure`, async () => {
    const f = fixture(name), update = f.entities.Shift.updateMany;
    f.entities.Shift.updateMany = async (query, ops) => {
      const result = await update(query, ops);
      if (ops.$set?.status === 'closed') throw new Error('Finalization reply lost');
      return result;
    };
    const result = await f.close();
    assert.equal(result.status, 200);
    assert.equal(result.data.shift.status, 'closed');
    assert.equal(cash(f), 600);
    assert.equal(f.db.BudgetTransaction.length, 1);
    assert.equal((await f.close()).status, 200);
    assert.equal(cash(f), 600);
    noDeletes(f);
  });

  test(`${name}: confirmed lost-finalize closure finishes only the last shop ticket cycle`, async () => {
    for (const anotherOpen of [false, true]) {
      const f = fixture(name), update = f.entities.Shift.updateMany;
      Object.assign(f.db.Shop[0], { service_ticket_cycle_active: true, service_ticket_counter: 17, service_ticket_version: 1 });
      if (anotherOpen) f.db.Shift.push({ ...structuredClone(f.db.Shift[0]), id: 'other-shift', user_id: 'other' });
      f.entities.Shift.updateMany = async (query, ops) => {
        const result = await update(query, ops);
        if (ops.$set?.status === 'closed') throw new Error('Finalization reply lost');
        return result;
      };
      const result = await f.close();
      assert.equal(result.status, 200);
      assert.equal(f.db.Shop[0].service_ticket_cycle_active, anotherOpen);
      assert.equal(f.db.Shop[0].service_ticket_counter, 17);
      assert.equal(cash(f), 600);
      noDeletes(f);
    }
  });

  test(`${name}: failed auxiliary replay reads return confirmed closed success with explicit incomplete details`, async () => {
    for (const failedPart of ['stock', 'budget']) {
      const f = fixture(name), update = f.entities.Shift.updateMany;
      f.entities.Shift.updateMany = async (query, ops) => {
        const result = await update(query, ops);
        if (ops.$set?.status === 'closed') throw new Error('Finalization reply lost');
        return result;
      };
      if (failedPart === 'stock') f.entities.ShiftProductSnapshot.filter = async () => { throw new Error('Stock details unavailable'); };
      else f.entities.BudgetTransaction.filter = async () => { throw new Error('Budget details unavailable'); };
      const result = await f.close();
      assert.equal(result.status, 200);
      assert.equal(result.data.shift.status, 'closed');
      assert.equal(result.data.details_complete, false);
      assert.match(result.data.details_warning, /Smena yopilgani va mablag‘lar saqlangani tasdiqlandi/);
      assert.equal(result.data.stock_report.complete, failedPart !== 'stock');
      assert.equal(result.data.budget_transactions_complete, failedPart !== 'budget');
      if (failedPart === 'stock') assert.equal(result.data.budget_transactions.length, 1);
      assert.equal(cash(f), 600);
      assert.equal(f.db.BudgetTransaction.length, 1);
      assert.equal((await f.close()).status, 200);
      assert.equal(cash(f), 600);
      noDeletes(f);
    }
  });

  test(`${name}: uncertain credit and failed reread stay locked without compensation or replay`, async () => {
    const f = fixture(name), update = f.entities.BudgetBalance.updateMany, get = f.entities.BudgetBalance.get;
    let unreadable = false;
    f.entities.BudgetBalance.updateMany = async (query, ops) => {
      const result = await update(query, ops);
      if (ops.$inc?.balance === 500) { unreadable = true; throw new Error('Credit reply lost'); }
      return result;
    };
    f.entities.BudgetBalance.get = async id => {
      if (unreadable) throw new Error('Reread unavailable');
      return get(id);
    };
    const result = await f.close();
    assert.equal(result.status, 503);
    assert.equal(f.db.Shift[0].status, 'closing');
    assert.equal(f.db.Shift[0].closing_review_required, true);
    assert.equal(cash(f), 600);
    assert.equal((await f.close()).status, 409);
    assert.equal(cash(f), 600);
    noDeletes(f);
  });

  test(`${name}: failed finalization reread retains completed money and replays safely after reads recover`, async () => {
    const f = fixture(name), update = f.entities.Shift.updateMany, get = f.entities.Shift.get;
    let unreadable = false;
    f.entities.Shift.updateMany = async (query, ops) => {
      const result = await update(query, ops);
      if (ops.$set?.status === 'closed') { unreadable = true; throw new Error('Finalization reply lost'); }
      return result;
    };
    f.entities.Shift.get = async id => {
      if (unreadable) throw new Error('Reread unavailable');
      return get(id);
    };
    const first = await f.close();
    assert.equal(first.status, 503);
    assert.equal(f.db.Shift[0].status, 'closed');
    assert.equal(f.db.Shift[0].budget_settled, true);
    assert.equal(cash(f), 600);
    unreadable = false;
    assert.equal((await f.close()).status, 200);
    assert.equal(f.db.BudgetTransaction.length, 1);
    assert.equal(cash(f), 600);
    noDeletes(f);
  });
}
