import { createClientFromRequest } from "npm:@base44/sdk";

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const STAFF_ROLES = ["admin", "manager", "cashier", "accountant", "production", "warehouse"];
const WINDOW_MS = 60_000;
const MAX_CHECKS_PER_WINDOW = 10;

// In-memory per-IP rate limiter. Replaces the previous service-role ActionHistory
// write, which the security scanner flagged as an unauthenticated database write.
// This endpoint is intentionally public (pre-auth allowlist gate for login/register),
// so it cannot require a logged-in user; IP-based throttling mitigates abuse instead.
const ipHits = new Map<string, number[]>();

function rateLimited(source: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const hits = (ipHits.get(source) || []).filter((t) => t > cutoff);
  if (hits.length >= MAX_CHECKS_PER_WINDOW) {
    ipHits.set(source, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(source, hits);
  return true;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const forwarded = String(req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    const source = forwarded || String(req.headers.get("cf-connecting-ip") || "unknown");

    if (!rateLimited(source)) {
      return Response.json({
        allowed: false,
        error: "Juda ko‘p urinish. Bir daqiqadan keyin qayta urinib ko‘ring.",
      }, { status: 429 });
    }

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