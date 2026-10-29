import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { readEntityPage } from '../src/lib/history-pagination.js';

const compile = filename => ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));

test('shop sync refreshes on events and reconnect, queues in-flight updates, and cleans up', async () => {
  const timers = new Map(), intervals = new Map(), subscriptions = new Map();
  const listeners = new Map();
  let cleanup, next = 0, reads = 0;
  const replies = [];
  const document = { visibilityState: 'visible',
    addEventListener: (key, cb) => listeners.set(key,cb),
    removeEventListener: key => listeners.delete(key) };
  const window = { addEventListener: (key,cb) => listeners.set(key,cb),
    removeEventListener: key => listeners.delete(key) };
  const navigator = { onLine: true };
  const module = {exports:{}};
  const require = name => {
    if(name==='react') return {useRef: current=>({current}),useEffect: cb=>{cleanup=cb();}};
    if(name==='@/api/base44Client') return {base44:{entities:Object.fromEntries(
      ['CustomerOrder','CustomerOrderItem','OrderPayment'].map(name=>[name,{
        subscribe: cb=>{subscriptions.set(name,cb);return()=>subscriptions.delete(name);}
      }]))}};
    throw Error(name);
  };
  vm.runInNewContext('(function(require,module,exports){'+compile('src/hooks/useOrderUpdates.js')+'\n})',{
    document,window,navigator,
    setTimeout:(cb)=>{timers.set(++next,cb);return next;},clearTimeout:id=>timers.delete(id),
    setInterval:(cb)=>{intervals.set(++next,cb);return next;},clearInterval:id=>intervals.delete(id),
  })(require,module,module.exports);
  module.exports.useOrderUpdates(()=>{reads++;return new Promise(resolve=>replies.push(resolve));},'branch');
  assert.equal(subscriptions.size,3);
  void listeners.get('focus')();
  assert.equal(reads,1);
  subscriptions.get('CustomerOrder')();
  [...timers.values()].at(-1)();
  assert.equal(reads,1);
  replies[0](); await flush();
  assert.equal(reads,2,'an event during a request causes another fresh read');
  replies[1](); await flush();
  document.visibilityState='hidden'; await listeners.get('visibilitychange')();
  navigator.onLine=false; document.visibilityState='visible'; await listeners.get('online')();
  assert.equal(reads,2);
  navigator.onLine=true; void listeners.get('online')();
  assert.equal(reads,3);
  replies[2](); await flush();
  cleanup();
  assert.equal(subscriptions.size,0);assert.equal(intervals.size,0);assert.equal(listeners.size,0);
});

test('quiet status refresh keeps loaded pages visible and preserves the pagination window', async () => {
  const timers = new Map(); let next=0, api, tree, release;
  const rows=Array.from({length:250},(_,i)=>({id:String(i).padStart(3,'0'),order_status:'qabul_qilindi',total:5000,shop_id:i%2?'branch':'central'}));
  let block=false;
  const entity={filter:async(_query,_sort,limit,skip)=>{
    if(block) await new Promise(resolve=>{release=resolve;});
    return structuredClone(rows.slice(skip,skip+limit));
  }};
  const module={exports:{}};
  const require=name=>{
    if(name==='react') return React;
    if(name==='@/lib/history-pagination') return {readEntityPage};
    throw Error(name);
  };
  vm.runInNewContext('(function(require,module,exports){'+compile('src/hooks/useEntityHistory.js')+'\n})',{
    Date,setTimeout:cb=>{timers.set(++next,cb);return next;},clearTimeout:id=>timers.delete(id),
  })(require,module,module.exports);
  function Harness(){api=module.exports.useEntityHistory(entity,{},'id');return null;}
  await act(async()=>{tree=create(React.createElement(Harness));});
  await act(async()=>{[...timers.values()][0]();await flush();});
  assert.equal(api.rows.length,100);
  await act(async()=>{await api.loadMore();});
  assert.equal(api.rows.length,200);
  rows[0].order_status='tayyor';
  block=true;
  let pending;
  await act(async()=>{pending=api.refresh();});
  assert.equal(api.loading,false);
  assert.equal(api.rows.length,200,'no blank list while the refresh is in flight');
  block=false;
  await act(async()=>{release();await pending;});
  assert.equal(api.rows.length,200);
  assert.equal(api.rows[0].order_status,'tayyor');
  assert.equal(api.rows[0].total,5000);
  assert.equal(api.rows[0].shop_id,'central');
  await act(async()=>{await api.loadMore();});
  assert.equal(api.rows.length,250);
  await act(async()=>{tree.unmount();});
});
