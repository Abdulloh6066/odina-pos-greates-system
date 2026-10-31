// Only the tea serving price changes. The owner explicitly kept recipe amounts unchanged.
export const TEA_PRODUCT_IDS = [
  '6ab66ca8ae6223ce0f93e60c', // Legacy combined green / black tea
  '6ace05d7ea4cdff9020d4a8d', // Ko‘k choy
  '6ace05d7ea4cdff9020d4a8c', // Qora choy
  '6ab6b03dfa815d9efa74363e', // Limon choy
  '6ab66ca8ae6223ce0f93e611', // Marokash
  '6ab66ca8ae6223ce0f93e610', // Oblepixa
  '6ab66ca8ae6223ce0f93e60f', // Imbir
  '6ab66ca8ae6223ce0f93e60e', // Mango marakuya
  '6ab66ca8ae6223ce0f93e60d', // Yagodniy
];
// Bardak stakan / Bardak chay are separate products with their own prices.
export const canChooseTeaServing = (productId) => TEA_PRODUCT_IDS.includes(String(productId));

export function validateTeaOption(row) {
  const option = row?.tea_option;
  if (option === undefined || option === null || option === '') return '';
  if (!['cup', 'pot'].includes(option) || !canChooseTeaServing(row?.product_id)) {
    const error = new Error('Choy tanlovi ushbu mahsulot uchun noto‘g‘ri.');
    error.status = 400;
    throw error;
  }
  return option;
}

export const teaServingPrice = (basePrice, option) =>
  Number(basePrice) / (option === 'cup' ? 2 : 1);
export const teaOptionName = (name, option) =>
  option === 'cup' ? name + ' — Stakan' : option === 'pot' ? name + ' — Choynik' : name;
