# Offline Kassa restart — 2026-10-29

## Implemented
- Build-generated, versioned service worker precaches JavaScript (including lazy POS dependencies), CSS and a POS navigation shell. Root/POS navigation falls back to that shell on connection failure. Updates wait for old clients to close, never force-reload a checkout.
- Only public image requests are cached opportunistically, bounded to 600 entries. API responses, POST requests, private media and financial mutations are never service-worker cached.
- A successfully verified staff profile provides local-only POS continuity for up to 24 hours, bound to app and the existing browser token fingerprint where available. Cookie-only browser sessions retain the same local continuity policy. This never issues credentials or grants server authentication; the original Base44 auth and backend permissions still govern all server operations.
- Transport-only fallback for staff/profile, shop catalog and active shift. Explicit server denials never fall back to cached access. Reconnect/focus revalidates an offline staff session.
- User/role/shop-scoped catalog and shift snapshots restore the register after reload; private shop journals and unpaid customer orders are excluded. Closing a shift invalidates its snapshot. Both logout paths clear restart snapshots without touching pending sales.
- Existing durable IndexedDB sales queue, original request keys, cross-tab locking, retry/backoff and acknowledgment rules preserved.
- Offline availability shown in Uzbek. Admin shop selection can recover from scoped catalog storage. Product ordering is retained locally.
- Extracted existing offline queue banner to keep changes within editor size limits; no financial flow redesign.

## Boundaries
Open the updated hosted Kassa online first, with an open shift, and wait for the readiness message. Use the same browser and origin; browser data clearing/eviction removes local preparation. Offline restart is not first-time login. Ordinary, non-discounted counter sales can be recorded locally and synchronized later. Opening/closing shifts, table/unpaid order operations, discounts, transfers, reports and external card/online processing still require connectivity. No unfinished-cart recovery was added.

## Verification
- Production build and lint passed.
- 65 memory/offline checks passed, including staff restoration, first-use block, network-only fallback, token/app scope, expiry, revocation on reconnect, shift invalidation, cache scope, emitted service worker, no API interception, and existing queue/idempotency regressions.
- No live records were created, edited or deleted for verification.
- Actual hosted-browser restart with networking disabled has not been exercised; use Testing Agent for browser acceptance verification. Publication is not performed by this change.