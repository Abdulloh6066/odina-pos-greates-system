import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";

// Expiry uses the server clock, through the selected day's end in Uzbekistan.
function isDiscountExpired(discount: any, now = Date.now()) {
  const date = discount?.valid_until;
  if (date === undefined || date === null || date === "") return false;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  const end = Date.parse(date + "T23:59:59.999+05:00");
  if (!Number.isFinite(end) || new Date(end + 5 * 60 * 60 * 1000).toISOString().slice(0, 10) !== date) return true;
  return now > end;
}


Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) return Response.json({ error: "Authentication required." }, { status: 401 });
    const user = await resolveAppUser(base44.asServiceRole, authenticatedUser);
    if (!["admin", "cashier"].includes(user.role)) return Response.json({ error: "Not allowed." }, { status: 403 });
    const body = await req.json();
    const code = String(body?.code || "").trim().toUpperCase();
    if (!code) return Response.json({ error: "Enter a discount code." }, { status: 400 });
    const matches = await base44.asServiceRole.entities.DiscountCode.filter({ code, active: true });
    const discount = matches?.[0];
    if (!discount || (discount.single_use !== false && Number(discount.usage_count || 0) >= 1)) {
      return Response.json({ error: "Invalid, inactive, or already-used code." }, { status: 404 });
    }
    if (isDiscountExpired(discount)) {
      return Response.json({ error: "Chegirma kodining muddati tugagan." }, { status: 409 });
    }
    return Response.json({ code: discount.code, percentage: Number(discount.percentage) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not validate code." }, { status: Number((error as any)?.status || 500) });
  }
});
