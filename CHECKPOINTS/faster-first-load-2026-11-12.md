# Faster first load — logo, reorder dialog, fonts (2026-11-12)

Request: three download-size fixes from the code review. No backend, entity, business-logic or visual-design changes. No publish.

- Logo: `src/components/brand/odina-mark.js` held the owner's 2047×2048 PNG as text (295 kB) inside the main bundle, although the sidebar shows it at 48 px and receipts at 72 px. It now holds the same logo scaled to 256×256 (26 kB). The original file `public/odina-mark.png` is unchanged; the login-page watermark (shown at 330 px) now uses that file directly.
- Reorder dialog: `src/pages/POS.jsx` loads `ProductOrderDialog` (and its drag-and-drop library) on demand instead of with Kassa. Only admin/manager can open it; for them it is fetched in idle time after Kassa appears. Cashiers never download it. If the download fails, Kassa keeps working and a message asks the user to refresh once online (browsers do not retry a failed module download within the same page).
- Fonts: the Google Fonts `@import` in `src/index.css` is replaced by `src/styles/fonts.css`, which serves Inter and Playfair Display from the app (`@fontsource-variable/inter`, `@fontsource-variable/playfair-display`). The rules mirror Google's stylesheet: same weights (Inter 400–700, Playfair 500–800), same unicode ranges, Latin and Cyrillic. The seven font files are in the offline cache list, so Kassa keeps its fonts offline.

Measured on the production build (gzip): main script 393 kB → 224 kB; Kassa script 92 kB → 61 kB; main stylesheet 27.1 kB → 27.6 kB. Kassa first load (script + styles) 512 kB → 312 kB, plus two font files (87 kB) now from the app instead of Google.

Validation: `npm run build` and `npm run lint` passed. Offline tests: the same 116 tests fail before and after this change (pre-existing, unrelated); none added, none fixed. `tests/pos-catalog-responsiveness.test.mjs` got two test-double adjustments so its sandbox can resolve the on-demand import. New `tests/first-load-weight.test.mjs` (3 tests) guards the three fixes. Checked in a headless browser against the built app with a mocked backend only (no live data): login page, Kassa and the reorder dialog render pixel-for-pixel as before (largest colour difference 22/255, on the resampled logo); cashier makes no request for the dialog code; manager/admin open it; a blocked download shows the message and leaves Kassa usable.

Not verified: a real receipt print, and behaviour against the live Base44 backend.

Files: src/components/brand/odina-mark.js; src/components/AuthLayout.jsx; src/pages/POS.jsx; src/index.css; src/styles/fonts.css; package.json; package-lock.json; tests/pos-catalog-responsiveness.test.mjs; tests/first-load-weight.test.mjs; this note.
