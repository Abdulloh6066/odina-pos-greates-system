import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole } from "../../shared/user-helpers.ts";

// One-time reset for the pre-launch transaction records. The fixed counts make
// the operation fail if a cashier has recorded another sale since the backup.
const EXPECTED: Record<string, number> = {
  SaleItem: 54,
  Payment: 39,
  Refund: 0,
  CashMovement: 0,
  StockMovement: 54,
  ShiftProductSnapshot: 0,
  Sale: 39,
  Shift: 3,
  DailyShopReport: 16,
};
const ORDER = [
  "SaleItem", "Payment", "Refund", "CashMovement", "StockMovement",
  "ShiftProductSnapshot", "Sale", "Shift", "DailyShopReport",
];

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth?.id) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const service = client.asServiceRole;
    const admin = await resolveStoredAppUser(service, auth);
    if (!admin || userRole(admin) !== "admin" || admin.active === false || admin.data?.active === false) {
      return Response.json({ error: "Faqat faol Egasi/Admin tozalashi mumkin." }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    if (body?.scope !== "prelaunch_sales_shifts" || body?.confirm !== "SOTUVNI_TOZALASH") {
      return Response.json({ error: "Tasdiq noto‘g‘ri." }, { status: 400 });
    }

    const rows: Record<string, any[]> = {};
    for (const name of ORDER) {
      const all = await service.entities[name].list("-created_date", 500);
      if (all.length !== EXPECTED[name]) {
        return Response.json({ error: name + " soni zaxiradan keyin o‘zgargan. Hech narsa o‘chirilmadi." }, { status: 409 });
      }
      rows[name] = all;
    }
    if (rows.StockMovement.some((row) => row.reference_type !== "sale")) {
      return Response.json({ error: "Sotuvga aloqasi bo‘lmagan ombor harakati bor. Hech narsa o‘chirilmadi." }, { status: 409 });
    }
    const saleIds = new Set(rows.Sale.map((row) => row.id));
    const shiftIds = new Set(rows.Shift.map((row) => row.id));
    if (rows.SaleItem.some((row) => !saleIds.has(row.sale_id)) ||
        rows.Payment.some((row) => !saleIds.has(row.sale_id)) ||
        rows.StockMovement.some((row) => !saleIds.has(row.reference_id)) ||
        rows.Sale.some((row) => !shiftIds.has(row.shift_id))) {
      return Response.json({ error: "Sotuv/smena bog‘lanishlari mos emas. Hech narsa o‘chirilmadi." }, { status: 409 });
    }

    const deleted: Record<string, number> = {};
    for (const name of ORDER) {
      for (let i = 0; i < rows[name].length; i += 10) {
        await Promise.all(rows[name].slice(i, i + 10).map((row) => service.entities[name].delete(row.id)));
      }
      deleted[name] = rows[name].length;
    }
    await service.entities.ActionHistory.create({
      user_id: String(admin.id || auth.id),
      user_name: String(admin.full_name || auth.full_name || auth.email || "Egasi"),
      action: "prelaunch_sales_shifts_cleared",
      details: "Sotuv, to‘lov, smena va sotuvga oid harakatlar tozalandi. Mahsulotlar, qoldiq, buyurtmalar va xavfsizlik tarixi saqlandi.",
    });
    return Response.json({ ok: true, deleted, preserved: ["Product", "ProductStock", "Category", "Recipe", "CustomerOrder", "BudgetBalance", "ActionHistory"] });
  } catch (error) {
    return Response.json({ error: "Tozalash to‘xtadi. Qayta urinishdan oldin qoldiq yozuvlarni tekshiring." }, { status: 500 });
  }
});
