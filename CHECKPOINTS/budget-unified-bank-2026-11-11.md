# One Bank account in Budget

The owner approved combining existing card funds and all future Humo/Uzcard receipts with Bank. Budget now shows and spends `bank + uzcard + humo` once. Existing balances and historical records are preserved, including settlement and sale payment methods. Cash, Online, total Budget, role checks, PIN and shop filtering retain their behavior.

New Bank requests use `bank_all` internally. Deposits enter the Bank balance; withdrawals and debt payments use a frozen, server-validated allocation across existing accounts, one financial request and one Bank history row. Existing frozen requests retain their original account/key. A backing update and its marker share a conditional write. Compensation fences even a delayed unapplied debit. A hash in the existing Settings request guard binds the physical parent journal before any backing write, including recovery. No global Bank lock or data migration.

Pooled history records the exact amount without misleading running-balance snapshots across independently updated accounts. The existing snapshot fields are optional; old snapshots and their source labels remain visible. Sync and verify this compatible schema update before enabling the new Budget handler.

Verification: 167 focused offline tests passed, including 24 new wallet tests, both shift settlement routes, expense categories, Kassa opening debt, and old pending requests. The late-write, missing/replaced journal, and schema-validation regressions failed before their fixes. Final independent review approved; lint, Vite build and local backend bundle compilation passed. No live payments, shifts, balances or other records were changed for testing. No AI/builder credits used.
