import { createClientFromRequest } from "npm:@base44/sdk";

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const STAFF_ROLES = ["admin", "manager", "cashier", "accountant", "production", "warehouse"];
const WINDOW_MS = 60_000;
const MAX_CHECKS_PER_WINDOW = 10;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const forwarded = String(req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    const source = forwarded || String(req.headers.get("cf-connecting-ip") || "unknown");
    const sourceKey = "public-email-check:" + (await sha256Hex(source)).slice(0, 24);
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const recent = await service.entities.ActionHistory.filter({
      user_id: sourceKey,
      action: "public_email_check",
      created_date: { $gte: since },
    }, "-created_date", MAX_CHECKS_PER_WINDOW + 1);

    if ((recent || []).length >= MAX_CHECKS_PER_WINDOW) {
      return Response.json({
        allowed: false,
        error: "Juda ko‘p urinish. Bir daqiqadan keyin qayta urinib ko‘ring.",
      }, { status: 429 });
    }

    await service.entities.ActionHistory.create({
      user_id: sourceKey,
      user_name: "Ro‘yxatdan o‘tish tekshiruvi",
      action: "public_email_check",
      details: "Email taklifi tekshirildi; email qiymati jurnalga yozilmadi.",
    });

    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ allowed: false }, { status: 400 });
    }

    const invites = await service.entities.PendingStaffInvite.filter(
      { email, status: "pending" },
      "-created_date",
      5,
    );
    if (invites?.length) {
      return Response.json({ allowed: true });
    }

    const users = await service.entities.User.list("-created_date", 500);
    const known = (users || []).some((user: any) =>
      normalizeEmail(user.email) === email &&
      user.active !== false &&
      user.data?.active !== false &&
      STAFF_ROLES.includes(String(user.role || user.data?.role || ""))
    );

    return Response.json({ allowed: known });
  } catch {
    return Response.json({
      allowed: false,
      error: "Email ruxsatini tekshirib bo‘lmadi.",
    }, { status: 503 });
  }
});
