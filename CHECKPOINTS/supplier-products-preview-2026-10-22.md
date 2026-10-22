# Supplier products — preview only (2026-10-22)

Request: selecting a supplier shows only its assigned active ingredients/packaging; admin controls each supplier's list. No publish or business-record changes.

- Reused CashRecipient with optional supplied_ingredient_ids (no default/backfill). Existing RLS retained: only admin can write assignments.
- Shared searchable admin assignment dialog opens from Qabul qiluvchilar cards and supplier purchase receiving. Full paginated ingredient catalog; inactive/missing saved IDs are retained unless explicitly removed. Save updates only supplied_ingredient_ids.
- New receipt editor reloads persisted supplier settings, fails closed on unset/empty lists or load errors, intersects location/active ingredient eligibility, and clears unsaved amounts when changing supplier or saving a mapping.
- Ertaga kerak purchase receiving narrows editable rows by supplier; full requisition, transfer flow, completed history and exact pending retry payloads remain intact.
- Both purchase backends validate configured assignments before any new claim/write. Rollout compatibility: suppliers whose field is absent keep their existing backend behavior so preview resource autosync does not disrupt the published app. Preview UI requires an explicit assignment; [] is authoritative and rejects all new purchase items. Pending/completed reconciliation uses its saved snapshot.
- No suppliers were assigned automatically. No entity records, prices, stock, debts, receipts, sales or historical snapshots were changed for testing. No publish command/action executed.

Validation: npm run build and npm run lint passed. 83 memory-only tests passed: 37 supplier assignment/settings/receiving tests, 39 Budget/supplier recovery tests, 7 existing financial-dialog tests. Diff whitespace check passed. Actual admin preview opened read-only; mapping persistence and receiving writes verified only against memory doubles.

Files: base44/entities/CashRecipient.jsonc; base44/functions/supplier-ledger/entry.ts; base44/shared/ingredient-requests.ts; src/components/warehouse/SupplierProductsDialog.jsx; src/components/warehouse/SupplierLedgerPanel.jsx; src/components/warehouse/IngredientRequisitionsPanel.jsx; src/pages/CashRecipients.jsx; tests/supplier-products-{backend,settings,ui}.test.mjs; tests/budget-supplier-dialog-retry.test.mjs (new dialog dependency double only); this note.
