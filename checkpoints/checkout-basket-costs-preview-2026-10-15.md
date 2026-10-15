# Basket ingredient costs and faster saving — preview only

Date: 15 October 2026 (Asia/Tashkent).
App: Odina POS (6a96eb22a9fd2b34081eb2dd).
Branch: audit-fixes (6ad0056bafaa7b155eadb265).
Starting commit: dfcac5d.
Preview: https://app.base44.com/apps/6a96eb22a9fd2b34081eb2dd/editor/preview?branch=audit-fixes

Checkout resolves the existing verified basket recipes, then loads supplier receipt items only for those ingredient IDs and the parent receipts needed to exclude cancelled/cancelling purchases. Optional burger fries include their server-defined ingredient. An empty/no-recipe basket makes no supplier requests. Selected fields reduce payload size. Matching receipt items page by unique ID rather than silently truncating an average. Reports retain the existing unscoped loader; no shared price/stock cache is introduced.

The weighted-average formula and unit conversions are unchanged. The scoped checkout path can include older valid purchases that the former global 500-receipt/1000-line limits excluded. Future checkout estimates can therefore become more complete; existing stored sale cost snapshots are never rewritten. Failed or malformed optional cost reads retain the existing explicit estimate fallback. More than 100,000 matching purchase lines also use that fallback rather than a falsely exact truncated average.

Branch ingredient deductions now run in batches of at most four independent ingredient chains. Each chain still conditionally updates its stock before writing its movement. Every started sibling settles before a failure reaches compensation, so late successful writes remain in the caller's recovery journals. Required stock checks, shop/role isolation, idempotency claims, financial confirmation and historical snapshots retain their existing behavior. Central retains its existing product-stock deduction behavior.

Validation:
- Build passed; lint passed.
- Full offline suite: 883 passed, 0 failed/cancelled/skipped, including cost math, optional fries, ingredient deductions, timeout recovery, financial confirmation and existing preview features.
- First full run found an obsolete concurrency test expecting broad purchase reads before recipe IDs were known. It was updated to verify that scoped purchase reads wait for basket ingredients and all financial writes wait for costing; final full run passed.
- Fetch/http/https/net/tls networking blocked by an external /tmp runner guard; SDK entities are in-memory fixtures.
- Post-change repeated exercise: 30 checkouts per store (10 each: no recipe, milk+coffee, six ingredients), plus 30 idempotent replays per store. All 60 checkouts and 60 replays passed. The same 60+60 exercise was run before the changes.
- With 900 unrelated purchase lines, a milk+coffee basket read 2 purchase lines + 2 parent receipts instead of 902 lines + 3 receipts. Six ingredients read 6 lines + 6 receipts instead of 906 lines + 7 receipts.
- Additional tests hold and fail concurrent ingredient writes, verify no early financial confirmation/compensation, restore balances after failure, replay safely, check pagination over 1000 lines/500 parents, reject malformed pages, exclude cancelled purchases, preserve earlier sale snapshots and refresh later costs.
- Main's complete-sale/entry.ts, cost-engine.ts and sale-ingredient-flow.ts were reread and are byte-for-byte unchanged from this task's starting Main reads.
- No publish, merge, schema/permission change or live business-data mutation.

Timing limit:
Offline benchmark clocks measure only the in-memory handler, excluding real Base44 database and browser/network delays. They are not real saving times and must not be reported as such. For reference only, post-change milk+coffee handler means were 11.15 ms Central / 9.03 ms Branch; six-ingredient means 9.70 / 8.76 ms. The benchmark is noisy and does not measure the real benefit of overlapping database writes. Kassa's existing scoped browser-local timer can measure future confirmed preview checkouts. Current real server seconds have not yet been established.
