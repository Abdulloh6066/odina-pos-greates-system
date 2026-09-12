import { createClientFromRequest } from "npm:@base44/sdk";
import { num, classifyItem, summarizeCount, isApprovalComplete, canApprove, validateCountedQuantity } from "../../shared/stock-count-logic.ts";
import { userLabel, userRole, userShopId } from "../../shared/user-helpers.ts";

const COUNT_ROLES = new Set(["admin", "manager", "cashier", "accountant"]);
const MANAGE_ROLES = new Set(["admin", "manager"]);

const itemKindOf = (item: any) => item?.item_kind === "ingredient" ? "ingredient" : "product";
const itemIdOf = (item: any) => String(item?.item_id || item?.product_id || "");
const itemNameOf = (item: any) => String(item?.item_name_snapshot || item?.product_name_snapshot || "Noma’lum");

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;
  try {
    const me = await base44.auth.me();
    if (!me) return Response.json({ error: "Tizimga kirish kerak." }, { status: 401 });
    const role = userRole(me);
    const shopId = userShopId(me);
    const userName = userLabel(me);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "list_counts");

    if (!COUNT_ROLES.has(role)) {
      return Response.json({ error: "Sizda ombor sanog‘idan foydalanish huquqi yo‘q." }, { status: 403 });
    }

    if (action === "list_counts") {
      let counts = await service.entities.StockCount.list("-created_date", 500);
      counts = (counts || []).filter((c: any) => c.status !== "cancelled");
      if (!MANAGE_ROLES.has(role)) counts = counts.filter((c: any) => c.location_id === shopId);
      const locFilter = String(body?.location_id || "");
      if (locFilter) counts = counts.filter((c: any) => c.location_id === locFilter);
      return Response.json({ counts });
    }

    if (action === "start_count") {
      const requestedLocationId = String(body?.location_id || "");
      const locationId = MANAGE_ROLES.has(role) ? requestedLocationId : shopId;
      if (!locationId) return Response.json({ error: "Do‘konni tanlang." }, { status: 400 });
      const location = await service.entities.Shop.get(locationId).catch(() => null);
      if (!location || location.active === false) {
        return Response.json({ error: "Faol do‘kon topilmadi." }, { status: 404 });
      }
      const [productStocks, products, ingredientStocks, ingredients] = await Promise.all([
        service.entities.ProductStock.filter({ location_id: locationId }, "-updated_at", 500),
        service.entities.Product.list("name", 500),
        service.entities.IngredientStock.filter({ location_id: locationId }, "-updated_at", 500),
        service.entities.Ingredient.list("name", 500),
      ]);
      const productMap = new Map((products || []).map((p: any) => [p.id, p]));
      const ingredientMap = new Map((ingredients || []).map((i: any) => [i.id, i]));
      const validProductStocks = (productStocks || [])
        .filter((s: any) => {
          const p = productMap.get(s.product_id);
          return p && p.active !== false && p.archived !== true && p.track_stock !== false;
        })
        .map((stock: any) => ({
          kind: "product",
          itemId: stock.product_id,
          name: productMap.get(stock.product_id)?.name || stock.product_name,
          unit: stock.unit || "piece",
          stock,
        }));
      const validIngredientStocks = (ingredientStocks || [])
        .filter((s: any) => {
          const ingredient = ingredientMap.get(s.ingredient_id);
          return ingredient && ingredient.active !== false;
        })
        .map((stock: any) => ({
          kind: "ingredient",
          itemId: stock.ingredient_id,
          name: ingredientMap.get(stock.ingredient_id)?.name || stock.ingredient_name,
          unit: stock.unit || ingredientMap.get(stock.ingredient_id)?.base_unit || "piece",
          stock,
        }));
      const countRows = [...validProductStocks, ...validIngredientStocks]
        .sort((a: any, b: any) => {
          if (a.kind !== b.kind) return a.kind === "product" ? -1 : 1;
          return String(a.name || "").localeCompare(String(b.name || ""));
        });

      const now = new Date().toISOString();
      const countNumber = `OS-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 7).toUpperCase()}`;
      const count = await service.entities.StockCount.create({
        count_number: countNumber,
        location_id: location.id,
        location_name: location.name,
        status: "draft",
        total_items: countRows.length,
        counted_items: 0,
        difference_items: 0,
        net_difference: 0,
        counted_by_id: me.id,
        counted_by_name: userName,
        created_at: now,
        notes: String(body?.notes || "").slice(0, 1000) || undefined,
      });
      const items: any[] = [];
      for (let i = 0; i < countRows.length; i++) {
        const row = countRows[i];
        const item = await service.entities.StockCountItem.create({
          stock_count_id: count.id,
          count_number: countNumber,
          location_id: location.id,
          item_kind: row.kind,
          item_id: row.itemId,
          item_name_snapshot: row.name,
          product_id: row.itemId,
          product_name_snapshot: row.name,
          unit: row.unit,
          system_quantity: num(row.stock.quantity),
          system_version: String(row.stock.updated_date || row.stock.updated_at || ""),
          counted_quantity: 0,
          was_counted: false,
          difference: 0,
          reason: "",
          item_order: i,
          applied: false,
          stale: false,
          created_at: now,
        });
        items.push(item);
      }
      return Response.json({ count, items });
    }

    if (action === "get_count") {
      const countId = String(body?.count_id || "");
      if (!countId) return Response.json({ error: "Sanoq tanlanmagan." }, { status: 400 });
      const count = await service.entities.StockCount.get(countId).catch(() => null);
      if (!count) return Response.json({ error: "Sanoq topilmadi." }, { status: 404 });
      if (!MANAGE_ROLES.has(role) && count.location_id !== shopId) {
        return Response.json({ error: "Bu sanog‘ni ko‘rishga ruxsat yo‘q." }, { status: 403 });
      }
      const items = await service.entities.StockCountItem.filter({ stock_count_id: countId }, "item_order", 500);
      return Response.json({ count, items });
    }

    if (action === "save_items") {
      const countId = String(body?.count_id || "");
      const count = await service.entities.StockCount.get(countId).catch(() => null);
      if (!count) return Response.json({ error: "Sanoq topilmadi." }, { status: 404 });
      if (count.status !== "draft") return Response.json({ error: "Faqat qoralama tahrirlanadi." }, { status: 409 });
      if (!MANAGE_ROLES.has(role) && count.location_id !== shopId) {
        return Response.json({ error: "Ruxsat yo‘q." }, { status: 403 });
      }
      const incoming = Array.isArray(body?.items) ? body.items : [];
      const existing = await service.entities.StockCountItem.filter({ stock_count_id: countId }, "item_order", 500);
      const map = new Map(existing.map((it: any) => [it.id, it]));
      const updates: any[] = [];
      for (const row of incoming) {
        const it = map.get(String(row.item_id));
        if (!it) continue;
        const checked = validateCountedQuantity(row.counted_quantity, it.unit);
        if (checked.error) {
          return Response.json({ error: `"${itemNameOf(it)}": ${checked.error}` }, { status: 400 });
        }
        const counted = checked.value;
        const wasCounted = counted !== null;
        const diff = wasCounted ? num(counted - num(it.system_quantity)) : 0;
        updates.push({
          id: it.id,
          was_counted: wasCounted,
          counted_quantity: wasCounted ? counted : 0,
          difference: diff,
          reason: String(row.reason || "").slice(0, 500),
        });
      }
      if (updates.length) await service.entities.StockCountItem.bulkUpdate(updates);
      const all = await service.entities.StockCountItem.filter({ stock_count_id: countId }, "item_order", 500);
      const summary = summarizeCount(all);
      const updatedCount = await service.entities.StockCount.update(countId, {
        total_items: summary.total_items,
        counted_items: summary.counted_items,
        difference_items: summary.difference_items,
        net_difference: summary.net_difference,
      });
      return Response.json({ count: updatedCount, items: all });
    }

    if (action === "submit_count") {
      const countId = String(body?.count_id || "");
      const count = await service.entities.StockCount.get(countId).catch(() => null);
      if (!count) return Response.json({ error: "Sanoq topilmadi." }, { status: 404 });
      if (count.status !== "draft") return Response.json({ error: "Faqat qoralama tasdiqlashga yuboriladi." }, { status: 409 });
      if (!MANAGE_ROLES.has(role) && count.location_id !== shopId) {
        return Response.json({ error: "Ruxsat yo‘q." }, { status: 403 });
      }
      const items = await service.entities.StockCountItem.filter({ stock_count_id: countId }, "item_order", 500);
      for (const it of items) {
        if (it.was_counted && num(it.difference) !== 0 && !String(it.reason || "").trim()) {
          return Response.json({ error: `"${itemNameOf(it)}" uchun farq sababini kiriting.` }, { status: 400 });
        }
      }
      const summary = summarizeCount(items);
      const now = new Date().toISOString();
      const updated = await service.entities.StockCount.update(countId, {
        status: "submitted",
        submitted_at: now,
        total_items: summary.total_items,
        counted_items: summary.counted_items,
        difference_items: summary.difference_items,
        net_difference: summary.net_difference,
      });
      return Response.json({ count: updated });
    }

    if (action === "approve_count") {
      if (!canApprove(role)) {
        return Response.json({ error: "Tasdiqlashni faqat egasi amalga oshiradi." }, { status: 403 });
      }
      const countId = String(body?.count_id || "");
      const requestId = String(body?.approval_request_id || "");
      if (!requestId) return Response.json({ error: "Tasdiqlash so‘rovi aniqlanmadi." }, { status: 400 });
      const count = await service.entities.StockCount.get(countId).catch(() => null);
      if (!count) return Response.json({ error: "Sanoq topilmadi." }, { status: 404 });
      if (count.status === "approved") {
        const items = await service.entities.StockCountItem.filter({ stock_count_id: countId }, "item_order", 500);
        return Response.json({ count, items, replayed: true, applied: 0, failed: 0, stale: items.filter((i: any) => i.stale).length });
      }
      if (count.status !== "submitted") {
        return Response.json({ error: "Faqat tasdiqlashga yuborilgan sanoq tasdiqlanadi." }, { status: 409 });
      }
      const items = await service.entities.StockCountItem.filter({ stock_count_id: countId }, "item_order", 500);
      const pending = (items as any[]).filter((it: any) => it.was_counted && num(it.difference) !== 0 && !it.applied);

      const [productStocks, ingredientStocks] = await Promise.all([
        service.entities.ProductStock.filter({ location_id: count.location_id }, "-updated_at", 500),
        service.entities.IngredientStock.filter({ location_id: count.location_id }, "-updated_at", 500),
      ]);
      const stocksByKey = new Map<string, any>();
      for (const stock of productStocks || []) stocksByKey.set(`product:${stock.product_id}`, stock);
      for (const stock of ingredientStocks || []) stocksByKey.set(`ingredient:${stock.ingredient_id}`, stock);

      const now = new Date().toISOString();
      let applied = 0;
      let failed = 0;
      let stale = 0;
      const needRecount: string[] = [];
      for (const it of pending) {
        const kind = itemKindOf(it);
        const itemId = itemIdOf(it);
        const itemName = itemNameOf(it);
        const stock = stocksByKey.get(`${kind}:${itemId}`);
        const stockEntity = kind === "ingredient" ? service.entities.IngredientStock : service.entities.ProductStock;
        const cls = classifyItem(it, stock);
        if (cls.stale) {
          stale++;
          await service.entities.StockCountItem.update(it.id, { stale: true }).catch(() => {});
          needRecount.push(itemName);
          continue;
        }
        const before = cls.before;
        const after = cls.after;
        const change = cls.change;
        if (change === 0) { applied++; continue; }
        const upd = await stockEntity.updateMany(
          { id: stock.id, quantity: before },
          { $set: { quantity: after, updated_at: now, updated_by: me.id, updated_by_name: userName } },
        );
        if (!upd?.success || Number(upd.updated || 0) !== 1) { failed++; continue; }
        let movement;
        try {
          movement = await service.entities.StockMovement.create({
            movement_number: `ST-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            location_id: count.location_id,
            location_name: count.location_name,
            item_kind: kind,
            item_id: itemId,
            item_name: itemName,
            unit: it.unit,
            movement_type: "adjustment",
            quantity_change: change,
            balance_before: before,
            balance_after: after,
            reason: `Ombor sanog‘i: ${count.count_number}${it.reason ? `. ${it.reason}` : ""}`,
            reference_id: count.id,
            reference_type: "stock_count",
            user_id: me.id,
            user_name: userName,
            created_at: now,
          });
        } catch {
          const rollbackAt = new Date().toISOString();
          const rollback = await stockEntity.updateMany(
            { id: stock.id, quantity: after },
            { $set: { quantity: before, updated_at: rollbackAt, updated_by: me.id, updated_by_name: userName } },
          );
          if (!rollback?.success || Number(rollback.updated || 0) !== 1) {
            throw new Error(`"${itemName}" qoldig‘i uchun tarix yozilmadi va avtomatik qaytarish bajarilmadi. Ombor tarixini tekshiring.`);
          }
          await service.entities.StockCountItem.update(it.id, { stale: true }).catch(() => {});
          stale++;
          failed++;
          needRecount.push(itemName);
          continue;
        }
        await service.entities.StockCountItem.update(it.id, {
          applied: true,
          applied_at: now,
          movement_id: movement.id,
          stale: false,
        });
        applied++;
      }

      const refreshed = await service.entities.StockCountItem.filter({ stock_count_id: countId }, "item_order", 500);
      if (isApprovalComplete(refreshed)) {
        const summary = summarizeCount(refreshed);
        const approved = await service.entities.StockCount.update(countId, {
          status: "approved",
          approved_at: now,
          approved_by_id: me.id,
          approved_by_name: userName,
          approval_request_id: requestId,
          total_items: summary.total_items,
          counted_items: summary.counted_items,
          difference_items: summary.difference_items,
          net_difference: summary.net_difference,
        });
        await service.entities.ActionHistory.create({
          user_id: me.id,
          user_name: userName,
          action: "stock_count_approved",
          details: `${count.count_number}. ${count.location_name}. ${applied} ta tuzatish qo‘llandi.`,
        }).catch(() => {});
        return Response.json({ count: approved, items: refreshed, applied, failed, stale, needRecount });
      }
      const partialCount = await service.entities.StockCount.get(countId);
      return Response.json({
        count: partialCount,
        items: refreshed,
        applied,
        failed,
        stale,
        needRecount,
        message: stale > 0
          ? "Ayrim qoldiqlar sanog‘dan keyin o‘zgargan. “Yangilash” tugmasini bosing va qayta sanang."
          : "Ayrim tuzatishlar qo‘llanmadi. Qayta tasdiqlang.",
      });
    }

    if (action === "refresh_stale_items") {
      if (!MANAGE_ROLES.has(role)) {
        return Response.json({ error: "Faqat egasi yoki boshqaruvchi yangilay oladi." }, { status: 403 });
      }
      const countId = String(body?.count_id || "");
      const count = await service.entities.StockCount.get(countId).catch(() => null);
      if (!count) return Response.json({ error: "Sanoq topilmadi." }, { status: 404 });
      if (count.status !== "submitted") {
        return Response.json({ error: "Faqat tasdiqlashga yuborilgan sanoq yangilanadi." }, { status: 409 });
      }
      const staleItems = await service.entities.StockCountItem.filter({ stock_count_id: countId, stale: true }, "item_order", 500);
      const [productStocks, ingredientStocks] = await Promise.all([
        service.entities.ProductStock.filter({ location_id: count.location_id }, "-updated_at", 500),
        service.entities.IngredientStock.filter({ location_id: count.location_id }, "-updated_at", 500),
      ]);
      const stockMap = new Map<string, any>();
      for (const stock of productStocks || []) stockMap.set(`product:${stock.product_id}`, stock);
      for (const stock of ingredientStocks || []) stockMap.set(`ingredient:${stock.ingredient_id}`, stock);
      for (const it of staleItems || []) {
        const s = stockMap.get(`${itemKindOf(it)}:${itemIdOf(it)}`);
        await service.entities.StockCountItem.update(it.id, {
          system_quantity: num(s?.quantity || 0),
          system_version: String(s?.updated_date || s?.updated_at || ""),
          was_counted: false,
          counted_quantity: 0,
          difference: 0,
          reason: "",
          stale: false,
          applied: false,
        });
      }
      if ((staleItems || []).length > 0) {
        await service.entities.StockCount.update(countId, { status: "draft" });
      }
      const refreshed = await service.entities.StockCount.get(countId);
      const items = await service.entities.StockCountItem.filter({ stock_count_id: countId }, "item_order", 500);
      return Response.json({ count: refreshed, items, refreshed_count: (staleItems || []).length });
    }

    if (action === "cancel_count") {
      const countId = String(body?.count_id || "");
      const count = await service.entities.StockCount.get(countId).catch(() => null);
      if (!count) return Response.json({ error: "Sanoq topilmadi." }, { status: 404 });
      if (!["draft", "submitted"].includes(count.status)) {
        return Response.json({ error: "Bu sanoqni bekor qilib bo‘lmaydi." }, { status: 409 });
      }
      if (!MANAGE_ROLES.has(role) && count.location_id !== shopId && count.counted_by_id !== me.id) {
        return Response.json({ error: "Ruxsat yo‘q." }, { status: 403 });
      }
      const now = new Date().toISOString();
      const updated = await service.entities.StockCount.update(countId, { status: "cancelled", cancelled_at: now });
      return Response.json({ count: updated });
    }

    return Response.json({ error: "Noma’lum sanoq amali." }, { status: 400 });
  } catch (error) {
    const status = Number((error as any)?.status) || 500;
    return Response.json({ error: error instanceof Error ? error.message : "Ombor sanog‘ini bajarib bo‘lmadi." }, { status });
  }
}