// Shared line identity and serialization for POS, saved orders and offline receipts.
// Missing options keep their original meaning and request fingerprints.
export const CAKE_EXTRA_AMOUNT = 5000;
const CAKE_CATEGORY_ID = '6ab57e00ab3a0a5019ea99db';

export const canChooseCakeExtra = (product, shopId) => product?.sale_unit !== 'gram'
  && (product?.shop_category_ids?.[shopId] || product?.category_id) === CAKE_CATEGORY_ID;

export function validateCakeExtra(row) {
  if (row?.cake_extra == null || row.cake_extra === false) return false;
  if (row.cake_extra !== true || row.fries_option || row.tea_option) {
    throw Object.assign(new Error('Tort qo‘shimchasi tanlovi noto‘g‘ri.'), { status: 400 });
  }
  return true;
}

export const cakeExtraSurcharge = row => row?.cake_extra === true ? CAKE_EXTRA_AMOUNT : 0;

export const saleLineKey = (row) =>
  String(row?.product_id || '')
  + (row?.fries_option === 'with' ? '::fries' : '')
  + (row?.tea_option === 'cup' ? '::tea-cup' : '')
  + (row?.cake_extra === true ? '::cake-extra' : '');

export const saleOptionFields = (row) => ({
  ...(['with', 'without'].includes(row?.fries_option) ? { fries_option: row.fries_option } : {}),
  ...(['cup', 'pot'].includes(row?.tea_option) ? { tea_option: row.tea_option } : {}),
  ...(row?.cake_extra === true ? { cake_extra: true } : {}),
});
