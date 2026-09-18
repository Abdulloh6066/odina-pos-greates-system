import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole, userShopId, userLabel } from "../../shared/user-helpers.ts";

// Phase 1 only: table configuration and read-only layout. No restaurant orders,
// reservations, sales, shift changes or inventory writes are performed here.
const ALLOWED_ROLES = new Set(["admin", "cashier"]);
const MAX_TABLES = 30;
const isShop = (shop: any) => Boolean(shop && shop.active !== false
  && shop.location_type !== "production" && shop.allows_pos !== false);
const safeShop = (shop: any) => ({
  id: String(shop.id),
  name: String(shop.name || "Do‘kon"),
  table_count: Number.isInteger(shop.restaurant_table_count)
    && shop.restaurant_table_count >= 0 && shop.restaurant_table_count <= MAX_TABLES
    ? shop.restaurant_table_count : 0,
});

Deno.serve(async (req) => {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth?.id) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });

    const service = client.asServiceRole;
    const actor = await resolveStoredAppUser(service, auth);
    const role = userRole(actor);
    if (!actor || actor.active === false || actor.data?.active === false || !ALLOWED_ROLES.has(role)) {
      return Response.json({ error: "Stollar bo‘limiga kirishga ruxsat yo‘q." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "status");

    if (action === "status") {
      if (role === "cashier") {
        // Ignore arbitrary shop IDs from the browser; use the stored assignment.
        const assignedId = userShopId(actor);
        if (!assignedId) return Response.json({ error: "Kassirga do‘kon biriktirilmagan." }, { status: 403 });
        const assignedShop = await service.entities.Shop.get(assignedId).catch(() => null);
        if (!isShop(assignedShop)) {
          return Response.json({ error: "Biriktirilgan do‘kon faol emas yoki topilmadi." }, { status: 403 });
        }
        return Response.json({ can_manage: false, shops: [safeShop(assignedShop)] });
      }

      const shops = await service.entities.Shop.list("name", 100);
      return Response.json({
        can_manage: true,
        shops: (shops || []).filter(isShop).map(safeShop),
      });
    }

    if (action !== "set_table_count") {
      return Response.json({ error: "Noma’lum amal." }, { status: 400 });
    }
    if (role !== "admin") {
      return Response.json({ error: "Stollar sonini faqat admin o‘zgartiradi." }, { status: 403 });
    }
    const shopId = String(body?.shop_id || "");
    const count = body?.table_count;
    if (!shopId || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_TABLES) {
      return Response.json({ error: `Stollar sonini 0 dan ${MAX_TABLES} gacha butun son bilan kiriting.` }, { status: 400 });
    }
    const shop = await service.entities.Shop.get(shopId).catch(() => null);
    if (!isShop(shop)) {
      return Response.json({ error: "Faqat faol savdo do‘koni uchun stol sozlanadi." }, { status: 404 });
    }
    const previous = safeShop(shop).table_count;
    if (previous === count) return Response.json({ ok: true, shop: safeShop(shop), unchanged: true });

    // No table orders exist in phase 1. When they are introduced, this action
    // must reject reductions affecting active orders or reservations BEFORE update.
    const updated = await service.entities.Shop.update(shop.id, { restaurant_table_count: count });
    await service.entities.ActionHistory.create({
      user_id: String(actor.id || auth.id),
      user_name: userLabel(actor),
      action: "restaurant_table_count_changed",
      details: `${String(shop.name || shop.id)} · stollar: ${previous} → ${count}`,
    });
    return Response.json({ ok: true, shop: safeShop(updated) });
  } catch (error) {
    console.error("restaurant-tables failed", error);
    return Response.json({ error: "Stollar ma’lumotini xavfsiz yuklash yoki saqlash amalga oshmadi." }, { status: 500 });
  }
});
