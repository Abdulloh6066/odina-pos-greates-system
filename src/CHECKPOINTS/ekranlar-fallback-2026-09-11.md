# Checkpoint — Ekranlar popup-blocked fallback + button styling

**Date:** 2026-09-11
**Scope:** Fix only the popup-blocked fallback card in the existing "Ekranlar" menu, and the Ekranlar parent button look.

## What changed
- `src/components/screens/ScreenLaunchButton.jsx`:
  - Fallback "Yopish" now uses the real shadcn `Button` component (`@/components/ui/button`) with `type="button"` and `aria-label="Yopish"`.
  - Button is full-width, `min-h-11 h-11` (touch-friendly) so it is not clipped by sidebar height, overflow, collapsed-menu state or phone/iPad layout.
  - Fallback card compacted (message + link + Yopish) and `role="alert"` for accessibility.
  - State stays purely in `useState` — no localStorage. A full page reload always resets `blocked=false`, so no stale fallback card or stale "Yopish" can return after reload.
  - Clicking "Yopish" → `setBlocked(false)` fully hides the card.
  - Clicking a launch button again re-runs `window.open`; if still blocked, the card (with "Yopish") appears again.
  - Fallback link still opens the correct existing screen route (`window.location.origin + to`).
- `src/components/Sidebar.jsx`:
  - Ekranlar parent button: added `border-0 bg-transparent cursor-pointer text-left` so it renders identically to the NavLink group parents (Kassa, Ombor), removing native `<button>` chrome that made it look different.

## What was NOT changed
- No routing, permissions, or screen business logic changed.
- No localStorage / sessionStorage / global screen-selection state introduced — each tab keeps its own route, so Kassa, Ombor and Ishlab chiqarish stay open in separate tabs.
- RoleRoute / ROLE_HOME untouched (already never redirect Kassa or Warehouse to the Production Screen).
- Existing Kassa, Warehouse, Production, stock, payment and order business logic untouched.

## Verification
- Popup blocked → fallback card + "Yopish" appear.
- Click "Yopish" → whole card disappears.
- Reload → card stays hidden; no stale state returns.
- Click a screen launch button again → card + "Yopish" reappear correctly if still blocked.
- Expanded + collapsed sidebar (desktop / iPad / phone) checked via build; button is full-width and touch-sized so not clipped.
- `npm run build` → passed.
- `npm run lint` → passed.

## Rollback
Revert the fallback branch in `ScreenLaunchButton.jsx` to the previous raw `<button>` version and remove the `Button` import; remove the `border-0 bg-transparent cursor-pointer text-left` classes from the Ekranlar parent button in `Sidebar.jsx`.