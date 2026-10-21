import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";

// Kassa rasmining kichik nusxasini saqlaydi. Bu yozuv faqat ikkita maydonni
// o‘zgartiradi; asl image_url, narx, qoldiq va savdo ma’lumotlari tegmaydi.
const HTTP_URL = /^https?:\/\/\S{4,2048}$/i;

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) return Response.json({ error: "Authentication required." }, { status: 401 });

    const user = await resolveAppUser(base44.asServiceRole, authenticatedUser);
    if (user.role !== "admin") {
      return Response.json({ error: "Faqat administrator kassa rasmlarini yangilashi mumkin." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const productId = String(body?.product_id || "").trim();
    const sourceUrl = String(body?.image_url || "").trim();
    const thumbnailUrl = String(body?.thumbnail_url || "").trim();
    if (!productId || productId.length > 64) {
      return Response.json({ error: "Mahsulot tanlanmadi." }, { status: 400 });
    }
    if (!HTTP_URL.test(sourceUrl) || !HTTP_URL.test(thumbnailUrl)) {
      return Response.json({ error: "Rasm manzillari http(s) havola bo‘lishi kerak." }, { status: 400 });
    }

    const product = await base44.asServiceRole.entities.Product.get(productId).catch(() => null);
    if (!product) return Response.json({ error: "Mahsulot topilmadi." }, { status: 404 });
    if (String(product.image_url || "").trim() !== sourceUrl) {
      return Response.json({ error: "Mahsulot rasmi o‘zgargan. Katalogni yangilab, qayta urinib ko‘ring." }, { status: 409 });
    }

    const updated = await base44.asServiceRole.entities.Product.update(product.id, {
      pos_thumbnail_url: thumbnailUrl,
      pos_thumbnail_source: sourceUrl,
    });

    return Response.json({
      ok: true,
      product_id: updated.id,
      pos_thumbnail_url: updated.pos_thumbnail_url,
      pos_thumbnail_source: updated.pos_thumbnail_source,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Kichik rasmni saqlab bo‘lmadi." },
      { status: Number((error as any)?.status || 500) },
    );
  }
}