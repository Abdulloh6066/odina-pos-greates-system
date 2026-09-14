import test from 'node:test';
import assert from 'node:assert/strict';
import {
  birthdayWindowMatches,
  buildBirthdayMessage,
  buildBirthdayKeyboard,
  addDaysToDateKey,
  birthdayDisplay,
  birthdayDedupKey,
  BIRTHDAY_STATUS_LABELS,
} from '../base44/shared/birthday-logic.ts';

const mk = (id, first, mm, dd, yy = 1990, phone = '+998900000000', last = '') => ({
  id, first_name: first, last_name: last, phone, birth_date: `${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`,
});

test('addDaysToDateKey handles year-end and leap year', () => {
  assert.equal(addDaysToDateKey('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToDateKey('2027-12-31', 1), '2028-01-01');
  assert.equal(addDaysToDateKey('2024-02-28', 1), '2024-02-29'); // leap
  assert.equal(addDaysToDateKey('2025-02-28', 1), '2025-03-01'); // non-leap
});

test('1) birthday today is included with Bugun label', () => {
  const m = birthdayWindowMatches([mk('a','Ali',9,13)], '2026-09-13');
  assert.equal(m.length, 1);
  assert.equal(m[0].days_remaining, 0);
  assert.equal(m[0].label, "Bugun tug'ilgan kuni");
});

test('2) birthday tomorrow is included with Ertaga label', () => {
  const m = birthdayWindowMatches([mk('a','Vali',9,14)], '2026-09-13');
  assert.equal(m.length, 1);
  assert.equal(m[0].days_remaining, 1);
  assert.equal(m[0].label, "Ertaga tug'ilgan kuni");
});

test('3) birthdays in 2 and 3 days are included', () => {
  const m = birthdayWindowMatches([mk('a','A',9,15), mk('b','B',9,16)], '2026-09-13');
  assert.equal(m.length, 2);
  assert.deepEqual(m.map(x=>x.days_remaining).sort(), [2,3]);
});

test('4) birthday in 4 days is excluded', () => {
  const m = birthdayWindowMatches([mk('a','A',9,17)], '2026-09-13');
  assert.equal(m.length, 0);
});

test('5) year-end December/January calculation works', () => {
  // today Dec 31, birthday Jan 2 -> in 2 days
  const m = birthdayWindowMatches([mk('a','A',1,2)], '2026-12-31');
  assert.equal(m.length, 1);
  assert.equal(m[0].days_remaining, 2);
  assert.equal(m[0].campaign_year, 2027);
  // today Dec 30, birthday Dec 31 -> tomorrow
  const m2 = birthdayWindowMatches([mk('b','B',12,31)], '2026-12-30');
  assert.equal(m2[0].days_remaining, 1);
  assert.equal(m2[0].campaign_year, 2026);
});

test('6) birth year does not affect matching', () => {
  const m = birthdayWindowMatches([
    mk('old','Old',9,13,1950),
    mk('young','Young',9,13,2020),
  ], '2026-09-13');
  assert.equal(m.length, 2);
});

test('Feb 29 birthday only matches in leap-year campaign', () => {
  // 2028 is leap. today 2028-02-26 -> Feb 29 is 3 days
  const leap = birthdayWindowMatches([mk('a','Leap',2,29)], '2028-02-26');
  assert.equal(leap.length, 1);
  assert.equal(leap[0].days_remaining, 3);
  // 2027 non-leap: Feb 29 never occurs
  const nonLeap = birthdayWindowMatches([mk('a','Leap',2,29)], '2027-02-26');
  assert.equal(nonLeap.length, 0);
});

test('7) hali aloqa qilinmadi is included in message', () => {
  const matches = birthdayWindowMatches([mk('a','Ali',9,13)], '2026-09-13');
  const fu = new Map([['a',{contact_status:'hali_aloqa_qilinmadi'}]]);
  const msg = buildBirthdayMessage(matches, fu);
  assert.match(msg, /Ali/);
  assert.match(msg, /Hali aloqa qilinmadi/);
});

test('8) qongiroq javob bolmadi is included in message', () => {
  const matches = birthdayWindowMatches([mk('a','Ali',9,13)], '2026-09-13');
  const fu = new Map([['a',{contact_status:'qongiroq_javob_bolmadi'}]]);
  const msg = buildBirthdayMessage(matches, fu);
  assert.match(msg, /Ali/);
  assert.match(msg, /Qo'ng'iroq qilindi, javob bo'lmadi/);
});

test('9) aloqa chiqildi is excluded from message', () => {
  const matches = birthdayWindowMatches([mk('a','Ali',9,13), mk('b','B',9,14)], '2026-09-13');
  const fu = new Map([['a',{contact_status:'aloqa_chiqildi'}], ['b',{contact_status:'hali_aloqa_qilinmadi'}]]);
  const msg = buildBirthdayMessage(matches, fu);
  assert.equal(msg.includes('Ali'), false);
  assert.match(msg, /B/);
  assert.match(msg, /Jami bog'lanish kerak: 1/);
});

test('10) contacted status is scoped to campaign year (different year = different followup)', () => {
  // Same customer, two campaign years: aloqa in 2026 should not block 2027
  const fu2026 = { contact_status: 'aloqa_chiqildi' };
  const matches2027 = birthdayWindowMatches([mk('a','Ali',9,13)], '2027-09-13');
  assert.equal(matches2027[0].campaign_year, 2027);
  // A fresh followup map for 2027 (no record) defaults to hali -> included
  const fu2027 = new Map();
  const msg = buildBirthdayMessage(matches2027, fu2027);
  assert.match(msg, /Ali/);
  // Confirm the 2026 aloqa record does not match the 2027 campaign key
  assert.notEqual(fu2026.contact_status, 'hali_aloqa_qilinmadi');
});

test('11) customer becomes eligible again next year (no permanent disable)', () => {
  const thisYear = birthdayWindowMatches([mk('a','Ali',9,13)], '2026-09-13');
  const nextYear = birthdayWindowMatches([mk('a','Ali',9,13)], '2027-09-13');
  assert.equal(thisYear.length, 1);
  assert.equal(nextYear.length, 1);
  assert.notEqual(thisYear[0].campaign_year, nextYear[0].campaign_year);
});

test('message groups by days remaining and shows counters', () => {
  const matches = birthdayWindowMatches([
    mk('a','Ali',9,13), mk('b','B',9,14), mk('c','C',9,15), mk('d','D',9,16),
  ], '2026-09-13');
  const fu = new Map();
  const msg = buildBirthdayMessage(matches, fu);
  assert.match(msg, /Bugun tug'ilgan kuni/);
  assert.match(msg, /Ertaga tug'ilgan kuni/);
  assert.match(msg, /2 kun qoldi/);
  assert.match(msg, /3 kun qoldi/);
  assert.match(msg, /Jami bog'lanish kerak: 4/);
});

test('no eligible customers returns empty message', () => {
  const matches = birthdayWindowMatches([], '2026-09-13');
  const msg = buildBirthdayMessage(matches, new Map());
  assert.equal(msg, '');
});

test('birthdayDisplay formats day and Uzbek month name', () => {
  assert.equal(birthdayDisplay(9, 13), '13 Sentabr');
  assert.equal(birthdayDisplay(1, 2), '2 Yanvar');
});

test('dedup key is per customer per birthday date', () => {
  assert.equal(birthdayDedupKey('c1','2026-09-16'), 'birthday:c1:2026-09-16');
  assert.notEqual(birthdayDedupKey('c1','2026-09-16'), birthdayDedupKey('c1','2027-09-16'));
});

test('status labels cover all three statuses', () => {
  assert.equal(BIRTHDAY_STATUS_LABELS.hali_aloqa_qilinmadi, "Hali aloqa qilinmadi");
  assert.equal(BIRTHDAY_STATUS_LABELS.qongiroq_javob_bolmadi, "Qo'ng'iroq qilindi, javob bo'lmadi");
  assert.equal(BIRTHDAY_STATUS_LABELS.aloqa_chiqildi, "Aloqaga chiqildi");
});

test('buildBirthdayKeyboard emits one numbered row per eligible customer with callback data', () => {
  const matches = birthdayWindowMatches([
    mk('a','Ali',9,13), mk('b','B',9,14), mk('c','C',9,15),
  ], '2026-09-13');
  const fu = new Map([
    ['a', { id: 'fu-a', contact_status: 'hali_aloqa_qilinmadi' }],
    ['b', { id: 'fu-b', contact_status: 'hali_aloqa_qilinmadi' }],
    ['c', { id: 'fu-c', contact_status: 'aloqa_chiqildi' }],
  ]);
  const kb = buildBirthdayKeyboard(matches, fu);
  assert.ok(kb);
  // "c" excluded (aloqa_chiqildi); numbering 1,2 matches message order
  assert.equal(kb.inline_keyboard.length, 2);
  assert.equal(kb.inline_keyboard[0][0].text, '1. ❌ Javob yo'q');
  assert.equal(kb.inline_keyboard[0][1].callback_data, 'bd:fu-a:ok');
  assert.equal(kb.inline_keyboard[1][0].callback_data, 'bd:fu-b:no');
});

test('buildBirthdayKeyboard returns null when no followup ids are present', () => {
  const matches = birthdayWindowMatches([mk('a','Ali',9,13)], '2026-09-13');
  assert.equal(buildBirthdayKeyboard(matches, new Map()), null);
});