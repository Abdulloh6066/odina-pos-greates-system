// Password material stays in Base44 secrets; this module is backend-only.
const encoder = new TextEncoder();
const SESSION_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const unlocking = new Set<string>();
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const failure = (error: string, status: number, extra = {}) => Response.json({ error, ...extra }, { status });

async function signingKey(secret: string) {
  if (!secret || secret.length < 64) throw new Error("Admin panel signing secret is missing");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function handleAdminPanel({ body, service, auth, admin, passwordConfig, signingSecret, now = Date.now() }: any) {
  if (!admin || (admin.role || admin.data?.role) !== "admin" || admin.active === false || admin.data?.active === false) {
    return failure("Faqat faol Egasi / Admin uchun.", 403);
  }
  const identity = String(auth.id) + ":" + String(admin.id);
  if (body.action === "admin_panel_session") {
    try {
      const token = String(body.token || "");
      if (token.length > 2048) return failure("Admin kirishi tugagan. Parolni qayta kiriting.", 401);
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra) throw new Error("Invalid token");
      const valid = await crypto.subtle.verify("HMAC", await signingKey(signingSecret), decode(signature), encoder.encode(payload));
      const session = JSON.parse(new TextDecoder().decode(decode(payload)));
      if (!valid || session.purpose !== "odina-admin-panel-v1" || session.subject !== identity
        || !Number.isFinite(session.expires_at) || session.expires_at <= now
        || session.expires_at > now + SESSION_MS || !Number.isFinite(session.issued_at) || session.issued_at > now) {
        return failure("Admin kirishi tugagan. Parolni qayta kiriting.", 401);
      }
      return Response.json({ ok: true, expires_at: session.expires_at });
    } catch {
      return failure("Admin kirishi tugagan. Parolni qayta kiriting.", 401);
    }
  }
  if (body.action !== "admin_panel_unlock") return failure("Noma’lum admin amali.", 400);
  if (typeof body.password !== "string" || !body.password || body.password.length > 256) {
    return failure("Admin parolini kiriting.", 400);
  }
  if (unlocking.has(identity)) return failure("Kirish tekshirilmoqda. Biroz kuting.", 429, { retry_after: 2 });
  unlocking.add(identity);
  try {
    const config = JSON.parse(passwordConfig || "{}");
    if (config.algorithm !== "PBKDF2-SHA256" || !Number.isInteger(config.iterations)
      || config.iterations < 100000 || config.iterations > 2000000
      || !/^[a-f0-9]{64}$/.test(config.salt || "") || !/^[a-f0-9]{64}$/.test(config.hash || "")) {
      return failure("Admin paroli hali sozlanmagan. Hisob egasiga murojaat qiling.", 503);
    }
    const key = await signingKey(signingSecret);
    // Durable history makes the cooldown survive function restarts.
    const failures = await service.entities.ActionHistory.filter({
      user_id: String(admin.id), action: "admin_panel_password_failed",
    }, "-created_date", 5);
    const recent = (failures || []).filter((row: any) => Date.parse(row.created_date || row.created_at || "") > now - ATTEMPT_WINDOW_MS);
    if (recent.length >= 5) {
      const retryAfter = Math.max(1, Math.ceil((Date.parse(recent[recent.length - 1].created_date || recent[recent.length - 1].created_at) + ATTEMPT_WINDOW_MS - now) / 1000));
      return failure("Ko‘p noto‘g‘ri urinish. Keyinroq qayta urinib ko‘ring.", 429, { retry_after: retryAfter });
    }
    const passwordKey = await crypto.subtle.importKey("raw", encoder.encode(body.password), "PBKDF2", false, ["deriveBits"]);
    const derived = await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(config.salt), iterations: config.iterations,
    }, passwordKey, 256);
    const actual = hex(new Uint8Array(derived));
    let difference = 0;
    for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ config.hash.charCodeAt(i);
    const audit = { user_id: String(admin.id), user_name: String(admin.display_name || admin.full_name || auth.email || "Egasi") };
    if (difference !== 0) {
      await service.entities.ActionHistory.create({ ...audit, action: "admin_panel_password_failed", details: "Admin panelga noto‘g‘ri parol bilan kirish urinishi." });
      return failure("Admin paroli noto‘g‘ri.", 401);
    }
    const expiresAt = now + SESSION_MS;
    const payload = encode(encoder.encode(JSON.stringify({ purpose: "odina-admin-panel-v1", subject: identity, issued_at: now, expires_at: expiresAt })));
    const signature = encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
    await service.entities.ActionHistory.create({ ...audit, action: "admin_panel_unlocked", details: "Admin panelga parol bilan kirildi." });
    return Response.json({ ok: true, token: payload + "." + signature, expires_at: expiresAt });
  } catch {
    return failure("Admin kirishini tekshirib bo‘lmadi. Qayta urinib ko‘ring.", 503);
  } finally {
    unlocking.delete(identity);
  }
}
