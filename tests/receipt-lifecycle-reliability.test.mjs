// Browser lifecycle simulation only. No real printer, payment, or network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startReceiptPrint } from '../src/lib/receipt-print-lifecycle.js';

function browser({ closing = false, throws = false, synchronous = false, legacy = false } = {}) {
  let clock = 0; let next = 0; let prints = 0; let done = 0;
  const warnings = []; const timers = new Map(); const frames = new Map(); const events = new Map();
  const classes = new Set(); let mediaListener;
  const media = { matches: false };
  if (legacy) { media.addListener = fn => { mediaListener = fn; }; media.removeListener = fn => { if (fn === mediaListener) mediaListener = null; }; }
  else { media.addEventListener = (_name, fn) => { mediaListener = fn; }; media.removeEventListener = (_name, fn) => { if (fn === mediaListener) mediaListener = null; }; }
  const doc = { visibilityState: 'visible', focused: true, hasFocus: () => doc.focused,
    querySelectorAll: () => closing ? [{}] : [],
    body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c) } },
  };
  const emit = name => { for (const fn of [...(events.get(name) || [])]) fn({ type: name }); };
  const win = {
    matchMedia: () => media,
    addEventListener: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener: (name, fn) => events.get(name)?.delete(fn),
    requestAnimationFrame: fn => { const id = ++next; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    print: () => { prints++; if (throws) throw new Error('Mock printer failure'); if (synchronous) emit('afterprint'); },
  };
  const cleanup = startReceiptPrint({ win, doc, onDone: () => { done++; }, onWarning: text => warnings.push(text) });
  const paint = (count = 3) => {
    for (let i = 0; i < count; i++) { const callbacks = [...frames.values()]; frames.clear(); for (const cb of callbacks) cb(); }
  };
  const advance = ms => {
    const end = clock + ms; let guard = 0;
    while (true) {
      const earliest = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!earliest || earliest[1].at > end) break;
      if (++guard > 100) throw new Error('Runaway test timer');
      clock = earliest[1].at; timers.delete(earliest[0]); earliest[1].fn();
    }
    clock = end;
  };
  return { doc, media, warnings, cleanup, emit, paint, advance, classes,
    mediaChange: matches => { media.matches = matches; mediaListener?.({ matches }); },
    stats: () => ({ prints, done, timers: timers.size, frames: frames.size, listeners: [...events.values()].reduce((n, set) => n + set.size, 0) }),
  };
}

test('normal afterprint completes once and fully cleans listeners, timers, and print mode', () => {
  const b = browser(); b.paint(); assert.equal(b.stats().prints, 1);
  b.emit('afterprint'); b.emit('afterprint'); b.advance(0);
  assert.deepEqual(b.stats(), { prints: 1, done: 1, timers: 0, frames: 0, listeners: 0 });
  assert.equal(b.classes.has('odina-sale-printing'), false);
});
test('synchronous afterprint defers completion until native print has returned', () => {
  const b = browser({ synchronous: true }); b.paint(); assert.equal(b.stats().done, 0);
  b.advance(0); assert.equal(b.stats().done, 1); assert.equal(b.stats().timers, 0);
});
test('missing completion event recovers after return without printing twice', () => {
  const b = browser(); b.paint(); b.advance(2000);
  assert.equal(b.stats().done, 1); assert.equal(b.stats().prints, 1);
  assert.equal(b.classes.has('odina-sale-printing'), false);
});
test('active print media prevents a fallback from closing a genuine print dialog', () => {
  const b = browser(); b.paint(); b.mediaChange(true); b.advance(6000);
  assert.equal(b.stats().done, 0); assert.equal(b.classes.has('odina-sale-printing'), true);
  b.mediaChange(false); b.advance(0); assert.equal(b.stats().done, 1);
});
test('unfocused document waits for focus; user input can recover stale print media', () => {
  const b = browser(); b.paint(); b.doc.focused = false; b.advance(4000);
  assert.equal(b.stats().done, 0);
  b.doc.focused = true; b.emit('focus'); b.advance(0); assert.equal(b.stats().done, 1);
  const c = browser(); c.paint(); c.mediaChange(true); c.emit('pointerdown'); c.advance(0);
  assert.equal(c.stats().done, 1); assert.equal(c.stats().prints, 1);
});
test('a stuck closed dialog times out safely instead of looping or forcibly unlocking other dialogs', () => {
  const b = browser({ closing: true }); b.paint(50); assert.equal(b.stats().prints, 0);
  b.advance(2000); assert.equal(b.stats().done, 1); assert.equal(b.stats().frames, 0);
  assert.equal(b.warnings.length, 1); assert.match(b.warnings[0], /Savdo saqlangan/);
});
test('printer exception leaves saved sale presentation recoverable', () => {
  const b = browser({ throws: true }); b.paint(); b.advance(0);
  assert.equal(b.stats().done, 1); assert.equal(b.warnings.length, 1);
  assert.equal(b.classes.has('odina-sale-printing'), false);
});
test('unmount cancels startup and completion callbacks without touching a live printer', () => {
  const b = browser(); b.cleanup(); b.paint(); b.advance(10000);
  assert.deepEqual(b.stats(), { prints: 0, done: 0, timers: 0, frames: 0, listeners: 0 });
  const c = browser(); c.paint(); c.emit('afterprint'); c.cleanup(); c.advance(0);
  assert.equal(c.stats().done, 0);
});
test('legacy media listeners still complete safely', () => {
  const b = browser({ legacy: true }); b.paint(); b.mediaChange(true); b.mediaChange(false); b.advance(0);
  assert.equal(b.stats().done, 1);
});
