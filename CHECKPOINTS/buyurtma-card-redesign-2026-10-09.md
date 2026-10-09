# Buyurtma Card Redesign Checkpoint — 2026-10-09

## Before State
- `OrderLedgerCard.jsx`: compact card with date/time + status at top, reference image (if any), customer/phone, type/fulfilment tags, bottom total + balance
- `orders-premium-ledger.css`: `.opl-order-*` classes for the ledger card layout
- No publish triggered

## Planned Change
- Redesign order card to match mockup: structured header with order number + badges, icon-based meta grid, clickable reference image, price summary footer
- Only UI/UX changes to `OrderLedgerCard.jsx` and `orders-premium-ledger.css`
- No business logic changes
- No publish

## Files Touched
- `src/components/orders/OrderLedgerCard.jsx`
- `src/styles/orders-premium-ledger.css