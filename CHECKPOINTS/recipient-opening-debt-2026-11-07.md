# Recipient opening debts (not deployed)

## Scope

This branch adds a one-time, immutable opening-liability entry per CashRecipient.
It does not import live amounts and contains no real recipient balances.
Entry creates neither SupplierReceipt nor stock, cash, bank or shift movements.
Supplier/company recipients are supported without inventing a shop allocation.

- New SupplierOpeningDebt entity: admin read, backend-only mutations. Original
  amount, effective date, actor and request identity remain immutable.
- Existing supplier-ledger gains create_opening_debt/list_opening_debts actions.
- CashRecipient holds only a random opaque creation claim. No monetary payload,
  notes or amount-derived hash is exposed on the staff-readable recipient.
- Qabul qiluvchilar has Uzbek entry and history for admin / Barcha do‘konlar.
  Ambiguous submissions retain their exact intent through close/reopen/refresh.
- Existing Budget payment recovery can allocate opening debt before purchases,
  using explicit opening_debt_id references and the existing durable journals.
  Purchase and opening histories remain distinguishable.

## Deliberate boundaries

No deployment, push, merge, live data import or live mutation testing is performed.
Opening debts are not shown in shop-scoped/cashier debt totals. They are repayable
only by the admin Budget backend; this branch does not add a payment UI. Existing
shift payments remain purchase-only. No opening-debt edits, resets, deletions or
second entries are offered. Corrections require a separately designed audited
workflow, not rewriting historical amounts.

## Deployment and import checklist

Follow README: authorized GitHub sync followed by publishing in Base44 dashboard,
not CLI deploy. The sandbox editor plan restriction does not verify whether git
sync/publish is available. Confirm that route before claiming deployment.

1. Review/authorize the branch and publish. Verify schema changes first, including
   SupplierOpeningDebt and its exact RLS, then supplier-ledger and budget-ledger
   bundles with updated shared recovery code, then frontend. Do not expose the
   feature when its schema/function deployment is incomplete.
2. Verify the published versions and user permissions read-only. No fake live
   receipts/payments are needed for testing.
3. Before importing authorized amounts, reconcile existing opening debts by
   recipient ID and establish the effective date. Import only confirmed amounts
   through create_opening_debt with durable per-recipient request keys. Omitted
   or unknown amounts remain untouched, never silently zeroed.
4. Read back each confirmed immutable original amount and total. Do not claim
   success on a timeout. No import payload is embedded in source control.

## Ambiguous creation recovery

A single conditional recipient claim is saved before one create attempt. A saved
entry can be reconciled using its original key/fingerprint. If the create outcome
is unknown and no record is visible, retries fail closed instead of duplicating
liability. There is deliberately no timeout-based claim theft. Only a definite
rejected create with no saved row releases its exact claim automatically. A truly
stuck claim requires an operator to establish the final result before any repair;
never clear claims or retry unknown writes blindly.

## Verification

Memory-only tests cover permission and scope boundaries, invalid input, one-entry
uniqueness, concurrent submissions, lost replies, fail-closed unknown creation,
immutable original balances, partial/full/mixed payments, compensation and retries.
Rendered JSX tests cover form validation, persisted exact retry, no premature
success, double submission, history and scope. No live backend was used.

Build and lint pass. The focused opening/UI plus existing payment recovery/dialog
suite passes 70/70 tests. Independent review added mixed-target compensation cases
and found no remaining actionable defects. The full pre-feature test baseline has
108 failing tests; the first feature run had exactly the same failing test names,
with all added tests passing. Typecheck matches baseline exactly at 1,466 existing
diagnostics after normalizing shifted line numbers; no new diagnostic was added.
These baseline failures are not described as a clean pass. Final full-suite totals
are recorded in the engineering handoff. Live visual/browser QA was not performed
because the new schemas/functions are intentionally not deployed.


## Follow-up: Kirim va qarzlar integration

The initial implementation deliberately left the Warehouse purchase ledger
unchanged. User feedback identified that this is where the debt balance is
expected. The follow-up adds a single admin/all-shops read-only ledger on that
tab, with opening liabilities separately identified and included once in the
remaining-debt total. They never inflate purchase/receipt amounts or acquire a
fictional shop. Specific-shop and non-admin scopes exclude unallocated balances.
Opening balances carry forward independently of receipt date filters, with that
behavior disclosed in the interface. Read failures must not appear as zero debt.

A backend regression checks complete pagination and disjoint opening-payment
history, without any mutation. UI tests verify the combined summary, scope,
filters, history and failure behavior. Final validation totals are in the handoff.

Follow-up validation: 93 focused tests pass. Full suite: 1,336 tests,
1,228 pass and the same 108 baseline failures (identical failing names).
Lint and build pass. Typecheck remains exactly the same 1,466 baseline
diagnostics. Independent review found no further concrete issues. These are
local mocked/rendered tests, not live deployed-app validation.
