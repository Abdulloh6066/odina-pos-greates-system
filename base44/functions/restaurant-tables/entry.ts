import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole, userShopId, userLabel } from "../../shared/user-helpers.ts";

// Shop-specific floor plans and server-persisted unpaid table orders.
// Completed sales, payments and stock movements occur only in complete-sale.
const ALLOWED_ROLES = new Set(["admin", "cashier"]);
const MAX_TABLES = 30;
const MAX_ORDER_ITEMS = 100;
const ordersOf = (shop: any) => Array.isArray(shop?.restaurant_table_orders) ? shop.restaurant_table_orders : [];
const ordersVersion = (shop: any) => Number.isInteger(shop?.restaurant_table_orders_version)
  && shop.restaurant_table_orders_version >= 0 ? shop.restaurant_table_orders_version : 0;
const ordersVersionCondition = (version: number) => version === 0
  ? { $or: [{ restaurant_table_orders_version: 0 }, { restaurant_table_orders_version: { $exists: false } }] }
  : { restaurant_table_orders_version: version };
const orderSummary = (order: any) => ({
  number: order.number, state: order.state, revision: order.revision,
  total: order.total, item_count: (order.items || []).reduce((sum: number, item: any) => sum + item.quantity, 0),
  started_at: order.started_at, updated_at: order.updated_at,
});
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
    && Number.isInteger(entry.x) && entry.x >= Math.max(60, 60 * size / 100)
    && entry.x <= Math.min(940, 1000 - 60 * size / 100)
    && Number.isInteger(entry.y) && entry.y >= Math.max(70, (size > 100 ? 90 : 70) * size / 100)
    && entry.y <= Math.min(930, 1000 - (size > 100 ? 90 : 70) * size / 100);
};
// Preserve original collision spacing at 100%; larger tables need more room.
const overlaps = (a: any, b: any) => {
  const factor = (sizeOf(a) + sizeOf(b)) / 200;
  const verticalSpacing = sizeOf(a) === 100 && sizeOf(b) === 100 ? 125 : 175 * factor;
  return Math.abs(a.x - b.x) < 115 * factor && Math.abs(a.y - b.y) < verticalSpacing;
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
// Never trust a drawn zone from the browser. Empty means no outdoor zone yet.
// Keep this validation in the protected function, not just in the visual editor.
const cross = (a: any, b: any, c: any) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (a: any, b: any, p: any) => cross(a, b, p) === 0
  && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
  && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
const segmentsCross = (a: any, b: any, c: any, d: any) => {
  const abC = cross(a, b, c); const abD = cross(a, b, d);
  const cdA = cross(c, d, a); const cdB = cross(c, d, b);
  return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d))
    || (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b))
    || ((abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0));
};
const validOutdoorPolygon = (polygon: any) => {
  if (!Array.isArray(polygon)) return false;
  if (polygon.length === 0) return true;
  if (polygon.length < 3 || polygon.length > 12) return false;
  const seen = new Set<string>();
  for (const point of polygon) {
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)
      || point.x < 0 || point.x > 1000 || point.y < 0 || point.y > 1000) return false;
    const key = `${point.x}:${point.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const doubleArea = Math.abs(polygon.reduce((sum: number, p: any, i: number) => {
    const next = polygon[(i + 1) % polygon.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0));
  if (doubleArea < 20000) return false;
  for (let i = 0; i < polygon.length; i += 1) {
    for (let j = i + 1; j < polygon.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === polygon.length - 1)) continue;
      if (segmentsCross(polygon[i], polygon[(i + 1) % polygon.length],
        polygon[j], polygon[(j + 1) % polygon.length])) return false;
    }
  }
  return true;
};
const cleanOutdoorPolygon = (polygon: any) => validOutdoorPolygon(polygon)
  ? polygon.map(({ x, y }: any) => ({ x, y })) : [];
const isShop = (shop: any) => Boolean(shop && shop.active !== false
  && shop.location_type === "shop" && shop.allows_pos !== false);
const safeShop = (shop: any) => ({
  id: String(shop.id),
  name: String(shop.name || "Do‘kon"),
  table_count: Number.isInteger(shop.restaurant_table_count)
    && shop.restaurant_table_count >= 0 && shop.restaurant_table_count <= MAX_TABLES
    ? shop.restaurant_table_count : 0,
  entrance: cleanEntrance(shop.restaurant_entrance),
  outdoor_polygon: cleanOutdoorPolygon(shop.restaurant_outdoor_polygon),
  orders: ordersOf(shop).filter((order: any) => Number.isInteger(order.number))
    .map(orderSummary).sort((a: any, b: any) => a.number - b.number),
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

    const shopId = String(body?.shop_id || "");
    if (action === "get_table_order" || action === "save_table_order" || action === "reconcile_table_payment") {
      const shop = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
      if (!isShop(shop)) return Response.json({ error: "Faol do‘kon topilmadi." }, { status: 404 });
      if (role === "cashier" && userShopId(actor) !== shop.id) {
        return Response.json({ error: "Boshqa do‘kon stoliga ruxsat yo‘q." }, { status: 403 });
      }
      const number = body?.table_number;
      if (!Number.isInteger(number) || number < 1 || number > safeShop(shop).table_count) {
        return Response.json({ error: "Bu do‘konda stol topilmadi." }, { status: 400 });
      }
      const stored = ordersOf(shop);
      const existing = stored.find((order: any) => order.number === number) || null;
      if (action === "get_table_order") return Response.json({ ok: true, order: existing });
      if (action === "reconcile_table_payment") {
        if (!existing || existing.state !== "paying" || !existing.checkout_key) {
          return Response.json({ error: "To‘lov tekshiriladigan stol topilmadi." }, { status: 409 });
        }
        const matches = await service.entities.Sale.filter({
          table_order_id_snapshot: existing.id, idempotency_key: existing.checkout_key,
        }, "-created_date", 2);
        if ((matches || []).length !== 1 || matches[0].status !== "completed"
          || matches[0].shop_id !== shop.id || matches[0].table_number_snapshot !== number) {
          return Response.json({ error: "To‘lov tasdiqlanmadi. Qayta to‘lov olmang — egasi Savdolar tarixini tekshirsin." }, { status: 409 });
        }
        const version = ordersVersion(shop);
        const cleared = await service.entities.Shop.updateMany(
          { id: shop.id, ...ordersVersionCondition(version) },
          { $set: { restaurant_table_orders: stored.filter((row: any) => row.id !== existing.id) },
            $inc: { restaurant_table_orders_version: 1 } },
        );
        if (!cleared?.success || Number(cleared.updated || 0) !== 1) {
          return Response.json({ error: "Stol holati o‘zgardi. Yangilang va qayta tekshiring." }, { status: 409 });
        }
        return Response.json({ ok: true, sale_id: matches[0].id, released: true });
      }
      const shiftId = String(body?.shift_id || "");
      const shift = shiftId ? await service.entities.Shift.get(shiftId).catch(() => null) : null;
      if (!shift || shift.status !== "open" || shift.user_id !== actor.id || shift.shop_id !== shop.id) {
        return Response.json({ error: "Stol buyurtmasini faqat shu do‘kondagi ochiq smenangizda saqlang." }, { status: 403 });
      }
      const revision = body?.expected_revision;
      if (!Number.isInteger(revision) || revision < 0 || revision !== (existing?.revision || 0)) {
        return Response.json({ error: "Buyurtma boshqa qurilmada o‘zgardi. Yangilang; sizning savatingiz o‘chirilmaydi." }, { status: 409 });
      }
      if (existing?.state !== undefined && existing.state !== "occupied") {
        return Response.json({ error: "Bu stolning to‘lovi boshlangan. Buyurtmani o‘zgartirib bo‘lmaydi." }, { status: 409 });
      }
      const requested = body?.items;
      if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_ORDER_ITEMS) {
        return Response.json({ error: "Buyurtmada 1–100 turdagi mahsulot bo‘lishi kerak." }, { status: 400 });
      }
      const previousItems = new Map((existing?.items || []).map((item: any) => [item.product_id, item]));
      const seen = new Set<string>();
      const items: any[] = [];
      for (const row of requested) {
        const productId = String(row?.product_id || "");
        const quantity = row?.quantity;
        if (!productId || seen.has(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
          return Response.json({ error: "Takroriy mahsulot yoki dona soni noto‘g‘ri." }, { status: 400 });
        }
        seen.add(productId);
        const previous: any = previousItems.get(productId);
        const product = await service.entities.Product.get(productId).catch(() => null);
        if (!previous && (!product || product.active === false || product.archived === true)) {
          return Response.json({ error: "Yangi qo‘shilgan mahsulot sotuvda mavjud emas." }, { status: 409 });
        }
        const price = previous ? previous.price : Number(product.price);
        if (!Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(price * quantity)) {
          return Response.json({ error: "Mahsulot narxi yoki miqdori noto‘g‘ri." }, { status: 400 });
        }
        items.push({ product_id: productId,
          product_name: previous?.product_name || String(product.name || "Mahsulot"),
          image_url: previous?.image_url || String(product.image_url || ""),
          price, quantity, subtotal: price * quantity,
          stock_tracked: previous ? previous.stock_tracked !== false : product.track_stock !== false,
          source_type: previous?.source_type || product.source_type || "central_produced" });
      }
      const total = items.reduce((sum: number, item: any) => sum + item.subtotal, 0);
      if (!Number.isSafeInteger(total) || total > 1_000_000_000_000) {
        return Response.json({ error: "Buyurtma summasi chegaradan oshdi." }, { status: 400 });
      }
      const now = new Date().toISOString();
      const order = { id: existing?.id || crypto.randomUUID(), number, revision: revision + 1,
        state: "occupied", items, total, started_at: existing?.started_at || now,
        opened_by: existing?.opened_by || actor.id, updated_by: actor.id, updated_at: now };
      const version = ordersVersion(shop);
      const updated = await service.entities.Shop.updateMany(
        { id: shop.id, restaurant_table_count: safeShop(shop).table_count, ...ordersVersionCondition(version) },
        { $set: { restaurant_table_orders: [...stored.filter((row: any) => row.number !== number), order] },
          $inc: { restaurant_table_orders_version: 1 } },
      );
      if (!updated?.success || Number(updated.updated || 0) !== 1) {
        return Response.json({ error: "Xarita boshqa qurilmada o‘zgardi. Savatni saqlagan holda yangilang." }, { status: 409 });
      }
      await service.entities.ActionHistory.create({ user_id: actor.id, user_name: userLabel(actor),
        action: "restaurant_table_order_saved",
        details: `${shop.name} · ${number}-stol · ${revision + 1}-tahrir · ${total} UZS (to‘lanmagan)` }).catch(() => {});
      return Response.json({ ok: true, order, summary: orderSummary(order) });
    }
    if (action !== "set_table_count" && action !== "set_table_layout") {
      return Response.json({ error: "Noma’lum amal." }, { status: 400 });
    }
    if (role !== "admin") {
      return Response.json({ error: "Stollarni faqat admin o‘zgartiradi." }, { status: 403 });
    }
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
      // A stale browser that knows only tables and entrance must preserve the
      // outdoor zone. Modern clients send it explicitly and are validated here.
      const outdoorPolygon = body?.outdoor_polygon === undefined
        ? current.outdoor_polygon : body.outdoor_polygon;
      if (!validOutdoorPolygon(outdoorPolygon)) {
        return Response.json({ error: "Ko‘cha hududi noto‘g‘ri. Kamida uchta nuqta tanlang, chiziqlar kesishmasin." }, { status: 400 });
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
        { $set: { restaurant_table_layout: clean, restaurant_entrance: cleanEntrance(entrance),
          restaurant_outdoor_polygon: cleanOutdoorPolygon(outdoorPolygon) },
          $inc: { restaurant_table_layout_version: 1 } },
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
    if (ordersOf(shop).some((order: any) => order.number > count)) {
      return Response.json({ error: "Buyurtmasi ochiq stolni olib tashlab bo‘lmaydi. Avval hisobni yakunlang." }, { status: 409 });
    }
    // Keep the table orders intact when the count grows or unused tables are removed.
    const existingLayout = Array.isArray(shop.restaurant_table_layout) ? shop.restaurant_table_layout : [];
    const countUpdate = await service.entities.Shop.updateMany(
      { id: shop.id, restaurant_table_count: previous === 0 ? { $in: [0, null] } : previous,
        restaurant_table_layout_version: safeShop(shop).layout_version === 0
          ? { $in: [0, null] } : safeShop(shop).layout_version,
        ...ordersVersionCondition(ordersVersion(shop)) },
      { $set: { restaurant_table_count: count,
        restaurant_table_layout: existingLayout.filter((row: any) => Number.isInteger(row?.number) && row.number <= count),
        restaurant_table_layout_version: safeShop(shop).layout_version + 1 } },
    );
    if (!countUpdate?.success || Number(countUpdate.updated || 0) !== 1) {
      return Response.json({ error: "Stol buyurtmasi yoki stollar soni o‘zgardi. Yangilang." }, { status: 409 });
    }
    const updated = await service.entities.Shop.get(shop.id);
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
