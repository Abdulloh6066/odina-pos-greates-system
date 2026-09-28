# Public entity permission audit — 2026-09-28

Checkpoint before work: 6ab9f1f5967b87c49e884540
Baseline commit: 2e7370de71f994c410c3a6c73209fb33b66c29a9
Permission baseline: checkpoints/public-entity-rls-before-2026-09-28.json

## Scope and outcome

Reviewed all 25 entity names from the user's Base44 scanner screenshots.
All existing live RLS definitions matched the sandbox source before changes.
Anonymous list requests returned zero records for all 25 before changes, so the scanner's claim that all records were public was not reproduced.

Added an explicit app staff-role gate to previously implicit identity/shop access paths: 20 entity read rules and 3 create rules (CustomerOrder, CustomerOrderItem, OrderPayment). The original rules are retained inside AND, so no existing access is widened. Allowed roles are the six existing User schema roles.

Already explicitly role-protected and unchanged: DailyShopReport, StockCount, StockCountItem, SupplierReceipt, SupplierReceiptItem.

All existing staff-role permission decisions are preserved, including shop scope, manager active checks, cashier ownership and non-admin budget restrictions. Schema properties, financial snapshots, update/delete rules, frontend and backend business logic were not changed. No business records were created, modified or deleted.

## Verification

- Five new offline permission tests pass, including old/new decision equivalence across six staff roles, active states, own/foreign/missing shops, user identities and budget payment sources.
- All 25 live schema rules match the intended source after synchronization.
- Post-change unauthenticated list probes: 25/25 return HTTP 200 with empty arrays.
- Post-change unauthenticated direct lookup of existing Shop, Sale, Shift and ProductStock records: 4/4 return HTTP 404; no data exposed. CustomerOrder had no record available for this sampled lookup.
- Selected regression suite: 82 tests, 59 passed, 23 failed.
- All 23 failures reproduced unchanged in an isolated archive of the BEFORE checkpoint: 22 stale test-harness import failures (APP_ROLES not defined) in customer-orders-complete and shift-close-v2, plus one stale POS receipt source-pattern assertion.
- No production-code changes were made to satisfy those pre-existing test failures.
- Build and git diff --check pass.

## Limits and next step

The Base44 dashboard security scanner was not rerun by the agent; no scanner API is exposed here. Rerun it to confirm the displayed warning count reflects current permissions.
Authenticated end-to-end cashier/manager browser workflows were not exercised; authorization preservation was checked offline, plus live schema and anonymous API checks.
Frontend Publish was not run. Entity permission changes synchronize live without Publish.

No business-logic redesign was needed or applied.
