// single-writer/draft-extension.ts
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

// single-writer/draft-owner.json
var draft_owner_default = {
  verified: true,
  telegramId: "2058596004",
  staffId: "6a96eb22a9fd2b34081eb2de",
  shops: ["6a96f0a4ecc85c2fc57f3173", "6a96f0a4ecc85c2fc57f3174"]
};

// ../odina-editor-baseline-2026-10-20/base44/shared/user-helpers.ts
var APP_ROLES = /* @__PURE__ */ new Set(["admin", "manager", "cashier", "accountant", "production", "warehouse"]);
var userRole = (user) => {
  const rootRole = String(user?.role || "");
  const nestedRole = String(user?.data?.role || "");
  if (APP_ROLES.has(rootRole)) return rootRole;
  if (APP_ROLES.has(nestedRole)) return nestedRole;
  return rootRole || nestedRole;
};
var userShopId = (user) => String(user?.shop_id || user?.data?.shop_id || "");
var userShopName = (user) => String(user?.shop_name || user?.data?.shop_name || "");
var resolveStoredAppUser = async (service, authenticatedUser) => {
  let storedUser = null;
  const authenticatedId = String(authenticatedUser?.id || "");
  const email = String(authenticatedUser?.email || "").trim().toLowerCase();
  if (authenticatedId) {
    storedUser = await service.entities.User.get(authenticatedId).catch(() => null);
  }
  if (!storedUser && email) {
    const matches = await service.entities.User.filter({ email }, "-updated_date", 5);
    storedUser = (matches || []).find(
      (candidate) => String(candidate?.email || "").trim().toLowerCase() === email
    ) || null;
  }
  return storedUser;
};
var resolveAppUser = async (service, authenticatedUser) => {
  const storedUser = await resolveStoredAppUser(service, authenticatedUser);
  const storedRole = userRole(storedUser);
  if (!storedUser || !APP_ROLES.has(storedRole) || storedUser.active === false || storedUser.data?.active === false) {
    throw Object.assign(new Error("Faol xodim ruxsati topilmadi."), { status: 403 });
  }
  const shopId = userShopId(storedUser);
  if (storedRole === "manager") {
    const shop = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
    if (!shop || shop.active === false) {
      throw Object.assign(new Error("Boshqaruvchiga faol ish joyi biriktirilishi kerak."), { status: 403 });
    }
  }
  return {
    ...storedUser,
    data: { ...storedUser.data || {}, role: storedRole, shop_id: shopId },
    id: storedUser.id,
    email: storedUser.email || authenticatedUser?.email,
    full_name: storedUser.display_name || storedUser.data?.display_name || storedUser.full_name || authenticatedUser?.full_name,
    role: storedRole,
    shop_id: shopId,
    shop_name: userShopName(storedUser),
    active: true,
    is_owner: storedRole === "admin" && (storedUser.is_owner === true || storedUser.data?.is_owner === true)
  };
};

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot-authorization.ts
async function resolveOrderBotStaff(service, staffId, binding = null, selectedShop = "") {
  const user = await resolveAppUser(service, { id: staffId });
  if (user.id !== staffId || user.disabled === true || user.data?.disabled === true || !["admin", "manager", "cashier"].includes(user.role)) throw new Error("Faol xodim ruxsati topilmadi.");
  if (binding && (binding.enabled !== true || binding.staff_id !== staffId)) throw new Error("Xodim biriktirilishi noto\u2018g\u2018ri.");
  const activePosShop = async (id) => {
    const shop2 = id ? await service.entities.Shop.get(id) : null;
    return shop2 && shop2.active !== false && shop2.allows_pos !== false && shop2.location_type !== "production" ? shop2 : null;
  };
  if (binding?.scope_policy === "owner_choose_shop") {
    if (!user.is_owner || user.role !== "admin") throw new Error("Do\u2018kon tanlashga ruxsat yo\u2018q.");
    const ids = binding.owner_shop_ids;
    if (!Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2) throw new Error("Do\u2018konlar sozlanmagan.");
    const shops = await Promise.all(ids.map(activePosShop));
    const choices = shops.filter(Boolean).map((s) => ({ id: s.id, name: s.name }));
    if (!choices.length || selectedShop && !choices.some((s) => s.id === selectedShop)) throw new Error("Tanlangan do\u2018kon faol emas.");
    return { ...user, shop_id: selectedShop, shop_name: choices.find((s) => s.id === selectedShop)?.name || "", owner_shop_choices: choices };
  }
  if (binding && (binding.scope_policy !== "assigned_shop" || binding.owner_shop_ids?.length)) throw new Error("Xodim biriktirilishi noto\u2018g\u2018ri.");
  const shop = await activePosShop(user.shop_id);
  if (!shop || selectedShop && selectedShop !== shop.id) throw new Error("Faol do\u2018kon biriktirilmagan.");
  return { ...user, shop_id: shop.id, shop_name: shop.name };
}

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/response-bytes.js
async function boundedBytes(response, limit) {
  if (!response.ok)
    throw Error("http");
  const stated = Number(response.headers.get("content-length"));
  if (stated > limit)
    throw Error("size");
  const reader = response.body?.getReader();
  if (!reader)
    throw Error("body");
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done)
      break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Error("size");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/telegram.js
