# Odina audit fixes — preview only

App: Odina POS (6a96eb22a9fd2b34081eb2dd)
Preview branch: audit-fixes (6ad0056bafaa7b155eadb265)
Starting commit: 41d367a0081a52359b48c6ec31a99bb73ea338b1

The user authorized all ten audit fixes, preserving existing working flows, roles, historical snapshots and live data, and explicitly requested preview without publication. No live business records were created, updated, deleted, reset or migrated. No publish or merge was performed. Existing resource names, function configurations and workflows remain unchanged.

| Audit item | Result |
| --- | --- |
| 1. Direct staff writes bypass order validation | Permission candidate denies direct creates on CustomerOrder, CustomerOrderItem and OrderPayment; service-role backend remains the validated creation path. Tested and staged in audit-permissions-pending-2026-10-15.json. **Not activated:** existing Base44 permission changes affect live access immediately, including on branches. Current schema RLS is deliberately identical to Main. |
| 2. Lost shift-close reply reverses a completed settlement | Stable settlement markers, claimed-shift reread, conditional finalization and confirmed-closure replay preserve saved Budget and closed snapshots. Partial or unconfirmable writes retain evidence and require owner review; no blanket financial rollback/reopen. Pending order/supplier payment journals block closing and participate in its atomic claim. |
| 3. Order/payment dialogs allocate new retry keys | Frozen actor-scoped request payloads and keys survive refresh/remount. PINs are excluded from stored intents. Same request replays; started requests are never silently replaced. |
| 4. Order-payment ledger exists but order/shift are incomplete | Persistent claims/fingerprints reconcile ledger, order and pinned original shift exactly once. Order-payment shift reservation prevents closing between ledger and totals. Creation advances are pinned to their original shift. |
| 5. Budget/supplier actions lack retry protection | Persistent source journals and request claims cover Budget adjustments and supplier payments from Budget or shift cash. Existing account creation is serialized with the existing singleton Settings. |
| 6. Supplier rollback overwrites concurrent cash/debt | Additive, once-only compensation preserves other operations. Interrupted multi-receipt compensation resumes its reversal phase. Audit failures do not undo saved payments. Closing/closed shift monetary snapshots are never rewritten. |
| 7. Failed transfer receipt can double stock | Atomic stock deltas and applied/reversed markers retain movement evidence and concurrent sales. Unknown recovery stays locked for review. Empty-stock races detect duplicates rather than deleting evidence. |
| 8. Inactive users can call old endpoints | Availability, profit report and discount validation resolve the stored active user before accepting the existing role. |
| 9. History hides old rows behind fixed limits | Server-side filters and 100-row load-more pages replace capped subsets. Unfinished order alerts and per-shift details load independently through complete pagination. Stale/debounced responses cannot overwrite a newer search. Numeric order sequence searches use the permanent exact sequence. |
| 10. Legacy suite fails from missing VM dependencies/assertions | Harnesses now load real modules with in-memory services and preserve behavior assertions. Permission tests compare the current immutable schema baseline, preserve all existing fields and required definitions, and test the staged permission overlay separately. |

Validation:
- Local final main suite: 779 passed, 0 failed.
- Isolated sandbox full suite, including src/tests: 842 passed, 0 failed, 0 skipped.
- Build passed.
- Lint passed.
- Tests use mocked records; fetch is disabled by an isolated runner guard. No production endpoints were invoked to make business records.
- Additional tests cover lost claim/credit/ledger/finalization replies, interrupted compensation, concurrent sale/cash changes, pending payment versus close races, original-shift advance attribution, auxiliary read failures, ticket-cycle compatibility, history races and real dialog/rendered report behavior.

Operational limits:
- A genuinely unconfirmable financial write is held for owner review rather than repeated or erased. A pending supplier payment started on an old shift is visibly directed to owner review in the POS.
- Historic discrepancies are not automatically corrected and no existing records are migrated.
- The permission candidate must be activated separately with explicit authorization because it changes live access immediately. Documentation: https://docs.base44.com/Building-your-app/working-with-branches and https://docs.base44.com/Setting-up-your-app/Managing-security-settings.
- Preview reads the existing shared data environment. Do not create fake orders, shifts, payments, transfers or movements while reviewing.

The checkpoint is the restorable, unpublished preview candidate. Keep Main/published release unchanged until the user authorizes release.
