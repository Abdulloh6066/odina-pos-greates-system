export const FORECAST_ORDER_STATUSES = ["qabul_qilindi", "tayyorlanmoqda"];

const round3 = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : 0;
};

const positive = (value: unknown) => Math.max(0, round3(value));

type ForecastIssue = {
  type: string;
  message: string;
  product_id?: string;
  ingredient_id?: string;
};

export function buildProductionIngredientForecast(input: any = {}) {
  const {
    orders = [],
    orderItems = [],
    products = [],
    recipes = [],
    recipeItems = [],
    ingredientStocks = [],
    todayDate = "",
    tomorrowDate = "",
  } = input;

  const issues: ForecastIssue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (issue: ForecastIssue) => {
    const key = [issue.type, issue.product_id || "", issue.ingredient_id || "", issue.message].join("|");
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(issue);
    }
  };

  const relevantOrders = (Array.isArray(orders) ? orders : []).filter(
    (order: any) =>
      FORECAST_ORDER_STATUSES.includes(String(order?.order_status || "")) &&
      (order?.required_date === todayDate || order?.required_date === tomorrowDate),
  );
  const orderById = new Map(relevantOrders.map((order: any) => [String(order.id), order]));
  const productRequirements = new Map<string, any>();

  for (const item of Array.isArray(orderItems) ? orderItems : []) {
    const order = orderById.get(String(item?.order_id || ""));
    if (!order) continue;

    const productId = String(item?.product_id || "");
    const quantity = positive(item?.quantity);
    if (!productId || quantity <= 0) continue;

    if (!productRequirements.has(productId)) {
      productRequirements.set(productId, {
        product_id: productId,
        product_name: item?.product_name_snapshot || "Noma’lum mahsulot",
        unit: item?.unit_snapshot || "piece",
        today_quantity: 0,
        tomorrow_quantity: 0,
        total_quantity: 0,
      });
    }

    const requirement = productRequirements.get(productId);
    if (requirement.unit !== (item?.unit_snapshot || "piece")) {
      addIssue({
        type: "order_unit_mismatch",
        product_id: productId,
        message: `${requirement.product_name}: buyurtma birliklari bir xil emas.`,
      });
      continue;
    }

    if (order.required_date === todayDate) requirement.today_quantity += quantity;
    if (order.required_date === tomorrowDate) requirement.tomorrow_quantity += quantity;
    requirement.total_quantity += quantity;
  }

  const productById = new Map((Array.isArray(products) ? products : []).map((row: any) => [String(row.id), row]));
  const recipesByProduct = new Map<string, any[]>();
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    if (recipe?.active !== true) continue;
    const productId = String(recipe?.product_id || "");
    if (!recipesByProduct.has(productId)) recipesByProduct.set(productId, []);
    recipesByProduct.get(productId)!.push(recipe);
  }

  const itemsByRecipe = new Map<string, any[]>();
  for (const item of Array.isArray(recipeItems) ? recipeItems : []) {
    const recipeId = String(item?.recipe_id || "");
    if (!itemsByRecipe.has(recipeId)) itemsByRecipe.set(recipeId, []);
    itemsByRecipe.get(recipeId)!.push(item);
  }

  const ingredientNeeds = new Map<string, any>();
  const plannedProducts: any[] = [];
  const skippedProducts: any[] = [];

  for (const requirement of productRequirements.values()) {
    const product = productById.get(requirement.product_id);
    if (!product) {
      addIssue({
        type: "product_missing",
        product_id: requirement.product_id,
        message: `${requirement.product_name}: mahsulot topilmadi.`,
      });
      continue;
    }

    if (product.source_type !== "central_produced") {
      skippedProducts.push({ ...requirement, reason: "not_central_produced" });
      continue;
    }

    const productUnit = product.production_unit || "piece";
    if (requirement.unit !== productUnit) {
      addIssue({
        type: "product_unit_mismatch",
        product_id: product.id,
        message: `${product.name}: buyurtma va ishlab chiqarish birligi mos emas.`,
      });
      continue;
    }

    const activeRecipes = recipesByProduct.get(String(product.id)) || [];
    if (activeRecipes.length === 0) {
      addIssue({
        type: "missing_recipe",
        product_id: product.id,
        message: `${product.name}: faol tex-karta yo‘q.`,
      });
      continue;
    }
    if (activeRecipes.length > 1) {
      addIssue({
        type: "duplicate_recipe",
        product_id: product.id,
        message: `${product.name}: bir nechta faol tex-karta topildi.`,
      });
      continue;
    }

    const recipe = activeRecipes[0];
    const outputQuantity = positive(recipe?.output_quantity);
    if (outputQuantity <= 0 || (recipe?.output_unit || productUnit) !== productUnit) {
      addIssue({
        type: "invalid_recipe_output",
        product_id: product.id,
        message: `${product.name}: tex-karta natija miqdori yoki birligi noto‘g‘ri.`,
      });
      continue;
    }

    const lines = itemsByRecipe.get(String(recipe.id)) || [];
    if (lines.length === 0) {
      addIssue({
        type: "empty_recipe",
        product_id: product.id,
        message: `${product.name}: tex-kartada masalliqlar yo‘q.`,
      });
      continue;
    }

    plannedProducts.push({
      ...requirement,
      product_name: product.name || requirement.product_name,
      recipe_id: recipe.id,
      recipe_version: Number(recipe.version || 1),
      recipe_output_quantity: outputQuantity,
    });

    for (const line of lines) {
      const ingredientId = String(line?.ingredient_id || "");
      const lineQuantity = positive(line?.quantity);
      const unit = String(line?.unit || "");
      if (!ingredientId || lineQuantity <= 0 || !["g", "ml", "piece"].includes(unit)) {
        addIssue({
          type: "invalid_recipe_item",
          product_id: product.id,
          ingredient_id: ingredientId || undefined,
          message: `${product.name}: tex-kartadagi masalliq miqdori yoki birligi noto‘g‘ri.`,
        });
        continue;
      }

      const key = `${ingredientId}|${unit}`;
      if (!ingredientNeeds.has(key)) {
        ingredientNeeds.set(key, {
          ingredient_id: ingredientId,
          ingredient_name: line.ingredient_name_snapshot || "Noma’lum masalliq",
          unit,
          required_today: 0,
          required_tomorrow: 0,
          required_total: 0,
          products: [],
        });
      }

      const need = ingredientNeeds.get(key);
      const todayAmount = round3(lineQuantity * positive(requirement.today_quantity) / outputQuantity);
      const tomorrowAmount = round3(lineQuantity * positive(requirement.tomorrow_quantity) / outputQuantity);
      need.required_today += todayAmount;
      need.required_tomorrow += tomorrowAmount;
      need.required_total += todayAmount + tomorrowAmount;
      need.products.push({
        product_id: product.id,
        product_name: product.name,
        today_quantity: positive(requirement.today_quantity),
        tomorrow_quantity: positive(requirement.tomorrow_quantity),
        ingredient_quantity: round3(todayAmount + tomorrowAmount),
      });
    }
  }

  const stocksByIngredient = new Map<string, any[]>();
  for (const stock of Array.isArray(ingredientStocks) ? ingredientStocks : []) {
    const ingredientId = String(stock?.ingredient_id || "");
    if (!stocksByIngredient.has(ingredientId)) stocksByIngredient.set(ingredientId, []);
    stocksByIngredient.get(ingredientId)!.push(stock);
  }

  const ingredientRequirements = Array.from(ingredientNeeds.values()).map((need: any) => {
    const stocks = stocksByIngredient.get(need.ingredient_id) || [];
    const matchingStocks = stocks.filter((stock: any) => String(stock?.unit || "") === need.unit);

    if (stocks.length > 0 && matchingStocks.length === 0) {
      addIssue({
        type: "stock_unit_mismatch",
        ingredient_id: need.ingredient_id,
        message: `${need.ingredient_name}: ombor va tex-karta birligi mos emas.`,
      });
    }
    if (matchingStocks.length > 1) {
      addIssue({
        type: "duplicate_stock",
        ingredient_id: need.ingredient_id,
        message: `${need.ingredient_name}: markaziy omborda takroriy qoldiq topildi.`,
      });
    }

    const available = round3(matchingStocks.reduce((sum: number, stock: any) => sum + positive(stock?.quantity), 0));
    const requiredToday = round3(need.required_today);
    const requiredTomorrow = round3(need.required_tomorrow);
    const requiredTotal = round3(requiredToday + requiredTomorrow);
    const missing = round3(Math.max(0, requiredTotal - available));

    return {
      ...need,
      required_today: requiredToday,
      required_tomorrow: requiredTomorrow,
      required_total: requiredTotal,
      available,
      missing,
      enough: missing <= 0,
    };
  }).sort((a: any, b: any) => {
    if (a.enough !== b.enough) return a.enough ? 1 : -1;
    return String(a.ingredient_name).localeCompare(String(b.ingredient_name));
  });

  const shortages = ingredientRequirements.filter((row: any) => !row.enough);
  const todayOrderCount = relevantOrders.filter((order: any) => order.required_date === todayDate).length;
  const tomorrowOrderCount = relevantOrders.filter((order: any) => order.required_date === tomorrowDate).length;
  const tomorrowProductCount = Array.from(productRequirements.values()).filter(
    (row: any) => positive(row.tomorrow_quantity) > 0,
  ).length;

  return {
    today_date: todayDate,
    tomorrow_date: tomorrowDate,
    today_order_count: todayOrderCount,
    tomorrow_order_count: tomorrowOrderCount,
    tomorrow_product_count: tomorrowProductCount,
    product_requirements: plannedProducts.map((row) => ({
      ...row,
      today_quantity: round3(row.today_quantity),
      tomorrow_quantity: round3(row.tomorrow_quantity),
      total_quantity: round3(row.total_quantity),
    })),
    skipped_products: skippedProducts,
    ingredient_requirements: ingredientRequirements,
    shortages,
    issues,
    has_shortage: shortages.length > 0,
    is_complete: issues.length === 0,
  };
}
