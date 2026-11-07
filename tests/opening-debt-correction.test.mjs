// Offline mock fixtures only; never production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from './helpers/memory-backend.mjs';
const file = 'base44/functions/supplier-ledger/entry.ts';
const make = () => memoryBackend({
  User: [{ id: 'owner', role: 'admin', active: true, full_name: 'Mock owner' }],
  SupplierOpeningDebt: [{ id: 'opening', supplier_id: 'supplier', debt_amount: 8000, remaining_debt: 8000,
    status: 'unpaid', effective_date: '2026-09-20', location_id: 'warehouse', request_fingerprint: 'original', idempotency_key: 'create-key' }],
  Settings: [{ id: 'settings', shop_name: 'Mock shop' }],
  CashRecipient: [{ id: 'supplier', name: 'Mock supplier', active: true, recipient_type: 'company' }],
  SupplierPayment: [], SupplierReceipt: [], BudgetBalance: [{ id: 'cash', account: 'cash', balance: 10000 }],
});
const correct = (f, changes = {}) => f.invoke(file, { action: 'correct_opening_debt_amount', opening_debt_id: 'opening', amount: 3000,
  reason: 'Mock entry correction', idempotency_key: 'correction-key', ...changes });
const list = f => f.invoke(file, { action: 'list_opening_debts' });
const pay = (f, changes = {}) => f.load('base44/shared/supplier-payment-recovery.ts').runSupplierPayment(f.service, f.db.User[0], {
  key: 'payment-key', action: 'pay_supplier', supplier_id: 'supplier', account: 'cash', amount: 1000, notes: 'Mock payment', ...changes,
}, { cash: 'Cash' });

test('correction changes only principal projection and remaining with immutable audit', async () => {
  const f = make(); const before = structuredClone(f.db.SupplierOpeningDebt[0]);
  assert.equal((await list(f)).data.opening_debts[0].can_correct_amount, true);
  const r = await correct(f); assert.equal(r.status, 200); assert.equal(r.data.already_processed, false);
  const debt = f.db.SupplierOpeningDebt[0];
  for (const [k,v] of Object.entries(before)) if (k !== 'remaining_debt') assert.equal(debt[k], v);
  assert.equal(debt.remaining_debt, 3000); assert.equal(debt.corrected_debt_amount, 3000);
  assert.equal(debt.amount_corrected_by_id, 'owner'); assert.ok(debt.amount_corrected_at);
  assert.equal((await list(f)).data.opening_debts[0].can_correct_amount, false);
  assert.deepEqual(f.calls, [['SupplierOpeningDebt','updateMany']]);
});
test('exact retries preserve audit and reject changed intent or actor', async () => {
  const f = make(); await correct(f); const saved = structuredClone(f.db.SupplierOpeningDebt[0]);
  assert.equal((await correct(f)).data.already_processed, true);
  for (const change of [{amount:4000},{reason:'Other reason'},{idempotency_key:'other-key'}]) assert.equal((await correct(f,change)).status,409);
  f.db.User[0].id='another-owner'; assert.equal((await correct(f)).status,409);
  assert.deepEqual(f.db.SupplierOpeningDebt[0],saved); assert.equal(f.calls.length,1);
});
test('invalid requests and non-admins never write', async () => {
  for (const change of [{amount:0},{amount:-1},{amount:1.5},{amount:'3000'},{amount:Number.MAX_SAFE_INTEGER+1},{reason:''},{reason:' '},{reason:'x'.repeat(2001)},{amount:8000}]) {
    const f=make();assert.equal((await correct(f,change)).status,400);assert.equal(f.calls.length,0);
  }
  for (const role of ['cashier','accountant','warehouse','production']) {const f=make();f.db.User[0].role=role;assert.equal((await correct(f)).status,403);assert.equal(f.calls.length,0);}
  const f=make();f.db.User[0].active=false;assert.equal((await correct(f)).status,403);
});
test('any payment history or journal, even reversed or malformed, fails closed', async () => {
  for (const journal of ['{"old":{"state":"reversed"}}','{"old":{"state":"applied"}}','broken','[]','null']) {
    const f=make();f.db.SupplierOpeningDebt[0].payment_operations_json=journal;
    assert.equal((await correct(f)).status,409);assert.equal((await list(f)).data.opening_debts[0].can_correct_amount,false);assert.equal(f.calls.length,0);
  }
  const f=make();f.db.SupplierPayment.push({id:'historical',opening_debt_id:'opening',payment_source:'shift',status:'reversed'});
  assert.equal((await correct(f)).status,409);assert.equal((await list(f)).data.opening_debts[0].can_correct_amount,false);
});
test('old omitted, null, empty and empty-object journals remain compatible', async () => {
  for (const journal of [undefined,null,'','{}']) {const f=make();if(journal!==undefined)f.db.SupplierOpeningDebt[0].payment_operations_json=journal;assert.equal((await correct(f)).status,200);assert.equal(f.db.SupplierOpeningDebt[0].payment_operations_json,journal);}
});
test('payment races block correction through exact journal and balance CAS', async () => {
  for(const journalOnly of [true,false]) {
    const f=make();const update=f.entities.SupplierOpeningDebt.updateMany;
    f.entities.SupplierOpeningDebt.updateMany=async(...args)=>{const row=f.db.SupplierOpeningDebt[0];row.payment_operations_json='{"raced":{"state":"reversed"}}';if(!journalOnly){row.remaining_debt=7000;row.status='partial';}return update(...args);};
    assert.equal((await correct(f)).status,409);assert.equal(f.db.SupplierOpeningDebt[0].corrected_debt_amount,undefined);
  }
});
test('concurrent corrections resolve once, and lost committed response reconciles', async () => {
  const f=make();const results=await Promise.all([correct(f),correct(f,{amount:4000,idempotency_key:'different'})]);
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
  const g=make();const update=g.entities.SupplierOpeningDebt.updateMany;
  g.entities.SupplierOpeningDebt.updateMany=async(...args)=>{await update(...args);throw new Error('lost');};
  assert.equal((await correct(g)).status,200);assert.equal((await correct(g)).status,200);assert.equal(g.calls.length,1);
});
test('unknown write outcome is pending, without fabricated success or duplicate debt', async () => {
  const f=make();f.entities.SupplierOpeningDebt.updateMany=async()=>{throw new Error('network');};
  const r=await correct(f);assert.equal(r.status,503);assert.equal(r.data.operation_pending,true);assert.equal(f.db.SupplierOpeningDebt.length,1);assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,8000);
});
test('future partial/full payments use corrected principal and exact retry stays safe after payment', async () => {
  const f=make();await correct(f);await pay(f);assert.equal(f.db.SupplierOpeningDebt[0].status,'partial');assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,2000);
  assert.equal((await correct(f)).status,200);assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,2000);
  await pay(f,{key:'payment-two',amount:2000});assert.equal(f.db.SupplierOpeningDebt[0].status,'paid');assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,0);
});
test('payment compensation restores corrected principal as unpaid, not false partial', async () => {
  const f=make();await correct(f);
  f.entities.BudgetTransaction.create=async()=>{throw Object.assign(new Error('definite rejection'),{status:422});};
  await assert.rejects(pay(f),e=>e.operation_reversed===true);
  assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,3000);assert.equal(f.db.SupplierOpeningDebt[0].status,'unpaid');assert.equal(f.db.SupplierOpeningDebt[0].debt_amount,8000);assert.equal(f.db.BudgetBalance[0].balance,10000);
});

