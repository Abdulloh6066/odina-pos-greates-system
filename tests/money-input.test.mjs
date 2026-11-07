import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import * as money from '../src/lib/money-input.js';

function loadComponent() {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync('src/components/ui/money-input.jsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(
    name => name === 'react' ? React : money, module, module.exports,
  );
  return module.exports.MoneyInput;
}

test('thousands, millions and billions display losslessly while raw amounts stay numeric', () => {
  for (const [raw, formatted] of [['3000', '3 000'], ['43000', '43 000'], ['1234567', '1 234 567'], ['1234567890', '1 234 567 890'], ['9007199254740993', '9 007 199 254 740 993'], ['-25000.50', '-25 000.50'], ['', ''], ['0', '0']]) {
    assert.equal(money.formatMoneyInput(raw), formatted);
    assert.equal(money.moneyEdit(formatted).value, raw);
  }
});

test('pasting spaces is supported; invalid/ambiguous strings are rejected, not converted to other money', () => {
  assert.equal(money.moneyEdit('1\u202f234\u00a0567').value, '1234567');
  for (const text of ['1,234', '1e6', '$3000', '3.00.00', '12-34', 'NaN', 'Infinity']) assert.equal(money.moneyEdit(text), null);
  assert.equal(money.moneyEdit('-').value, '');
  assert.equal(money.moneyEdit('3000.').formatted, '3 000.');
  assert.equal(money.moneyEdit('39 000', 2).caret, 2);
});

function setup(initial = '', numeric = false) {
  const Component = loadComponent();
  const received = [];
  const input = { value: '', selectionStart: 0, selectionEnd: 0,
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    setCustomValidity(message) { this.validationMessage = message; },
    ownerDocument: { createElement: () => ({ validationMessage: '' }) },
  };
  let setExternal;
  function Harness() {
    const [value, setValue] = React.useState(initial);
    setExternal = setValue;
    return React.createElement(Component, { value, type: 'number', min: 0, onChange: event => {
      received.push(event.target.value);
      assert.equal(event.currentTarget.value, event.target.value);
      setValue(numeric ? Number(event.target.value) : event.target.value);
    } });
  }
  let tree;
  act(() => { tree = create(React.createElement(Harness), { createNodeMock: () => input }); });
  const enter = (value, caret = value.length) => {
    input.value = value; input.selectionStart = input.selectionEnd = caret;
    act(() => tree.root.findByType('input').props.onChange({ target: input }));
  };
  return { tree, input, received, enter, reset: value => act(() => setExternal(value)) };
}

test('actual controlled component groups as typed and emits only raw values', () => {
  const { tree, received, enter, reset } = setup();
  for (const text of ['3', '30', '300', '3000', '3 0000']) enter(text);
  assert.equal(tree.root.findByType('input').props.value, '30 000');
  assert.deepEqual(received, ['3', '30', '300', '3000', '30000']);
  enter('43 000'); assert.equal(received.at(-1), '43000');
  enter(''); assert.equal(tree.root.findByType('input').props.value, '');
  reset('1234567890'); assert.equal(tree.root.findByType('input').props.value, '1 234 567 890');
  act(() => tree.unmount());
});

test('numeric consumers retain fractional typing, and external keypad changes reformat', () => {
  const { tree, enter, reset } = setup(0, true);
  enter('3000.'); assert.equal(tree.root.findByType('input').props.value, '3 000.');
  enter('3 000.50'); assert.equal(tree.root.findByType('input').props.value, '3 000.50');
  reset(43000); assert.equal(tree.root.findByType('input').props.value, '43 000');
  act(() => tree.unmount());
});

test('middle edits and separator deletion preserve cursor and remove adjacent digits', () => {
  const { tree, input, enter } = setup('3000');
  enter('39 000', 2); assert.equal(input.selectionStart, 2);
  input.value = '39 000'; input.setSelectionRange(3, 3);
  tree.root.findByType('input').props.onKeyDown({ key: 'Backspace', currentTarget: input });
  assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 3]);
  enter('3000', 1); assert.equal(tree.root.findByType('input').props.value, '3 000');
  input.value = '3 000'; input.setSelectionRange(1, 1);
  tree.root.findByType('input').props.onKeyDown({ key: 'Delete', currentTarget: input });
  assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 3]);
  enter('300', 1); assert.equal(tree.root.findByType('input').props.value, '300');
  enter('-'); assert.ok(input.validationMessage);
  act(() => tree.unmount());
});

test('money fields are explicitly marked; unrelated quantity and PIN fields stay untouched', () => {
  const cases = {
    'src/components/orders/OrderForm.jsx': 3,
    'src/components/pos/ShiftDialog.jsx': 3,
    'src/pages/Products.jsx': 4,
    'src/components/OpeningDebtDialog.jsx': 2,
    'src/components/warehouse/IngredientRequisitionsPanel.jsx': 1,
  };
  for (const [path, count] of Object.entries(cases)) {
    const source = readFileSync(path, 'utf8');
    assert.equal((source.match(/<Input data-money/g) || []).length, count);
    assert.doesNotMatch(source, /<Input data-money[^>]*type="password"/);
  }
  assert.doesNotMatch(readFileSync('src/pages/DiscountCodes.jsx', 'utf8'), /data-money/);
  assert.doesNotMatch(readFileSync('src/pages/POS.jsx', 'utf8'), /data-money/);
});
