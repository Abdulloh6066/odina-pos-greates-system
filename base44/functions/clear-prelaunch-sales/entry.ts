import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole } from "../../shared/user-helpers.ts";

// Frozen from the read-only archive made on 2026-09-26. Any new or changed
// transaction IDs stop the reset before it touches data.
const EXPECTED: Record<string, [number, string]> = {
  SaleItem: [82, "7f3ed1ab9bf0fa3047853760a31f8cf2376a91549a58d51b65df6938f6f197dd"],
  Payment: [54, "635d5012cf766d5410b98441bfabccae08757a489ba0bcb2e91a78b625cd4b59"],
  Refund: [0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  CashMovement: [0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  StockMovement: [82, "a52ffa9dbcb0b3a2836b06738592982ec22cb12a98e9d5adad0270c1bb86dea6"],
  ShiftProductSnapshot: [489, "49e4ea4342c21a292917b5afd7710279288a70fe44adad9175418b0b7d0d3b1a"],
  Sale: [54, "51a0391ac1624b8fb0c26b47b61d0093cfcc2d844146f47fa99a2d120b374af9"],
  Shift: [6, "156cccdd85d349697bcf293d68e6a97fbf57febfb637b1fb4dacba65f5f8758b"],
  DailyShopReport: [17, "7fa0ac0baff7489e2629f38770250bc6e916ed1c4df92a743a414a4db4c78606"],
  BudgetTransaction: [3, "57929cb8e399a989c6588f48c0292fc0ad422a34db3b50d4476a6270b9f64b07"],
};
const ORDER = [
  "SaleItem", "Payment", "Refund", "CashMovement", "StockMovement",
  "ShiftProductSnapshot", "Sale", "Shift", "DailyShopReport", "BudgetTransaction",
];
async function fingerprint(rows: any[]) {
  const ids = rows.map((row) => String(row.id)).sort().join("\n");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ids));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
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
      const [count, digest] = EXPECTED[name];
      if (all.length !== count || await fingerprint(all) !== digest) {
        return Response.json({ error: name + " zaxiradan keyin o‘zgargan. Hech narsa o‘chirilmadi." }, { status: 409 });
      }
      rows[name] = all;
    }
    const saleIds = new Set(rows.Sale.map((row) => row.id));
    const shiftIds = new Set(rows.Shift.map((row) => row.id));
    if (rows.StockMovement.some((row) => row.reference_type !== "sale" || !saleIds.has(row.reference_id)) ||
        rows.SaleItem.some((row) => !saleIds.has(row.sale_id)) ||
        rows.Payment.some((row) => !saleIds.has(row.sale_id)) ||
        rows.Sale.some((row) => !shiftIds.has(row.shift_id)) ||
        rows.ShiftProductSnapshot.some((row) => !shiftIds.has(row.shift_id)) ||
        rows.BudgetTransaction.some((row) => row.type !== "shift_deposit" || !shiftIds.has(row.shift_id))) {
      return Response.json({ error: "Sotuv/smena bog‘lanishlari mos emas. Hech narsa o‘chirilmadi." }, { status: 409 });
    }
    const expectedBudget = {
      cash: [825097, 500000, 325097],
      uzcard: [309000, 27000, 282000],
      online: [111000, 0, 111000],
    } as Record<string, [number, number, number]>;
    const balances = await service.entities.BudgetBalance.list("-created_date", 500);
    if (balances.length !== 5 || rows.BudgetTransaction.length !== 3) {
      return Response.json({ error: "Byudjet holati o‘zgargan. Hech narsa o‘chirilmadi." }, { status: 409 });
    }
    for (const [account, [current, before, amount]] of Object.entries(expectedBudget)) {
      const balance = balances.find((row: any) => row.account === account);
      const deposit = rows.BudgetTransaction.find((row) => row.account === account);
      if (!balance || Number(balance.balance) !== current || !deposit ||
          Number(deposit.balance_before) !== before || Number(deposit.balance_after) !== current ||
          Number(deposit.amount) !== amount || deposit.direction !== "in") {
        return Response.json({ error: "Byudjet mablag‘i zaxiradan keyin o‘zgargan. Hech narsa o‘chirilmadi." }, { status: 409 });
      }
    }
    const deleted: Record<string, number> = {};
    for (const name of ORDER) {
      for (let i = 0; i < rows[name].length; i += 10) {
        await Promise.all(rows[name].slice(i, i + 10).map((row) => service.entities[name].delete(row.id)));
      }
      deleted[name] = rows[name].length;
    }
    for (const [account, [, before]] of Object.entries(expectedBudget)) {
      const balance = balances.find((row: any) => row.account === account);
      await service.entities.BudgetBalance.update(balance.id, { balance: before, updated_at: new Date().toISOString() });
    }
    await service.entities.ActionHistory.create({
      user_id: String(admin.id || auth.id),
      user_name: String(admin.full_name || auth.full_name || auth.email || "Egasi"),
      action: "prelaunch_sales_shifts_cleared",
      details: "54 sotuv, 6 smena va bog‘liq yozuvlar tozalandi; uchta smena byudjet tushumi qaytarildi. Mahsulotlar va qoldiqlar saqlandi.",
    });
    return Response.json({ ok: true, deleted, preserved: ["Product", "ProductStock", "Category", "Recipe", "CustomerOrder", "BudgetBalance", "ActionHistory"] });
  } catch {
    return Response.json({ error: "Tozalash qisman to‘xtagan bo‘lishi mumkin. Qayta urinishdan oldin Admin bilan tekshiring." }, { status: 500 });
  }
});
