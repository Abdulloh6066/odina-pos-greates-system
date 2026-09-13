// Offline-only regression tests for website date/time display.
// No Base44 records or external services are accessed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatUzbekistanDateTime,
  formatUzbekistanTime,
  shiftDateKey,
  uzbekistanDateKey,
  uzbekistanDateParts,
  uzbekistanMonthKey,
  uzbekistanMonthStartKey,
} from '../src/lib/uzbekistan-time.js';

test('UTC evening crosses into the next Uzbekistan calendar day', () => {
  const instant = '2026-09-12T19:30:00.000Z';
  assert.equal(uzbekistanDateKey(instant), '2026-09-13');
  assert.deepEqual(uzbekistanDateParts(instant), {
    year: '2026',
    month: '09',
    day: '13',
  });
  assert.equal(uzbekistanMonthKey(instant), '2026-09');
  assert.equal(uzbekistanMonthStartKey(instant), '2026-09-01');
  assert.match(formatUzbekistanTime(instant), /00:30/);
});

test('all displayed date-times use a 24-hour Uzbekistan clock without a zone label', () => {
  const text = formatUzbekistanDateTime('2026-09-13T18:59:00.000Z');
  assert.match(text, /13/);
  assert.match(text, /23:59/);
  assert.doesNotMatch(text, /Toshkent|Tashkent|Asia\//i);
});

test('calendar-day shifting stays stable across month and year boundaries', () => {
  assert.equal(shiftDateKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDateKey('2026-12-31', 1), '2027-01-01');
});

test('invalid timestamps never appear as the current time', () => {
  assert.equal(uzbekistanDateKey('invalid'), '');
  assert.equal(formatUzbekistanDateTime('invalid'), '—');
  assert.equal(formatUzbekistanDateTime(''), '—');
});