test('already planned and debited payment serializes after correction or compensates overpayment', async () => {
  for (const amount of [1000, 5000]) {
    const f=make();const update=f.entities.BudgetBalance.updateMany;let corrected=false;
    f.entities.BudgetBalance.updateMany=async(...args)=>{
      const result=await update(...args);
      if (!corrected && f.db.BudgetBalance[0].balance===10000-amount) {
        corrected=true;assert.equal((await correct(f)).status,200);
      }
      return result;
    };
    if(amount>3000) {
      await assert.rejects(pay(f,{amount}),e=>e.operation_reversed===true);
      assert.equal(f.db.BudgetBalance[0].balance,10000);assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,3000);
      assert.equal(f.db.SupplierOpeningDebt[0].status,'unpaid');assert.equal(f.db.SupplierPayment.length,0);
    } else {
      await pay(f,{amount});assert.equal(f.db.BudgetBalance[0].balance,9000);assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,2000);
      assert.equal(f.db.SupplierOpeningDebt[0].status,'partial');assert.equal(f.db.SupplierPayment.length,1);
    }
    assert.equal(corrected,true);assert.equal(f.db.SupplierOpeningDebt[0].debt_amount,8000);assert.equal(f.db.SupplierOpeningDebt[0].corrected_debt_amount,3000);
  }
});
test('correction between payment debt read and CAS forces fresh debt validation', async () => {
  for (const amount of [1000, 5000]) {
    const f=make();const update=f.entities.SupplierOpeningDebt.updateMany;let corrected=false;
    f.entities.SupplierOpeningDebt.updateMany=async(query,ops)=>{
      if(!corrected && ops.$inc?.remaining_debt) {
        corrected=true;
        assert.equal(f.db.BudgetBalance[0].balance,10000-amount);
        assert.equal((await correct(f)).status,200);
      }
      return update(query,ops);
    };
    if(amount>3000) {
      await assert.rejects(pay(f,{amount}),e=>e.operation_reversed===true);
      assert.equal(f.db.BudgetBalance[0].balance,10000);assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,3000);
      assert.equal(f.db.SupplierOpeningDebt[0].status,'unpaid');assert.equal(f.db.SupplierPayment.length,0);
    } else {
      await pay(f,{amount});assert.equal(f.db.BudgetBalance[0].balance,9000);assert.equal(f.db.SupplierOpeningDebt[0].remaining_debt,2000);
      assert.equal(f.db.SupplierOpeningDebt[0].status,'partial');assert.equal(f.db.SupplierPayment.length,1);
    }
    assert.equal(corrected,true);
  }
});
