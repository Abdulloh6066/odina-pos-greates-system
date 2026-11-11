# Fixed 5,000 UZS cake option in POS

For a piece-sold product in the shop's Tortlar category, the POS offers the existing style of choice dialog: Qo‘shimchasiz or +5 000 UZS. A 120,000 UZS cake becomes one 125,000 UZS cake line when selected. The product catalogue, recipe, quantity and stock rules are unchanged; no separate fee line is added. A plain cake and a cake with the option can coexist in one cart.

The fixed option is validated and priced from the server's shop catalogue for direct sales and table/takeaway orders. Saved orders retain their price. The option is included in the existing line identity, offline serialization and request fingerprint. Old rows without the flag retain their exact identity. Sale, SaleItem and saved Shop order schemas add only an optional boolean; verify hosted schemas before publishing the new handlers.

Validation: 158 focused offline checks passed, including the real POS add/choice path, one-line price, mixed quantities/costs, shop price authority, invalid inputs, stored table price, offline synchronization, and burger/tea/discount/settlement regressions. Lint, production build, and both backend bundle compilations passed. No live sales, product updates, stock movements, or AI/builder calls.
