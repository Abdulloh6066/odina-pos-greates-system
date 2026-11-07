# Bulk pending cancellation and stale shift recovery — 2026-11-07

Adds an owner-PIN-protected bulk cancellation to the pending-sale dialog. The
confirmation freezes the selected record IDs, shows their count, requires a
reason and PIN, and does not include later arrivals. The server verifies PIN
once per bounded batch, then checks ownership, existing sales and the checkout
claim fence for every request. Completed receipts are reconciled rather than
deleted; in-flight or rejected decisions remain in the queue. Uncommitted
requests receive the existing durable cancellation journal and device archive.
Partial successes survive a later batch/network/storage failure so acknowledged
receipts still reconcile their inventory and shift reservations.

Investigation found a reproducible cache recovery gap: the queue treated a 409
closed-shift rejection as a failed receipt but never refreshed the till's cached
shift. It now calls POS's existing generation/mutation-guarded current-shift
reader once per drain. Old receipts keep their original shift IDs and are never
silently moved to a different shift. A late read cannot overwrite a newer sale,
shift close or newly opened shift. Direct checkout uses the same guarded reader
after this rejection. Backend also returns the machine-readable error code
SALE_SHIFT_NOT_OPEN while preserving its legacy error text.

Production logs before 10:26 showed requests stopping after user/sale-key/shift
reads, before product pricing. They did not retain enough information to prove
the original 75,000/65,000 rejection. The cache failure was independently
reproduced and corrected; do not describe this as proof of that earlier cause.

Validation: 99 targeted offline tests passed, including actual queue hook/UI,
bulk wrong PIN, closed-shift financial immutability, committed/in-flight guards,
selection snapshots, partial acknowledgements and late shift read protection.
Application build/lint passed. No live queued sale was retried, edited, cancelled
or deleted by the coding agent. The owner will use the PIN confirmation himself.
