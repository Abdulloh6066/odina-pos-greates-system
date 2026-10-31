# Mahsulotlar: list sales to Odina branches and outside shops

- Added /wholesale-products, independent of retail POS and existing 3D + and Warehouse screens.
- Admin and production roles only; production staff restricted server-side to their assigned production source and own sales.
- Reuses Product.sheet_price. No piece-price fallback, no live product price changes. Sheet quantities in 0.5 increments.
- Single-product draft/confirm flow freezes price, conversion, customer, quantity and payment method server-side. Preparing a quote does not change stock or record a completed sale.
- WholesaleSale is a separate private journal (admin or seller reads, admin writes); backend validates all staff operations.
- Exactly-once source deduction uses ProductStock.wholesale_applied atomic markers and a durable per-sale lease longer than request lifetime. Uncertain writes retain the lease and resume the same record, not a new sale.
- Branch sales reuse pending StockTransfer and the existing destination receipt flow; external sales never create an internal shop or transfer.
- Cash/bank-transfer recording only. No online payment capture, no automatic retail Sale/Shift/Budget entries, no wholesale entries silently mixed into existing retail financial reports. The page explicitly explains the separate journal.
- No live sales, transfers, payments, shifts, or stock mutations performed during development. Endpoint setup/catalog were read-only. Business mutations covered using in-memory, network-disabled tests.
- Build and lint passed. Wholesale validation, retry/concurrency and offline restart tests passed before checkpoint; final regression includes branch receipt flow.