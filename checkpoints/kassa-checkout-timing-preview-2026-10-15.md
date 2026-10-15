# Kassa Yakunlash timing — preview only

Branch: audit-fixes (6ad0056bafaa7b155eadb265)
Starting commit: 06e1992e3e37eb74e0f3d8f8df0b153a3b9526fb

Kassa now keeps the most recent final checkout attempt's elapsed seconds in a small status line directly below its header. Before the first attempt, a placeholder explains where the result will appear. While checkout is pending, the line shows an in-progress label without a live counter. The value remains visible on this Kassa page after receipt presentation and until the next attempt/page reload. It is scoped to the current shift.

The displayed total is the same single elapsed-ms measurement already used by the existing `[Odina checkout timing]` console entry. No extra clock reads, server requests, database writes, polling, intervals or dependencies are added. A small client state update and text render have negligible expected overhead. Payment validation, financial payloads, idempotency keys, carts, offline queues, receipt printing and shift closing use their existing flow.

Labels distinguish confirmed checkout (`Yakunlash`), replay confirmation (`Qayta tekshirish`), successfully queued device storage (`Qurilmaga saqlash`, awaiting server confirmation), and an unconfirmed attempt (`Yakunlash tasdiqlanmadi`). A local storage failure is never presented as saved. A receipt presentation error after confirmed saving retains the saved outcome. Each retry measures its own attempt, excluding the human pause between attempts.

Measurement begins at the accepted final Yakunlash submission and ends in its existing finally block, after synchronous result handling. It includes local preparation, API/queue wait and synchronous completion handling. It excludes earlier stock checking/payment selection, later React rendering, physical printing and asynchronous refresh work. It cannot reconstruct durations for earlier checkouts and does not write duration into sale history.

Validation: build passed; lint passed; 67 offline checks passed, including 46 checkout/recovery/receipt cases, existing read-latency and timeout recovery checks, real callback timing with deterministic clocks, duplicate submission guards, unchanged request/clock counts, queue/storage failure cases and the real status component. Fetch was blocked in offline verification. No real sale, payment, shift or stock record was created or changed for testing.

Only POS presentation, its small status component, associated mock test harnesses and this checkpoint note changed. No backend functions, entities, permissions or live business records were modified. No publish or merge.
