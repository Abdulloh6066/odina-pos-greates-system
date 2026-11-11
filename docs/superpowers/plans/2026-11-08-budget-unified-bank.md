# Unified Bank implementation plan

**Goal:** Existing Bank, Humo and Uzcard balances and future card settlements form one spendable Bank wallet in Budget.

**Approved design:** Preserve the physical ledger accounts and immutable historic records. Expose one logical Bank selector (`bank_all`) backed by `bank`, `uzcard`, `humo`; new Bank deposits enter `bank`. The server debits the backing balances using recoverable, conditional markers and writes one Bank history record. Existing request identities and recovery paths remain intact. Existing shift settlement and sale/payment method snapshots remain unchanged.

**Constraints:** No live test payments, sales, shifts or stock records. Owner role/PIN still required. No Base44 AI/builder calls. Do not merge funds by rewriting old records. Preserve all latest upstream features and POS images.

1. Write offline backend tests in `tests/budget-unified-bank.test.mjs`: 40+50+30 balances, withdraw/pay 100 => total 20; canonical deposit; insufficient funds; concurrency; lost replies; partial reversal; exact retry identity; unchanged legacy paths and owner authorization. Verify missing behavior fails first.
2. Extend `base44/shared/supplier-payment-recovery.ts` only for the opt-in logical Bank source. Freeze allocation before any source write; commit each backing delta with its marker; reverse only applied parts. Reuse debt planning, durable history writes and compensation.
3. Allow `bank_all` in owner `budget-ledger` manual and supplier actions, using the existing PIN and validation checks. Store history with physical account `bank`, never create a `bank_all` balance record.
4. Budget shows Cash, Bank and Online, with Bank history/filter matching all backing accounts. Adjustment and opening-debt payment selectors use the logical Bank total. Frozen legacy requests retain their exact saved payload.
5. Add actual React dialog/render tests for the total and request payload. Run financial/settlement/order regressions, lint, build and independent review. Create a checkpoint, merge via GitHub, compile the dependent functions and publish the ready Base44 checkpoint. Verify published code without creating live records.
