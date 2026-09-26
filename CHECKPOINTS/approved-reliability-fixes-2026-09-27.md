# Approved Odina reliability fixes — 2026-09-27

## Scope and restore point

User approved audit items 1, 4, 5, 7, 10, 11, 12. Preserve cashier speed, manual price reductions, product/category data and current UI conventions. Prepared-drink ingredient wiring (8), broad permission cleanup (9), stock-count labels (13), and unrelated history-page pagination were not part of this change.

Pre-change Base44 checkpoint: `6ab82507b1640c4f1afd2609`.
Name: `Before approved reliability fixes 1-4-5-7-10-11-12 — 2026-09-27`.
Git commit: `70e3b35a5db142223945f27128b50b9c3ee4f3d0`.

Separate concurrent edits to product favorites, receipt logos/wording, table pre-checks, and shift-print behavior were observed and preserved. Do not blindly restore the entire old tree over those edits; compare and restore the relevant changes selectively.

## Implemented

1. Cash withdrawals: atomic shift debit and operation-key claim, duplicate request protection, confirmed-ledger replay, safe compensation for a definite rejected ledger write, explicit owner-review state for uncertain outcomes. A failed audit write cannot invalidate a saved withdrawal. POS freezes the request key/payload during uncertain retries. This request ref is not a durable cross-reload transaction journal.
4. Refund reporting: original sale remains positive on its sale day; completed refund activity is negative on its refund day, with the saved original cost reversed. Same-day full refunds net to zero.
5. Report cash flow: customer-order advances and balances are shown on payment day, separately from POS sale profit; no second full-order amount is added at handover. Both other-expense category aliases are recognized. Unknown/estimated cost is labelled. Daily reports, profit report, overview totals and private Telegram report share the dated activity calculation.
7. Production staff: action-specific authorization allows ready/shipped for a valid assigned production location, not order creation/payment/financial completion.
10. Offline queue: permanent rejected independent sales remain visible for review while following valid sales can sync; connection/session errors pause the queue with bounded backoff. Manual retry can revisit rejected rows. Empty queues do not poll. A finalization marker is written in the existing final shift-total update, so retries cannot discard a version-3 sale before financial writes finish. Normal checkout has no extra API call; legacy version-2 receipts remain unchanged. This is not a redesign of every possible partial-transaction failure in the older checkout.
11. Receipt printing: bounded wait for closed modal layers, afterprint/media/focus/input recovery, timers/listeners cleanup, nonblocking warning and reprint from saved history. Never repeats the financial transaction or globally releases another modal's pointer lock.
12. Export delivery: per-destination status/fingerprints, date/shop keyed Sheets row updates instead of blind appends, delivery lease to prevent overlapping sends, actual confirmation required for sent_at, explicit review for uncertain email replies. The 00:xx runs target the preceding Uzbekistan business date. Open/closing shifts block premature target-day export; a new next-day shift does not block the previous closed day.

## Offline verification

Final full-suite run at this checkpoint preparation:
`node --test --test-reporter=spec tests/*.test.mjs src/tests/*.test.mjs`
Result: **410 tests, 410 passed, 0 failed, 0 skipped**.

`npm run lint`: passed.
`npm run build`: passed.
TypeScript parser scan: 277 source/test files parsed, zero syntax errors.
All 55 entity JSON schema files parsed successfully.

Tests include overlapping/duplicate withdrawals, insufficient cash, definite rejection compensation preserving concurrent changes, lost write replies, same/later-day refunds, deposits on different days, paginated totals, unknown gram costs, bad offline record isolation, session/backoff behavior, missing printer events, properly scoped production roles, duplicate/partial export delivery and midnight dates. Existing discounts, table workflows, shift closing and customer-order tests also pass.

All transaction/stock/email/Sheets/Telegram testing used in-memory mocks. No real sale, order, payment, shift, stock adjustment or test delivery was created, changed, or deleted by this task. No historical financial records were migrated. New optional report/config schema fields were confirmed through the schema read tool with existing required fields and role rules preserved.

## Performance observations

Removed the report screen's initial duplicate fetch and separate latest-1,000-sale download; report charts share one result. Date edits are debounced, stale responses ignored, ingredient cost fallback loads only when needed, and an empty offline queue does not poll. Normal checkout save-request count remains unchanged.

Measured production-build JS downloads before the final rebuild: main chunk approximately 832 KB (361 KB gzip); report/chart chunk approximately 458 KB (121 KB gzip). These are source/build observations, not measurements of the user's real internet connection, iPad FPS, or cashier latency. Repeated cost/recipe reads during checkout and image delivery remain candidates for a separate measured performance task.

## Publication status and operating notes

Code edits were saved/auto-committed through Base44. Live schema reads show the optional report/config fields. **The published frontend and backend release were not verified.** The browser release check redirected to Base44 login, and the CLI whoami check also requested login. No Publish action or CLI deployment was performed by this task. Follow the repository README: publish through the logged-in Base44 dashboard, not a broad CLI deployment that bypasses source sync.

Before refreshing a cashier device, finish its current checkout and ensure pending offline sales are synchronized. Never clear browser data to resolve an offline queue warning. If money status is uncertain, inspect saved history and the operation reference; do not charge or pay again blindly. Print testing covered browser simulations, not an actual receipt printer: reprint a saved receipt after release without creating a new sale.

Existing stored/exported reports and old duplicate spreadsheet rows were not bulk-rewritten. A manual send can recompute a selected derived report; ambiguous existing duplicate Sheets rows stop for review instead of being deleted. Uncertain email outcomes require checking the inbox before an explicit resend. Configured automatic export runs remain 23:00–00:45 every 15 minutes; this change does not schedule retries after that window. Report source limits fail explicitly rather than showing incomplete totals. Custom-order cash receipts are included, but full custom-order profit accounting is not newly implemented.
