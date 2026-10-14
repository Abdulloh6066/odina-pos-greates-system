import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';

const endpoints = ['base44/functions/shift-close-v2/entry.ts', 'base44/functions/complete-sale/entry.ts'];
const request = { action: 'close_shift', shift_id: 's', actual_cash: 1000, budget_cash_submitted: 1000, cash_left_for_next_shift: 0 };
function fixture() {
  return memoryBackend({
    User: [{ id: 'u', role: 'cashier', active: true, shop_id: 'shop', email: 'offline@example.test' }],
    Shop: [{ id: 'shop', name: 'Offline shop', active: true, location_type: 'shop', allows_pos: true }],
    Shift: [{ id: 's', user_id: 'u', shop_id: 'shop', status: 'open', opened_at: '2026-09-27T06:00:00Z', expected_cash: 1000 }],
    Settings: [{ id: 'settings', customer_order_last_number: 0 }],
    BudgetBalance: [{ id: 'b', account: 'cash', balance: 0 }],
  });
}

for (const endpoint of endpoints) {
  for (const stage of ['claim', 'credit', 'ledger', 'finalize']) {
    test(`${endpoint}: saved ${stage} write with lost reply reconciles once`, async () => {
      const f = fixture(); let fired = false;
      if (stage === 'claim' || stage === 'finalize') {
        const original = f.entities.Shift.updateMany;
        f.entities.Shift.updateMany = async (q, ops) => {
          const result = await original(q, ops);
          if (!fired && ops.$set?.status === (stage === 'claim' ? 'closing' : 'closed')) {
            fired = true; throw new Error('Offline saved write, lost reply');
          }
          return result;
        };
      } else if (stage === 'credit') {
        const original = f.entities.BudgetBalance.updateMany;
        f.entities.BudgetBalance.updateMany = async (q, ops) => {
          const result = await original(q, ops);
          if (!fired && ops.$inc?.balance === 1000) { fired = true; throw new Error('Offline saved credit, lost reply'); }
          return result;
        };
      } else {
        const original = f.entities.BudgetTransaction.create;
        f.entities.BudgetTransaction.create = async row => {
          const saved = await original(row);
          if (!fired) { fired = true; throw new Error('Offline saved ledger, lost reply'); }
          return saved;
        };
      }
      const first = await f.invoke(endpoint, request);
      assert.equal(first.status, 200, JSON.stringify(first.data));
      assert.equal(f.db.Shift[0].status, 'closed');
      assert.equal(f.db.Shift[0].budget_settled, true);
      assert.equal(f.db.BudgetBalance[0].balance, 1000);
      assert.equal(f.db.BudgetTransaction.length, 1);
      const replay = await f.invoke(endpoint, request);
      assert.equal(replay.status, 200, JSON.stringify(replay.data));
      assert.equal(replay.data.already_closed, true);
      assert.equal(f.db.BudgetBalance[0].balance, 1000);
      assert.equal(f.db.BudgetTransaction.length, 1);
      assert.equal(f.calls.filter(([, op]) => op === 'delete').length, 0);
    });
  }
  test(`${endpoint}: unavailable final confirmation preserves money and saved closure`, async () => {
    const f = fixture(); const update = f.entities.Shift.updateMany;
    const get = f.entities.Shift.get; let blockReads = false;
    f.entities.Shift.updateMany = async (q, ops) => {
      const result = await update(q, ops);
      if (ops.$set?.status === 'closed') { blockReads = true; throw new Error('Offline final reply lost'); }
      return result;
    };
    f.entities.Shift.get = async id => { if (blockReads) throw new Error('Offline confirmation unavailable'); return get(id); };
    const result = await f.invoke(endpoint, request);
    assert.equal(result.status, 503);
    assert.equal(result.data.review_required, true);
    assert.equal(f.db.Shift[0].status, 'closed');
    assert.equal(f.db.BudgetBalance[0].balance, 1000);
    assert.equal(f.db.BudgetTransaction.length, 1);
    blockReads = false;
    assert.equal((await f.invoke(endpoint, request)).status, 200);
    assert.equal(f.db.BudgetBalance[0].balance, 1000);
  });
  test(`${endpoint}: unknown ledger result remains locked and cannot repost cash`, async () => {
    const f = fixture(); let creates = 0;
    f.entities.BudgetTransaction.create = async () => { creates++; throw new Error('Offline unknown ledger write'); };
    const result = await f.invoke(endpoint, request);
    assert.equal(result.status, 503);
    assert.equal(f.db.Shift[0].status, 'closing');
    assert.equal(f.db.Shift[0].closing_review_required, true);
    assert.equal(f.db.BudgetBalance[0].balance, 1000);
    assert.equal((await f.invoke(endpoint, request)).status, 409);
    assert.equal(creates, 1);
    assert.equal(f.db.BudgetBalance[0].balance, 1000);
    assert.equal(f.calls.filter(([, op]) => op === 'delete').length, 0);
  });
  test(`${endpoint}: closed snapshot rejects different totals and other employee`, async () => {
    const f = fixture(); assert.equal((await f.invoke(endpoint, request)).status, 200);
    assert.equal((await f.invoke(endpoint, { ...request, actual_cash: 900, budget_cash_submitted: 900 })).status, 409);
    f.db.User[0].id = 'other';
    assert.equal((await f.invoke(endpoint, request)).status, 403);
    assert.equal(f.db.BudgetTransaction.length, 1);
  });
}

test('shift deposit reversal preserves concurrent balance changes and is applied once', async () => {
  const f = fixture(); const h = f.load('base44/shared/shift-close-helpers.ts');
  const change = await h.creditBudgetBalance(f.service, 'cash', 1000, f.db.User[0], '2026-09-27T07:00:00Z', 'offline-credit');
  await f.entities.BudgetBalance.updateMany({ id: 'b' }, { $inc: { balance: 200 } });
  await h.rollbackBudgetBalance(f.service, change, f.db.User[0]);
  await h.rollbackBudgetBalance(f.service, change, f.db.User[0]);
  assert.equal(f.db.BudgetBalance[0].balance, 200);
});
