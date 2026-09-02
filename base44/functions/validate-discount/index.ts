import { createClientFromRequest } from "npm:@base44/sdk";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
    if (!["admin", "cashier"].includes(user.role)) return Response.json({ error: "Not allowed." }, { status: 403 });
    const body = await req.json();
    const code = String(body?.code || "").trim().toUpperCase();
    if (!code) return Response.json({ error: "Enter a discount code." }, { status: 400 });
    const matches = await base44.asServiceRole.entities.DiscountCode.filter({ code, active: true });
    const discount = matches?.[0];
    if (!discount || (discount.single_use !== false && Number(discount.usage_count || 0) >= 1)) {
      return Response.json({ error: "Invalid, inactive, or already-used code." }, { status: 404 });
    }
    return Response.json({ code: discount.code, percentage: Number(discount.percentage) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not validate code." }, { status: 500 });
  }
});
