// Run the actual POS close callback and render the existing financial report.
// Mocked responses only: no SDK connection, native printer or live financial writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

const pos = readFileSync('src/pages/POS.jsx', 'utf8');
const start = pos.indexOf('  const closeShift = async');
const end = pos.indexOf('  const recordCashWithdrawal =', start);
assert.ok(start >= 0 && end > start);
const closeSource = pos.slice(start, end) + '\nglobalThis.testClose = closeShift;';
const body = { actual_cash: 1000, budget_cash_submitted: 500, cash_left_for_next_shift: 500 };
const closed = { id: 'shift', status: 'closed', shop_name: 'Do‘kon', user_name: 'Kassir',
  cash_sales: 1000, total_sales: 2200, uzcard_sales: 1200, humo_sales: 0, expected_cash: 1000,
  actual_cash: 1000, budget_cash_submitted: 500, cash_left_for_next_shift: 500, difference: 0,
  stock_count_completed: true, stock_snapshot_count: 5 };

function harness(payload) {
  const state = {}, warnings = [], alerts = [], calls = [];
  const context = {
    closingShiftRef: { current: false }, shiftMutationRef: { current: 0 }, shiftToClose: { id: 'shift' },
    isOnline: true, offlineStorageError: '', offlineSales: [],
    base44: { functions: { invoke: async (name, request) => { calls.push({ name, request }); return { data: payload }; } } },
    toast: warning => warnings.push(warning), odinaAlert: async message => alerts.push(message), loadAll: async () => {},
  };
  for (const field of ['ShiftLoading', 'ShiftReport', 'Shift', 'CloseShiftOpen', 'ShiftToClose']) {
    context['set' + field] = value => { state[field] = value; };
  }
  vm.runInNewContext(closeSource, context);
  return { state, warnings, alerts, calls, run: () => context.testClose(body) };
}

test('normal confirmed closure retains the usual financial report and does not show an auxiliary warning', async () => {
  const f = harness({ shift: closed, stock_report: { rows: [], complete: true } });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, 'shift-close-v2');
  assert.equal(f.state.ShiftReport, closed);
  assert.equal(f.state.Shift, null);
  assert.equal(f.state.CloseShiftOpen, false);
  assert.equal(f.state.ShiftToClose, null);
  assert.equal(f.state.ShiftLoading, false);
  assert.equal(f.warnings.length, 0);
  assert.equal(f.alerts.length, 0);
});

test('confirmed closure with unavailable stock details shows a nonmodal Uzbek warning and keeps the saved report', async () => {
  const warning = 'Smena yopilgani va mablag‘lar saqlangani tasdiqlandi. Qoldiq tafsilotlari yuklanmadi.';
  const before = structuredClone(closed);
  const f = harness({ shift: closed, details_warning: warning, stock_report: { rows: [], complete: false } });
  await f.run();
  assert.equal(f.state.ShiftReport, closed);
  assert.deepEqual(closed, before);
  assert.equal(f.state.ShiftReport.stock_count_completed, true);
  assert.equal(f.state.ShiftReport.stock_snapshot_count, 5);
  assert.equal(f.state.Shift, null);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0].title, 'Smena yopildi');
  assert.equal(f.warnings[0].description, warning);
  assert.equal(f.alerts.length, 0, 'A modal alert must not interrupt report printing');
  assert.equal(f.calls.length, 1, 'Presentation never repeats closure or financial writes');
});

test('incomplete stock details get a fallback warning even without a backend warning string', async () => {
  const f = harness({ shift: closed, stock_report: { rows: [], complete: false } });
  await f.run();
  assert.equal(f.state.ShiftReport, closed);
  assert.match(f.warnings[0].description, /Smena yopildi.*Smenalar tarixidan/);
  assert.equal(f.calls.length, 1);
});

test('the existing shift report prints confirmed financial fields independently of unavailable auxiliary stock rows', () => {
  const report = readFileSync('src/components/pos/ShiftReport.jsx', 'utf8');
  const source = report.replace(/^import .+\n/gm, '').replace('export default function', 'function');
  const compiled = transformSync(source + '\nglobalThis.TestReport = ShiftReport;', { loader: 'jsx', jsx: 'transform' }).code;
  const context = { React, useEffect: React.useEffect, useRef: React.useRef,
    createPortal: children => children, document: { body: {} },
    startReceiptPrint: () => { throw new Error('Native printing is disabled in render tests'); },
    toast: () => {}, formatUZS: value => `${Number(value || 0)} UZS`, formatUzbekistanDateTime: () => 'Sana' };
  vm.runInNewContext(compiled, context);
  const html = renderToStaticMarkup(React.createElement(context.TestReport, { shift: closed, onAfterPrint: () => {} }));
  assert.match(html, /SMENA HISOBOTI/);
  assert.match(html, /Bank card savdosi/);
  assert.match(html, /1200 UZS/);
  assert.match(html, /2200 UZS/);
  assert.match(html, /Budgetga naqd topshirildi/);
  assert.match(html, /Kassada qoldirildi/);
  assert.match(report, /return startReceiptPrint\(/);
  assert.doesNotMatch(report, /functions\.invoke|entities\./);
});

