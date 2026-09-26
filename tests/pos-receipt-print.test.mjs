// Offline receipt lifecycle test. No printer or live sale is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const receipt = fs.readFileSync(new URL('../src/components/pos/Receipt.jsx', import.meta.url), 'utf8');
const pos = fs.readFileSync(new URL('../src/pages/POS.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('printed 80mm receipt uses saved sale items, payments and shop contacts', () => {
  assert.match(receipt, /sale\.items\?\.map/);
  assert.match(receipt, /sale\.payments\?\.map/);
  assert.match(receipt, /formatUZS\(sale\.total\)/);
  assert.match(receipt, /sale\.sale_number/);
  assert.match(receipt, /sale\.receipt_phone_snapshot/);
  assert.match(receipt, /return createPortal\(/);
  assert.match(receipt, /className="receipt-print sale-receipt hidden/);
  assert.match(css, /\.receipt-print\.sale-receipt \{ display: block !important; \}/);
  assert.match(css, /body\.odina-sale-printing > #root \{ display: none !important; \}/);
});

const start = receipt.indexOf('  useEffect(() => {\n    if (!print || !sale || afterPrintRef.current)');
const end = receipt.indexOf('  }, [print, sale]);', start);
assert.ok(start >= 0 && end > start, 'print effect exists');
const effectBody = receipt.slice(start, end + '  }, [print, sale]);'.length)
  .replace('  useEffect(() => {', '  const runEffect = () => {')
  .replace('  }, [print, sale]);', '  };');

function simulatePrint({ print = true, throws = false } = {}) {
  const calls = [];
  const classes = new Set();
  let afterprint;
  const sale = { id: 'saved-sale' };
  const context = {
    print, sale, afterPrintRef: { current: null },
    onAfterPrintRef: { current: (value) => calls.push(['after', value.id]) },
    document: { body: { classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
    } } },
    window: {
      addEventListener: (name, fn) => { assert.equal(name, 'afterprint'); afterprint = fn; },
      removeEventListener: (name, fn) => { if (name === 'afterprint' && afterprint === fn) afterprint = null; },
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      print: () => { calls.push(['print']); if (throws) throw new Error('printer unavailable'); },
    },
  };
  vm.runInNewContext(effectBody + '\nglobalThis.cleanup = runEffect();', context);
  return { calls, classes, afterprint: () => afterprint?.(), cleanup: () => context.cleanup?.(),
    current: () => context.afterPrintRef.current };
}

test('receipt finishes only after print and clears print mode once', () => {
  const result = simulatePrint();
  assert.deepEqual(result.calls, [['print']]);
  assert.equal(result.classes.has('odina-sale-printing'), true);
  result.afterprint();
  result.afterprint();
  assert.deepEqual(result.calls, [['print'], ['after', 'saved-sale']]);
  assert.equal(result.classes.has('odina-sale-printing'), false);
  assert.equal(result.current(), null);
  result.cleanup();
});

test('printer failure releases print mode; POS decides whether to ask for a service ticket', () => {
  const result = simulatePrint({ throws: true });
  assert.deepEqual(result.calls, [['print'], ['after', 'saved-sale']]);
  assert.equal(result.classes.has('odina-sale-printing'), false);
  assert.equal(result.current(), null);
  assert.match(pos, /if \(sale\?\.items\?\.length && !sale\?\.table_number_snapshot\)/);
  assert.match(pos, /onAfterPrint=\{finishSalePresentation\}/);
  assert.deepEqual(simulatePrint({ print: false }).calls, []);
});
