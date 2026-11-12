export function validRowCount(value) {
  const count = Number(value);
  return /^\d+$/.test(String(value)) && Number.isInteger(count) && count >= 1 && count <= 30;
}
export function formWriter(user) {
  return String(user?.name || user?.full_name || '').trim();
}

// First keypad digit replaces the old count; subsequent digits append.
export function rowCountKey(value, key, replace = false) {
  if (key === 'clear') return '';
  if (key === 'backspace') return String(value).slice(0, -1);
  if (!/^[0-9]$/.test(key)) return String(value);
  const next = (replace ? '' : String(value)) + key;
  return next.length <= 2 ? next : String(value);
}
