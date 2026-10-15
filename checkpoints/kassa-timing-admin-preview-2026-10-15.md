# Owner/admin-only Kassa timing — preview only

Branch: audit-fixes (6ad0056bafaa7b155eadb265)
Starting commit: dfcac5d700d1bc0432583ea3130b68236713d56a

CheckoutTimingStatus now receives the authenticated current user's role from POS and renders only for the exact existing admin role used by the owner/admin interface. Cashiers, managers, staff, regular users and unknown roles receive no seconds, placeholder, pending label, timestamp or persistence warning. This changes display only; existing local timing capture, retention, checkout requests and financial behavior are unchanged. Browser diagnostics are not a substitute for backend access controls, and no permissions or backend/entity data were changed.

45 offline timing/checkout/recovery tests passed with network disabled, including actual POS prop wiring, all role/pending/placeholder/saved combinations, persistence after remount and unchanged request/clock counts. Remote build and lint passed. Independent local review found no actionable issues. No app sale, payment, shift or stock record was created or changed for testing. Nothing published or merged.

During the user's missing-timing report, browser DOM inspection identified the visible static preview pinned to commit 5e98a422614ae5df7b7952d2363c6058e702d876, which predates timing persistence. The hidden sandbox preview carried the newer code. Older static-version checkout metrics were in-memory only and cannot be reconstructed after navigating away. After this checkpoint, refresh the visible editor preview to the latest branch commit and verify its commit parameter before reporting runtime verification.
