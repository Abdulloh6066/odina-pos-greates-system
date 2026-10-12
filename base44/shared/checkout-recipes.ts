// One checkout request's RAW recipes. Nothing is shared between transactions.
// Optional cost reads may fall back per product; mandatory ingredient reads
// always propagate a failed bulk read so deductions can never be skipped.
export type CheckoutRecipeLoader = {
  recipesForProduct: (productId: string, required?: boolean) => Promise<any[]>;
  itemsForRecipe: (recipeId: string, required?: boolean) => Promise<any[]>;
};

async function readScopedRows(entity: any, query: any, sort?: string): Promise<any[]> {
  const result: any[] = [];
  const seen = new Set<string>();
  for (let skip = 0; skip < 10000; skip += 500) {
    const rows = await entity.filter(query, sort, 500, skip);
    if (!Array.isArray(rows)) throw new Error("Tex-karta javobi noto‘g‘ri.");
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) throw new Error("Tex-karta sahifalari takrorlandi.");
      seen.add(row.id); result.push(row);
    }
    if (rows.length < 500) return result;
  }
  throw new Error("Tex-karta ma’lumotlari juda katta.");
}

const groupRows = (rows: any[], key: string) => {
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const id = String(row[key] || "");
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(row);
  }
  return groups;
};

const orderedRecipeItems = (rows: any[]) => [...rows].sort((left, right) =>
  (Number(left.position) || 0) - (Number(right.position) || 0)
    || String(left.id).localeCompare(String(right.id)));

export function createCheckoutRecipeLoader(service: any, inputIds: string[]): CheckoutRecipeLoader {
  const productIds = [...new Set(inputIds.map(String).filter(Boolean))];
  const allowedIds = new Set(productIds);
  let recipesPromise: Promise<Map<string, any[]>> | undefined;
  let itemsPromise: Promise<Map<string, any[]>> | undefined;
  const recipeFallbacks = new Map<string, Promise<any[]>>();
  const itemFallbacks = new Map<string, Promise<any[]>>();

  // Only the exceptional optional-cost fallback uses individual queries, and
  // its reads stay bounded even when a large basket has multiple failed cards.
  let active = 0;
  const waiting: Array<() => void> = [];
  const pump = () => { while (active < 4 && waiting.length) waiting.shift()!(); };
  const fallbackRead = (read: () => Promise<any[]>): Promise<any[]> => new Promise((resolve, reject) => {
    waiting.push(() => {
      active += 1;
      Promise.resolve().then(read).then(resolve, reject).finally(() => { active -= 1; pump(); });
    });
    pump();
  });

  const recipes = () => recipesPromise ??= (async () => {
    if (!productIds.length) return new Map<string, any[]>();
    // Retain the SDK's normal ordering for optional cost lookups. Required
    // ingredient callers still sort versions and reject duplicate active cards.
    return groupRows(await readScopedRows(service.entities.Recipe,
      { product_id: { $in: productIds }, active: true }), "product_id");
  })();
  const items = () => itemsPromise ??= (async () => {
    const byProduct = await recipes();
    const recipeIds = [...new Set([...byProduct.values()].flat().map(row => String(row.id)))];
    if (!recipeIds.length) return new Map<string, any[]>();
    // Position repeats between cards. Page by a unique key, then restore each
    // card's ingredient order locally instead of paging across tied positions.
    const byRecipe = groupRows(await readScopedRows(service.entities.RecipeItem,
      { recipe_id: { $in: recipeIds } }, "id"), "recipe_id");
    for (const [recipeId, rows] of byRecipe) byRecipe.set(recipeId, orderedRecipeItems(rows));
    return byRecipe;
  })();

  return {
    async recipesForProduct(productId, required = false) {
      if (!allowedIds.has(productId)) throw new Error("Mahsulot to‘lov savatida mavjud emas.");
      try { return [...((await recipes()).get(productId) || [])]; }
      catch (error) {
        if (required) throw error;
        if (!recipeFallbacks.has(productId)) {
          recipeFallbacks.set(productId, fallbackRead(() => readScopedRows(service.entities.Recipe,
            { product_id: productId, active: true })));
        }
        return [...await recipeFallbacks.get(productId)!];
      }
    },
    async itemsForRecipe(recipeId, required = false) {
      try { return [...((await items()).get(recipeId) || [])]; }
      catch (error) {
        if (required) throw error;
        if (!itemFallbacks.has(recipeId)) {
          itemFallbacks.set(recipeId, fallbackRead(async () => orderedRecipeItems(
            await readScopedRows(service.entities.RecipeItem, { recipe_id: recipeId }, "id"))));
        }
        return [...await itemFallbacks.get(recipeId)!];
      }
    },
  };
}
