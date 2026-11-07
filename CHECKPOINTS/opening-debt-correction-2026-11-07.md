# Correct an unpaid opening principal without recording a payment

The owner requested correction of one previously supplied opening amount. This
path keeps the original debt_amount immutable and stores a separate corrected
principal with reason, actor, time and request identity. Remaining liability
changes by the correction, without a payment, receipt, inventory or cash entry.

Only active administrators may make a one-time correction, before any payment
or recovery journal evidence exists. A conditional write checks the financial
state and prior correction to prevent a stale correction from overwriting a
concurrent payment. Exact repeated requests reconcile; changed corrections do
not overwrite the audit. Warehouse attribution remains independent.

Opening-debt display, paid totals and payment compensation use the effective
principal (corrected_debt_amount when present, otherwise original debt_amount).
The original reported value and correction remain visible as history. A decrease
must never appear as paid money.

Deploy via GitHub sync and the existing Base44 publication workflow. Verify
schema and affected core supplier/budget function compilations first. Apply only
the owner's explicit correction through the guarded UI, then verify original,
corrected and remaining principal, audit, date, location, and global totals.

Validation: independent review passed. 115 focused tests pass, including
preplanned payment and conditional-write races. Full suite has 1,381 tests,
1,270 passing and the same 111 failures as current main. Typecheck matches
current main exactly at 1,477 existing diagnostics. Lint/build pass. Tests use
mock data only; no live mutation was used as a test.
