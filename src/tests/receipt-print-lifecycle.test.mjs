import test from 'node:test';
import assert from 'node:assert/strict';
import { startReceiptPrint } from '../lib/receipt-print-lifecycle.js';

function harness() {
  const frames = new Map(), timers = new Map(), events = new Map(), mediaEvents = new Map();
  const classes = new Set();
  let id = 0, closing = true, prints = 0, done = 0;
  const win = {
    requestAnimationFrame: f => { frames.set(++id, f); return id; },
    cancelAnimationFrame: n => frames.delete(n),
    setTimeout: f => { timers.set(++id, f); return id; },
    clearTimeout: n => timers.delete(n),
    addEventListener: (n, f) => events.set(n, f),
    removeEventListener: (n, f) => { if (events.get(n) === f) events.delete(n); },
    matchMedia: () => ({
      addEventListener: (n, f) => mediaEvents.set(n, f),
      removeEventListener: (n, f) => { if (mediaEvents.get(n) === f) mediaEvents.delete(n); },
    }),
    print: () => { prints++; },
  };
  const doc = { querySelectorAll: () => closing ? [{}] : [], body: {
    classList: { add: n => classes.add(n), remove: n => classes.delete(n) }
  }};
  const flush = collection => { const tasks = [...collection.values()]; collection.clear(); tasks.forEach(f => f()); };
  return { win, doc, frames, timers, events, mediaEvents, classes,
    tick: () => flush(frames), flush: () => flush(timers),
    close: () => { closing = false; },
    printCount: () => prints, doneCount: () => done,
    start: () => startReceiptPrint({win, doc, onDone: () => done++}),
  };
}

test('printing waits for closing dialogs and two paint frames', () => {
  const h = harness(); const stop = h.start();
  h.tick(); h.tick(); assert.equal(h.printCount(), 0);
  h.close(); h.tick(); h.tick(); assert.equal(h.printCount(), 0);
  h.tick(); assert.equal(h.printCount(), 1);
  stop();
});
test('afterprint (including cancel) completes once, outside native print call', () => {
  const h = harness(); h.close(); h.start();
  h.tick(); h.tick(); h.tick();
  const finish = h.events.get('afterprint');
  finish(); finish(); assert.equal(h.doneCount(), 0);
  h.flush(); assert.equal(h.doneCount(), 1); assert.equal(h.classes.size, 0);
});
test('print media exit recovers when browser omits afterprint', () => {
  const h = harness(); h.close(); h.start(); h.tick(); h.tick(); h.tick();
  const change = h.mediaEvents.get('change'); change({matches:true}); change({matches:false});
  h.flush(); assert.equal(h.doneCount(), 1); assert.equal(h.events.size, 0);
});
test('cleanup prevents a stale print or stale completion', () => {
  const h = harness(); const stop = h.start(); stop(); h.close(); h.tick();
  assert.equal(h.printCount(), 0);
  const h2 = harness(); h2.close(); const stop2 = h2.start(); h2.tick(); h2.tick(); h2.tick();
  h2.events.get('afterprint')(); stop2(); h2.flush(); assert.equal(h2.doneCount(), 0);
});
test('printer exception releases print state and finishes safely', () => {
  const h = harness(); h.win.print = () => { throw Error('printer unavailable'); };
  h.close(); h.start(); h.tick(); h.tick(); h.tick(); h.flush();
  assert.equal(h.doneCount(), 1); assert.equal(h.classes.size, 0);
});
