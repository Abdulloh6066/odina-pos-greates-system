// Shared POS/server rules for Branch's two burger options.
// Ingredient and serving size are owner-confirmed; prices always come from the server catalogue.
export const BURGER_FRIES_SHOP_ID = '6a96f0a4ecc85c2fc57f3174';
export const BURGER_PRODUCT_IDS = ['6ab747c5c1c33517e6eea448', '6ab747c5c1c33517e6eea449'];
export const FRIES_INGREDIENT_ID = '6aca42bb8a3025f47521338e';
export const FRIES_GRAMS = 150;
export const FRIES_SURCHARGE = 5000;

export const canChooseBurgerFries = (productId, shopId) =>
  shopId === BURGER_FRIES_SHOP_ID && BURGER_PRODUCT_IDS.includes(String(productId));

export function validateFriesOption(row, shopId) {
  const option = row?.fries_option;
  if (option === undefined || option === null || option === '') return '';
  if (!['with', 'without'].includes(option) || !canChooseBurgerFries(row?.product_id, shopId)) {
    const error = new Error('Fri tanlovi ushbu mahsulot yoki do‘kon uchun noto‘g‘ri.');
    error.status = 400;
    throw error;
  }
  return option;
}

// Missing options on old carts/receipts retain their original base-price meaning.
export const saleLineKey = (row) =>
  String(row?.product_id || '') + (row?.fries_option === 'with' ? '::fries' : '');
export const friesOptionFields = (row) =>
  ['with', 'without'].includes(row?.fries_option) ? { fries_option: row.fries_option } : {};
export const friesSurcharge = (row) => row?.fries_option === 'with' ? FRIES_SURCHARGE : 0;
export const burgerOptionName = (name, option) =>
  option === 'with' ? name + ' — Fri bilan' : option === 'without' ? name + ' — Frisiz' : name;

export function recipeWithBurgerFries(line, recipe) {
  if (line?.fries_option !== 'with') return recipe;
  if (!BURGER_PRODUCT_IDS.includes(String(line.product_id)) || !recipe?.items?.length
      || !Number.isFinite(Number(recipe.output_quantity)) || Number(recipe.output_quantity) <= 0) {
    const error = new Error('Fri bilan burger uchun to‘liq faol tex-karta kerak.');
    error.status = 409;
    throw error;
  }
  return { ...recipe, items: [...recipe.items, {
    ingredient_id: FRIES_INGREDIENT_ID,
    ingredient_name_snapshot: 'Kartoshka fri',
    quantity: FRIES_GRAMS * Number(recipe.output_quantity),
    unit: 'g',
  }] };
}

export function costWithBurgerFries(line, baseCost, ingredientCosts) {
  if (line?.fries_option !== 'with') return baseCost;
  const fries = ingredientCosts.get(FRIES_INGREDIENT_ID);
  return { ...baseCost,
    costPerPiece: baseCost.costPerPiece + FRIES_GRAMS * Number(fries?.cost || 0),
    hasPrice: baseCost.hasPrice && fries?.hasPrice === true,
    missing: fries?.hasPrice ? baseCost.missing : [...(baseCost.missing || []), 'Kartoshka fri'],
  };
}
