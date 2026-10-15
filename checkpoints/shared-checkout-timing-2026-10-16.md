# Shared checkout timing

Owner/admin-only cross-device checkout duration history. Workers report their own checkout diagnostics asynchronously through checkout-timing; only admins can list history. CheckoutTiming is a separate append-only diagnostic entity. Existing sales, payments, shifts, inventory and historical snapshots are unchanged.

The timer measures browser elapsed time for the Yakunlash action. API round-trip duration is labelled separately. Confirmed/rechecked outcomes require the server's original completion marker and matching worker/shift/shop; queued and unconfirmed attempts remain distinct. Durable per-user diagnostic uploads retry the same immutable event after a lost reply. Corrupt rows are quarantined without blocking healthy reports. Diagnostics never await or retry financial completion.

Validation: 873 offline tests passed, including backend role/ownership checks, failure/retry paths, immutable financial snapshots, outbox storage/reload/user-switch handling, admin UI request cancellation, and POS nonblocking reporting. Final history remount check: 16/16 passed. Remote build and lint passed. Read-only preview smoke confirmed the admin history returns its empty state successfully after registering the new schema. No fake sales or diagnostic rows were created, no existing live data was modified, and older browser-only timings were not backfilled.

Final merge verification: updated audit-fixes from current Main, retaining delivery/conditional packaging and receipt reprint behavior alongside the audit fixes. The preservation test explicitly allows only Main's optional open-order delivery flag and still compares every original field, required list, and permission. Removed the merge assistant's temporary probe module. Independent final review found no blockers. Remote final suite: 893 passed, 0 failed, with global fetch disabled. Final merged build and lint passed. No migration scripts or live business tests were run.

Preview branch: audit-fixes. User explicitly authorized publishing after checks. Admin path: Kassa → Xodimlar vaqti. Future normal checkouts from refreshed clients populate this history.
