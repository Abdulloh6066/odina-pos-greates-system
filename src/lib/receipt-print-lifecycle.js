// Printing is presentation only: never retry or change the saved sale here.
// Do not release global modal pointer locks: another real dialog may own them.
export function startReceiptPrint({ win = window, doc = document, onDone, onWarning = () => {}, printClass = 'odina-sale-printing', warningMessage }) {
  let stopped = false;
  let started = false;
  let returned = false;
  let finished = false;
  let sawPrintMedia = false;
  let frame = null;
  let doneTimer = null;
  let recoveryTimer = null;
  let paintedFrames = 0;
  const media = win.matchMedia?.('print');
  const warning = warningMessage || 'Savdo saqlangan. Chek chiqmagan bo‘lsa, Savdolar tarixidan qayta chop eting; qayta pul olmang.';
  const removeListeners = () => {
    win.removeEventListener('afterprint', finish);
    win.removeEventListener('focus', recoverOnReturn);
    win.removeEventListener('pointerdown', recoverOnInteraction, true);
    win.removeEventListener('keydown', recoverOnInteraction, true);
    if (media?.removeEventListener) media.removeEventListener('change', onMediaChange);
    else media?.removeListener?.(onMediaChange);
  };
  const finish = () => {
    if (stopped || finished) return;
    finished = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    if (recoveryTimer !== null) win.clearTimeout(recoveryTimer);
    removeListeners();
    doc.body.classList.remove(printClass);
    // Defer until native window.print() returns, including synchronous afterprint.
    doneTimer = win.setTimeout(() => { if (!stopped) onDone(); }, 0);
  };
  const recoverOnReturn = () => {
    if (!started || !returned || finished || stopped || media?.matches) return;
    if (doc.visibilityState === 'hidden' || (doc.hasFocus && !doc.hasFocus())) return;
    finish();
  };
  const recoverOnInteraction = () => {
    // Actual input to the webpage proves the native dialog is no longer blocking it.
    if (started && returned) finish();
  };
  const onMediaChange = (event) => {
    if (event.matches) sawPrintMedia = true;
    else if (started && sawPrintMedia) finish();
  };
  const checkReturned = () => {
    if (finished || stopped) return;
    recoverOnReturn();
    if (!finished) recoveryTimer = win.setTimeout(checkReturned, 2000);
  };
  const nextFrame = () => {
    if (stopped || finished) return;
    const closingLayers = doc.querySelectorAll('[role="dialog"][data-state="closed"]');
    if (closingLayers.length || paintedFrames < 2) {
      paintedFrames = closingLayers.length ? 0 : paintedFrames + 1;
      frame = win.requestAnimationFrame(nextFrame);
      return;
    }
    win.clearTimeout(recoveryTimer);
    started = true;
    win.addEventListener('afterprint', finish);
    win.addEventListener('focus', recoverOnReturn);
    win.addEventListener('pointerdown', recoverOnInteraction, true);
    win.addEventListener('keydown', recoverOnInteraction, true);
    if (media?.addEventListener) media.addEventListener('change', onMediaChange);
    else media?.addListener?.(onMediaChange);
    doc.body.classList.add(printClass);
    try { win.print(); } catch { onWarning(warning); finish(); }
    finally {
      returned = true;
      if (!finished && !stopped) recoveryTimer = win.setTimeout(checkReturned, 2000);
    }
  };
  // Never spin forever behind a stuck exit animation. Skip this print safely;
  // leave the sale untouched and allow reprint from its saved history.
  recoveryTimer = win.setTimeout(() => {
    if (!started && !stopped && !finished) { onWarning(warning); finish(); }
  }, 2000);
  frame = win.requestAnimationFrame(nextFrame);
  return () => {
    stopped = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    if (doneTimer !== null) win.clearTimeout(doneTimer);
    if (recoveryTimer !== null) win.clearTimeout(recoveryTimer);
    removeListeners();
    doc.body.classList.remove(printClass);
  };
}