var TelegramAdapter = class {
  #token;
  constructor({ token = "", fetchImpl, enabled = false, timeoutMs = 1e4 }) {
    if (typeof fetchImpl !== "function")
      throw Error("Transport talab qilinadi.");
    this.#token = token;
    Object.assign(this, { fetchImpl, enabled, timeoutMs });
  }
  async request(method, payload) {
    try {
      if (!this.enabled || !this.#token || !["getFile", "sendMessage", "answerCallbackQuery"].includes(method))
        throw Error("disabled");
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536)));
      if (body.ok !== true)
        throw Error("api");
      return body.result;
    } catch {
      throw Error("Telegram amali tasdiqlanmadi.");
    }
  }
  async downloadBytes(fileId) {
    try {
      if (typeof fileId !== "string" || fileId.length > 512 || /[/:?]/.test(fileId))
        throw Error("file");
      const file = await this.request("getFile", { file_id: fileId });
      if (file?.file_id !== fileId || file.file_size > 10485760 || typeof file.file_path !== "string" || !/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(file.file_path) || file.file_path.includes(".."))
        throw Error("file");
      const response = await this.fetchImpl(`https://api.telegram.org/file/bot${this.#token}/${file.file_path}`, { redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      return await boundedBytes(response, 10485760);
    } catch {
      throw Error("Rasmni yuklab bo\u2018lmadi.");
    }
  }
  async sendReply(sender, response) {
    if (!/^[1-9]\d*$/.test(String(sender)) || typeof response?.text !== "string" || response.text.length > 4096)
      throw Error("Javob noto\u2018g\u2018ri.");
    const keyboard = response.buttons?.map(([text, data]) => {
      if (typeof text !== "string" || typeof data !== "string" || new TextEncoder().encode(data).length > 64)
        throw Error("Tugma noto\u2018g\u2018ri.");
      return [{ text, callback_data: data }];
    });
    const result = await this.request("sendMessage", { chat_id: sender, text: response.text, ...keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {} });
    if (!Number.isSafeInteger(result?.message_id) || String(result.chat?.id) !== String(sender))
      throw Error("Telegram javobi tasdiqlanmadi.");
    return result.message_id;
  }
  async acknowledge(callbackId) {
    if (typeof callbackId !== "string" || callbackId.length > 200)
      return;
    await this.request("answerCallbackQuery", { callback_query_id: callbackId, text: "So\u2018rov tekshirildi." });
  }
};

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/setup.js
var INTAKE_CONFIG = Object.freeze({
  ownerStaffId: "6a96eb22a9fd2b34081eb2de",
  ownerShopIds: ["6a96f0a4ecc85c2fc57f3173", "6a96f0a4ecc85c2fc57f3174"],
  controlId: "6ac3ffe963d876f807aef8bf",
  runId: "order-bot-cas-20261005-01",
  webhookUrl: "https://base44.app/api/apps/6a96eb22a9fd2b34081eb2dd/functions/telegram-order-webhook",
  approvedPhotoHosts: ["base44.app"]
});
async function controlRow(entity, config = INTAKE_CONFIG) {
  const row = await entity.get(config.controlId);
  if (row?.id !== config.controlId || row.enabled !== false || row.test_run_id !== config.runId || !Number.isSafeInteger(row.version)) throw Error("control");
  return row;
}

// single-writer/draft-transport.js
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

// single-writer/protocol.js
import { createHash } from "node:crypto";

// single-writer/draft-transport.js
var DRAFT_APP = "6a96eb22a9fd2b34081eb2dd";
function mac(key, purpose, timestamp, nonce, body) {
  if (typeof key !== "string" || key.length < 32) throw Error("transport_key_required");
  return createHmac("sha256", key).update(`${DRAFT_APP}
${purpose}
${timestamp}
${nonce}
${body}`).digest("hex");
}
function draftVerifier({ key, purpose, now = Date.now }) {
  const seen = /* @__PURE__ */ new Map();
  return async (req) => {
    if (req.method !== "POST") throw Error("invalid_request");
    const timestamp = req.headers.get("x-draft-time") || "", nonce = req.headers.get("x-draft-nonce") || "";
    if (!/^\d{13}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 3e4 || !/^[a-f0-9-]{36}$/.test(nonce)) throw Error("invalid_request");
    const reader = req.body?.getReader();
    if (!reader) throw Error("invalid_request");
    const chunks = [];
    let size = 0;
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) {
          await reader.cancel();
          throw Error("invalid_request");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const supplied = req.headers.get("x-draft-mac") || "";
    const expected = mac(key(), purpose, timestamp, nonce, body);
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw Error("invalid_request");
    for (const [n, expiry] of seen) if (expiry < now()) seen.delete(n);
    if (seen.has(nonce) || seen.size >= 4096) throw Error("invalid_request");
    seen.set(nonce, Number(timestamp) + 3e4);
    return JSON.parse(body);
  };
}
function ownerMatches(current, owner) {
  return current?.verified === true && current.active === true && current.isOwner === true && current.telegramId === owner.telegramId && current.staffId === owner.staffId && JSON.stringify(current.shops) === JSON.stringify(owner.shops);
}

// single-writer/draft-relay.js
function createDraftRelay({ owner, key, enabled = () => false, deliveryEnabled = () => false, readOwner, sendReply, now, verify: verify2 = draftVerifier({ key, purpose: "relay", now }) }) {
  return async (req) => {
    if (!enabled()) return new Response("Disabled", { status: 503 });
    let value;
    try {
      value = await verify2(req);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    if (!ownerMatches(await readOwner(), owner)) return new Response("Forbidden", { status: 403 });
    if (value?.action === "owner" && Object.keys(value).length === 1)
      return Response.json({ ...owner, active: true, isOwner: true });
    const r = value?.response;
    if (value?.action !== "reply" || Object.keys(value).some((k) => !["action", "recipient", "response"].includes(k)) || value.recipient !== owner.telegramId || !r || Object.keys(r).some((k) => !["text", "buttons"].includes(k)) || typeof r.text !== "string" || !r.text.startsWith("Qoralama rejimi. POSga saqlanmaydi.\n") || r.text.length > 4096 || r.buttons !== void 0 && (!Array.isArray(r.buttons) || r.buttons.length > 20 || r.buttons.some((b) => !Array.isArray(b) || b.length !== 2 || typeof b[0] !== "string" || b[0].length > 100 || typeof b[1] !== "string" || Buffer.byteLength(b[1]) > 64 || !/^draft:(?:shop|edit|cancel|inscribe|note):/.test(b[1]))))
      return new Response("Invalid reply", { status: 400 });
    if (!deliveryEnabled()) return new Response("Disabled", { status: 503 });
    try {
      await sendReply(owner.telegramId, r);
      return Response.json({ acknowledged: true });
    } catch {
      return new Response("Outcome unknown", { status: 502 });
    }
  };
}

// single-writer/draft-extension.ts
var DRAFT_REVISION = "owner-draft-isolated-v1";
var DRAFT_FLAGS = { ingress: false, relay: true, delivery: true };
var ownerStateId = "6ac41c139d2eedd404aac7ff";
async function currentOwner(service) {
  if (secrets.get("ODINA_ORDER_BOT_OWNER_TELEGRAM_ID") !== draft_owner_default.telegramId) throw Error("configured_owner_changed");
  const control = await controlRow(service.entities.TelegramOrderBotState);
  const state = JSON.parse(control.payload_json);
  if (control.phase !== "complete" || state.probe?.passed !== true || state.activation !== "active" || state.ownerStateId !== ownerStateId) throw Error("owner_activation_changed");
  const binding = await service.entities.TelegramOrderBotState.get(ownerStateId);
  if (String(binding.sender_id) !== draft_owner_default.telegramId || binding.staff_id !== draft_owner_default.staffId || binding.scope_policy !== "owner_choose_shop" || JSON.stringify(binding.owner_shop_ids) !== JSON.stringify(draft_owner_default.shops)) throw Error("owner_binding_changed");
  const user = await resolveOrderBotStaff(service, draft_owner_default.staffId, binding);
  if (user.owner_shop_choices?.length !== 2 || user.active !== true) throw Error("owner_disabled");
  return { ...draft_owner_default, active: true, isOwner: user.is_owner === true };
}
var verify = draftVerifier({ key: () => secrets.get("ODINA_DRAFT_RELAY_KEY") || "", purpose: "relay" });
async function relay(req) {
  if (!DRAFT_FLAGS.relay) return new Response("Disabled", { status: 503, headers: { "x-odina-draft-revision": DRAFT_REVISION } });
  try {
    const response = await createDraftRelay({
      owner: draft_owner_default,
      verify,
      key: () => secrets.get("ODINA_DRAFT_RELAY_KEY") || "",
      enabled: () => DRAFT_FLAGS.relay,
      deliveryEnabled: () => DRAFT_FLAGS.delivery,
      readOwner: () => currentOwner(createClientFromRequest(req).asServiceRole),
      sendReply: (id, response2) => new TelegramAdapter({
        token: secrets.get("ODINA_ORDER_BOT_TOKEN") || "",
        enabled: DRAFT_FLAGS.delivery,
        fetchImpl: globalThis.fetch,
        timeoutMs: 5e3
      }).sendReply(id, response2)
    })(req);
    response.headers.set("x-odina-draft-revision", DRAFT_REVISION);
    return response;
  } catch {
    return new Response("Unavailable", { status: 503 });
  }
}
export {
  relay as default
};
