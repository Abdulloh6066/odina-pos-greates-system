import { createClientFromRequest } from "npm:@base44/sdk";
import { num, classifyItem, summarizeCount, isApprovalComplete, canApprove } from "../../shared/stock-count-logic.ts";
import { userLabel, userRole, userShopId } from "../../shared/user-helpers.ts";

const COUNT_ROLES = new Set(["admin", "manager", "cashier", "accountant"]);
const MANAGE_ROLES = new Set(["admin", "manager"]);

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

    if (action === "list_counts") {
      let counts = await service.entities.StockCount.list("-created_date", 500);
      counts = (counts || []).filter((c: any) => c.status !== "cancelled");
      if (!MANAGE_ROLES.has(role)) counts = counts.filter((c: any) => c.location_id === shopId);
      const locFilter = String(body?.location_id || "");
      if (locFilter) counts = counts.filter((c: any) => c.location_id === locFilter);
      return Response.json({ counts });
    }

    if (action === "start_count") {
      if (!COUNT_ROLES.has(role)) {
        return Response.json({ error: "Sizda ombor sanog‘ini boshlash huquqi yo‘q." }, { status: 403 });
      }
      const requestedLocationId = String(body?.location_id || "");
      const locationId = MANAGE_ROLES.has(role) ? requestedLocationId : shopId;
      if (!locationId) return Response.json({ error: "Do‘konni tanlang." }, { status: 400 });
      const location = await service.entities.Shop.get(locationId).catch(() => null);
      if (!location || location.active === false) {
        return Response.json({ error: "Faol do‘kon topilmadi." }, { status: 404 });
      }
      const [stocks, products] = await Promise.all([
        service.entities.ProductStock.filter({ location_id: locationId }, "-updated_at", 500),
        service.entities.Product.list("name", 500),
      ]);
      const productMap = new Map((products || []).map((p: any) => [p.id, p]));
      const validStocks = (stocks || [])
        .filter((s: any) => {
          const p = productMap.get(s.product_id);
          return p && p.active !== false && p.archived !== true && p.track_stock !== false;
        })
        .sort((a: any, b: any) => String(a.product_name || "").localeCompare(String(b.product_name || "")));

      const now = new Date().toISOString();
      const countNumber = `OS-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 7).toUpperCase()}`;
      const count = await service.entities.StockCount.create({
        count_number: countNumber,
        location_id: location.id,
        location_name: location.name,
        status: "draft",
        total_items: validStocks.length,
        counted_items: 0,
        difference_items: 0,
        net_difference: 0,
        counted_by_id: me.id,
        counted_by_name: userName,
        created_at: now,
        notes: String(body?.notes || "").slice(0, 1000) || undefined,
      });
      const items: any[] = [];
      for (let i = 0; i < validStocks.length; i++) {
        const s = validStocks[i];
        const p = productMap.get(s.product_id);
        const item = await service.entities.StockCountItem.create({
          stock_count_id: count.id,
          count_number: countNumber,
          location_id: location.id,
          product_id: s.product_id,
          product_name_snapshot: p.name,
          unit: s.unit || "piece",
          system_quantity: num(s.quantity),
          system_version: String(s.updated_date || s.updated_at || ""),
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
        const raw = row.counted_quantity;
        const counted = (raw === null || raw === undefined || raw === "") ? null : num(raw);
        if (counted !== null && (!Number.isFinite(counted) || counted < 0 || !Number.isSafeInteger(counted))) {
          return Response.json({ error: "Sanalgan miqdor manfiy bo‘lmagan butun son bo‘lishi kerak." }, { status: 400 });
        }
        const wasCounted = counted !== null;
        const diff = wasCounted ? counted - num(it.system_quantity) : 0;
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
          return Response.json({ error: `"${it.product_name_snapshot}" uchun farq sababini kiriting.` }, { status: 400 });
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

      const productIds = [...new Set(pending.map((it: any) => it.product_id))];
      const stocksByProduct = new Map<string, any>();
      if (productIds.length) {
        const allStocks = await service.entities.ProductStock.filter({ location_id: count.location_id }, "-updated_at", 500);
        for (const s of allStocks || []) stocksByProduct.set(s.product_id, s);
      }

      const now = new Date().toISOString();
      let applied = 0;
      let failed = 0;
      let stale = 0;
      const needRecount: string[] = [];
      for (const it of pending) {
        const stock = stocksByProduct.get(it.product_id);
        const cls = classifyItem(it, stock);
        if (cls.stale) {
          stale++;
          await service.entities.StockCountItem.update(it.id, { stale: true }).catch(() => {});
          needRecount.push(it.product_name_snapshot);
          continue;
        }
        const before = cls.before;
        const after = cls.after;
        const change = cls.change;
        if (change === 0) { applied++; continue; }
        const upd = await service.entities.ProductStock.updateMany(
          { id: stock.id, quantity: before },
          { $set: { quantity: after, updated_at: now, updated_by: me.id, updated_by_name: userName } },
        );
        if (!upd?.success || Number(upd.updated || 0) !== 1) { failed++; continue; }
        const movement = await service.entities.StockMovement.create({
          movement_number: `ST-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
          location_id: count.location_id,
          location_name: count.location_name,
          item_kind: "product",
          item_id: it.product_id,
          item_name: it.product_name_snapshot,
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
        }).catch(() => null);
        await service.entities.StockCountItem.update(it.id, {
          applied: true,
          applied_at: now,
          movement_id: movement?.id || undefined,
          stale: false,
        }).catch(() => {});
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
          ? "Ayrim mahsulotlar qoldig‘i sanog‘dan keyin o‘zgargan. “Yangilash” tugmasini bosing va qayta sanang."
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
      const stocks = await service.entities.ProductStock.filter({ location_id: count.location_id }, "-updated_at", 500);
      const stockMap = new Map((stocks || []).map((s: any) => [s.product_id, s]));
      for (const it of staleItems || []) {
        const s = stockMap.get(it.product_id);
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