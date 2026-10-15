# Buyurtma action timing — preview only

Branch: audit-fixes (6ad0056bafaa7b155eadb265)
Starting commit: 09b62e5a385c0e66fb2176dbe2975aa2e13083b7

The existing create and complete success messages now show elapsed seconds for the current button action, for example `Saqlash: 2,4 soniya` and `Yakunlash: 1,8 soniya`. Pending retries and server-confirmed saved operations use `Qayta tekshirish`, so the new attempt is not presented as the duration of an earlier request.

The clock starts after local validation and stops after a valid saved-order response, before refresh or receipt callbacks. It includes local request preparation, network and server time. This is a client-observed duration, not a server-only execution time or the full time from order creation to delivery. Failed/unconfirmed requests retain existing error behavior and do not display a success duration. Old orders are not backfilled.

Implementation: two clock reads per successful action, using performance.now with a Date.now fallback. No interval, polling, additional API request, dependency, schema field, telemetry write or business-record write is added. Timing stays outside frozen retry payloads, session storage and financial calculations. The helper is used only by the two Buyurtma dialogs; Kassa checkout and shift closing are untouched.

Validation: build passed; lint passed; 36 offline tests passed, including 9 actual-dialog retry/timing tests and existing checkout latency, lost-reply recovery and shift-close checks. Tests used mocked records with fetch blocked. No real order was created, paid, completed or changed to test the feature.

Saved as an unpublished preview checkpoint. No publish or merge, no permission activation, no live-data migration or correction.
