# Owner-only pending-sale cancellation · 2026-11-05

Base: `a409f37810a34b13142bc3c750694910b1f4f314`.

## Scope

Add an Uzbek owner-only **Navbatdagi savdolar** dialog in Kassa. It lists this device's retained offline requests, including cashier requests while the owner is signed in. The owner selects one exact receipt, enters a reason and the existing owner approval PIN, and explicitly confirms. The PIN is sent only to the authenticated backend and is never saved in the local queue, journal, or logs. Assumption: “admin code” means the existing owner approval PIN, not the separate admin-panel password.

## Safety

- Reuse `complete-sale` with `cancel_pending_sale`; no competing financial endpoint or entity.
- Require an active stored protected owner (`admin` plus `is_owner`) matching authenticated identity, and existing PIN verification/rate limiting.
- Atomically reserve the existing Shift request key and append a cancellation journal (owner, time, cashier, shop, reason). Checkout and cancellation race for the same key; only one wins.
- Both request-key claims and the new journal are backend-only fields (`rls.write: false`). Publish the schema and backend together; do not enable the UI against an old backend/schema.
- Refuse completed sales, already-claimed/in-flight or ambiguous requests, and closing shifts. Completed sales remain on the existing refund path. Unclaimed offline requests in an already closed shift can be cancelled without rewriting its totals.
- Keep server financial records, inventory movements and totals unchanged. Keep the local request until an exact key/shift/cashier/shop cancellation acknowledgment arrives. Lost responses and failed local removals are recoverable with the same key.
- Queue replay consumes a confirmed cancellation without creating a payment or receipt. Exact matching pending receipt displays are dismissed on direct, replay, and cross-tab cancellation. Other receipts remain unchanged.

## Verification

All tests use in-memory entities/storage and mocked UI, never live Base44 data. Coverage includes owner/admin/cashier permissions, spoofed flags, wrong/rate-limited PIN, completed/uncertain sales, both race outcomes, lost acknowledgments, local storage failures, cross-tab locks, exact ACK binding, repeated clicks, closing/reopening, account switch, and stale receipt/error cleanup.

Final test counts are recorded in the pull request. Initial clean-main comparison: 1,404 tests, 1,296 passed, 108 failed. The feature's full run had the same failure names; no existing test began failing. Repository typecheck has 1,377 baseline errors; this change adds none. Build and lint pass. Existing large-bundle and missing local Base44 configuration warnings remain.

No live sale was cancelled or changed. No Base44 publish/deploy, main-branch merge, PIN change, or credential creation was performed. This is a draft for review; actual Base44 field-permission enforcement still needs authorized staging verification before publication.
