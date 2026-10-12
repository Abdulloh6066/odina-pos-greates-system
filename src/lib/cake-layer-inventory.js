export const isCakeLayer = (ingredient) => ingredient?.is_cake_layer === true;
export const ingredientUnitLabel = (ingredient) =>
  isCakeLayer(ingredient) ? 'list/qavat' : ({ g: 'g', ml: 'ml', piece: 'dona' }[ingredient?.base_unit] || '');

export function cakeLayerStockRows(ingredients, stocks, locationId) {
  return ingredients.filter((item) => isCakeLayer(item) && item.active !== false).map((ingredient) => {
    const matches = stocks.filter((stock) => stock.location_id === locationId && stock.ingredient_id === ingredient.id);
    const stock = matches[0];
    const quantity = stock ? Number(stock.quantity) : 0;
    const valid = matches.length <= 1 && ingredient.base_unit === 'piece'
      && (!stock || stock.unit === 'piece') && Number.isSafeInteger(quantity) && quantity >= 0;
    return { ingredient, quantity: valid ? quantity : 0, valid };
  });
}

// Capacities are alternatives: recipes that share stock cannot be added together.
export function calculateProductionCapacity({ product, recipe, lines, ingredients, stocks, locationId }) {
  const result = { possible: 0, layerPossible: 0, layers: [], issue: '' };
  if (!recipe || recipe.active === false || !lines?.length) return { ...result, issue: 'Faol retsept kiriting.' };
  const output = Number(recipe.output_quantity);
  if (!Number.isSafeInteger(output) || output <= 0
    || (recipe.output_unit || 'piece') !== (product.production_unit || 'piece')) {
    return { ...result, issue: 'Retsept natijasi mahsulot birligiga mos emas.' };
  }
  const seen = new Set();
  const limits = [];
  const layerLimits = [];
  for (const line of lines) {
    const ingredient = ingredients.find((item) => item.id === line.ingredient_id);
    const quantity = Number(line.quantity);
    if (!ingredient || ingredient.active === false || ingredient.category === 'household'
      || !Number.isFinite(quantity) || quantity <= 0 || line.unit !== ingredient.base_unit
      || seen.has(line.ingredient_id)) {
      return { ...result, issue: 'Retseptdagi masalliq yoki birlikni tekshiring.' };
    }
    seen.add(line.ingredient_id);
    const matches = stocks.filter((stock) => stock.location_id === locationId && stock.ingredient_id === line.ingredient_id);
    const stock = matches[0];
    const available = stock ? Number(stock.quantity) : 0;
    if (matches.length > 1 || (stock && stock.unit !== line.unit) || !Number.isFinite(available)) {
      return { ...result, issue: 'Ombor qoldig‘i yoki birligini tekshiring.' };
    }
    const perOutput = quantity / output;
    const limit = Math.max(0, Math.floor(Math.max(0, available) / perOutput + 1e-9));
    limits.push(limit);
    if (isCakeLayer(ingredient)) {
      if (ingredient.base_unit !== 'piece' || !Number.isSafeInteger(perOutput)
        || !Number.isSafeInteger(available) || available < 0) {
        return { ...result, issue: 'Qavatlar har bir mahsulot uchun butun list sonida kiritiladi.' };
      }
      result.layers.push({ ingredient, available, perOutput, possible: limit });
      layerLimits.push(limit);
    }
  }
  result.possible = Math.min(...limits);
  result.layerPossible = layerLimits.length ? Math.min(...layerLimits) : 0;
  return result;
}
