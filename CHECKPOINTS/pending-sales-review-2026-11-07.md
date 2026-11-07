# Pending POS sale review — 2026-11-07

The queue banner now opens a per-sale review dialog, including the full retained
server error, original device receipt, payment amounts, and current server prices.
Staff can inspect and retry one request without a PIN. Editing the final total or
cancelling an uncommitted request requires the existing owner PIN, verified on the
server with the existing rate limit and audit trail.

The Shift journal atomically fences the original checkout key and stores its
resolution. Edits create one server-approved replacement request, preserving the
original product prices, products, payment methods and recorded time. The device
archives the original and adds the replacement in one IndexedDB transaction. Lost
replies can be recovered through inspection; late sender errors cannot resurrect
archived rows, including browsers without Web Locks. PINs are never persisted.

Completed or in-flight server sales cannot be edited or cancelled from this view.
Closed-shift pending records remain inspectable and can be PIN-cancelled if they
were never committed. Editing/reposting into a closed shift is blocked because it
would change settled financial history. No shift is reopened or reassigned.

Validation: 91 targeted offline regression tests passed, including 75000 less
10000 = 65000, retry idempotency, PIN failures, shop/staff isolation, closed shifts,
claim races, lost replies, legacy payment methods and the actual React dialog.
Full application lint and production build passed. The dialog was visually checked
at desktop and 390px width using mocked data only. No live transactions or records
were created, edited, retried or cancelled for testing.

Rollback: revert the feature commit. Original cancelled/edited request keys must
remain fenced when processing existing Shift resolution journals; do not remove
the cancellation guard while such records can still be replayed by old devices.
