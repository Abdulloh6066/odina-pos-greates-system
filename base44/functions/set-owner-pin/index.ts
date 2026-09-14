import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole } from "../../shared/user-helpers.ts";

const ITERATIONS = 210000;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const auth = await base44.auth.me();
    if (!auth?.id) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const service = base44.asServiceRole;
    const user = await resolveStoredAppUser(service, auth);
    if (!user || userRole(user) !== "admin" || user.active === false || user.data?.active === false) {
      return Response.json({ error: "Faqat faol Egasi/Admin PIN kodni o‘zgartira oladi." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const pin = String(body?.pin || "");
    if (!/^\d{6,8}$/.test(pin)) {
      return Response.json({ error: "Yangi PIN kod 6–8 ta raqamdan iborat bo‘lishi kerak." }, { status: 400 });
    }

    const saltBytes = crypto.getRandomValues(new Uint8Array(24));
    const salt = hex(saltBytes);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pin),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: ITERATIONS,
    }, key, 256);

    const payload = {
      key: "owner_approval_pin",
      pin_hash: hex(new Uint8Array(derived)),
      pin_salt: salt,
      pin_algorithm: "PBKDF2-SHA256",
      pin_iterations: ITERATIONS,
      pin_updated_at: new Date().toISOString(),
      pin_updated_by: user.id || auth.id,
    };
    const matches = await service.entities.SecuritySettings.filter({ key: payload.key });
    if (matches?.[0]) await service.entities.SecuritySettings.update(matches[0].id, payload);
    else await service.entities.SecuritySettings.create(payload);

    await service.entities.ActionHistory.create({
      user_id: user.id || auth.id,
      user_name: user.full_name || auth.full_name || auth.email,
      action: "owner_pin_updated",
      details: "Owner approval PIN was securely replaced.",
    }).catch(() => {});

    return Response.json({ success: true });
  } catch {
    return Response.json({
      error: "PIN kodni xavfsiz saqlab bo‘lmadi.",
    }, { status: 500 });
  }
});
