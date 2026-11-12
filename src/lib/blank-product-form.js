export function validRowCount(value) {
  const count = Number(value);
  return /^\d+$/.test(String(value)) && Number.isInteger(count) && count >= 1 && count <= 30;
}
export function formWriter(user) {
  return String(user?.name || user?.full_name || '').trim();
}
