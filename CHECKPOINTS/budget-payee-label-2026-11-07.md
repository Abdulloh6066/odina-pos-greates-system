# Budget payment recipient label

Display the existing stored supplier name as “Qabul qiluvchi” on supplier-payment history cards. Keep actor, notes, account, amount and balance history unchanged. Legacy records without a name display “Noma’lum”; never infer a recipient from the actor or free-text notes. Search continues to use the stored supplier name.

Frontend-only correction. No entity migrations, backend changes, payments or balance mutations. Publish through the repository's GitHub/Base44 workflow; no backend recompilation is needed.

Validation: mocked actual-JSX tests cover names, missing legacy names, non-supplier transactions and name search. Lint and production build pass. Typecheck retains the same 1,480 baseline diagnostics. Full-suite baseline contains 111 existing failing tests; compare names before release. No production transaction is used for testing writes.
