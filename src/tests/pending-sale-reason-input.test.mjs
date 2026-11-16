import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

// Render the real dialog with inert UI and server adapters: no live sales or calls.
let source = readFileSync(new URL('../components/pos/PendingSalesDialog.jsx', import.meta.url), 'utf8');
source = source.replace(/import \{ ([^}]+) \} from 'lucide-react';/, (_, names) =>
  'const ' + names.split(',').map(name => name.trim() + " = 'span'").join(', ') + ';');
source = source
  .replace("import { base44 } from '@/api/base44Client';", "const base44 = { functions: { invoke: async () => ({ data: { state: 'pending', shift_status: 'open', subtotal: 100 } }) } };")
  .replace("import { formatUZS } from '@/lib/pos';", "const formatUZS = String;")
  .replace("import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';", "const formatUzbekistanDateTime = String;")
  .replace("import { syncErrorMessage } from '@/lib/offline-sales';", "const syncErrorMessage = error => error.message;")
  .replace("import { Button } from '@/components/ui/button';", "const Button = 'button';")
  .replace("import { Input } from '@/components/ui/input';", "const Input = 'input';")
  .replace("import { Label } from '@/components/ui/label';", "const Label = 'label';")
  .replace("import { Textarea } from '@/components/ui/textarea';", "const Textarea = 'textarea';")
  .replace("import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';", "const Dialog = 'section', DialogContent = 'article', DialogHeader = 'header', DialogTitle = 'h2';")
  .replace("from 'react'", "from " + JSON.stringify(import.meta.resolve('react')));
const code = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText;
const { default: PendingSalesDialog } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

for (const state of [{ online: false, syncing: false }, { online: true, syncing: true }]) {
  test('reason remains editable and submission blocked during ' + (!state.online ? 'disconnection' : 'background sync'), async () => {
    let view;
    let calls = 0;
    let finish;
    const props = {
      records: [{ id: 'mock-sale', status: 'failed', created_at: '2026-11-16', request: { items: [], payments: [] }, local_sale: { total: 100 } }],
      online: true, syncing: false, onClose() {}, onRetry() {}, onResolve() {},
      onResolveAll: async () => { calls++; return await new Promise(resolve => { finish = resolve; }); },
    };
    await act(async () => { view = create(React.createElement(PendingSalesDialog, props)); });
    const field = () => view.root.findByProps({ id: 'pending-sale-reason' });
    const submit = () => view.root.findByProps({ type: 'submit' });
    const form = () => view.root.findByType('form');
    act(() => view.root.findAllByType('button').find(button =>
      button.children.some(child => typeof child === 'string' && child.includes('Hammasini navbatdan olib tashlash'))
    ).props.onClick());
    act(() => view.root.findByProps({ id: 'pending-sale-pin' }).props.onChange({ target: { value: '1234' } }));
    await act(async () => { view.update(React.createElement(PendingSalesDialog, { ...props, ...state })); });
    assert.equal(field().props.disabled, false);
    act(() => field().props.onChange({ target: { value: 'Takroriy savdo 123' } }));
    assert.equal(field().props.value, 'Takroriy savdo 123');
    assert.equal(submit().props.disabled, true);
    await act(async () => { form().props.onSubmit({ preventDefault() {} }); });
    assert.equal(calls, 0, 'blocked submit must not call the cancellation handler');
    await act(async () => { view.update(React.createElement(PendingSalesDialog, props)); });
    assert.equal(field().props.value, 'Takroriy savdo 123');
    assert.equal(submit().props.disabled, false);
    act(() => form().props.onSubmit({ preventDefault() {} }));
    assert.equal(calls, 1);
    assert.equal(field().props.disabled, true, 'freeze the submitted reason only while cancellation runs');
    await act(async () => { finish({ results: [], errors: [] }); });
    act(() => view.unmount());
  });
}
