# Remember Kassa Yakunlash seconds — preview only

Branch: audit-fixes (6ad0056bafaa7b155eadb265)
Starting commit: 5e98a422614ae5df7b7952d2363c6058e702d876

The existing Kassa timing status now remembers its last measured attempt in browser localStorage, so closing/reopening Kassa or refreshing the same browser restores the seconds and result for the exact same cashier, shop and shift. It also shows the attempt finish timestamp using the existing Asia/Tashkent formatter. The timestamp is recorded after measuring the final attempt; it is informational and does not modify the sale's historical timestamp.

Storage retains a single latest metric per user: schema version, user/shop/shift identifiers, elapsed milliseconds, existing outcome and finish timestamp. No sale items, amounts, payments, request keys, PINs or authentication data are stored by this feature. Invalid, malformed or mismatched stored values are ignored. Another shift/user never displays the previous scope's seconds. A later attempt replaces that user's previous stored metric. This is device/browser-local; it does not sync across devices and clearing browser storage removes it.

The existing confirmed, replayed, queued and unconfirmed outcome labels remain distinct. Queued storage never claims server confirmation. If browser storage fails, the latest duration remains visible in memory with an accurate explanation that it could not be retained on this device. Storage exceptions cannot affect checkout. Captured callbacks from an obsolete scope or older Kassa instance cannot overwrite a newer result. A request finishing after navigation may persist while it still owns that user's metric, without setting state after unmount.

POS retains the existing total duration sample, clock reads and financial flow. Only its final display-state update is replaced by local metric persistence. There are no extra backend requests, timers, polling, financial payload changes, dependencies, backend/schema/permission edits or changes to live business records. One tiny local write after an attempt adds negligible expected overhead. The timer starts with future attempts and cannot reconstruct earlier checkout durations.

Validation: remote preview build and lint passed. 62 offline Node tests passed with network disabled, covering actual checkout callback -> actual persistence hook/helper -> unmount/remount -> visible timing, scoped restoration, malformed/blocked storage, stale completion ownership, all existing outcomes, unchanged request/clock counts, offline recovery and receipt lifecycle. Independent local review found no actionable issues. No real/fake sale, payment, shift, order or stock movement was created in the app for testing. No publish or merge.
