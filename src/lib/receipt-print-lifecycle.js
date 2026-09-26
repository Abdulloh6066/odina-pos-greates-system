// Wait for closing modal layers before starting a browser print dialog.
// Never release modal pointer locks globally: another real dialog may own them.
export function startReceiptPrint({ win = window, doc = document, onDone }) {
  let stopped = false;
  let started = false;
  let finished = false;
  let sawPrintMedia = false;
  let frame = null;
  let doneTimer = null;
  let paintedFrames = 0;
  const media = win.matchMedia?.('print');
  const removeListeners = () => {
    win.removeEventListener('afterprint', finish);
    media?.removeEventListener?.('change', onMediaChange);
  };
  const finish = () => {
    if (stopped || finished) return;
    finished = true;
    removeListeners();
    doc.body.classList.remove('odina-sale-printing');
    // afterprint can fire inside window.print(); open the next modal only
    // after the native print call has returned.
    doneTimer = win.setTimeout(() => { if (!stopped) onDone(); }, 0);
  };
  const onMediaChange = (event) => {
    if (event.matches) sawPrintMedia = true;
    else if (started && sawPrintMedia) finish();
  };
  const nextFrame = () => {
    if (stopped) return;
    const closingLayers = doc.querySelectorAll('[role="dialog"][data-state="closed"]');
    if (closingLayers.length || paintedFrames < 2) {
      paintedFrames = closingLayers.length ? 0 : paintedFrames + 1;
      frame = win.requestAnimationFrame(nextFrame);
      return;
    }
    started = true;
    win.addEventListener('afterprint', finish);
    media?.addEventListener?.('change', onMediaChange);
    doc.body.classList.add('odina-sale-printing');
    try { win.print(); } catch { finish(); }
  };
  frame = win.requestAnimationFrame(nextFrame);
  return () => {
    stopped = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    if (doneTimer !== null) win.clearTimeout(doneTimer);
    removeListeners();
    doc.body.classList.remove('odina-sale-printing');
  };
}
