# Odina Shop Permanent Project Rules

1. Before every future change, inspect the existing implementation and preserve everything that already works.

2. Never delete, reset, rename or modify live records, entities, financial history or historical snapshots unless the user explicitly requests the exact destructive action.

3. Never create duplicate entities, backend functions, pages or competing implementations. Reuse existing resources first.

4. Change only the feature explicitly requested. Do not redesign or refactor unrelated pages.

5. Preserve all existing business logic for:

   * POS and sales
   * shifts
   * payments and Budget
   * products and categories
   * inventory and recipes
   * production
   * transfers
   * waste
   * supplier debts
   * reports
   * customer orders

6. Preserve existing roles and permissions. Budget and other owner-sensitive information must remain owner/admin-only. Users must never gain access to another shop or restricted financial information.

7. All important mutations and financial calculations must be validated securely by the backend. Never trust shop IDs, prices, totals, employee identities or permissions sent by the browser.

8. Historical sale items, prices, payments, order items and other financial snapshots must remain immutable.

9. Never create fake/live sales, payments, shifts, transfers, stock movements or orders for testing. Use mocked/offline tests only.

10. Never use `delete` or `deleteMany` during testing. If a task appears to require deleting live data, stop and ask the user first.

11. Default interface language is Uzbek Latin. Avoid mixed English labels unless they are established payment or product names.

12. Use `Asia/Tashkent` timezone for all displayed business dates and times.

13. All UI must be responsive and touch-friendly on desktop, iPad, tablet and phone.

14. Visual style:

* Premium, clean and elegant bakery design
* Primary olive: `#ACA95D`
* Main warm accent/buttons: `#FECD7C`
* Secondary tan accent: `#D0B17F`
* White and warm off-white neutral backgrounds are allowed
* Dark readable text and subtle neutral borders are allowed
* Red and green may be used only for errors, warnings and success states
* Do not introduce unrelated bright brand colors
* Do not overuse the accent colors
* Preserve the Odina logo and current typography unless explicitly requested

15. Avoid native browser controls that create inconsistent dark menus when a polished accessible custom component is appropriate.

16. After code changes, run build and lint, perform only safe offline verification, and create a checkpoint.

17. If a future prompt begins with "Follow ODINA_PROJECT_RULES.md", read this file completely before making changes.