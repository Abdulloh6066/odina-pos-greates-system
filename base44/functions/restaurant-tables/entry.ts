import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole, userShopId, userLabel } from "../../shared/user-helpers.ts";

// Store-specific table count and spatial layout only. POS checkout lives in
// complete-sale. This function never creates sales, orders or stock movements.
const ALLOWED_ROLES = new Set(["admin", "cashier"]);
const MAX_TABLES = 30;
const DEFAULT_ENTRANCE = { side: "top", offset: 500 };
const validEntrance = (entry: any) => entry && ["top", "right", "bottom", "left"].includes(entry.side)
  && Number.isInteger(entry.offset) && entry.offset >= 150 && entry.offset <= 850;
const cleanEntrance = (entry: any) => validEntrance(entry)
  ? { side: entry.side, offset: entry.offset } : { ...DEFAULT_ENTRANCE };
// Older stored layouts have no size: display them at their original 100%.
const sizeOf = (entry: any) => entry?.size === undefined ? 100 : entry?.size;
const validSize = (size: any) => Number.isInteger(size) && size >= 80 && size <= 140 && size % 10 === 0;
const hasValidPosition = (entry: any, count: number) => {
  const size = sizeOf(entry);
  return entry && Number.isInteger(entry.number) && entry.number >= 1 && entry.number <= count
    && validSize(size)
    && Number.isInteger(entry.x) && entry.x >= 60 * size / 100 && entry.x <= 1000 - 60 * size / 100
    && Number.isInteger(entry.y) && entry.y >= 70 * size / 100 && entry.y <= 1000 - 70 * size / 100;
};
// Preserve original collision spacing at 100%; larger tables need more room.
const overlaps = (a: any, b: any) => {
  const factor = (sizeOf(a) + sizeOf(b)) / 200;
  return Math.abs(a.x - b.x) < 115 * factor && Math.abs(a.y - b.y) < 125 * factor;
};
const validateLayout = (layout: any, count: number) => {
  if (!Array.isArray(layout) || layout.length !== count || count <= 0 || count > MAX_TABLES) return false;
  const numbers = new Set<number>();
  for (const point of layout) {
    if (!hasValidPosition(point, count) || numbers.has(point.number)) return false;
    numbers.add(point.number);
  }
  return !layout.some((point: any, i: number) => layout.some((other: any, j: number) => i < j && overlaps(point, other)));
};
const isShop = (shop: any) => Boolean(shop && shop.active !== false
  && shop.location_type === "shop" && shop.allows_pos !== false);
const safeShop = (shop: any) => ({
  id: String(shop.id),
  name: String(shop.name || "Do‘kon"),
  table_count: Number.isInteger(shop.restaurant_table_count)
    && shop.restaurant_table_count >= 0 && shop.restaurant_table_count <= MAX_TABLES
    ? shop.restaurant_table_count : 0,
  entrance: cleanEntrance(shop.restaurant_entrance),
  layout_version: Number.isInteger(shop.restaurant_table_layout_version)
    && shop.restaurant_table_layout_version >= 0 ? shop.restaurant_table_layout_version : 0,
  layout: (Array.isArray(shop.restaurant_table_layout) ? shop.restaurant_table_layout : [])
    .filter((row: any) => hasValidPosition(row, Number(shop.restaurant_table_count || 0)))
    .map((row: any) => ({ number: row.number, x: row.x, y: row.y, size: sizeOf(row) })),
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

    if (action !== "set_table_count" && action !== "set_table_layout") {
      return Response.json({ error: "Noma’lum amal." }, { status: 400 });
    }
    if (role !== "admin") {
      return Response.json({ error: "Stollarni faqat admin o‘zgartiradi." }, { status: 403 });
    }
    const shopId = String(body?.shop_id || "");
    if (action === "set_table_layout") {
      const shop = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
      if (!isShop(shop)) return Response.json({ error: "Faol do‘kon topilmadi." }, { status: 404 });
      const current = safeShop(shop);
      const version = body?.layout_version;
      if (!Number.isInteger(version) || version !== current.layout_version) {
        return Response.json({ error: "Xarita boshqa oynada o‘zgardi. Yangilab qayta joylashtiring." }, { status: 409 });
      }
      // Older clients may omit entrance; preserve the saved location in that case.
      // New clients must supply a valid wall and position; never trust browser data.
      const entrance = body?.entrance === undefined ? current.entrance : body.entrance;
      if (!validEntrance(entrance)) {
        return Response.json({ error: "Eshik joylashuvi noto‘g‘ri. Devorni va joyini qayta tanlang." }, { status: 400 });
      }
      const layout = body?.layout;
      // Old browser tabs that omit size must not reset sizes saved by a newer tab.
      const existingSizes = new Map((current.layout || []).map((row: any) => [row.number, row.size]));
      const clean = Array.isArray(layout) ? layout.map((row: any) => ({
        number: row?.number, x: row?.x, y: row?.y,
        size: row?.size === undefined ? (existingSizes.get(row?.number) || 100) : row.size,
      })).sort((a: any, b: any) => a.number - b.number) : null;
      if (!validateLayout(clean, current.table_count)) {
        return Response.json({ error: "Stol soni, o‘lchami yoki joylashuvi noto‘g‘ri. Stollar ustma-ust tushmasligi va xaritadan chiqmasligi kerak." }, { status: 400 });
      }
      const expectedVersion = version === 0
        ? { $or: [{ restaurant_table_layout_version: 0 }, { restaurant_table_layout_version: { $exists: false } }] }
        : { restaurant_table_layout_version: version };
      const updated = await service.entities.Shop.updateMany(
        { id: shop.id, ...expectedVersion, restaurant_table_count: current.table_count },
        { $set: { restaurant_table_layout: clean, restaurant_entrance: cleanEntrance(entrance) }, $inc: { restaurant_table_layout_version: 1 } },
      );
      if (!updated?.success || Number(updated.updated || 0) !== 1) {
        return Response.json({ error: "Stollar soni yoki xarita o‘zgardi. Yangilang va qayta urinib ko‘ring." }, { status: 409 });
      }
      const saved = await service.entities.Shop.get(shop.id);
      await service.entities.ActionHistory.create({
        user_id: String(actor.id || auth.id), user_name: userLabel(actor),
        action: "restaurant_table_layout_changed",
        details: `${String(shop.name || shop.id)} · ${current.table_count} stol joylashuvi yangilandi`,
      });
      return Response.json({ ok: true, shop: safeShop(saved) });
    }
    
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
    const existingLayout = Array.isArray(shop.restaurant_table_layout) ? shop.restaurant_table_layout : [];
    const updated = await service.entities.Shop.update(shop.id, {
      restaurant_table_count: count,
      restaurant_table_layout: existingLayout.filter((row: any) => Number.isInteger(row?.number) && row.number <= count),
      restaurant_table_layout_version: safeShop(shop).layout_version + 1,
    });
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
