import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole } from "../../shared/user-helpers.ts";

// Dependency order: child/history rows first, then their parent business records.
// System configuration, users, shops and security/audit records are intentionally absent.
const CLEANUP_ENTITIES = [
  "ShiftProductSnapshot",
  "shift-product-snapshot",
  "recipe-item",
  "RecipeItem",
  "telegram-delivery",
  "TelegramDelivery",
  "SaleItem",
  "SupplierReceiptItem",
  "StockCountItem",
  "ProductionBatchItem",
  "production-batch-item",
  "CustomerOrderItem",
  "OrderPayment",
  "ShopRequestItem",
  "Refund",
  "Payment",
  "Sale",
  "CashMovement",
  "StockMovement",
  "WasteRecord",
  "StockCount",
  "StockTransfer",
  "SupplierPayment",
  "SupplierReceipt",
  "BudgetTransaction",
  "DailyShopReport",
  "ProductionBatch",
  "production-batch",
  "Shift",
  "CustomerOrder",
  "BirthdayFollowup",
  "ShopRequest",
  "ProductStock",
  "IngredientStock",
  "Recipe",
  "recipe",
  "Product",
  "Ingredient",
  "Category",
  "DiscountCode",
  "BudgetBalance",
] as const;

async function deleteAll(service: any, entityName: string): Promise<number> {
  const entity = service.entities[entityName];
  let deleted = 0;
  for (let batch = 0; batch < 1000; batch += 1) {
    const rows = await entity.list("id", 100);
    if (!rows?.length) return deleted;
    for (let index = 0; index < rows.length; index += 10) {
      await Promise.all(rows.slice(index, index + 10).map((row: any) => entity.delete(row.id)));
    }
    deleted += rows.length;
  }
  throw new Error("DELETE_LIMIT:" + entityName);
}

Deno.serve(async (req) => {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth?.id) {
      return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    }

    const service = client.asServiceRole;
    const admin = await resolveStoredAppUser(service, auth);
    if (!admin || userRole(admin) !== "admin" || admin.active === false || admin.data?.active === false) {
      return Response.json({ error: "Faqat faol Egasi/Admin ma’lumotlarni tozalashi mumkin." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    if (body?.scope !== "test_business_data" || body?.confirm !== "TOZALASH") {
      return Response.json({ error: "Tozalash tasdig‘i noto‘g‘ri." }, { status: 400 });
    }

    const deleted: Record<string, number> = {};
    let total = 0;
    for (const entityName of CLEANUP_ENTITIES) {
      const count = await deleteAll(service, entityName);
      deleted[entityName] = count;
      total += count;
    }

    await service.entities.ActionHistory.create({
      user_id: String(admin.id || auth.id),
      user_name: String(admin.full_name || auth.full_name || auth.email || "Egasi"),
      action: "test_business_data_cleared",
      details: total + " ta test biznes yozuvi tozalandi. Admin, do‘konlar va xavfsizlik sozlamalari saqlandi.",
    });

    return Response.json({
      ok: true,
      total_deleted: total,
      deleted,
      preserved: ["User", "Shop", "Settings", "SecuritySettings", "TelegramControl", "DailyExportConfig", "PendingStaffInvite", "CashRecipient", "ActionHistory"],
    });
  } catch {
    return Response.json({
      error: "Tozalash yakunlanmadi. Qayta urinishdan oldin Admin bilan tekshiring.",
    }, { status: 500 });
  }
});
