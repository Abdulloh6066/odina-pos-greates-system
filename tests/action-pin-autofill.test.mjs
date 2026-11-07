// Password-manager hints are best-effort: browsers/extensions control their own
// save prompts. Keep action PINs masked rather than using visible text inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const actionFiles = [
  'src/components/OpeningDebtPaymentDialog.jsx',
  'src/components/pos/PendingSalesDialog.jsx',
  'src/components/pos/KassaActionDialogs.jsx',
  'src/pages/Budget.jsx',
  'src/components/warehouse/SupplierLedgerPanel.jsx',
];
function inputs(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const result = [];
  function visit(node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === 'Input') {
      result.push(Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(attribute => [
        attribute.name.getText(source), attribute.initializer && ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : null,
      ])));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}
const hints = { type: 'password', autoComplete: 'one-time-code', 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-bwignore': 'true' };

test('every action PIN stays masked and asks browsers and password managers not to save it as a login', () => {
  let count = 0;
  for (const file of actionFiles) {
    const fields = inputs(file).filter(input => input.type === 'password');
    assert.ok(fields.length, `${file} must contain action PIN inputs`);
    for (const field of fields) {
      for (const [name, value] of Object.entries(hints)) assert.equal(field[name], value, `${file}: ${name}`);
      assert.equal(field.inputMode, 'numeric');
      count++;
    }
  }
  assert.equal(count, 7);
});

test('shared Input forwards hints into HTML without exposing the PIN as visible text', () => {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync('src/components/ui/input.jsx', 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const require = name => name === 'react' ? React : name === './money-input' ? { MoneyInput: () => { throw new Error('PIN inputs must not use money formatting'); } } : name === '@/lib/utils' ? { cn: (...values) => values.filter(Boolean).join(' ') } : (() => { throw new Error(name); })();
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})')(require, module, module.exports);
  const html = renderToStaticMarkup(React.createElement(module.exports.Input, { ...hints, inputMode: 'numeric', defaultValue: '' }));
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="one-time-code"/);
  for (const name of ['data-lpignore', 'data-1p-ignore', 'data-bwignore']) assert.ok(html.includes(`${name}="true"`));
});

test('real credentials and PIN setup are not reclassified as action codes', () => {
  for (const file of ['src/pages/Login.jsx', 'src/pages/Register.jsx', 'src/pages/ResetPassword.jsx',
    'src/pages/Mfa.jsx', 'src/components/admin/AdminAccessProvider.jsx', 'src/components/security/PinManager.jsx', 'src/pages/Settings.jsx']) {
    for (const input of inputs(file).filter(input => input.type === 'password')) {
      assert.notEqual(input.autoComplete, 'one-time-code', file);
      assert.equal(input['data-lpignore'], undefined, file);
      assert.equal(input['data-1p-ignore'], undefined, file);
    }
  }
});
