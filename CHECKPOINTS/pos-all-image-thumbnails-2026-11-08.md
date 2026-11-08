# POS image thumbnails across the catalogue

Extends the existing source-matched POS thumbnail manifest from 11 to 105 current product photos (94 new files). The owner requested the image improvement across all categories after Pishiriqlar was found to serve 1.5–1.7 MB PNGs.

The existing maintenance script generated WebP at maximum 512 px, quality 88, preserving aspect ratio and transparency. The 105 original public PNGs total 142,593,808 bytes; their POS files total 3,192,862 bytes (97.76% smaller). All 11 previous manifest entries/assets remain identical, including the eight approved Central trial photos.

Coverage: Pishiriqlar 24, mini/tart 12, Aralash 9, 15 somlik 8, FOOD 6, Salatlar 5, Choy 5, Kofe 14, Milkshake/Smuzi 8, Limonadlar/Matcha/Anchan 10, Fresh detox 4. All 183 active non-archived products were considered. Existing 22 local SVG references, 30 inline WebP references, 11 canonical WebP references and two product-level optimized money photos are retained. Thirteen missing/non-URL image references retain their existing display/fallback behavior; no photo identity was guessed.

Only the generated display manifest, its offline source snapshot, new static assets and this checkpoint change. No Product/entity writes, original photo replacements, uploads through Base44 integrations, AI/builder calls or business logic changes. Both shops use the same existing lookup. A changed image_url still invalidates its prior thumbnail and falls back to the current original. The existing Rasmlarni saqlash button automatically chooses these local WebP paths; no new cache or UI implementation.

Validation:
- 104 focused offline tests passed: thumbnail lookup/source guards, existing Central bytes, image cache/button, catalogue selection/responsiveness/order, offline sales, checkout request flight and discounts.
- Every generated file decoded successfully and passed WebP signature, content hash, maximum dimension, aspect ratio and exact live source checks.
- Eight before/after visual pairs inspected at POS display size (pastries, mini cake, burger, coffee and salad).
- Full ESLint and Vite production build passed; the existing large-chunk advisory remains.
- No live sale, payment, shift, order, stock movement or other test record was created.

After publication, reopen the POS after finishing the current sale and press Rasmlarni saqlash on each register to warm the new file URLs. Existing images and queued sales must not be cleared. Browser eviction or newly added/replaced photos can still require fresh downloads.
