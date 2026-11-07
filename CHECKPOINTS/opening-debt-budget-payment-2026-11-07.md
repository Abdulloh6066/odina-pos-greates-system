# Targeted opening-debt payments from Budget

Adds an owner-only To‘lov action beside opening debts in recipient and warehouse views. The user chooses a global Budget account and amount, reviews the resulting account/debt balances, and enters the existing owner approval PIN. No payment is automatically executed by this feature release.

The existing recoverable supplier payment backend accepts an optional explicit opening debt and location. It changes only that liability, preserves previous FIFO request fingerprints, checks concurrent metadata/balance changes, and records the warehouse on payment and Budget history. Partial failure recovery reuses exact frozen intent without persisting the PIN. Pending fully-paid requests remain recoverable outside warehouse status/search filters without changing totals.

Validation: independent review passed with 184 distinct focused/regression tests. Full suite: 1,452 tests, 1,341 pass, the same 111 failing tests as the deployed baseline. Typecheck remains identical at 1,480 pre-existing diagnostics. Lint, production build and diff checks pass. Tests used mocks only; no production payments or balance changes.

Release requires separate authorized public GitHub upload and Base44 publication. No schema changes. After source sync, compile budget-ledger and supplier-ledger because the shared recovery implementation changed; do not redeploy unrelated shift/restaurant bundles merely for unchanged transitive helpers. Verify live UI without submitting a payment or asking the user for their PIN in chat.
