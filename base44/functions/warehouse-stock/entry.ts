import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";

const ALLOWED_ROLES = new Set(["admin", "manager", "cashier", "accountant", "production"]);
const ALLOWED_TYPES = new Set(["opening", "adjustment"]);
const BALANCE_READER_VERSION = "2026-10-25-manager-stock-1";

const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : NaN;
};

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const auth = await base44.auth.me();
    if (!auth) return Response.json({ error: "Authentication required." }, { status: 401 });
    const user = await resolveAppUser(service, auth);
    if (!ALLOWED_ROLES.has(user.role)) {
      return Response.json({ error: "Your role cannot manage warehouse stock." }, { status: 403 });
    }

    const body = await req.json();
    const action = String(body?.action || "");

    if (action === "list_balances") {
      const locationId = String(body?.location_id || "");
      const itemKind = String(body?.item_kind || "");
      if (!locationId || !["ingredient", "product"].includes(itemKind)) {
        return Response.json({ error: "Location and stock kind are required." }, { status: 400 });
      }
      if (user.role !== "admin" && (!user.shop_id || user.shop_id !== locationId)) {
        return Response.json({ error: "You can view stock only for your assigned location." }, { status: 403 });
      }
      const entity = itemKind === "ingredient" ? service.entities.IngredientStock : service.entities.ProductStock;
      const rows = [];
      for (let skip = 0; skip < 10000; skip += 500) {
        const page = await entity.filter({ location_id: locationId }, "-updated_at", 500, skip);
        if (!Array.isArray(page)) return Response.json({ error: "Qoldiq serveri javobi noto‘g‘ri." }, { status: 502 });
        rows.push(...page.filter((row) => row?.location_id === locationId));
        if (page.length < 500) return Response.json({ rows, location_id: locationId,
          stock_source: itemKind === "ingredient" ? "IngredientStock" : "ProductStock",
          reader_version: BALANCE_READER_VERSION });
      }
      return Response.json({ error: "Qoldiqlar to‘liq yuklanmadi." }, { status: 500 });
    }

    if (action !== "adjust_stock") {
      return Response.json({ error: "Unknown warehouse action." }, { status: 400 });
    }

    const locationId = String(body?.location_id || "");
    const itemKind = String(body?.item_kind || "");
    const itemId = String(body?.item_id || "");
    const movementType = String(body?.movement_type || "adjustment");
    const reason = String(body?.reason || "").trim();
    const hasCount = body?.counted_quantity !== undefined;
    const countedQuantity = Number(body?.counted_quantity);
    let quantityChange = number(body?.quantity_change);

    if (!locationId || !["ingredient", "product"].includes(itemKind) || !itemId) {
      return Response.json({ error: "Location and stock item are required." }, { status: 400 });
    }
    if (hasCount && (!Number.isFinite(countedQuantity) || countedQuantity < 0
      || Math.abs(countedQuantity) > Number.MAX_SAFE_INTEGER / 1000
      || Math.abs(countedQuantity - number(countedQuantity)) > 0.0000001
      || (itemKind === "product" && !Number.isSafeInteger(countedQuantity))
      || typeof body?.counted_quantity !== "number" || typeof body?.expected_quantity !== "number" || movementType !== "adjustment")) {
      return Response.json({ error: "Haqiqiy sanoq uchun manfiy bo‘lmagan miqdor va ko‘rilgan qoldiq majburiy." }, { status: 400 });
    }
    if ((!hasCount && (!Number.isFinite(quantityChange) || quantityChange === 0)) || !reason) {
      return Response.json({ error: "A non-zero quantity and reason are required." }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(movementType)) {
      return Response.json({ error: "This stock movement type is not available in Phase 4A." }, { status: 400 });
    }
    if (user.role !== "admin" && (!user.shop_id || user.shop_id !== locationId)) {
      return Response.json({ error: "You can manage stock only for your assigned location." }, { status: 403 });
    }

    const location = await service.entities.Shop.get(locationId);
    if (!location || location.active === false) {
      return Response.json({ error: "Warehouse location not found or inactive." }, { status: 404 });
    }

    const item = itemKind === "ingredient"
      ? await service.entities.Ingredient.get(itemId)
      : await service.entities.Product.get(itemId);
    if (!item || item.active === false || item.archived === true) {
      return Response.json({ error: "Stock item not found or inactive." }, { status: 404 });
    }

    if (itemKind === "ingredient" && item.is_cake_layer === true) {
      if (location.location_type !== "production") {
        return Response.json({ error: "Qavat/list qoldig‘i faqat markaziy ishlab chiqarishda yuritiladi." }, { status: 400 });
      }
      if (item.base_unit !== "piece" || item.purchase_unit !== "piece" || Number(item.conversion_to_base) !== 1
        || !Number.isSafeInteger(hasCount ? countedQuantity : Number(body?.quantity_change))) {
        return Response.json({ error: "Qavatlar butun list sonida, dona birligida kiritiladi." }, { status: 400 });
      }
    }

    if (itemKind === "ingredient" && (!["g", "ml", "piece"].includes(item.base_unit)
      || (item.base_unit === "piece" && !Number.isSafeInteger(hasCount ? countedQuantity : quantityChange)))) {
      return Response.json({ error: "Masalliq birligi noto‘g‘ri yoki butun dona kiritilmagan." }, { status: 400 });
    }

    const stockEntity = itemKind === "ingredient"
      ? service.entities.IngredientStock
      : service.entities.ProductStock;
    const itemIdField = itemKind === "ingredient" ? "ingredient_id" : "product_id";
    const itemNameField = itemKind === "ingredient" ? "ingredient_name" : "product_name";
    const matches = await stockEntity.filter({ location_id: locationId, [itemIdField]: itemId });
    if ((matches || []).length > 1) {
      return Response.json({ error: "Duplicate stock balances found. Owner support is required." }, { status: 409 });
    }

    const existing = matches?.[0] || null;
    const balanceBefore = number(existing ? existing.quantity : 0);
    if (!Number.isFinite(balanceBefore) || (existing && existing.quantity == null)
      || (itemKind === "ingredient" && existing && existing.unit !== item.base_unit)
      || (itemKind === "ingredient" && item.base_unit === "piece" && !Number.isSafeInteger(balanceBefore))) {
      return Response.json({ error: "Qoldiq yoki uning birligini avval tekshiring." }, { status: 409 });
    }
    if (body?.expected_quantity !== undefined) {
      if (typeof body.expected_quantity !== "number" || !Number.isFinite(body.expected_quantity)) {
        return Response.json({ error: "Ko‘rilgan qoldiq noto‘g‘ri." }, { status: 400 });
      }
      if (number(body.expected_quantity) !== balanceBefore) {
        return Response.json({ error: "Qoldiq boshqa qurilmada o‘zgardi. Yangilangan miqdorni tekshirib, oynani qayta oching." }, { status: 409 });
      }
    }
    if (hasCount) quantityChange = number(countedQuantity - balanceBefore);
    const balanceAfter = number(balanceBefore + quantityChange);
    if (itemKind === "ingredient" && item.is_cake_layer === true
      && ((existing && existing.unit !== "piece") || !Number.isSafeInteger(balanceBefore) || !Number.isSafeInteger(balanceAfter))) {
      return Response.json({ error: "Qavat qoldig‘i yoki uning birligi noto‘g‘ri." }, { status: 409 });
    }
    if (!Number.isFinite(balanceAfter) || Math.abs(balanceAfter) > Number.MAX_SAFE_INTEGER / 1000 || balanceAfter < 0) {
      return Response.json({ error: "This change would make stock negative." }, { status: 409 });
    }

    const now = new Date().toISOString();
    const userName = user.full_name || user.email || "Unknown user";
    const unit = itemKind === "ingredient" ? item.base_unit
      : location.location_type === "production" ? (item.production_unit || "piece") : "piece";
    if (itemKind === "product" && (!Number.isSafeInteger(quantityChange) || (existing && (existing.unit || "piece") !== unit))) {
      return Response.json({ error: "Butun list/dona kiriting; qoldiq birligi mahsulotga mos bo‘lishi kerak." }, { status: 400 });
    }
    if (hasCount && existing && quantityChange === 0) {
      return Response.json({ stock: existing, movement: null, unchanged: true });
    }
    let stock;

    if (existing) {
      const update = await stockEntity.updateMany(
        { id: existing.id, quantity: balanceBefore },
        { $set: {
          quantity: balanceAfter,
          location_name: location.name,
          [itemNameField]: item.name,
          unit,
          updated_at: now,
          updated_by: user.id,
          updated_by_name: userName,
        } },
      );
      if (!update?.success || Number(update.updated || 0) !== 1) {
        return Response.json({ error: "Stock changed at the same time. Refresh and try again." }, { status: 409 });
      }
      stock = { ...existing, quantity: balanceAfter, location_name: location.name, [itemNameField]: item.name, unit, updated_at: now, updated_by: user.id, updated_by_name: userName };
    } else {
      stock = await stockEntity.create({
        location_id: location.id,
        location_name: location.name,
        [itemIdField]: item.id,
        [itemNameField]: item.name,
        unit,
        quantity: balanceAfter,
        low_stock_level: 0,
        updated_at: now,
        updated_by: user.id,
        updated_by_name: userName,
      });
    }

    try {
      const movement = await service.entities.StockMovement.create({
        movement_number: `ST-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        location_id: location.id,
        location_name: location.name,
        item_kind: itemKind,
        item_id: item.id,
        item_name: item.name,
        unit,
        movement_type: movementType,
        quantity_change: quantityChange,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        reason,
        user_id: user.id,
        user_name: userName,
        created_at: now,
      });

      try {
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "stock_adjusted",
          details: `${location.name}. ${item.name}: ${quantityChange > 0 ? "+" : ""}${quantityChange} ${unit}. ${reason}`,
        });
      } catch {
        // The stock ledger is the authoritative audit trail.
      }

      return Response.json({ stock, movement });
    } catch (error) {
      try {
        if (existing) {
          await stockEntity.update(existing.id, { quantity: balanceBefore });
        } else if (stock?.id) {
          await stockEntity.delete(stock.id);
        }
      } catch {
        // Preserve the original ledger failure.
      }
      throw error;
    }
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Could not update warehouse stock.",
    }, { status: Number(error?.status) || 500 });
  }
}