import { uzbekistanDateKey } from './uzbekistan-time';

// Mirror of the server-side normalizePhone so client lookups match stored keys.
export function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('998')) return digits;
  if (digits.length === 9) return '998' + digits;
  if (digits.startsWith('8') && digits.length === 10) return '998' + digits.slice(1);
  return digits;
}

export function fullName(customer) {
  return [customer?.first_name, customer?.last_name].filter(Boolean).join(' ').trim() || customer?.first_name || customer?.phone || '';
}

export function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('998') && digits.length === 12) {
    return `+998 ${digits.slice(3, 5)} ${digits.slice(5, 8)}-${digits.slice(8, 10)}-${digits.slice(10, 12)}`;
  }
  return phone || '';
}

export function birthdayDisplay(birthDate) {
  if (!birthDate) return '';
  const [, mm, dd] = String(birthDate).split('-').map(Number);
  const MONTHS_UZ = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
  return `${dd} ${MONTHS_UZ[mm - 1] || ''}`;
}

export function nextBirthdayInfo(birthDate, now = Date.now()) {
  if (!birthDate) return null;
  const [by, bm, bd] = String(birthDate).split('-').map(Number);
  if (!by || !bm || !bd) return null;
  const today = uzbekistanDateKey(now).split('-').map(Number);
  const ty = today[0]; const tm = today[1]; const td = today[2];
  let nextYear = ty;
  if (bm < tm || (bm === tm && bd < td)) nextYear = ty + 1;
  const nextDate = `${nextYear}-${String(bm).padStart(2, '0')}-${String(bd).padStart(2, '0')}`;
  const isToday = bm === tm && bd === td;
  const isTomorrow = (() => {
    const tmr = new Date(Date.now() + 86400000);
    const tk = uzbekistanDateKey(tmr.getTime()).split('-').map(Number);
    return bm === tk[1] && bd === tk[2];
  })();
  return { date: nextDate, isToday, isTomorrow };
}