# Checkpoint — Ekranlar popup-blocked fallback state lifted to Sidebar

**Date:** 2026-09-11
**Scope:** Make the popup-blocked fallback card (and "Yopish" button) survive collapsing/reopening the Ekranlar section, while still resetting on a full page reload. Also fix the Ekranlar parent button look.

## Root cause (previous turn)
The `blocked` state lived inside each `ScreenLaunchButton`. When the Ekranlar section was collapsed, `{screensOpen && (...)}` unmounted the children, destroying their local `useState`. Reopening remounted them fresh with `blocked=false`, so the fallback card and "Yopish" vanished — the user could not dismiss the warning after toggling.

## Fix
Lifted the per-screen blocked state into the persistent `Sidebar` component:
- `src/components/Sidebar.jsx`:
  - Added `const [blockedScreens, setBlockedScreens] = useState({})` — a map keyed by screen key (`launch-pos`, `launch-warehouse`, `launch-production`).
  - Passed `blocked`, `onBlocked`, `onClear` props into each `ScreenLaunchButton`.
  - `onBlocked` sets that screen's entry to `true`; `onClear` deletes it (fully hides the card).
- `src/components/screens/ScreenLaunchButton.jsx`:
  - Now controlled: receives `blocked`, `onBlocked`, `onClear` props instead of self-managing `useState`.
  - Removed the now-unused `useState` import.
  - `handleOpen` calls `onBlocked()` (replaces `setBlocked(true)`) when `window.open` is blocked; `onAfterOpen` still fires on success.
  - "Yopish" `Button` `onClick` now calls `onClear`.
  - Fallback card styling unchanged: pink card, correct screen link, full-width touch-sized `Button` ("Yopish") with `type="button"` and `aria-label`.
- `src/components/Sidebar.jsx` (previous turn, retained): Ekranlar parent button carries `border-0 bg-transparent cursor-pointer text-left` so it renders identically to the NavLink group parents (Kassa, Ombor).

## Why this satisfies all constraints
- **Component state only / no localStorage:** blocked state is plain `useState` in the Sidebar.
- **Survives Ekranlar toggle:** the Sidebar stays mounted when the Ekranlar section collapses/expands, so `blockedScreens` is retained; reopening re-renders `ScreenLaunchButton` with the same `blocked` value → card + "Yopish" still visible.
- **Resets on full page reload:** the Sidebar remounts on a full reload, so `useState({})` initializes empty → no stale fallback card returns.
- **"Yopish" always renders while card visible:** the fallback branch always renders the Button.
- **Click "Yopish" fully clears + hides card:** `onClear` deletes the screen's entry → `blocked=false` → card disappears.
- **Launch button re-triggers card:** after "Yopish" clears the entry, clicking the launch button re-runs `window.open`; if still blocked, `onBlocked` sets it true again → card reappears.
- **Not clipped:** full-width, `min-h-11 h-11` Button; card is compact and lives in the scrolling nav.
- **Real Button component:** uses `@/components/ui/button` with `type="button"` and `aria-label="Yopish"`.
- **Correct route:** fallback link uses `window.location.origin + to` (the existing screen route).

## What was NOT changed
- No routing, permissions, or screen business logic changed.
- No localStorage / sessionStorage / global screen-selection state introduced — each tab keeps its own route, so Kassa, Ombor and Ishlab chiqarish stay open in separate tabs.
- RoleRoute / ROLE_HOME untouched.
- Existing Kassa, Warehouse, Production, stock, payment and order business logic untouched.

## Verification
1. Popup blocked → fallback card + "Yopish" appear.
2. Click "Yopish" → whole card disappears.
3. Collapse Ekranlar, reopen → card + "Yopish" still visible (state survived the toggle).
4. Full page reload → card stays hidden; no stale state returns.
5. Click a screen launch button again → card + "Yopish" reappear correctly if still blocked.
- `npm run build` → passed (clean).
- `npm run lint` → passed (clean).

## Rollback
Revert `ScreenLaunchButton.jsx` to self-managed `useState(false)` (rename `onBlocked`→`setBlocked(true)`, `onClear`→`setBlocked(false)`, restore `useState` import), and remove `blockedScreens` state + the `blocked`/`onBlocked`/`onClear` props from `Sidebar.jsx`. Remove the `border-0 bg-transparent cursor-pointer text-left` classes from the Ekranlar parent button if the button-chrome fix should also be reverted.