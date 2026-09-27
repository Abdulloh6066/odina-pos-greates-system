import { userRole, userShopId } from "./user-helpers.ts";

// Validate stored record ownership before privileged operations or retry responses.
export async function assertManagerRequestScope(service: any, user: any, body: any) {
  if (userRole(user) !== "manager") return;
  const shopId = userShopId(user);
  const deny = () => { throw Object.assign(new Error("Faqat biriktirilgan ish joyi uchun ruxsat berilgan."), { status: 403 }); };
  const shop = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
  if (!shop || shop.active === false) deny();
  for (const field of ["shop_id", "location_id"]) {
    if (body?.[field] && String(body[field]) !== shopId) deny();
  }
  for (const [key, entity, scope] of [
    ["shift_id", "Shift", "shop_id"], ["sale_id", "Sale", "shop_id"],
    ["order_id", "CustomerOrder", "shop_id"], ["receipt_id", "SupplierReceipt", "location_id"],
  ]) {
    if (!body?.[key]) continue;
    const row = await service.entities[entity].get(String(body[key])).catch(() => null);
    if (!row || row[scope] !== shopId) deny();
  }
}
