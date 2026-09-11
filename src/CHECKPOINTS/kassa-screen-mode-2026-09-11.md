# Checkpoint — Kassa screen-only mode (`/pos?screen=1`)

**Date:** 2026-09-11
**Scope:** Add a route-based "screen mode" to the existing Kassa (POS) route so that opening "Kassada ochish" from the Ekranlar menu shows only the POS interface (no sidebar, no global header, no breadcrumbs), while normal `/pos` keeps the full app chrome. Refreshing the tab preserves the screen-only view; other tabs are unaffected. No business logic changed.

## Approach
Reuse the existing Layout's outlet-context plumbing. Layout detects `/pos?screen=1` and renders a sidebar-free shell that still passes the same outlet context POS depends on (`user`, `sidebarCollapsed`, `reloadUser`), plus a new `screenMode` flag. No new route, no duplicate Kassa page, no localStorage, no new entities.

## Changes

### `src/components/Layout.jsx`
- Added `const screenMode = location.pathname === '/pos' && new URLSearchParams(location.search).get('screen') === '1';`.
- Added an early return when `screenMode`: a bare `min-h-dvh` flex column wrapping `<main><Outlet/></main>` with context `{ user, sidebarCollapsed: false, reloadUser: checkUserAuth, screenMode: true }`. No Sidebar, no mobile hamburger header, no brand bar.
- Normal return's `<Outlet>` context now also carries `screenMode: false` so non-screen pages (and normal `/pos`) behave exactly as before.

### `src/pages/POS.jsx`
- Reads `screenMode` from `useOutletContext()`.
- Root container height: `h-dvh` in screen mode (no mobile header above it), unchanged `h-[calc(100dvh-3.5rem)] lg:h-dvh` otherwise.
- Mobile cart bar offset: `left-0` with no `lg:left-*` offset in screen mode (no sidebar to account for); unchanged offset behaviour otherwise.
- Waste-expiry alert banner hidden in screen mode (`!screenMode && ...`) so the screen-only view cannot navigate away to `/waste`.

### `src/components/Sidebar.jsx`
- "Kassada ochish" launch path changed from `/pos` to `/pos?screen=1` so `ScreenLaunchButton` opens the screen-only URL in a new browser tab.
- Active-state comparison uses `child.path.split('?')[0]` so the launch button still highlights correctly now that the path carries a query string (no change for the query-free Warehouse/Production launch buttons).

## What was NOT changed
- No routing, permissions, or role logic changed. `AuthGate` + `RoleRoute` still gate `/pos`, so unauthenticated/unauthorized users are blocked identically in both normal and screen mode.
- No POS business logic changed (cart, discount/promo validation, stock check, checkout, payment, shift open/close, cash withdrawal, supplier debt, realtime ProductStock subscription).
- No entities, backend functions, or payment/shift/stock/order behaviour changed.
- No duplicate Kassa page, cart, payment flow, or shift logic created.
- Warehouse and Production screen routes unchanged; their Ekranlar launch buttons unchanged.
- Normal app pages retain the Sidebar + mobile header.

## Verification (route-based, no localStorage)
1. "Kassada ochish" → `window.open('/pos?screen=1')` in a new tab. ✅
2. That tab renders only the POS interface (header with shift status + "Smenani ochish"/"Smenani yopish", categories, product search + cards, cart with promo/totals/checkout). No sidebar/header/breadcrumbs. ✅
3. Refreshing the tab keeps `?screen=1` in the URL → Layout stays in screen mode. ✅
4. Other tabs: a normal `/pos` tab keeps the sidebar; `/warehouse` and `/production-screen` tabs are unaffected (separate URLs). ✅
5. Normal application pages retain existing navigation (Sidebar + mobile header). ✅
6. `npm run build` → passed (clean). `npm run lint` → passed (clean). ✅

## Responsive notes
- Desktop ≥xl: inline cart side-panel (unchanged) + POS header.
- lg (iPad landscape): inline cart hidden (`xl:flex`), full-width bottom "Buyurtma" bar at `left-0` (no sidebar offset in screen mode).
- <lg (phone/tablet portrait): category chips row, product grid, bottom "Buyurtma" bar opens the cart Sheet — all touch-sized (`min-h-11`+).
- Screen-only container is `h-dvh`, so it fills the viewport on phone, iPad, and desktop without the app chrome.

## Rollback
- Layout: remove the `screenMode` const, the screen-mode early return, and the `screenMode: false` field from the normal Outlet context.
- POS: restore the context destructure to `{ user, sidebarCollapsed }`, the static height class, the static cart-bar offset class, and the waste-alert condition to `wasteAlerts.length > 0`.
- Sidebar: revert the launch-pos path to `/pos` and the active comparison to `location.pathname === child.path`.