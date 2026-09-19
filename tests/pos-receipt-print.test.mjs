import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const receipt = fs.readFileSync(new URL('../src/components/pos/Receipt.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('printable receipt uses the full saved sale contents outside the clipped dialog', () => {
  const content = receipt.slice(receipt.indexOf('const receiptContent = ('), receipt.indexOf('  return (\n    <Dialog'));
  assert.match(content, /sale\.items\?\.map/);
  assert.match(content, /sale\.payments\?\.map/);
  assert.match(content, /formatUZS\(sale\.total\)/);
  assert.match(content, /sale\.sale_number/);
  assert.match(receipt, /className="receipt-preview"\>\{receiptContent\}/);
  assert.match(receipt, /createPortal\(\s*<div className="receipt-print sale-receipt hidden[^"]*"\>\s*\{receiptContent\}/);
  assert.match(css, /\.receipt-print\.sale-receipt \{ display: block !important; \}/);
  assert.match(css, /body\.odina-sale-printing > #root \{ display: none !important; \}/);
});

const printAction = receipt.slice(
  receipt.indexOf('  const handlePrint = () => {'),
  receipt.indexOf('  const timeStr ='),
).trim();

function simulatePrint({ eligible, throws = false }) {
  const calls = [];
  const classes = new Set();
  let afterprint;
  const context = {
    afterPrintRef: { current: null },
    canOfferStaffTicket: eligible,
    setAskStaffTicket: (value) => calls.push(['ask', value]),
    document: { body: { classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
    } } },
    window: {
      addEventListener: (name, handler) => { assert.equal(name, 'afterprint'); afterprint = handler; },
      removeEventListener: (name, handler) => { if (name === 'afterprint' && afterprint === handler) afterprint = null; },
      print: () => { calls.push(['print']); if (throws) throw new Error('printer unavailable'); },
    },
  };
  vm.runInNewContext(printAction + '\nglobalThis.startPrint = handlePrint;', context);
  context.startPrint();
  return { calls, classes, afterprint: () => afterprint?.(), current: () => context.afterPrintRef.current };
}

test('walk-in sale asks about service ticket only after the print window closes', () => {
  const result = simulatePrint({ eligible: true });
  assert.deepEqual(result.calls, [['ask', false], ['print']]);
  assert.equal(result.classes.has('odina-sale-printing'), true);
  result.afterprint();
  assert.deepEqual(result.calls.at(-1), ['ask', true]);
  assert.equal(result.classes.has('odina-sale-printing'), false);
  assert.equal(result.current(), null);
});

test('table sale and failed print do not offer a second service ticket', () => {
  const table = simulatePrint({ eligible: false });
  table.afterprint();
  assert.deepEqual(table.calls, [['ask', false], ['print']]);
  const failure = simulatePrint({ eligible: true, throws: true });
  assert.deepEqual(failure.calls, [['ask', false], ['print']]);
  assert.equal(failure.current(), null);
  assert.equal(failure.classes.has('odina-sale-printing'), false);
});
