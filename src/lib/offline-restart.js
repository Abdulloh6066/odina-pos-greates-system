// Local continuity only, never a replacement for server authorization.
const PREFIX = 'odina-restart-v1:';
let identityGeneration = 0;
export const OFFLINE_MAX_AGE = 24 * 60 * 60 * 1000;
const scope = user => JSON.stringify([user?.id, user?.role, user?.shop_id || '']);
export function readRestartValue(key, maxAge = OFFLINE_MAX_AGE) {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + key) || 'null');
    const age = Date.now() - value?.savedAt;
    return value && age >= 0 && age < maxAge ? value.data : null;
  } catch { return null; }
}
export function saveRestartValue(key, data) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), data })); return true; }
  catch { return false; }
}
export function clearOfflineRestart() {
  identityGeneration++;
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* Does not delete the independent pending-sales database. */ }
}
async function sessionBinding() {
  const token = localStorage.getItem('base44_access_token') || localStorage.getItem('token');
  if (!token) return 'browser-cookie-session';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function rememberOfflineStaff(user, appId) {
  if (!user?.id || user.active === false || !['admin', 'manager', 'cashier'].includes(user.role)) {
    clearOfflineRestart(); return false;
  }
  try {
    const generation = identityGeneration;
    const { id, role, shop_id, shop_name, full_name } = user;
    const binding = await sessionBinding();
    if (generation !== identityGeneration) return false;
    return saveRestartValue('staff', { appId, binding,
      user: { id, role, shop_id, shop_name, full_name, active: true } });
  } catch { return false; }
}
export async function readOfflineStaff(appId) {
  try {
    const saved = readRestartValue('staff');
    if (saved?.appId !== appId || saved.binding !== await sessionBinding()) return null;
    return saved.user?.active && ['admin', 'manager', 'cashier'].includes(saved.user.role) ? saved.user : null;
  } catch { return null; }
}
export const readPosRestart = user => readRestartValue('pos:' + scope(user));
export const savePosRestart = (user, data) => saveRestartValue('pos:' + scope(user), data);
export const readShiftRestart = user => readRestartValue('shift:' + scope(user));
export function saveShiftRestart(user, shift) {
  if (!user?.id) return false;
  return saveRestartValue('shift:' + scope(user), { shift: shift?.status === 'open' ? shift : null });
}
export function offlineReadError() {
  return Object.assign(new Error('Internet yo‘q. Saqlangan kassa ma’lumotlari ishlatiladi.'), { code: 'ERR_NETWORK' });
}
export async function restartRead(read, timeoutMs = 8000) {
  if (globalThis.navigator?.onLine === false) throw offlineReadError();
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Aloqa vaqti tugadi.'), { code: 'ETIMEDOUT' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
// Do not put unpaid customer orders, private journals or embedded images in the cache.
export function restartCatalog({ cats, prods, shopList, operationalSettings, stockList }) {
  const image = value => typeof value === 'string' && !value.startsWith('data:') ? value : '';
  return { cats, prods: prods.map(p => ({ ...p, image_url: image(p.image_url) })),
    shopList: shopList.map(s => ({ id: s.id, name: s.name, active: s.active,
      allows_pos: s.allows_pos, location_type: s.location_type, instagram: s.instagram,
      phone: s.phone, address: s.address, pos_product_order: s.pos_product_order,
      pos_product_order_version: s.pos_product_order_version })), operationalSettings, stockList };
}