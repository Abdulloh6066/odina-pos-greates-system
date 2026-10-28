# Buyurtmalar compact layout — 2026-10-29

Approved reference: compact order ledger with no large page heading or dashboard summary strip.

## Change
- Move the existing Yangi buyurtma action beside the date tabs.
- Present real CustomerOrder snapshots as compact rows: reference image/number/type, customer, handover, payment, status and action menu.
- Keep details, repeat, search, shop/type/status/payment filters, date selection, alerts, retry states and load-more history.
- Use the existing date filter with the shared Uzbek calendar component.
- Stack rows and toolbar controls at phone widths; retain the existing logo, sidebar, store scope and typography.
- No backend, entity schema, permission or live-record changes.

## Preservation
The Orders.jsx source before its return statement is byte-identical to the pre-change version: all queries, effects, financial/action handlers, request guards and sorting/filter logic are unchanged. Existing OrderForm, OrderDetail, payment/completion dialogs and staff ticket components are untouched.

## Verification
- npm run build: passed.
- npm run lint: passed.
- node --test tests/orders-compact-layout.test.mjs tests/global-shop-sections.test.mjs tests/order-dialog-retry.test.mjs tests/history-pagination-audit.test.mjs src/tests/order-alerts.test.mjs: 53 passed, 0 failed.
- Browser: existing Orders preview, 1440px desktop and 390px phone; date picker selects 2026-10-29 and Ro‘yxat clears it through the existing setter.
- Current selected Branch has no orders; populated row behavior is verified with offline snapshot fixtures. No test orders/payments created.
- Frontend saved to Base44 preview; publishing remains a separate editor action.
