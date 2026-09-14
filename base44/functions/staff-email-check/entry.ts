import { createClientFromRequest } from "npm:@base44/sdk";

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ allowed: false, reason: "invalid_email" }, { status: 400 });
    }

    // 1) Admin "+xodim qo'shish" orqali yuborilgan, hali aktivlanmagan taklif
    const invites = await base44.asServiceRole.entities.PendingStaffInvite.filter(
      { email, status: "pending" },
      "-created_date",
      5,
    );
    if (invites && invites.length > 0) {
      return Response.json({ allowed: true, reason: "invite" });
    }

    // 2) Ilovada allaqachon mavjud bo'lgan faol xodim
    const users = await base44.asServiceRole.entities.User.list("-created_date", 500);
    const known = (users || []).find(
      (u) => normalizeEmail(u.email) === email && u.active !== false,
    );
    if (known) {
      return Response.json({ allowed: true, reason: "user" });
    }

    return Response.json({ allowed: false, reason: "not_listed" });
  } catch (error) {
    return Response.json(
      { allowed: false, reason: "error", error: String(error?.message || error) },
      { status: 500 },
    );
  }
});