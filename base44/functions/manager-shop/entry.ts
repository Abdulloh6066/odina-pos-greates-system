import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";
import { readManagerShiftHistory } from "../../shared/manager-shift-history.ts";

export default async function(req) {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const service = client.asServiceRole;
    const user = await resolveAppUser(service, auth);
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "So‘rov noto‘g‘ri." }, { status: 400 });
    if (body.action === "get_operational_settings") {
      if (!["admin", "manager", "cashier", "accountant", "production"].includes(user.role)) {
        return Response.json({ error: "Kassa parametrlariga ruxsat yo‘q." }, { status: 403 });
      }
      // No IDs, counters, payment claims, Budget journals, delivery settings or arbitrary fields.
      const rows = await service.entities.Settings.list("-created_date", 1);
      if (!Array.isArray(rows)) return Response.json({ error: "Kassa parametrlari javobi noto‘g‘ri." }, { status: 502 });
      const settings = rows[0] || {};
      const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
      return Response.json({ settings: {
        shop_name: text(settings.shop_name, "Odina Shop"),
        thank_you_message: text(settings.thank_you_message),
        receipt_footer: text(settings.receipt_footer),
        currency: text(settings.currency, "UZS"),
        allow_negative_stock: settings.allow_negative_stock !== false,
      } });
    }
    if (user.role !== "manager" || !user.shop_id) return Response.json({ error: "Boshqaruvchi ruxsati kerak." }, { status: 403 });
    if (body.shop_id && body.shop_id !== user.shop_id) return Response.json({ error: "Boshqa do‘konga ruxsat yo‘q." }, { status: 403 });
    if (['list_shift_history', 'get_shift_detail'].includes(body.action)) {
      return Response.json(await readManagerShiftHistory(service, user, body));
    }
    if (body.action === "set_category_visibility") {
      if (Object.keys(body).some(key => !["action", "category_id", "hidden", "shop_id"].includes(key)) || typeof body.hidden !== "boolean") {
        return Response.json({ error: "Faqat do‘kon kategoriyasi ko‘rinishini o‘zgartirish mumkin." }, { status: 400 });
      }
      const category = await service.entities.Category.get(String(body.category_id || "")).catch(() => null);
      if (!category) return Response.json({ error: "Kategoriya topilmadi." }, { status: 404 });
      if (category.hidden_shop_ids != null && !Array.isArray(category.hidden_shop_ids)) {
        return Response.json({ error: "Kategoriya ko‘rinishini tekshiring." }, { status: 409 });
      }
      const before = category.hidden_shop_ids || [];
      if (before.includes(user.shop_id) !== body.hidden) {
        const after = body.hidden ? [...before, user.shop_id] : before.filter(id => id !== user.shop_id);
        const result = await service.entities.Category.updateMany({ id: category.id,
          hidden_shop_ids: category.hidden_shop_ids == null ? { $exists: false } : { $eq: before },
        }, { $set: { hidden_shop_ids: after } });
        if (!result?.success || Number(result.updated || 0) !== 1) return Response.json({ error: "Kategoriya o‘zgargan. Yangilab qayta urinib ko‘ring." }, { status: 409 });
      }
      return Response.json({ ok: true, category_id: category.id, shop_id: user.shop_id, hidden: body.hidden });
    }
    if (body.action === "set_product_category") {
      if (Object.keys(body).some(key => !["action", "product_id", "category_id", "shop_id"].includes(key))) {
        return Response.json({ error: "Faqat do‘kon kategoriyasini o‘zgartirish mumkin." }, { status: 400 });
      }
      const product = await service.entities.Product.get(String(body.product_id || "")).catch(() => null);
      const category = await service.entities.Category.get(String(body.category_id || "")).catch(() => null);
      if (!product || product.archived === true || !category || category.active === false) return Response.json({ error: "Faol mahsulot va kategoriyani tanlang." }, { status: 400 });
      if (product.available_shop_ids?.length && !product.available_shop_ids.includes(user.shop_id)) return Response.json({ error: "Mahsulot bu do‘konga biriktirilmagan." }, { status: 403 });
      const result = await service.entities.Product.updateMany({ id: product.id }, { $set: { [`shop_category_ids.${user.shop_id}`]: category.id } });
      if (!result?.success || Number(result.updated || 0) !== 1) return Response.json({ error: "Kategoriya saqlanmadi." }, { status: 409 });
      return Response.json({ ok: true, product_id: product.id, shop_id: user.shop_id, category_id: category.id });
    }
    if (body.action === "set_product_price") {
      const price = Number(body.price);
      if (!Number.isSafeInteger(price) || price < 0) return Response.json({ error: "Narx musbat butun son yoki nol bo‘lsin." }, { status: 400 });
      const product = await service.entities.Product.get(String(body.product_id || "")).catch(() => null);
      if (!product || product.archived === true) return Response.json({ error: "Mahsulot topilmadi." }, { status: 404 });
      if (product.available_shop_ids?.length && !product.available_shop_ids.includes(user.shop_id)) return Response.json({ error: "Mahsulot bu do‘konga biriktirilmagan." }, { status: 403 });
      // A dotted-field update preserves every other shop's concurrent price edits.
      const result = await service.entities.Product.updateMany({ id: product.id }, {
        $set: { [`shop_prices.${user.shop_id}`]: price },
      });
      if (!result?.success || Number(result.updated || 0) !== 1) return Response.json({ error: "Narx saqlanmadi." }, { status: 409 });
      await service.entities.ActionHistory.create({
        user_id: user.id, user_name: user.full_name || user.email,
        action: "shop_product_price_updated",
        details: `${user.shop_id} · ${product.name} · ${price} UZS`,
      }).catch(() => {});
      return Response.json({ ok: true, product_id: product.id, shop_id: user.shop_id, price });
    }
    return Response.json({ error: "Bu amal uchun ruxsat yo‘q." }, { status: 403 });
  } catch (error) {
    return Response.json({ error: error?.message || "Amal bajarilmadi." }, { status: error?.status || 500 });
  }
}
