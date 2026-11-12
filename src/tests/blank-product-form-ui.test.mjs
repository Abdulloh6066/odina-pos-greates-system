import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
let source = readFileSync(new URL('../pages/BlankProductForm.jsx', import.meta.url), 'utf8')
 .replace("import { useOutletContext } from 'react-router-dom';", "const useOutletContext = () => ({ user: { name: 'Kassir Test' } });")
 .replace("import '@/styles/blank-product-form.css';", '');
source = source.replace(/from '([^']+)'/g, (_, path) => {
 const url = path.startsWith('@/') ? new URL('../'+path.slice(2)+'.js', import.meta.url).href : import.meta.resolve(path);
 return `from '${url}'`;
});
const code = ts.transpileModule(source, {compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {default: Page} = await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('touch keypad opens, replaces existing count, closes and reopens; invalid values cannot print', () => {
 let view;
 act(()=> { view=create(React.createElement(Page)); });
 const input=()=>view.root.findByType('input');
 const press=(label)=>act(()=>view.root.findAllByType('button').find(b=>b.props['aria-label']===label).props.onClick());
 act(()=>input().props.onFocus({target:{select(){}}}));
 assert.equal(input().props['aria-expanded'],true);
 press('2'); press('5'); assert.equal(input().props.value,'25');
 act(()=>view.root.findAllByType('button').find(b=>b.children.includes('Tayyor')).props.onClick());
 assert.equal(input().props['aria-expanded'],false);
 act(()=>input().props.onClick({currentTarget:{select(){}}}));
 press('3'); press('1'); assert.equal(input().props.value,'31');
 assert.equal(view.root.findAllByType('button').find(b=>b.children.includes('Tayyor')).props.disabled,true);
 assert.equal(view.root.findAllByType('button').at(-1).props.disabled,true);
 press('Oxirgi raqamni o‘chirish'); assert.equal(input().props.value,'3');
 press('Tozalash'); assert.equal(input().props.value,'');
 act(()=>input().props.onKeyDown({key:'Escape',preventDefault(){}}));
 assert.equal(input().props['aria-expanded'],false);
 act(()=>view.unmount());
});
