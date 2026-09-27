import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";

export default async function(req) {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const service = client.asServiceRole;
    const user = await resolveAppUser(service, auth);
    if (user.role !== "manager" || !user.shop_id) return Response.json({ error: "Boshqaruvchi ruxsati kerak." }, { status: 403 });
    const body = await req.json();
    if (body.shop_id && body.shop_id !== user.shop_id) return Response.json({ error: "Boshqa do‘konga ruxsat yo‘q." }, { status: 403 });
    if (body.action === "set_product_price") {
      const price = Number(body.price);
      if (!Number.isSafeInteger(price) || price < 0) return Response.json({ error: "Narx musbat butun son yoki nol bo‘lsin." }, { status: 400 });
      const product = await service.entities.Product.get(String(body.product_id || "")).catch(() => null);
      if (!product || product.archived === true) return Response.json({ error: "Mahsulot topilmadi." }, { status: 404 });
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
