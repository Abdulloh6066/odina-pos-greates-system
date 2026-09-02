import { createClientFromRequest } from "npm:@base44/sdk";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
    if (!["admin", "cashier"].includes(user.role)) {
      return Response.json({ error: "Your role cannot close a Kassa shift." }, { status: 403 });
    }
    const body = await req.json();
    const shiftId = String(body?.shift_id || "");
    const actualCash = Math.round(Number(body?.actual_cash));
    if (!shiftId || !Number.isFinite(actualCash) || actualCash < 0) {
      return Response.json({ error: "Shift and a valid counted cash amount are required." }, { status: 400 });
    }
    const shift = await base44.asServiceRole.entities.Shift.get(shiftId);
    if (!shift || shift.status !== "open") return Response.json({ error: "The shift is not open." }, { status: 409 });
    if (shift.user_id !== user.id) return Response.json({ error: "This shift belongs to another user." }, { status: 403 });

    const expected = Math.round(Number(shift.expected_cash || 0));
    const closedAt = new Date().toISOString();
    const updated = await base44.asServiceRole.entities.Shift.update(shift.id, {
      status: "closed", closed_at: closedAt, actual_cash: actualCash, difference: actualCash - expected,
    });
    await base44.asServiceRole.entities.ActionHistory.create({
      user_id: user.id, user_name: user.full_name || user.email,
      action: "shift_closed", details: `${shift.shop_name}. Difference ${actualCash - expected} UZS`,
    });
    return Response.json({ shift: updated, print_report_required: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not close shift." }, { status: 500 });
  }
});
