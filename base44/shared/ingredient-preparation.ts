// Sauce preparation reuses ingredient stock and the existing stock ledger.
// Recipe quantities are base units; yield is explicitly confirmed, never inferred.
import { userShopId } from "./user-helpers.ts";

const roles = new Set(["admin", "manager", "production"]);
const round = (n: number) => Math.round(n * 1000) / 1000;
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
const checked = (n: any, unit: string, positive = false) => typeof n === "number"
  && Number.isFinite(n) && Math.abs(n) <= 1e9 && (!positive || n > 0)
  && Math.abs(n - round(n)) < 1e-8 && (unit !== "piece" || Number.isSafeInteger(n));
const keys = (row: any, field: string) => Array.isArray(row?.[field]) ? row[field] : [];
const changed = (result: any) => result?.success === true && Number(result.updated) === 1;
const label = (user: any) => user.full_name || user.email || "Xodim";
const pendingError = () => fail("Oldingi tayyorlash holati tekshirilishi kerak. Qayta tayyorlamang; egasiga murojaat qiling.", 503);

async function stockFor(service: any, locationId: string, ingredient: any) {
  const rows = await service.entities.IngredientStock.filter({
    location_id: locationId, ingredient_id: ingredient.id,
  }, "id", 2);
  const row = rows?.[0];
  if (rows?.length !== 1 || row.unit !== ingredient.base_unit || !checked(row.quantity, row.unit)) {
    throw fail(ingredient.name + ": qoldiq yoki birlikni tekshiring.");
  }
  return row;
}

async function recipePlan(service: any, location: any, output: any) {
  const recipe = output.preparation_recipe;
  if (!recipe || recipe.confirmed !== true) return null;
  if (!Number.isSafeInteger(recipe.version) || recipe.version < 1
    || recipe.output_unit !== output.base_unit || !checked(recipe.output_quantity, output.base_unit, true)
    || !Array.isArray(recipe.items) || !recipe.items.length || recipe.items.length > 50) {
    throw fail("Tayyorlash retsepti to‘liq emas. Egasi tekshirishi kerak.");
  }
  const seen = new Set();
  const items = [];
  for (const item of recipe.items) {
    if (!item.ingredient_id || seen.has(item.ingredient_id) || item.ingredient_id === output.id) {
      throw fail("Retseptda takroriy yoki noto‘g‘ri masalliq bor.");
    }
    seen.add(item.ingredient_id);
    const ingredient = await service.entities.Ingredient.get(item.ingredient_id);
    if (!ingredient || ingredient.active === false || ingredient.is_cake_layer === true
      || ingredient.category !== "food" || ingredient.base_unit !== item.unit
      || !checked(item.quantity, item.unit, true)) {
      throw fail("Retsept masallig‘i yoki uning birligi noto‘g‘ri.");
    }
    const stock = await stockFor(service, location.id, ingredient);
    items.push({ ingredient_id: ingredient.id, name: ingredient.name, quantity: item.quantity,
      unit: item.unit, stock_quantity: stock.quantity, stock });
  }
  return { version: recipe.version, output_quantity: recipe.output_quantity, output_unit: recipe.output_unit, items };
}

