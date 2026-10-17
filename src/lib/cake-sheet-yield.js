const EDIT_ROLES = new Set(['admin', 'accountant']);
const CAKE_CATEGORIES = new Set(['15somlik', '18somlik', 'aralash', 'mini/tart', 'tortlar', 'cakes']);

const categoryKey = value => String(value || '').normalize('NFKC').toLocaleLowerCase('uz')
  .replace(/['‘’ʻʼ`]/g, '').replace(/\s+/g, '').replace(/:/g, '/');
const productionUnit = product => product?.production_unit || 'piece';

// This setting records the future cutting ratio. It does not change inventory units.
export function isCakeSheetYieldProduct(product) {
  return Boolean(product && product.active !== false && product.archived !== true
    && product.track_stock !== false && product.sale_unit !== 'gram'
    && (product.source_type || 'central_produced') === 'central_produced'
    && (productionUnit(product) === 'sheet' || CAKE_CATEGORIES.has(categoryKey(product.category_name))));
}

export function savedCakeSheetYield(product) {
  return Number.isSafeInteger(product?.pieces_per_sheet) && product.pieces_per_sheet > 0
    ? String(product.pieces_per_sheet) : '';
}

export function parseCakeSheetYield(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function expectedField(product, field) {
  if (!Object.prototype.hasOwnProperty.call(product, field) || product[field] === undefined) return { $exists: false };
  // Mongo null equality also matches missing fields; require an actual stored null.
  return product[field] === null ? { $eq: null, $exists: true } : product[field];
}

const isVerified = (row, id, value) => row?.id === id && isCakeSheetYieldProduct(row)
  && productionUnit(row) === 'piece' && row.pieces_per_sheet === value;

async function readBack(entity, id) {
  try { return await entity.get(id); }
  catch { throw problem('UNCONFIRMED', 'Saqlanganini tasdiqlab bo‘lmadi. Mahsulotlarni yangilab, saqlangan sonni tekshiring.'); }
}

// Use the existing user-mode Product entity. Server RLS and schema validation
// remain authoritative; no service-role client or backend function is involved.
export async function saveCakeSheetYield({ entity, user, product, value }) {
  if (!EDIT_ROLES.has(user?.role) || user?.active === false) {
    throw problem('FORBIDDEN', 'Bu sozlamani faqat admin yoki hisobchi saqlashi mumkin.');
  }
  const parsed = parseCakeSheetYield(value);
  if (parsed === null) throw problem('VALIDATION', '1 listdan chiqadigan bo‘lak sonini musbat butun son bilan kiriting.');
  if (!product?.id || !isCakeSheetYieldProduct(product)) {
    throw problem('VALIDATION', 'Faol tort yoki pishiriq mahsulotini tanlang.');
  }
  if (productionUnit(product) !== 'piece') {
    throw problem('FORBIDDEN', 'Listli mahsulotning amaldagi bo‘lak sozlamasi bu oynada o‘zgartirilmaydi.');
  }
  if (typeof entity?.updateMany !== 'function' || typeof entity?.get !== 'function') {
    throw problem('UNCONFIRMED', 'Mahsulot sozlamasini saqlash xizmati mavjud emas.');
  }

  if (product.pieces_per_sheet === parsed) {
    const current = await readBack(entity, product.id);
    if (!isVerified(current, product.id, parsed)) {
      throw problem('CONFLICT', 'Mahsulot boshqa joyda o‘zgargan. Ro‘yxatni yangilab qayta tekshiring.');
    }
    return current;
  }

  const filter = {
    id: product.id,
    production_unit: expectedField(product, 'production_unit'),
    pieces_per_sheet: expectedField(product, 'pieces_per_sheet'),
    source_type: expectedField(product, 'source_type'),
    category_name: expectedField(product, 'category_name'),
    active: { $ne: false }, archived: { $ne: true },
    track_stock: { $ne: false }, sale_unit: { $ne: 'gram' },
  };
  let result;
  try {
    result = await entity.updateMany(filter, { $set: { pieces_per_sheet: parsed } });
  } catch (error) {
    const status = Number(error?.response?.status || error?.status || 0);
    if (status && status !== 408 && status !== 429 && status < 500) {
      throw problem([401, 403].includes(status) ? 'FORBIDDEN' : 'VALIDATION',
        error?.response?.data?.error || error?.message || 'Mahsulot sozlamasi saqlanmadi.');
    }
    // A lost response may follow a successful write. Verify once; never resend.
    const current = await readBack(entity, product.id);
    if (isVerified(current, product.id, parsed)) return current;
    throw problem('UNCONFIRMED', 'Saqlash natijasi tasdiqlanmadi. Ro‘yxatni yangilab, mahsulot holati va sonini tekshiring.');
  }
  if (Number(result?.updated) === 0) {
    throw problem('CONFLICT', 'Mahsulot boshqa joyda o‘zgargan. Ro‘yxatni yangilab qayta tekshiring.');
  }
  if (result?.success !== true || Number(result.updated) !== 1) {
    throw problem('UNCONFIRMED', 'Saqlash tasdig‘i noto‘g‘ri. Ro‘yxatni yangilab, saqlangan sonni tekshiring.');
  }
  const current = await readBack(entity, product.id);
  if (!isVerified(current, product.id, parsed)) {
    throw problem('CONFLICT', 'Mahsulot saqlashdan keyin o‘zgargan. Ro‘yxatni yangilab qayta tekshiring.');
  }
  return current;
}
