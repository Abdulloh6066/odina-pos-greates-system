# POS catalogue responsiveness — 2026-11-07

Owner-approved scope: prepare/reuse product prices and category order, and keep
category/search state inside the catalogue so browsing does not redraw the cart.
The image download button is deferred to a separate, later change.

`PosCatalog` retains the existing desktop/mobile markup and ProductGrid. Shop
prices are prepared when products or shop change; ordered category/favorite
views are prepared when catalogue or shop order changes. Search still precedes
variant placement, preserving results when a variant's target is excluded.
The existing cake price sort, partial custom order and shop category overrides
keep their precedence. Product references stay stable across browsing views.

POS still owns cart, sale submission, prices used in saved carts, inventory
reservations, payment locks and server reconciliation. Stock and lock changes
flow into the catalogue as props. Its ref exposes UI reset and the current
category for the existing product-order editor. Image/preload logic is unchanged.

Validation: 76 focused offline checks passed (actual POS/catalogue components,
selection semantics, product-order validation, offline sales, immutable checkout
requests and discounts); full lint and production build passed. An additional
comparison executed the actual previous POS filter from commit 40c7dfb against
3,024 selections covering 12/75/180 products, 3 shop scopes, grouped categories,
favorites, custom order, variants and search: all results matched exactly.
The actual POS regression first failed because a category change redrew the
cart (16 renders versus 15 before the click), and now passes with no added cart
render; unchanged retained product cards also skip rendering.

Broader existing suites had baseline failures before edits (26/50 in
pos-performance/global-shop-operations/product-order combined, mostly stale
fixtures/imports and older checkout timing expectations). These were not used
as passing evidence. Current device latency is not measured by render counts;
the owner will assess the interaction on the cashier machine after deployment.
No live sales, shifts, stock movements, payments or orders were created or changed.