export async function ingredientPreparation(service: any, user: any, body: any) {
  if (!roles.has(user.role) || user.active === false) throw fail("Tayyorlash uchun ruxsat yo‘q.", 403);
  const locationId = String(body.location_id || "");
  const ingredientId = String(body.ingredient_id || "");
  if (!locationId || !ingredientId) throw fail("Do‘kon va sousni tanlang.", 400);
  if (user.role !== "admin" && userShopId(user) !== locationId) {
    throw fail("Faqat biriktirilgan do‘kon uchun ruxsat berilgan.", 403);
  }
  const [location, output] = await Promise.all([
    service.entities.Shop.get(locationId), service.entities.Ingredient.get(ingredientId),
  ]);
  if (!location || location.active === false || location.location_type === "production") {
    throw fail("Faol do‘kon topilmadi.", 404);
  }
  if (!output || output.active === false || output.category !== "food" || output.is_cake_layer === true
    || !["g", "ml", "piece"].includes(output.base_unit)
    || !output.preparation_shop_ids?.includes(location.id)) {
    throw fail("Bu masalliq uchun do‘konda tayyorlash yoqilmagan.", 403);
  }
  let outputStock = await stockFor(service, location.id, output);
  const preparing = body.action === "prepare_ingredient";
  const quantity = body.quantity;
  const requestId = String(body.request_id || "");
  const key = "IP:" + locationId + ":" + ingredientId + ":" + user.id + ":" + requestId;
  if (preparing && (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId) || !checked(quantity, output.base_unit, true))) {
    throw fail("Musbat miqdor va tayyorlash raqami kerak.", 400);
  }

  // Replay is checked before the current recipe, so a later recipe edit cannot
  // cause a successful request to deduct stock again.
  const replay = async (stock: any) => {
    const rows = await service.entities.StockMovement.filter({
      reference_type: "ingredient_preparation", reference_id: key,
      location_id: location.id, item_id: output.id, movement_type: "production_output",
    }, "id", 2);
    const receipt = rows?.[0];
    if (rows?.length !== 1) throw pendingError();
    if (receipt.user_id !== user.id || receipt.quantity_change !== quantity
      || receipt.preparation_snapshot?.recipe_version !== body.recipe_version) {
      throw fail("Bu tayyorlash raqami boshqa amal uchun ishlatilgan.");
    }
    return { stock, movement: receipt, already_processed: true };
  };
  if (preparing && keys(outputStock, "preparation_completed_keys").includes(key)) return replay(outputStock);

  const plan = await recipePlan(service, location, output);
  if (!preparing) return {
    configured: Boolean(plan), pending: Boolean(outputStock.preparation_pending_key),
    output: { id: output.id, name: output.name, unit: output.base_unit, stock_quantity: outputStock.quantity },
    recipe: plan ? { version: plan.version, output_quantity: plan.output_quantity, output_unit: plan.output_unit,
      items: plan.items.map(({ stock, ...item }) => item) } : null,
  };
  if (!plan) throw fail("Retsept kiritilmagan. Tayyorlashni hozir saqlab bo‘lmaydi.");
  if (plan.version !== body.recipe_version) throw fail("Retsept yangilangan. Oynani qayta oching.");
  if (outputStock.preparation_pending_key) throw pendingError();

  const usage = plan.items.map(item => {
    const raw = item.quantity * quantity / plan.output_quantity;
    const required = round(raw);
    if (!checked(required, item.unit, true) || (item.unit === "piece" && Math.abs(raw - required) > 1e-8)) {
      throw fail(item.name + ": bu miqdor uchun retseptni aniq hisoblab bo‘lmaydi.");
    }
    if (item.stock_quantity < required) throw fail(item.name + ": masalliq yetarli emas.");
    return { ...item, required };
  });
  const now = new Date().toISOString();
  const audit = { updated_at: now, updated_by: user.id, updated_by_name: label(user) };
  const claim = await service.entities.IngredientStock.updateMany({
    id: outputStock.id, preparation_completed_keys: { $ne: key },
    $or: [{ preparation_pending_key: { $exists: false } }, { preparation_pending_key: "" }],
  }, { $set: { preparation_pending_key: key } });
  if (!changed(claim)) {
    outputStock = await service.entities.IngredientStock.get(outputStock.id);
    if (keys(outputStock, "preparation_completed_keys").includes(key)) return replay(outputStock);
    throw pendingError();
  }

  const attempted: any[] = [];
  const movementBase = {
    location_id: location.id, location_name: location.name, item_kind: "ingredient",
    reference_type: "ingredient_preparation", reference_id: key,
    user_id: user.id, user_name: label(user), created_at: now,
    reason: output.name + " tayyorlash · retsept v" + plan.version,
  };
  const record = (item: any, type: string, delta: number, before: number, after: number, extra = {}) =>
    service.entities.StockMovement.create({
      ...movementBase, movement_number: "ST-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
      item_id: item.id, item_name: item.name, unit: item.base_unit,
      movement_type: type, quantity_change: delta, balance_before: before, balance_after: after, ...extra,
    });
  try {
    for (const item of usage) {
      attempted.push(item); // Track before awaiting: a lost reply may still have applied.
      const result = await service.entities.IngredientStock.updateMany({
        id: item.stock.id, unit: item.unit, quantity: item.stock_quantity,
        preparation_input_keys: { $ne: key },
      }, { $inc: { quantity: -item.required }, $push: { preparation_input_keys: key }, $set: audit });
      if (!changed(result)) throw fail(item.name + ": qoldiq o‘zgardi. Yangilang va qayta urinib ko‘ring.");
      await record({ id: item.ingredient_id, name: item.name, base_unit: item.unit },
        "production_use", -item.required, item.stock_quantity, round(item.stock_quantity - item.required));
    }
    // Other inventory operations may have changed the sauce during preparation.
    outputStock = await service.entities.IngredientStock.get(outputStock.id);
    if (!outputStock || !checked(outputStock.quantity, output.base_unit)
      || outputStock.unit !== output.base_unit || outputStock.preparation_pending_key !== key
      || !checked(round(outputStock.quantity + quantity), output.base_unit)) throw pendingError();
    const movement = await record(output, "production_output", quantity,
      outputStock.quantity, round(outputStock.quantity + quantity), { preparation_snapshot: {
        recipe_version: plan.version, recipe_output_quantity: plan.output_quantity,
        recipe_output_unit: plan.output_unit, prepared_quantity: quantity,
        items: usage.map(item => ({ ingredient_id: item.ingredient_id, name: item.name, unit: item.unit,
          recipe_quantity: item.quantity, used_quantity: item.required })),
      } });
    const commit = await service.entities.IngredientStock.updateMany({
      id: outputStock.id, unit: output.base_unit, quantity: outputStock.quantity,
      preparation_pending_key: key, preparation_completed_keys: { $ne: key },
    }, { $inc: { quantity }, $push: { preparation_completed_keys: key },
      $set: { ...audit, preparation_pending_key: "" } });
    if (!changed(commit)) throw fail("Sous qoldig‘i o‘zgardi. Yangilang va qayta urinib ko‘ring.");
    return { stock: { ...outputStock, quantity: round(outputStock.quantity + quantity) }, movement };
  } catch (error) {
    // Never compensate an uncertain final commit. Its atomic marker is authoritative.
    let current;
    try { current = await service.entities.IngredientStock.get(outputStock.id); }
    catch { throw pendingError(); }
    if (keys(current, "preparation_completed_keys").includes(key)) return replay(current);
    if (current?.preparation_pending_key !== key) throw pendingError();
    try {
      for (const item of attempted) {
        const row = await service.entities.IngredientStock.get(item.stock.id);
        if (!row) throw pendingError();
        if (keys(row, "preparation_input_keys").includes(key)) {
          const undo = await service.entities.IngredientStock.updateMany({
            id: row.id, preparation_input_keys: { $in: [key] },
          }, { $inc: { quantity: item.required }, $pull: { preparation_input_keys: key }, $set: audit });
          if (!changed(undo)) throw pendingError();
        }
      }
      const records = await service.entities.StockMovement.filter({
        reference_type: "ingredient_preparation", reference_id: key, location_id: location.id,
      }, "id", 100);
      for (const row of records || []) await service.entities.StockMovement.delete(row.id);
      const released = await service.entities.IngredientStock.updateMany({
        id: current.id, preparation_pending_key: key, preparation_completed_keys: { $ne: key },
      }, { $set: { preparation_pending_key: "" } });
      if (!changed(released)) throw pendingError();
    } catch { throw pendingError(); }
    throw error;
  }
}
