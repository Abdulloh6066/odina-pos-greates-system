import { createClientFromRequest } from "npm:@base44/sdk";

const ITERATIONS = 210000;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
    if (user.role !== "admin") {
      return Response.json({ error: "Only Owner/Admin can set the approval PIN." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const pin = String(body?.pin || "");
    if (!/^\d{4,8}$/.test(pin)) {
      return Response.json({ error: "PIN must contain 4 to 8 digits." }, { status: 400 });
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
      pin_updated_by: user.id,
    };
    const service = base44.asServiceRole;
    const matches = await service.entities.SecuritySettings.filter({ key: payload.key });
    if (matches?.[0]) await service.entities.SecuritySettings.update(matches[0].id, payload);
    else await service.entities.SecuritySettings.create(payload);

    await service.entities.ActionHistory.create({
      user_id: user.id,
      user_name: user.full_name || user.email,
      action: "owner_pin_updated",
      details: "Owner approval PIN was securely replaced.",
    }).catch(() => {});

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Could not set owner PIN.",
    }, { status: 500 });
  }
});
