# Allocate existing opening debts to a warehouse

The owner clarified that existing opening liabilities belong to the production
warehouse. Previously these balances were intentionally unallocated and visible
only to the owner in the all-shops view.

This correction adds an audited, one-time location assignment to the existing
records. It preserves their IDs, original amounts, remaining amounts, effective
dates, request fingerprints, payment history and creation claims. No new debt,
purchase, stock or cash record is created. Existing staff access is unchanged.

The owner can assign a previously unallocated balance to an active location
already linked to its recipient. Conditional writes and reconciliation protect
against concurrent assignment and lost responses. Once assigned, another
location cannot replace it through this action.

The owner ledger includes allocated balances in their matching location and once
in the all-shops total. Unallocated balances remain all-shops only. Date filters
continue to apply only to purchase receipts, not carried opening balances.

Deployment uses the existing GitHub sync and Base44 publish workflow. Verify
schema additions and supplier-ledger compilation before publishing. Assign only
the specifically authorized existing records through the guarded owner UI, then
read back record IDs, location and immutable monetary/date fields. Never embed
real recipient amounts or private records in source control.
