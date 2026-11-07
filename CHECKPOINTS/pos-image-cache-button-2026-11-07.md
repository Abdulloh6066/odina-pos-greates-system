# Manual POS image warmup — 2026-11-07

Adds “Rasmlarni saqlash” immediately before Ixcham. It warms public images for
the viewed catalogue in the current browser, reports progress, supports cancel,
and resumes by skipping readable image responses already in CacheStorage.
Shop/user/catalogue changes or loss of connectivity abort the previous batch;
late completion cannot replace the new context's status. Progress lives inside
the button component, independently of the basket and catalogue.

The helper prioritizes existing matching thumbnails and product photo fallbacks.
For Wix responsive images it caches the existing Image component's 1x/2x/3x URLs
at the current image-child dimensions (excluding the photo border). An empty
view uses an inert offscreen probe with the existing grid/card/photo styles.
Two requests run concurrently. Missing images,
CORS/storage errors and non-image bodies are reported individually, never as
full success. The existing 600-image limit is retained; current warmup entries
are protected during cleanup, and excess plan entries are reported as skipped.

Uses the existing odina-public-images-v1 cache. The worker additionally recognizes
legacy Base44 public image-file URLs with matching app IDs; private files and
business API responses remain excluded. Existing image rendering and background
thumbnail warmup are unchanged. No source image, product, price, stock or sale
record is modified, and no upload/AI service is used.

Benefit is earlier availability of previously uncached images, especially on
slow connections; it is not a measured reduction in checkout/server latency.
Already cached images gain little from another warmup. Browser storage may be
cleared/evicted, and a responsive layout change can require additional URLs.
The worker retains its no-skipWaiting lifecycle: after a deployment, existing
old tabs may need to close/reopen normally before the new image route is active.

Validation: 104 targeted offline checks passed, including real button state,
actual POS placement/scope, persistent-cache reuse, two-worker bounds, partial
failure, cancellation, stale context, public/private worker routes, existing
thumbnail behavior, catalogue isolation, pricing, stock propagation, request
immutability and discounts. Full lint and production build passed. The first
new worker test failed against the previous code because legacy public image
URLs bypassed its image cache; it passes with the narrow public-file rule.

Local browser verification used the real Image and cache button with production
POS styles. After a warmup from an empty view, the responsive Wix currentSrc
(w_273,h_226) exactly matched a warmed URL; the rendered child box measured
136.5 x 112.75. Three local images remained visible with the fixture's image
server disabled: its image-request counter stayed at three, blocked requests
zero. No business API was involved.

Review regressions also reproduce cancellation during asynchronous key listing:
an aborted old job cannot prune the next scope's new image. Cleanup checks the
abort state before listing/deleting; cancellation counts include unprocessed
images rather than claiming zero missing files.
