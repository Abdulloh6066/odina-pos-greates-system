# Checkpoint — In-app order deadline & payment alerts

**Date:** 2026-09-11
**Scope:** Add clear in-app order alerts to the existing Orders and Production screens.

## What changed
- `src/lib/order-alerts.js` (NEW): pure, self-contained logic for order deadline + payment alerts.
  - Active/unfulfilled statuses only: `qabul_qilindi`, `tayyorlanmoqda`, `tayyor`.
  - Excludes cancelled (`bekor_qilindi`), delivered (`yuborildi_olib_ketildi`), completed (`yakunlandi`).
  - `deadlineState`: `overdue` (Kechikdi) when handover passed; `due_soon` (1 soatdan kam qoldi) when within next 60 min.
  - `hasUnpaidBalance`: `remaining_balance > 0` and `payment_status !== 'paid'` (Qolgan to'lov).
  - Handover instant interpreted in Asia/Tashkent (UTC+5, no DST) via `Date.UTC - 5h`.
  - Sort: overdue first, then upcoming deadlines (soonest), then unpaid-only.
- `src/hooks/useOrderAlerts.js` (NEW): recomputes alerts on the already-loaded (RLS-scoped) orders every 30s. No extra API calls; permissions preserved.
- `src/components/orders/OrderAlertSummary.jsx` (NEW): compact summary with counts (Kechikdi / 1 soatdan kam / Qolgan to'lov) + clickable rows that open existing order details. Read-only — never mutates status/payments/stock.
- `src/pages/Orders.jsx`: renders `OrderAlertSummary` above the order list; alert click opens existing `OrderDetail`.
- `src/pages/ProductionScreen.jsx`: renders `OrderAlertSummary` at top of main content; reuses existing `OrderDetail` for alert clicks (onPaid → reload; onRepeat → close, role-gated by existing logic).
- `src/tests/order-alerts.test.mjs` (NEW): offline regression tests for the pure logic.

## What was NOT changed
- No new entities, backend functions, pages, or duplicate implementations.
- No order status, payment, or stock mutations added (alerts are read-only).
- No Telegram integration.
- Existing Orders / ProductionScreen / OrderDetail logic untouched.
- Existing roles/permissions/RLS untouched — alerts use the same RLS-scoped order lists each page already fetches.

## Verification
- `node --check` on `order-alerts.js`, `useOrderAlerts.js`, `order-alerts.test.mjs` → OK.
- `npm run build` → passed (no errors).
- `npm run lint` → passed (no warnings).
- Offline tests written (`order-alerts.test.mjs`); run with `node --test src/tests/order-alerts.test.mjs`.

## Rollback
Delete the four new files and revert the two integrations (remove `OrderAlertSummary` render + `useOrderAlerts` usage from `Orders.jsx` and `ProductionScreen.jsx`, and the `OrderDetail` instance added to `ProductionScreen.jsx`).