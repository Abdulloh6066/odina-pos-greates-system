# Kassa opening-debt repayments

Base: main f171f5ab2a09671219674b864378ae29e975e6cb (Budget expense categories retained).

## Behavior
- Kassa → Pul berish → Tovarlarga pul includes suppliers with outstanding opening liabilities for admin, manager and cashier.
- Both stores pay the same shared debt balance. Opening debt location remains attribution; no debt is copied or moved.
- Only the paying shift loses cash and gains cash_removed. Budget balance, purchase receipts and inventory are not changed by an opening-only Kassa payment.
- Existing cashier owner-PIN and shift ownership/shop controls are unchanged. No new authorization setting was introduced.
- New supplier payments allocate opening liabilities first, then eligible purchase receipts, matching the established Budget order. Saved retry plans/fingerprints remain unchanged.
- Picker totals, new allocation plans and remaining-balance replies share the same payable-debt reader. Cancelled rows are excluded; debts page past 500.
- Existing conditional debt/source journals, immutable payment snapshots, compensation and ambiguous-result recovery remain in use. New opening allocations also freeze supplier/location metadata.
- Owner opening-debt history includes Budget and Kassa payments, labeled by payment source and paying store.
- Supplier data refreshes every time Pul berish opens; late earlier reads cannot overwrite a newer refresh.

## Verification
- 219/219 focused offline tests pass: all opening-debt, Budget supplier and supplier-product suites.
- Actual CashWithdrawalDialog render tested with opening-only suppliers, cash/debt limits and cashier PIN.
- Both stores, concurrent Budget/Kassa and two-Kassa payments, same-key replay, changed-key scope, lost replies, ambiguous writes and compensating failures tested using in-memory fixtures only.
- npm run lint: pass.
- npm run build: pass (existing large-chunk warning).
- npm run typecheck: 1,494 diagnostics, exactly the same file/message multiset as untouched main; zero new diagnostics.
- Full aggregate run: 1,509 tests, 1,398 passed, 111 failed; unchanged baseline has 1,476 tests, 1,365 passed, the exact same 111 failed tests.
- Independent read-only payment-safety review found no blocker.

No schema migration, production data mutation or real payment was performed during implementation and tests. Deployment must use the repository's Git-sync/Builder workflow and include changed shared modules and supplier-ledger function. Read-only authenticated runtime verification is still required after publication.
