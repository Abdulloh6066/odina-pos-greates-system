import { createClientFromRequest } from "npm:@base44/sdk";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
    if (!["admin", "cashier"].includes(user.role)) {
      return Response.json({ error: "Your role cannot open a Kassa shift." }, { status: 403 });
    }

    const body = await req.json();
    const startingCash = Math.round(Number(body?.starting_cash || 0));
    if (!Number.isFinite(startingCash) || startingCash < 0) {
      return Response.json({ error: "Starting cash must be zero or more." }, { status: 400 });
    }

    const existing = await base44.asServiceRole.entities.Shift.filter({ user_id: user.id, status: "open" });
    if (existing?.length) return Response.json({ error: "You already have an open shift." }, { status: 409 });

    let shopId = String(body?.shop_id || "");
    if (user.role === "cashier") {
      if (!user.shop_id) return Response.json({ error: "Owner must assign this cashier to a shop first." }, { status: 403 });
      shopId = user.shop_id;
    }
    if (!shopId) return Response.json({ error: "A shop is required." }, { status: 400 });

    const shop = await base44.asServiceRole.entities.Shop.get(shopId);
    if (!shop) return Response.json({ error: "Shop not found." }, { status: 404 });

    const now = new Date().toISOString();
    const shift = await base44.asServiceRole.entities.Shift.create({
      user_id: user.id,
      user_name: user.full_name || user.email,
      shop_id: shop.id,
      shop_name: shop.name,
      status: "open",
      opened_at: now,
      starting_cash: startingCash,
      expected_cash: startingCash,
    });
    await base44.asServiceRole.entities.ActionHistory.create({
      user_id: user.id, user_name: user.full_name || user.email,
      action: "shift_opened", details: `${shop.name}, starting cash ${startingCash} UZS`,
    });
    return Response.json({ shift });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not open shift." }, { status: 500 });
  }
});
