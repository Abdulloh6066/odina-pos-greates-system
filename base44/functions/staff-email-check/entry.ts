import { createClientFromRequest } from "npm:@base44/sdk";

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const STAFF_ROLES = new Set(["admin", "manager", "cashier", "accountant", "production", "warehouse"]);

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const currentUser = await base44.auth.me();
    if (!currentUser?.id) {
      return Response.json({ allowed: false }, { status: 401 });
    }

    const email = normalizeEmail(currentUser.email);
    if (!email) {
      return Response.json({ allowed: false }, { status: 403 });
    }

    // IMPORTANT: this function intentionally ignores any email supplied by the
    // caller. It can only verify the authenticated caller's own account, which
    // prevents the endpoint from being used as an email-membership oracle.
    const service = base44.asServiceRole;
    const stored = await service.entities.User.get(currentUser.id).catch(() => null);
    const role = String(stored?.role || stored?.data?.role || currentUser.role || "");
    const active = stored?.active !== false && stored?.data?.active !== false;

    if (active && STAFF_ROLES.has(role)) {
      return Response.json({ allowed: true });
    }

    // A newly authenticated invitee may not have received their staff role yet.
    // Only their own pending invite is considered; arbitrary email probing is impossible.
    const invites = await service.entities.PendingStaffInvite.filter(
      { email, status: "pending" },
      "-created_date",
      1,
    );

    return Response.json({ allowed: Boolean(invites?.length) });
  } catch {
    return Response.json({ allowed: false }, { status: 403 });
  }
});
