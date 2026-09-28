import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";

export default async function(req) {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const service = client.asServiceRole;
    const user = await resolveAppUser(service, auth);
    const body = await req.json();
    const shopId = String(body.shop_id || "");
    if (!["admin", "manager", "cashier"].includes(user.role)
      || (user.role !== "admin" && (!user.shop_id || shopId !== user.shop_id))) {
      return Response.json({ error: "Bu do‘konga ruxsat yo‘q." }, { status: 403 });
    }
    if (!["get", "save"].includes(body.action)) return Response.json({ error: "Noma’lum amal." }, { status: 400 });
    if (body.action === "save" && !["admin", "manager"].includes(user.role)) {
      return Response.json({ error: "Tartibni faqat admin yoki menejer o‘zgartira oladi." }, { status: 403 });
    }
    const shop = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
    if (!shop || shop.active === false || shop.allows_pos === false || shop.location_type === "production") {
      return Response.json({ error: "Faol savdo do‘koni topilmadi." }, { status: 404 });
    }
    const version = Number.isSafeInteger(shop.pos_product_order_version) ? shop.pos_product_order_version : 0;
    const current = Array.isArray(shop.pos_product_order) ? shop.pos_product_order : [];
    if (body.action === "get") return Response.json({ shop_id: shopId, order: current, version });
    const ids = body.order;
    if (!Number.isSafeInteger(body.version) || body.version < 0
      || !Array.isArray(ids) || ids.length > 5000
      || ids.some(id => typeof id !== "string" || !id || id.length > 100)
      || new Set(ids).size !== ids.length) {
      return Response.json({ error: "Mahsulotlar tartibi noto‘g‘ri." }, { status: 400 });
    }
    if (body.version !== version) return Response.json({ error: "Tartib boshqa qurilmada o‘zgardi. Oynani qayta ochib tekshiring." }, { status: 409 });
    // Validate only the IDs being ordered; never write Product, prices or stock.
    for (let start = 0; start < ids.length; start += 200) {
      const chunk = ids.slice(start, start + 200);
      const rows = await service.entities.Product.filter({ id: { $in: chunk } }, "id", 200);
      const allowed = new Set(rows.filter(p => p.active !== false && p.archived !== true
        && (!p.available_shop_ids?.length || p.available_shop_ids.includes(shopId))).map(p => p.id));
      if (chunk.some(id => !allowed.has(id))) return Response.json({ error: "Mahsulotlar ro‘yxati o‘zgardi. Oynani qayta oching." }, { status: 400 });
    }
    const versionQuery = version === 0
      ? { $or: [{ pos_product_order_version: 0 }, { pos_product_order_version: { $exists: false } }] }
      : { pos_product_order_version: version };
    const result = await service.entities.Shop.updateMany({ id: shopId, ...versionQuery }, {
      $set: { pos_product_order: ids, pos_product_order_version: version + 1 },
    });
    if (!result?.success || Number(result.updated || 0) !== 1) {
      return Response.json({ error: "Tartib boshqa qurilmada o‘zgardi. Oynani qayta ochib tekshiring." }, { status: 409 });
    }
    await service.entities.ActionHistory.create({
      user_id: user.id, user_name: user.full_name || user.email,
      action: "pos_product_order_updated",
      details: shop.name + " · " + ids.length + " ta mahsulot tartibi saqlandi",
    }).catch(() => {});
    return Response.json({ ok: true, shop_id: shopId, order: ids, version: version + 1 });
  } catch (error) {
    return Response.json({ error: error?.message || "Tartib saqlanmadi." }, { status: error?.status || 500 });
  }
}
