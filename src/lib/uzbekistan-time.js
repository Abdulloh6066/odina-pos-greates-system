export const UZBEKISTAN_TIME_ZONE = 'Asia/Tashkent';

const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: UZBEKISTAN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function validDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function uzbekistanDateParts(value = Date.now()) {
  const date = validDate(value);
  if (!date) return null;
  const values = Object.fromEntries(
    dateKeyFormatter.formatToParts(date).map(({ type, value: part }) => [type, part]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
  };
}

export function uzbekistanDateKey(value = Date.now()) {
  const parts = uzbekistanDateParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
}

export function uzbekistanMonthKey(value = Date.now()) {
  return uzbekistanDateKey(value).slice(0, 7);
}

export function uzbekistanMonthStartKey(value = Date.now()) {
  const month = uzbekistanMonthKey(value);
  return month ? `${month}-01` : '';
}

export function shiftDateKey(dateKey, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return '';
  const shifted = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + Number(days || 0),
  ));
  return shifted.toISOString().slice(0, 10);
}

export function formatUzbekistan(value, options = {}) {
  const date = validDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('uz-UZ', {
    ...options,
    timeZone: UZBEKISTAN_TIME_ZONE,
  }).format(date);
}

export function formatUzbekistanDateTime(value, options = {}) {
  return formatUzbekistan(value, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...options,
  });
}

export function formatUzbekistanDate(value, options = {}) {
  return formatUzbekistan(value, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...options,
  });
}

export function formatUzbekistanTime(value, options = {}) {
  return formatUzbekistan(value, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...options,
  });
}
