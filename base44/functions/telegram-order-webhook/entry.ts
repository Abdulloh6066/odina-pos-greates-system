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
function base44PhotoUpload(service) {
  return async (bytes, mime) => {
    try {
      const result = await service.integrations.Core.UploadFile({ file: new File([bytes], mime === "image/png" ? "order-reference.png" : "order-reference.jpg", { type: mime }) });
      if (typeof result?.file_url !== "string")
        throw Error();
      return result.file_url;
    } catch {
      throw Error("Rasmni saqlab bo\u2018lmadi.");
    }
  };
}

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
function senderOf(update) {
  const cb = update?.callback_query, m = cb?.message ?? update?.message, from = cb?.from ?? m?.from;
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !Number.isSafeInteger(from?.id) || from.id <= 0 || from.is_bot || m?.chat?.type !== "private" || String(m.chat.id) !== String(from.id) || m.forward_origin || m.forward_from || m.forward_date)
    throw Error("private_verified_sender_required");
  return String(from.id);
}

// single-writer/draft-transport.js
var DRAFT_APP = "6a96eb22a9fd2b34081eb2dd";
function isDraft(update) {
  const text = update?.message?.text ?? update?.message?.caption;
  return /^\/draft(?:@odina_buyurtmalar_bot)?(?:\s|$)/u.test(text || "") || String(update?.callback_query?.data || "").startsWith("draft:");
}
function mac(key, purpose, timestamp, nonce, body) {
  if (typeof key !== "string" || key.length < 32) throw Error("transport_key_required");
  return createHmac("sha256", key).update(`${DRAFT_APP}
${purpose}
${timestamp}
${nonce}
${body}`).digest("hex");
}
function signDraftRequest({ key, purpose, value, now = Date.now() }) {
  const body = JSON.stringify(value), timestamp = String(now), nonce = randomUUID();
  return { method: "POST", body, headers: {
    "content-type": "application/json",
    "x-draft-time": timestamp,
    "x-draft-nonce": nonce,
    "x-draft-mac": mac(key, purpose, timestamp, nonce, body)
  } };
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
function privateOwner(update, owner) {
  try {
    return senderOf(update) === owner.telegramId;
  } catch {
    return false;
  }
}
function createDraftClient({ url, key, purpose, enabled = () => false, fetchImpl = fetch }) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || target.hash) throw Error("https_endpoint_required");
  return async (value) => {
    if (!enabled()) throw Error("disabled");
    const response = await fetchImpl(target.href, {
      ...signDraftRequest({ key: key(), purpose, value }),
      redirect: "error",
      signal: AbortSignal.timeout(5e3)
    });
    if (!response.ok) throw Error("transport_failed");
    return response.json();
  };
}
function createDraftDispatch({ owner, enabled = () => false, readOwner, forward }) {
  return async (update, legacy) => {
    if (!isDraft(update)) return legacy();
    if (!enabled()) return new Response("Draft disabled", { status: 200 });
    if (!privateOwner(update, owner) || !ownerMatches(await readOwner(), owner)) return new Response("Forbidden", { status: 403 });
    const clean = structuredClone(update);
    if (clean.message) {
      for (const field of ["text", "caption"]) if (typeof clean.message[field] === "string")
        clean.message[field] = clean.message[field].replace(/^\/draft@odina_buyurtmalar_bot(?=\s|$)/u, "/draft");
    }
    try {
      await forward(clean);
      return new Response("OK");
    } catch {
      return new Response("Draft unavailable", { status: 503 });
    }
  };
}

// single-writer/draft-extension.ts
var DRAFT_REVISION = "owner-draft-isolated-v1";
var DRAFT_FLAGS = { ingress: false, relay: false, delivery: false };
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
async function maybeDraft(req, service) {
  const reader = req.clone().body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (; ; ) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 32768) {
        void reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(part.value));
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  let update;
  try {
    update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  const response = await createDraftDispatch({
    owner: draft_owner_default,
    enabled: () => DRAFT_FLAGS.ingress,
    readOwner: () => currentOwner(service),
    forward: (value) => createDraftClient({
      url: secrets.get("ODINA_DRAFT_WORKER_URL") || "",
      key: () => secrets.get("ODINA_DRAFT_INGRESS_KEY") || "",
      purpose: "ingress",
      enabled: () => DRAFT_FLAGS.ingress
    })(value)
  })(update, async () => null);
  if (response) response.headers.set("x-odina-draft-revision", DRAFT_REVISION);
  return response;
}
var verify = draftVerifier({ key: () => secrets.get("ODINA_DRAFT_RELAY_KEY") || "", purpose: "relay" });

// ../odina-editor-baseline-2026-10-20/base44/functions/telegram-order-webhook/ingress.ts
import { timingSafeEqual as timingSafeEqual3 } from "node:crypto";
import { createClientFromRequest as createClientFromRequest2 } from "npm:@base44/sdk";
import { secrets as secrets2 } from "base44:runtime";

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/bot.js
import { randomUUID as randomUUID2 } from "node:crypto";

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/parser.js
var months = {
  yan: 1,
  yanv: 1,
  fev: 2,
  fevr: 2,
  mar: 3,
  mart: 3,
  apr: 4,
  apre: 4,
  may: 5,
  iyn: 6,
  iyun: 6,
  iyl: 7,
  iyul: 7,
  avg: 8,
  avgu: 8,
  sen: 9,
  sent: 9,
  okt: 10,
  okta: 10,
  okty: 10,
  oqti: 10,
  okti: 10,
  noy: 11,
  noya: 11,
  dek: 12,
  deka: 12
};
var monthWords = "(?:(?:yanv|fevr|mart|apre|iyun|iyul|avgu|sent|okta|okty|oqti|okti|noya|deka)[a-z]*|(?:yan|fev|mar|apr|may|iyn|iyl|avg|sen|okt|noy|dek)(?![a-z]))";
var datePattern = "\\b(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[ \\t]*[-.]?[ \\t]*" + monthWords + ")\\b";
var deliveryPattern = /(?<![\p{L}\p{N}_])(?:dastafka|dastavka|dostavka|delivery|доставка|даставка|дастафка|yetkazib\s+berish)(?![\p{L}\p{N}_])/iu;
var pickupPattern = /^(?:olish\s*:\s*)?olib\s+(?:ketish|ketadi|ketaman|ketamiz)[.!]?$/iu;
function parse(text, now, draft = {}) {
  text = orderInput(text);
  const patch = {}, errors = [];
  function take(regex, key, convert = (m) => m[1]) {
    const a = [...text.matchAll(regex)];
    if (a.length === 1)
      patch[key] = convert(a[0]);
    if (a.length > 1) {
      patch[key] = null;
      errors.push(key);
    }
  }
  take(new RegExp("(" + datePattern + ")", "gi"), "date", (m) => {
    if (/^\d{4}/.test(m[1])) return m[1];
    const parts = m[1].match(/^(\d{1,2})[ \t]*[-.]?[ \t]*([a-z]+)$/i);
    const word = parts[2].toLowerCase(), month = months[word.slice(0, 4)] ?? months[word];
    return `${(/* @__PURE__ */ new Date(+now + 18e6)).getUTCFullYear()}-${String(month).padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  });
  take(/\b(\d{1,2}:\d{2})\b/g, "time", (m) => m[1].padStart(5, "0"));
  const prices = [...text.matchAll(/(?<![\d.,+-])\b(\d+)\s*lik\b/gi)].map((m) => Number(m[1]) * 1e3);
  const amount = "(?:\\d{1,3}(?:[ \\u00a0\\u202f.,]\\d{3})+|\\d+)";
  const currency = "(?:so['\u2018\u2019\u02BB\u02BC]?m|sum|uzs|usz|\u0441\u0443\u043C)";
  for (const m of text.matchAll(new RegExp("(?<![\\d.,+-])\\b(" + amount + ")[ \\t]*" + currency + "(?![\\p{L}\\p{N}_])", "giu")))
    if (!/[-+\d][\d \t\u00a0\u202f.,]*$/.test(text.slice(0, m.index)))
      prices.push(Number(m[1].replace(/\D/g, "")));
  const labelled = new RegExp("(?:^|[;\\n])[ \\t]*narx[ \\t]*:[ \\t]*(" + amount + ")[ \\t]*(?=$|[;\\n])", "gi");
  for (const m of text.matchAll(labelled)) prices.push(Number(m[1].replace(/\D/g, "")));
  const distinctPrices = [...new Set(prices)];
  if (distinctPrices.length === 1 && Number.isSafeInteger(distinctPrices[0]) && distinctPrices[0] > 0)
    patch.tier = distinctPrices[0];
  else if (distinctPrices.length) {
    patch.tier = null;
    errors.push("tier");
  }
  take(/(?<!\d)(\+?998[\s-]*\d{2}[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})(?!\d)/g, "phone", (m) => "+" + m[1].replace(/\D/g, ""));
  take(/(?:^|[,;\n])\s*ism\s*:\s*([^,;\n]+)/gi, "name", (m) => m[1].trim());
  take(/(?:^|[,;\n])\s*tur\s*:\s*(tugilgan_kun_va_boshqa|toy_va_bazmlar)\b/gi, "type");
  if (/\bto['‘’ʻʼ]?y\s+uchun\b/i.test(text)) {
    if (Object.hasOwn(patch, "type") && patch.type !== "toy_va_bazmlar") {
      patch.type = null;
      if (!errors.includes("type")) errors.push("type");
    } else patch.type = "toy_va_bazmlar";
  }
  const delivery = text.split(/[,;\n]/).some((line) => deliveryPattern.test(line) && !/(?:emas|kerak\s+emas|shart\s+emas|yo['‘’ʻʼ]?q)\b/iu.test(line));
  const pickup = text.split(/[,;\n]/).some((line) => pickupPattern.test(line.trim()));
  if (delivery && pickup) {
    patch.fulfilment = null;
    errors.push("fulfilment");
  } else if (delivery) patch.fulfilment = "delivery";
  else if (pickup) patch.fulfilment = "pickup";
  if (!draft.name && !Object.hasOwn(patch, "name")) {
    const lines = text.split(/[,;\n]/).map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean);
    const names = lines.filter((line) => line.length <= 80 && !deliveryPattern.test(line) && !pickupPattern.test(line) && /^(?:[\p{L}‘’ʻʼ'-]+|\p{Lu}[\p{L}‘’ʻʼ'-]*(?: \p{Lu}[\p{L}‘’ʻʼ'-]*){1,2})$/u.test(line) && !/(?:^| )(?:buyurtma|tort|rasm|yoziladi|yozilad|olib|ketish|yetkazib|avans|to‘lov|narx|sana|vaqt|telefon|rahmat|salom|aniq|deb|uchun|oq|qora|pushti|qizil|rang|gullar|bezak|bento|dastafka|dastavka|dostavka)(?:$| )/iu.test(line));
    const contactReply = Boolean(patch.phone || draft.phone);
    const nameReply = !draft.name && lines.length === 1 && Boolean(draft.date || draft.time || draft.photo || draft.phone);
    if (contactReply || nameReply) {
      if (names.length === 1) patch.name = names[0];
      if (names.length > 1) {
        patch.name = null;
        errors.push("name");
      }
    }
  }
  if (/avans|oldindan|to['‘’]?landi/i.test(text))
    errors.push("payment");
  return { patch, errors };
}
function recoverContactDetails(draft, now) {
  const parsed = parse(draft.notes || "", now, draft);
  let changed = false;
  for (const key of ["name", "fulfilment"]) {
    if (!draft[key] && parsed.patch[key] && !parsed.errors.includes(key)) {
      draft[key] = parsed.patch[key];
      changed = true;
    }
  }
  if (!draft.fulfilment && !parsed.errors.includes("fulfilment") && !draft.errors?.includes("fulfilment")) {
    draft.fulfilment = "pickup";
    changed = true;
  }
  return changed;
}
function recoverMissingPrice(draft, now) {
  if (draft.tier || draft.errors?.includes("tier")) return false;
  const parsed = parse(draft.notes || "", now, draft);
  if (!parsed.patch.tier || parsed.errors.includes("tier")) return false;
  draft.tier = parsed.patch.tier;
  return true;
}
var inscriptionLabel = /^(?:tort(?:dagi|ga)?\s+yozuv|yozuv)\s*:\s*(.+)$/iu;
var noteLabel = /^(?:izoh|qo['‘’ʻʼ]?shimcha\s+izoh)\s*:\s*(.+)$/iu;
var writingMarker = /^(?:yoziladi|yozilad|yozilsin)[.!]?$/iu;
var inlineWriting = /^(.+?)\s+(?:deb\s+)?(?:yoziladi|yozilad|yozilsin)[.!]?$/iu;
function decorationLines(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const protectedLines = /* @__PURE__ */ new Set(), explicit = [], candidates = [], additional = [];
  let orphanMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].match(inscriptionLabel), note = lines[i].match(noteLabel);
    if (label) {
      explicit.push(label[1].trim());
      protectedLines.add(i);
    } else if (note) {
      additional.push(note[1].trim());
      protectedLines.add(i);
    } else if (writingMarker.test(lines[i])) {
      protectedLines.add(i);
      const before = lines[i - 1];
      if (before && !protectedLines.has(i - 1) && !/[:\d]/u.test(before) && !/^(?:olib\s+ketish|to['‘’ʻʼ]?y\s+uchun)$/iu.test(before)) {
        candidates.push(before);
        protectedLines.add(i - 1);
      } else if (!before || !inscriptionLabel.test(before) && !inlineWriting.test(before)) orphanMarker = true;
    } else {
      const inline = lines[i].match(inlineWriting);
      if (inline) {
        candidates.push(inline[1].replace(/^[«“"]|[»”"]$/g, "").trim());
        protectedLines.add(i);
      }
    }
  }
  return { lines, protectedLines, explicit, candidates: [...new Set(candidates)], additional, orphanMarker };
}
function orderInput(text) {
  const { lines, protectedLines } = decorationLines(text);
  return lines.filter((_, i) => !protectedLines.has(i)).join("\n");
}
function removeOrderFields(line, draft) {
  if (/[,;](?!\d)/.test(line) && /(?:^|[,;])\s*(?:ism|telefon|sana|vaqt|narx|tur|olish)\s*:/iu.test(line))
    return line.split(/[,;](?!\d)/).map((part) => removeOrderFields(part.trim(), draft)).filter(Boolean).join("; ");
  if (line === draft.name) return "";
  if (/^(?:ism|telefon|sana|vaqt|narx|tur|olish)\s*:/iu.test(line)) {
    const value = line.replace(/^[^:]+:\s*/, "");
    if (/^ism\s*:/iu.test(line) && value === draft.name) return "";
    line = value;
  }
  return line.replace(/(?<!\d)(\+?998[\s-]*\d{2}[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})(?!\d)/g, "").replace(new RegExp(datePattern, "gi"), "").replace(/\b\d{1,2}:\d{2}\b/g, "").replace(/(?<![\d.,+-])\b\d+\s*lik\b/gi, "").replace(/(?<![\d.,+-])\b(?:\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+|\d+)[ \t]*(?:so['‘’ʻʼ]?m|sum|uzs|usz|сум)(?![\p{L}\p{N}_])/giu, "").replace(pickupPattern, "").replace(/^(?:to['‘’ʻʼ]?y\s+uchun|tugilgan_kun_va_boshqa|toy_va_bazmlar)$/iu, "").replace(new RegExp("^" + String(draft.tier || "NO_PRICE") + "$"), "").replace(/^[\s,;—-]*(?:razmerda)?[\s,;—-]*$/iu, "").trim();
}
function updateCustomization(draft) {
  const parts = decorationLines(draft.notes || "");
  const additional = [...parts.additional];
  for (let i = 0; i < parts.lines.length; i++) {
    if (!parts.protectedLines.has(i)) {
      const rest = removeOrderFields(parts.lines[i], draft);
      if (rest) additional.push(rest);
    }
  }
  const candidate = parts.candidates.length === 1 ? parts.candidates[0] : "";
  const decision = draft.inscription_decision?.text === candidate ? draft.inscription_decision : null;
  let inscription = parts.explicit.at(-1) || "";
  let pending = false;
  if (!inscription && candidate) {
    if (decision?.accepted === true) inscription = candidate;
    else if (decision?.accepted === false) additional.push(candidate);
    else pending = true;
  }
  if (parts.candidates.length > 1) additional.push(...parts.candidates);
  const values = {
    notes_format_version: 1,
    inscription,
    inscription_candidate: candidate,
    inscription_pending: pending,
    inscription_unclear: !inscription && (parts.candidates.length > 1 || parts.orphanMarker),
    additional_notes: [...new Set(additional)].join("\n")
  };
  const changed = Object.entries(values).some(([k, v]) => draft[k] !== v);
  Object.assign(draft, values);
  return changed;
}
function orderNotes(draft) {
  if (draft.notes_format_version !== 1) return draft.notes;
  return [
    draft.inscription ? "Tortdagi yozuv: " + draft.inscription : "",
    draft.additional_notes ? "Izoh: " + draft.additional_notes : ""
  ].filter(Boolean).join("\n");
}
function dateProblem(d, now) {
  if (!d.date || !d.time) return "";
  const t = /* @__PURE__ */ new Date(d.date + "T" + d.time + ":00+05:00");
  if (!Number.isFinite(+t) || (/* @__PURE__ */ new Date(+t + 18e6)).toISOString().slice(0, 16) !== d.date + "T" + d.time)
    return "Sana yoki vaqt noto\u2018g\u2018ri. To\u2018g\u2018ri sana va vaqt yuboring.";
  if (t < now)
    return d.date + " " + d.time + " o\u2018tib ketgan. Yangi sana va vaqt yuboring.";
  return "";
}
function missing(d, now) {
  const labels = { date: "Sana:", time: "Vaqt:", tier: "Narx:", phone: "Telefon raqami:", name: "Mijoz ismi:", type: "Buyurtma turi:", fulfilment: "Olish usuli:", photo: "Tort rasmi:" };
  const needed = Object.keys(labels).filter((k) => !d[k] && !(k === "type" && d.type === void 0));
  if (d.date && d.time) {
    const t = /* @__PURE__ */ new Date(`${d.date}T${d.time}:00+05:00`);
    if (!Number.isFinite(+t) || (/* @__PURE__ */ new Date(+t + 18e6)).toISOString().slice(0, 16) !== `${d.date}T${d.time}` || t < now)
      needed.push("date", "time");
  }
  if (d.fulfilment && d.fulfilment !== "pickup") needed.push("fulfilment");
  if (d.tier && !Number.isSafeInteger(d.tier))
    needed.push("tier");
  return [...new Set(needed)].map((k) => labels[k]);
}

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/bot.js
var reply = (text) => ({ text });
var money = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " so\u2018m";
var OrderBot = class {
  constructor({ store, allowlist = {}, pos, photos, now = () => /* @__PURE__ */ new Date(), bindingProvider = null, submissionEnabled = true }) {
    Object.assign(this, { store, allowlist, pos, photos, now, bindingProvider, submissionEnabled });
  }
  async auth(s) {
    const binding = this.bindingProvider ? await this.bindingProvider(s) : null;
    const id = this.bindingProvider ? binding?.staff_id : Object.hasOwn(this.allowlist, s) ? this.allowlist[s] : null;
    if (!id)
      return null;
    const u = await this.pos.staff(id, binding);
    return u?.id === id && u.active === true && u.data?.active !== false && ["admin", "manager", "cashier"].includes(u.role) && (u.owner_shop_choices?.length || u.shop_id && await this.pos.shopActive(u.shop_id)) ? u : null;
  }
  scopeMatches(d, staff) {
    return d.staff === staff.id && (staff.owner_shop_choices ? !d.shop || staff.owner_shop_choices.some((s) => s.id === d.shop) : d.shop === staff.shop_id);
  }
  async handle(u) {
    const cb = u?.callback_query, m = cb?.message ?? u?.message, s = String((cb?.from ?? m?.from)?.id ?? "");
    if (!Number.isSafeInteger((cb?.from ?? m?.from)?.id) || !Number.isSafeInteger(u?.update_id) || !/^[1-9]\d*$/.test(s) || m?.chat?.type !== "private" || String(m.chat.id) !== s || m?.forward_origin || m?.forward_from || m?.forward_date || (cb?.from ?? m?.from)?.is_bot)
      return reply("Faqat shaxsiy chatda foydalaning.");
    const staff = await this.auth(s);
    if (!staff)
      return reply("Sizga ruxsat berilmagan. Mas\u2019ul xodimga murojaat qiling.");
    const existing = await this.store.get(s);
    if (existing && !this.scopeMatches(existing, staff))
      return reply("Xodim yoki do\u2018kon biriktirilishi o\u2018zgargan. Mas\u2019ul xodim tekshirsin.");
    const uid = String(u.update_id), delivery = await this.store.transaction(s, (tx) => tx.delivery(uid, s));
    if (delivery.duplicate)
      return delivery.response;
    let r;
    try {
      r = await this.process(s, staff, m, cb);
    } catch {
      r = reply("So\u2018rov yakunlanmadi. /holat yuboring; qayta buyurtma yaratmang.");
    }
    return this.store.transaction(s, (tx) => tx.reply(uid, r));
  }
  summary(d) {
    const fields = missing(d, this.now());
    if (fields.length || d.errors?.length) {
      const received = [
        d.date && !fields.some((f) => f.startsWith("Sana")) ? `\u{1F4C5} Sana: ${d.date}` : "",
        d.time && !fields.some((f) => f.startsWith("Vaqt")) ? `\u{1F550} Vaqt: ${d.time}` : "",
        d.tier && !fields.some((f) => f.startsWith("Narx")) ? `\u{1F4B0} Narx: ${money(d.tier)}` : "",
        d.phone ? `\u{1F4DE} Telefon: ${d.phone}` : "",
        d.name ? `\u{1F464} Mijoz ismi: ${d.name}` : "",
        d.type === null ? "" : `\u{1F4CB} Buyurtma turi: ${d.type === "toy_va_bazmlar" ? "To\u2018y buyurtmasi" : "Buyurtma"}`,
        d.fulfilment === "pickup" ? "\u{1F6CD} Olish: olib ketish" : "",
        d.photo ? "\u{1F4F7} Tort rasmi: qabul qilindi" : ""
      ].filter(Boolean);
      return reply([
        ...received.length ? ["\u2705 Qabul qilingan ma\u2019lumotlar:", ...received, ""] : [],
        ...dateProblem(d, this.now()) ? [dateProblem(d, this.now()), ""] : [],
        ...d.fulfilment === "delivery" ? ["Yetkazib berish bu botda hali yoqilmagan. Olib ketish bo\u2018lsa, \xABolib ketish\xBB deb yuboring.", ""] : [],
        fields.length === 1 && fields[0] === "Narx:" ? "\u26A0\uFE0F Buyurtma narxi yetishmayapti." : fields.length ? "\u26A0\uFE0F Quyidagi ma\u2019lumotlar yetishmayapti:" : "\u26A0\uFE0F Buyurtma ma\u2019lumotlarini aniqlashtiring.",
        ...fields.length === 1 && fields[0] === "Narx:" ? [] : fields.map((field) => "\u2022 " + field.replace(/:$/, "")),
        ...fields.includes("Narx:") ? ["Narxdan keyin som, UZS yoki lik yozing."] : [],
        "",
        d.errors?.length ? "Noto\u2018g\u2018ri yoki bir nechta qiymat bor; /tahrir bilan to\u2018liq matnni qayta yuboring." : "Yetishmayotgan ma\u2019lumotlarni yuboring."
      ].join("\n"));
    }
    if (d.inscription_pending)
      return {
        text: "Tortga \xAB" + d.inscription_candidate + "\xBB deb yozilsinmi?",
        buttons: [["Ha, yozilsin", `inscribe:${d.id}:${d.version}`], ["Yo\u2018q, izoh sifatida", `note:${d.id}:${d.version}`]]
      };
    if (d.inscription_unclear)
      return reply("Tortdagi yozuvni aniqlashtiring. \xABTortdagi yozuv: ...\xBB shaklida yuboring. Oldingi matn saqlanadi.\n\nIzoh: " + d.additional_notes);
    if (!d.shop && d.owner_shop_choices?.length)
      return { text: "Buyurtma qaysi do\u2018konda saqlansin?", buttons: d.owner_shop_choices.map((s) => [s.name, `shop:${d.id}:${d.version}:${s.id}`]) };
    return { text: `Shu buyurtma to\u2018g\u2018rimi? \u{1F9FE}

\u{1F464} Ism: ${d.name}
\u{1F4DE} Telefon: ${d.phone}
\u{1F4C5} Sana: ${d.date}
\u{1F550} Vaqt: ${d.time}

\u{1F3EA} Do\u2018kon: ${d.shop_name || d.shop}
\u{1F4CB} Buyurtma turi: ${d.type === "toy_va_bazmlar" ? "To\u2018y buyurtmasi" : "Buyurtma"}
\u{1F6CD} Olish: olib ketish
\u{1F4E6} Soni: 1 dona

\u{1F4B0} Narx: ${money(d.tier)}
\u{1F4B0} To\u2018lov: to\u2018lanmagan
\u{1F4B0} Qoldiq: ${money(d.tier)}

\u{1F4DD} ${orderNotes(d) || "Izoh: yo\u2018q"}`, buttons: [["\u2705 Tasdiqlash", `ok:${d.id}:${d.version}`], ["\u270F\uFE0F Tahrirlash", `edit:${d.id}:${d.version}`], ["\u274C Bekor qilish", `cancel:${d.id}:${d.version}`]] };
  }
  async process(s, staff, m, cb) {
    let d = await this.store.get(s);
    if (d && !this.scopeMatches(d, staff))
      return reply("Xodim yoki do\u2018kon biriktirilishi o\u2018zgargan. Mas\u2019ul xodim tekshirsin.");
    if (cb) {
      const [action, id, v, shopId] = String(cb.data).split(":");
      if (!d || d.id !== id || String(d.version) !== v)
        return reply("Bu tasdiq eskirgan. /holat yuboring.");
      if (action === "shop") {
        if (!staff.owner_shop_choices?.some((s2) => s2.id === shopId))
          return reply("Do\u2018kon tanlashga ruxsat yo\u2018q.");
        return this.store.transaction(s, (tx) => {
          const c = tx.get(s);
          if (c.status !== "draft" || c.version !== d.version)
            return reply("Bu tanlov eskirgan. /holat yuboring.");
          c.shop = shopId;
          c.shop_name = staff.owner_shop_choices.find((s2) => s2.id === shopId).name;
          c.version++;
          tx.put(s, c);
          return this.summary(c);
        });
      }
      if (["inscribe", "note"].includes(action)) {
        return this.store.transaction(s, (tx) => {
          const current = tx.get(s);
          if (current.status !== "draft" || current.version !== d.version || !current.inscription_pending)
            return reply("Bu javob eskirgan. /holat yuboring.");
          current.inscription_decision = { text: current.inscription_candidate, accepted: action === "inscribe" };
          updateCustomization(current);
          current.version++;
          tx.put(s, current);
          return this.summary(current);
        });
      }
      if (action === "ok")
        return this.confirm(s, d);
      if (!["edit", "cancel"].includes(action))
        return reply("Amal noto\u2018g\u2018ri.");
      return this.store.transaction(s, (tx) => {
        const c = tx.get(s);
        if (c.status !== "draft" || c.version !== d.version)
          return reply("Buyurtma tekshirilmoqda. /holat yuboring.");
        c.version++;
        c.status = action === "cancel" ? "cancelled" : "draft";
        if (action === "edit")
          c.editing = true;
        tx.put(s, c);
        return reply(action === "cancel" ? "Buyurtma bekor qilindi." : "To\u2018liq yangi matnni yuboring. Rasm saqlanadi.");
      });
    }
    const text = String(m.text ?? m.caption ?? "");
    if (/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/.test(text))
      return reply("Maxfiy kalitni chatga yubormang. Mas\u2019ul xodimga murojaat qiling.");
    if (text === "/start") return reply([
      "Assalomu alaykum!",
      staff.is_owner === true ? "Siz boss sifatida tanildingiz." : "Siz xodim sifatida tanildingiz.",
      "Sizdan buyurtma olishga tayyormiz.",
      "",
      "Tort rasmi va buyurtma matnini yuboring.",
      "Namuna uchun /yordam tugmasini bosing."
    ].join("\n"));
    if (text === "/yordam") return reply([
      "Assalomu alaykum! Tort rasmi va buyurtma matnini yuboring.",
      "",
      "Masalan:",
      "Ism: Ali",
      "Telefon: +998901234567",
      "Sana: 2026-10-10",
      "Vaqt: 10:00",
      "Narx: 200 lik",
      "To\u2018y buyurtmasi bo\u2018lsa, matnda \xABto\u2018y uchun\xBB deb yozing.",
      "Olish: olib ketish",
      "Tortdagi yozuv: Tug\u2018ilgan kuning bilan!",
      "Izoh: oq rangda bezatilsin",
      "",
      "200 lik \u2014 200 000 so\u2018m.",
      "Avans qabul qilinmaydi.",
      "",
      "Yakuniy ma\u2019lumotlarni ko\u2018rib, Tasdiqlash tugmasini bosing.",
      "",
      "/holat \u2014 holat",
      "/tahrir \u2014 tahrirlash",
      "/bekor \u2014 bekor qilish"
    ].join("\n"));
    if (text === "/holat") {
      if (!d)
        return reply("Rasm va buyurtma matnini yuboring.");
      if (["submitting", "uncertain", "complete"].includes(d.status))
        return this.reconcile(s, d);
      if (d.status === "cancelled")
        return reply("Buyurtma bekor qilingan.");
      return this.store.transaction(s, (tx) => {
        const current = tx.get(s);
        if (!current || current.status !== "draft")
          return reply("Buyurtma holati o\u2018zgargan. /holat yuboring.");
        const contactRecovered = recoverContactDetails(current, this.now());
        const priceRecovered = recoverMissingPrice(current, this.now());
        const notesUpdated = updateCustomization(current);
        if (contactRecovered || priceRecovered || notesUpdated) {
          current.version++;
          tx.put(s, current);
        }
        return this.summary(current);
      });
    }
    return this.store.transaction(s, (tx) => {
      d = tx.get(s);
      if (d && ["submitting", "uncertain"].includes(d.status))
        return reply("Buyurtma tekshirilmoqda. /holat yuboring.");
      if (!d || ["cancelled", "complete"].includes(d.status))
        d = { id: randomUUID2().slice(0, 16), version: 0, sender: s, staff: staff.id, shop: staff.owner_shop_choices ? "" : staff.shop_id, shop_name: staff.shop_name, owner_shop_choices: staff.owner_shop_choices, status: "draft", type: "tugilgan_kun_va_boshqa", notes: "", errors: [] };
      if (text === "/bekor") {
        d.status = "cancelled";
        d.version++;
        tx.put(s, d);
        return reply("Buyurtma bekor qilindi.");
      }
      if (text === "/tahrir") {
        d.editing = true;
        d.version++;
        tx.put(s, d);
        return reply("To\u2018liq yangi matnni yuboring.");
      }
      if (text.length > 2e3 || d.notes.length + text.length > 3500)
        return reply("Matn juda uzun. /tahrir bilan qisqaroq yuboring.");
      if (d.editing && text) {
        for (const k of ["date", "time", "tier", "phone", "name", "type", "fulfilment"])
          delete d[k];
        d.notes = "";
        delete d.inscription_decision;
        d.errors = [];
        d.editing = false;
      }
      const p = parse(text, this.now(), d);
      Object.assign(d, p.patch);
      if (d.type === void 0) d.type = "tugilgan_kun_va_boshqa";
      d.errors.push(...p.errors);
      if (text)
        d.notes = (d.notes + "\n" + text).trim();
      recoverContactDetails(d, this.now());
      recoverMissingPrice(d, this.now());
      updateCustomization(d);
      const photo = m.photo?.at(-1);
      if (photo?.file_id && photo.file_size <= 10485760)
        d.photo = { file_id: photo.file_id };
      d.version++;
      tx.put(s, d);
      return this.summary(d);
    });
  }
  async confirm(s, snapshot) {
    if (!this.submissionEnabled)
      return reply("Buyurtma yuborish hozircha yoqilmagan. Mas\u2019ul xodimga murojaat qiling.");
    if (snapshot.status === "draft" && updateCustomization(snapshot)) {
      return this.store.transaction(s, (tx) => {
        const current = tx.get(s);
        if (current.status !== "draft" || current.version !== snapshot.version)
          return reply("Bu tasdiq eskirgan. /holat yuboring.");
        updateCustomization(current);
        current.version++;
        tx.put(s, current);
        return this.summary(current);
      });
    }
    if (snapshot.inscription_pending || snapshot.inscription_unclear)
      return this.summary(snapshot);
    if (!snapshot.shop)
      return this.summary(snapshot);
    if (snapshot.editing)
      return reply("Avval yangi matnni yuboring.");
    if (missing(snapshot, this.now()).length || snapshot.errors.length)
      return this.summary(snapshot);
    const d = await this.store.transaction(s, (tx) => {
      const c = tx.get(s);
      if (c.status !== "draft" || c.version !== snapshot.version)
        return null;
      if (c.type === void 0) c.type = "tugilgan_kun_va_boshqa";
      c.status = "submitting";
      c.key = c.key || `odina-order-bot:${c.id}:${c.version}`;
      tx.put(s, c);
      return c;
    });
    if (!d)
      return this.reconcile(s, await this.store.get(s));
    try {
      const image = await this.photos.rehost(d.photo);
      d.reference_image = image;
      await this.store.transaction(s, (tx) => {
        const c = tx.get(s);
        if (c.key !== d.key || !["submitting", "uncertain"].includes(c.status))
          throw Error("claim");
        c.reference_image = image;
        tx.put(s, c);
      });
      const staff = await this.auth(s);
      if (!staff || !this.scopeMatches(d, staff))
        throw Error("scope");
      await this.pos.createConfirmed({ draft: d, image, staffId: staff.id });
    } catch {
    }
    return this.reconcile(s, d);
  }
  async reconcile(s, d) {
    const staff = await this.auth(s);
    if (!staff || !this.scopeMatches(d, staff))
      return reply("Ruxsat o\u2018zgargan. Mas\u2019ul xodim tekshirsin.");
    let r;
    try {
      r = await this.pos.reconcile(d);
    } catch {
      r = null;
    }
    const valid = r?.complete === true && r.key === d.key && r.staff === d.staff && r.shop === d.shop && r.total === d.tier && r.paid_amount === 0 && r.remaining_balance === d.tier && r.payment_status === "unpaid" && /^BO-[A-Z0-9-]+$/.test(r.order_number);
    await this.store.transaction(s, (tx) => {
      const c = tx.get(s);
      if (c?.key === d.key) {
        c.status = valid ? "complete" : "uncertain";
        tx.put(s, c);
      }
    });
    return reply(valid ? `\u2705 Buyurtma saqlandi.
\u{1F9FE} Buyurtma raqami: ${Number.isSafeInteger(r.order_sequence) && r.order_sequence > 0 ? r.order_sequence : r.order_number}
\u{1F4B0} To\u2018lov: to\u2018lanmagan
\u{1F4B0} Qoldiq: ${money(r.remaining_balance)}${r.catalog_missing ? "\n\nKatalogdagi mos mahsulot topilmadi. Oddiy buyurtma sifatida saqlandi." : ""}` : "Natija tekshirilmoqda. /holat yuboring. Yangi buyurtma yaratmang.");
  }
};

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/base44-store.js
var clone = (value) => structuredClone(value);
var waiting = { text: "So\u2018rov tekshirilmoqda. /holat yuboring." };
var Base44StateStore = class {
  constructor(entity, { canonicalIds = {}, maxAttempts = 8, maxReceipts = 32 } = {}) {
    Object.assign(this, { entity, canonicalIds, maxAttempts, maxReceipts });
  }
  async row(sender) {
    const id = Object.hasOwn(this.canonicalIds, sender) ? this.canonicalIds[sender] : null;
    if (!id)
      throw Error("Xodim biriktirilmagan.");
    const rows = await this.entity.filter({ sender_id: sender }, "-created_date", 2);
    if (rows.length !== 1 || rows[0].id !== id || rows[0].enabled !== true || !Number.isSafeInteger(rows[0].version) || rows[0].version < 0)
      throw Error("Xodim biriktirilishi tekshirilsin.");
    return rows[0];
  }
  async binding(sender) {
    try {
      const r = await this.row(sender);
      return { enabled: r.enabled, staff_id: r.staff_id, scope_policy: r.scope_policy, owner_shop_ids: r.owner_shop_ids || [] };
    } catch {
      return null;
    }
  }
  state(row) {
    const s = JSON.parse(row.payload_json);
    if (!s || !Array.isArray(s.receipts) || !Number.isSafeInteger(s.floor) || s.receipts.length > this.maxReceipts || JSON.stringify(s).length > 24e4)
      throw Error("Saqlangan holat tekshirilsin.");
    return s;
  }
  async get(sender) {
    const r = await this.row(sender);
    return clone(this.state(r).draft);
  }
  async transaction(sender, reducer) {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const r = await this.row(sender), s = this.state(r);
      let dirty = false;
      const tx = {
        get: (key) => {
          if (key !== sender)
            throw Error("scope");
          return clone(s.draft);
        },
        put: (key, d) => {
          if (key !== sender)
            throw Error("scope");
          s.draft = clone(d);
          dirty = true;
        },
        delivery: (id, key) => {
          if (key !== sender || !/^\d+$/.test(id))
            throw Error("scope");
          const old = s.receipts.find((x) => x.id === id);
          if (old)
            return { duplicate: true, response: clone(old.response || waiting) };
          if (Number(id) <= s.floor)
            return { duplicate: true, response: { text: "Bu xabar eskirgan. /holat yuboring." } };
          if (s.receipts.length >= this.maxReceipts) {
            const done = s.receipts.filter((x) => x.response && (!x.outbox || ["sent", "unknown"].includes(x.outbox.status))).sort((a, b) => Number(a.id) - Number(b.id))[0];
            if (!done)
              throw Error("Javoblar navbati to\u2018lgan.");
            s.floor = Math.max(s.floor, Number(done.id));
            s.receipts = s.receipts.filter((x) => x.id !== done.id);
          }
          s.receipts.push({ id, response: null });
          dirty = true;
          return { duplicate: false };
        },
        reply: (id, response) => {
          const receipt = s.receipts.find((x) => x.id === id);
          if (!receipt)
            throw Error("receipt");
          if (!receipt.response) {
            receipt.response = clone(response);
            receipt.outbox = { status: "pending" };
            dirty = true;
          }
          return clone(receipt.response);
        },
        receipt: (id) => clone(s.receipts.find((x) => x.id === id)),
        setOutbox: (id, outbox) => {
          const receipt = s.receipts.find((x) => x.id === id);
          if (!receipt)
            throw Error("receipt");
          receipt.outbox = clone(outbox);
          dirty = true;
        }
      };
      const result = reducer(tx);
      if (result?.then)
        throw Error("Reducer must not perform asynchronous side effects");
      if (!dirty)
        return result;
      const payload = JSON.stringify(s);
      if (payload.length > 24e4)
        throw Error("Holat hajmi oshgan.");
      const query = { id: r.id, sender_id: sender, enabled: true, version: r.version, phase: r.phase, staff_id: r.staff_id, scope_policy: r.scope_policy, owner_shop_ids: { $eq: r.owner_shop_ids || [] } };
      const updated = await this.entity.updateMany(query, { $set: { payload_json: payload, phase: s.draft?.status || "idle", version: r.version + 1 } });
      if (updated?.success === true && updated.has_more !== true && updated.updated === 1)
        return result;
      if (updated?.success === true && updated.has_more !== true && updated.updated === 0)
        continue;
      throw Error("Holat yozilishi tasdiqlanmadi.");
    }
    throw Error("Holat band. /holat yuboring.");
  }
  async claimReply(sender, id) {
    return this.transaction(sender, (tx) => {
      const r = tx.receipt(id);
      if (r?.outbox?.status !== "pending")
        return null;
      tx.setOutbox(id, { status: "sending" });
      return r.response;
    });
  }
  async finishReply(sender, id, messageId) {
    return this.transaction(sender, (tx) => {
      const r = tx.receipt(id);
      if (r?.outbox?.status === "sending")
        tx.setOutbox(id, messageId ? { status: "sent", message_id: messageId } : { status: "unknown" });
    });
  }
};

// ../odina-editor-baseline-2026-10-20/base44/shared/shift-close-helpers.ts
var money2 = (value) => Math.round(Number(value) || 0);
var httpError = (message, status) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// ../odina-editor-baseline-2026-10-20/base44/shared/customer-helpers.ts
function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("998")) return digits;
  if (digits.length === 9) return "998" + digits;
  if (digits.startsWith("8") && digits.length === 10) return "998" + digits.slice(1);
  return digits;
}
function splitFullName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || "Mijoz",
    last_name: parts.slice(1).join(" ")
  };
}
async function ensureCustomer(service, input) {
  const explicitId = String(input?.customer_id || "").trim();
  if (explicitId) {
    const existing = await service.entities.Customer.get(explicitId).catch(() => null);
    if (existing) return { customer_id: existing.id, customer: existing };
  }
  const phone = String(input?.phone || "").trim();
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return { customer_id: "", customer: null };
  const matches = await service.entities.Customer.filter({ phone_normalized: phoneNormalized });
  if (matches && matches.length) {
    return { customer_id: matches[0].id, customer: matches[0] };
  }
  const { first_name, last_name } = splitFullName(String(input?.name || ""));
  try {
    const created = await service.entities.Customer.create({
      first_name,
      last_name,
      phone,
      phone_normalized: phoneNormalized,
      birth_date: "",
      label: "",
      notes: ""
    });
    return { customer_id: created.id, customer: created };
  } catch {
    return { customer_id: "", customer: null };
  }
}

// ../odina-editor-baseline-2026-10-20/base44/shared/customer-order-sequence.js
async function allocateCustomerOrderSequence(service) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const rows = await service.entities.Settings.list("-created_date", 2);
    const settings = rows?.length === 1 ? rows[0] : null;
    const last = settings?.customer_order_last_number;
    if (!settings?.id || !Number.isSafeInteger(last) || last < 0 || last >= Number.MAX_SAFE_INTEGER) {
      throw Object.assign(new Error("Buyurtma raqamlash sozlamasi tekshirilsin."), { status: 503 });
    }
    const next = last + 1;
    const result = await service.entities.Settings.updateMany(
      { id: settings.id, customer_order_last_number: last },
      { $set: { customer_order_last_number: next } }
    );
    if (result?.success === true && result.updated === 1 && !result.has_more) return next;
    if (result?.success !== true || result.updated !== 0 || result.has_more) {
      throw Object.assign(new Error("Buyurtma raqamini band qilib bo\u2018lmadi."), { status: 503 });
    }
  }
  throw Object.assign(new Error("Buyurtma raqami band. Qayta urinib ko\u2018ring."), { status: 409 });
}

// ../odina-editor-baseline-2026-10-20/base44/shared/customer-order-create.ts
var ORDER_RUNTIME_VERSION = "customer-orders-v6-2026-10-15";
var PAYMENT_METHODS = /* @__PURE__ */ new Set([
  "cash",
  "bank_card",
  "online",
  "uzcard",
  "humo",
  "click",
  "payme",
  "bank_transfer",
  "other"
]);
var ORDER_TYPES = /* @__PURE__ */ new Set(["toy_va_bazmlar", "tugilgan_kun_va_boshqa"]);
var WEDDING_PIECES_PER_SHEET = 40;
function tashkentNowParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const o = Object.fromEntries(fmt.formatToParts(/* @__PURE__ */ new Date()).map((p) => [p.type, p.value]));
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour === "24" ? "0" : o.hour),
    minute: Number(o.minute)
  };
}
function methodToShiftField(method) {
  if (method === "cash") return "cash_sales";
  if (method === "uzcard" || method === "bank_card") return "uzcard_sales";
  if (method === "humo") return "humo_sales";
  if (method === "bank_transfer") return "bank_transfer_sales";
  if (["online", "click", "payme", "other"].includes(method)) return "online_sales";
  return null;
}
async function findOpenShift(service, userId, shopId) {
  const shifts = await service.entities.Shift.filter({
    user_id: userId,
    status: "open",
    shop_id: shopId
  });
  return shifts && shifts[0] || null;
}
async function applyPaymentToShift(service, shift, method, amount, paymentKey = "") {
  const field = methodToShiftField(method);
  const inc = { total_sales: amount, order_count: 1 };
  if (field) inc[field] = amount;
  if (method === "cash") inc.expected_cash = amount;
  if (paymentKey) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await service.entities.Shift.get(shift.id);
      if (current?.order_payment_keys?.includes(paymentKey)) return;
      if (!current || current.status !== "open") throw paymentPending("To\u2018lov smenasi yopilmoqda yoki yopilgan. Egasi tekshirishi kerak.");
      const operations = orderPaymentShiftJournal(current);
      if (!operations[paymentKey] || operations[paymentKey].amount !== amount || operations[paymentKey].method !== method) throw paymentPending();
      operations[paymentKey].state = "applied";
      try {
        const result = await service.entities.Shift.updateMany(
          {
            id: current.id,
            status: "open",
            order_payment_keys: { $nin: [paymentKey] },
            order_payment_operations_json: current.order_payment_operations_json ?? { $exists: false }
          },
          { $inc: inc, $push: { order_payment_keys: paymentKey }, $set: { order_payment_operations_json: JSON.stringify(operations) } }
        );
        if (result?.success && Number(result.updated || 0) === 1) return;
      } catch {
        const saved = await service.entities.Shift.get(shift.id);
        if (saved?.order_payment_keys?.includes(paymentKey)) return;
      }
    }
    throw paymentPending("Smena bir vaqtda o\u2018zgardi. Shu to\u2018lovni qayta tekshiring.");
  }
  const update = await service.entities.Shift.updateMany(
    { id: shift.id, status: "open" },
    { $inc: inc }
  );
  if (!update?.success || Number(update.updated || 0) !== 1) {
    const current = paymentKey ? await service.entities.Shift.get(shift.id) : null;
    if (!current?.order_payment_keys?.includes(paymentKey)) throw httpError("Smena o\u2018zgardi. To\u2018lovni egasi tekshirishi kerak.", 409);
  }
}
async function orderRequestFingerprint(payload) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== void 0).map((key) => [key, canonical(value[key])])) : value;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(payload))));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function paymentPending(message = "To\u2018lov natijasi tekshirilmoqda. Shu so\u2018rovni qayta tekshiring; yangi to\u2018lov kiritmang.") {
  return Object.assign(httpError(message, 503), { operation_pending: true });
}
function orderPaymentShiftJournal(shift) {
  try {
    const value = shift?.order_payment_operations_json ? JSON.parse(shift.order_payment_operations_json) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw paymentPending("Smenadagi buyurtma to\u2018lovlari holatini egasi tekshirishi kerak.");
  }
}
async function reserveOrderPaymentShift(service, order, user, intent, key) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const shift = await service.entities.Shift.get(intent.shift_id);
    if (!shift || shift.shop_id !== order.shop_id || shift.user_id !== user.id) throw paymentPending("To\u2018lov smenasi mos emas. Egasi tekshirishi kerak.");
    if (shift.order_payment_keys?.includes(key)) return;
    const operations = orderPaymentShiftJournal(shift);
    const prior = operations[key];
    if (prior) {
      if (prior.fingerprint !== intent.fingerprint || prior.actor_id !== user.id || prior.order_id !== order.id) throw paymentPending("Smena to\u2018lov so\u2018rovi mos emas.");
      if (shift.status !== "open") throw paymentPending("To\u2018lov smenasi yopilmoqda yoki yopilgan. Egasi tekshirishi kerak.");
      return;
    }
    if (shift.status !== "open") throw paymentPending("To\u2018lov smenasi yopilmoqda yoki yopilgan. Yangi to\u2018lov yozilmadi; egasi tekshirishi kerak.");
    operations[key] = {
      fingerprint: intent.fingerprint,
      actor_id: user.id,
      order_id: order.id,
      amount: intent.amount,
      method: intent.method,
      state: "pending"
    };
    try {
      const claimed = await service.entities.Shift.updateMany(
        {
          id: shift.id,
          status: "open",
          order_payment_operations_json: shift.order_payment_operations_json ?? { $exists: false }
        },
        { $set: { order_payment_operations_json: JSON.stringify(operations) } }
      );
      if (claimed?.success && Number(claimed.updated || 0) === 1) return;
    } catch {
      const saved = await service.entities.Shift.get(shift.id);
      if (orderPaymentShiftJournal(saved)[key]?.fingerprint === intent.fingerprint) return;
    }
  }
  throw paymentPending("Smenadagi to\u2018lov boshqa oynada o\u2018zgardi. Shu so\u2018rovni qayta tekshiring.");
}
function assertPaymentRequest(payment, user, order, body, fingerprint) {
  if (payment.order_id !== order.id || payment.shop_id !== order.shop_id || payment.employee_id !== user.id || payment.payment_method !== body.method || money2(payment.amount) !== money2(body.amount) || payment.payment_kind !== String(body.payment_kind || "balance") || payment.request_fingerprint && payment.request_fingerprint !== fingerprint) {
    throw httpError("Bu so\u2018rov kaliti boshqa to\u2018lovga tegishli.", 409);
  }
}
async function recordCustomerOrderPayment(service, user, body, allowPendingCreation = false) {
  let requestStarted = false;
  try {
    const orderId = String(body.order_id || "");
    const key = String(body.idempotency_key || "");
    const amount = money2(body.amount);
    const method = String(body.method || "");
    const kind = String(body.payment_kind || "balance");
    if (!orderId || !key || key.length > 200 || amount <= 0 || !PAYMENT_METHODS.has(method) || !["advance", "balance", "additional"].includes(kind)) throw httpError("To\u2018lov ma\u2019lumotlari noto\u2018g\u2018ri.", 400);
    let order = await service.entities.CustomerOrder.get(orderId);
    if (!order) throw httpError("Buyurtma topilmadi.", 404);
    if (["cashier", "manager"].includes(user.role) && order.shop_id !== user.shop_id) throw httpError("Bu buyurtma boshqa do\u2018konga tegishli.", 403);
    if (order.creation_state === "pending" && !allowPendingCreation) throw paymentPending("Buyurtma yaratish hali tasdiqlanmadi. Avval shu so\u2018rovni tekshiring.");
    if (order.completion_key && order.order_status !== "yakunlandi" && order.completion_key !== key && order.payment_operation_key !== key) throw paymentPending("Buyurtmani yakunlash boshlangan. Avval shu amalni tekshiring.");
    const fingerprint = await orderRequestFingerprint({ order_id: order.id, shop_id: order.shop_id, actor_id: user.id, method, amount, payment_kind: kind });
    let rows = await service.entities.OrderPayment.filter({ idempotency_key: key });
    if (rows.length > 1) throw paymentPending("Takroriy to\u2018lov yozuvlari bor. Egasi tekshirishi kerak.");
    let payment = rows[0] || null;
    requestStarted = Boolean(payment);
    if (payment) {
      assertPaymentRequest(payment, user, order, body, fingerprint);
      if (!payment.request_fingerprint) {
        const ledger = await service.entities.OrderPayment.filter({ order_id: order.id }, "paid_at", 1e4);
        const ledgerPaid = ledger.filter((row) => row.status === "completed").reduce((sum, row) => sum + money2(row.amount), 0);
        if (money2(order.paid_amount) < ledgerPaid) throw paymentPending("Oldingi to\u2018lov va buyurtma summalari mos emas. Egasi tekshirishi kerak.");
        return { payment, order, already_exists: true };
      }
      if (payment.reconciliation_state === "completed") {
        if (order.payment_operation_key === key) await service.entities.CustomerOrder.updateMany({ id: order.id, payment_operation_key: key }, { $set: { payment_operation_key: "", payment_operation_phase: "completed" } });
        const savedOrder = await service.entities.CustomerOrder.get(order.id);
        if (savedOrder?.payment_operation_key === key) throw paymentPending();
        return { payment, order: savedOrder, already_exists: true };
      }
    }
    if (order.payment_operation_key && order.payment_operation_key !== key) throw paymentPending("Bu buyurtmaning oldingi to\u2018lovi yakunlanmagan. Avval uni tekshiring.");
    let intent = order.payment_operation_key === key ? order.payment_operation_payload : null;
    if (intent) requestStarted = true;
    if (intent && intent.fingerprint !== fingerprint) throw httpError("Bu so\u2018rov kaliti boshqa to\u2018lov uchun ishlatilgan.", 409);
    if (!intent) {
      if (payment) throw paymentPending("To\u2018lov amali yozuvi to\u2018liq emas. Egasi tekshirishi kerak.");
      if (order.order_status === "bekor_qilindi" || order.order_status === "yakunlandi") throw httpError("Ushbu buyurtmaga yangi to\u2018lov qabul qilinmaydi.", 409);
      const before = money2(order.paid_amount);
      if (amount > money2(order.total) - before) throw httpError(`To\u2018lov qolgan qarzdan oshmasligi kerak: ${money2(order.total) - before} UZS.`, 400);
      const pinnedCreationShift = allowPendingCreation && kind === "advance" && Object.prototype.hasOwnProperty.call(order, "creation_advance_shift_id");
      const shift = pinnedCreationShift ? order.creation_advance_shift_id ? await service.entities.Shift.get(order.creation_advance_shift_id) : null : await findOpenShift(service, user.id, order.shop_id);
      if (pinnedCreationShift && order.creation_advance_shift_id && (!shift || shift.user_id !== user.id || shift.shop_id !== order.shop_id || shift.status !== "open")) {
        throw paymentPending("Avansning dastlabki smenasi yopilmoqda yoki yopilgan. Egasi tekshirishi kerak.");
      }
      if (!shift && method === "cash") throw httpError("Naqd to\u2018lov uchun ushbu do\u2018konda smenani oching.", 409);
      intent = {
        fingerprint,
        actor_id: user.id,
        before,
        after: before + amount,
        remaining: money2(order.total) - before - amount,
        shift_id: shift?.id || "",
        method,
        amount,
        kind,
        paid_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      const settingsRows = await service.entities.Settings.list("-created_date", 2);
      if (settingsRows.length !== 1) throw paymentPending("To\u2018lov sozlamasi tekshirilsin.");
      const requestKey = await orderRequestFingerprint({ payment_key: key });
      requestStarted = true;
      const requestBinding = `${requestKey}:${fingerprint}`;
      try {
        await service.entities.Settings.updateMany(
          { id: settingsRows[0].id, customer_order_payment_request_keys: { $nin: [requestKey] } },
          { $push: { customer_order_payment_request_keys: requestKey, customer_order_payment_request_fingerprints: requestBinding } }
        );
      } catch {
      }
      const claimedSettings = await service.entities.Settings.get(settingsRows[0].id);
      if (!claimedSettings?.customer_order_payment_request_fingerprints?.includes(requestBinding)) {
        if (claimedSettings?.customer_order_payment_request_keys?.includes(requestKey)) throw httpError("Bu so\u2018rov kaliti boshqa to\u2018lov uchun ishlatilgan.", 409);
        throw paymentPending();
      }
      const claim = await service.entities.CustomerOrder.updateMany(
        {
          id: order.id,
          paid_amount: before,
          $or: [{ payment_operation_key: { $exists: false } }, { payment_operation_key: "" }]
        },
        { $set: { payment_operation_key: key, payment_operation_payload: intent, payment_operation_phase: "claimed" } }
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) throw paymentPending();
      order = await service.entities.CustomerOrder.get(order.id);
    }
    const appliedKey = `payment:${fingerprint}:${key}`;
    if (intent.shift_id) await reserveOrderPaymentShift(service, order, user, intent, appliedKey);
    if (!payment) {
      const writeClaim = await service.entities.CustomerOrder.updateMany(
        { id: order.id, payment_operation_key: key, payment_operation_phase: "claimed" },
        { $set: { payment_operation_phase: "ledger_writing" } }
      );
      if (writeClaim?.success && Number(writeClaim.updated || 0) === 1) {
        try {
          payment = await service.entities.OrderPayment.create({
            order_id: order.id,
            order_number_snapshot: order.order_number,
            payment_kind: kind,
            payment_method: method,
            amount,
            paid_at: intent.paid_at,
            shop_id: order.shop_id,
            shop_name_snapshot: order.shop_name_snapshot,
            employee_id: user.id,
            employee_name: user.full_name || user.email || "Noma\u2019lum xodim",
            employee_role: user.role,
            shift_id: intent.shift_id,
            idempotency_key: key,
            status: "completed",
            request_fingerprint: fingerprint,
            reconciliation_state: "pending"
          });
        } catch {
          rows = await service.entities.OrderPayment.filter({ idempotency_key: key });
          if (rows.length !== 1) throw paymentPending();
          payment = rows[0];
        }
      } else {
        rows = await service.entities.OrderPayment.filter({ idempotency_key: key });
        if (rows.length !== 1) throw paymentPending();
        payment = rows[0];
      }
      assertPaymentRequest(payment, user, order, body, fingerprint);
    }
    try {
      await service.entities.CustomerOrder.updateMany(
        { id: order.id, payment_operation_key: key, paid_amount: intent.before, payment_applied_keys: { $nin: [appliedKey] } },
        {
          $set: { paid_amount: intent.after, remaining_balance: intent.remaining, payment_status: intent.remaining <= 0 ? "paid" : "partial", updated_at: (/* @__PURE__ */ new Date()).toISOString() },
          $push: { payment_applied_keys: appliedKey }
        }
      );
    } catch {
    }
    order = await service.entities.CustomerOrder.get(order.id);
    if (!order?.payment_applied_keys?.includes(appliedKey)) throw paymentPending();
    if (intent.shift_id) {
      const shift = await service.entities.Shift.get(intent.shift_id);
      if (!shift || shift.shop_id !== order.shop_id || shift.user_id !== user.id) throw paymentPending("To\u2018lov smenasi mos emas. Egasi tekshirishi kerak.");
      try {
        await applyPaymentToShift(service, shift, method, amount, appliedKey);
      } catch {
        const saved = await service.entities.Shift.get(intent.shift_id);
        if (!saved?.order_payment_keys?.includes(appliedKey)) throw paymentPending("To\u2018lov saqlandi, smena hali tasdiqlanmadi. Shu so\u2018rovni qayta tekshiring.");
      }
    }
    await service.entities.OrderPayment.updateMany({ id: payment.id, request_fingerprint: fingerprint }, { $set: { reconciliation_state: "completed" } });
    const confirmedPayment = await service.entities.OrderPayment.get(payment.id);
    if (confirmedPayment?.reconciliation_state !== "completed") throw paymentPending();
    await service.entities.CustomerOrder.updateMany(
      { id: order.id, payment_operation_key: key },
      { $set: { payment_operation_key: "", payment_operation_phase: "completed" } }
    );
    const confirmedOrder = await service.entities.CustomerOrder.get(order.id);
    if (!confirmedOrder || confirmedOrder.payment_operation_key === key) throw paymentPending();
    await service.entities.ActionHistory.create({
      user_id: user.id,
      user_name: user.full_name || user.email,
      action: "order_payment",
      details: `${order.order_number} \xB7 ${kind} \xB7 ${method} \xB7 ${amount} UZS`
    }).catch(() => {
    });
    return { payment: confirmedPayment, order: confirmedOrder, already_exists: Boolean(rows[0]) };
  } catch (error) {
    if (!requestStarted && !error?.operation_pending) error.request_not_started = true;
    if (requestStarted) error.operation_pending = true;
    throw error;
  }
}
async function normalizeOrderItems(service, requestedItems, orderType, shopId, botGuard = null) {
  const normalized = [];
  for (const requested of requestedItems) {
    const productId = String(requested?.product_id || "");
    const quantity = Number(requested?.quantity);
    if (!productId && botGuard?.allowUnlistedCake === true) {
      const price = botGuard.expectedTotal;
      if (requestedItems.length !== 1 || quantity !== 1 || !Number.isSafeInteger(price) || price <= 0 || price > 1e9) {
        throw httpError("Oddiy buyurtma narxi yoki miqdori noto\u2018g\u2018ri.", 400);
      }
      const products = await service.entities.Product.filter({ active: true, name: `TORT ${price}` });
      const matching = products.filter((p) => p.archived !== true && p.production_unit !== "sheet" && String(p.name).trim().toUpperCase() === `TORT ${price}` && Number(p.shop_prices?.[shopId] ?? p.price) === price);
      if (matching.length) throw httpError("Katalog o\u2018zgardi. Buyurtmani qayta tekshirish kerak.", 409);
      normalized.push({
        product_id: "",
        item_type: "custom",
        product_name_snapshot: "Oddiy buyurtma (tort)",
        product_image_snapshot: "",
        category_name_snapshot: "Buyurtmalar",
        unit_snapshot: "piece",
        quantity: 1,
        event_pieces_per_sheet_snapshot: 0,
        unit_price_snapshot: price,
        line_total: price,
        customization_note: String(requested?.customization_note || "")
      });
      continue;
    }
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
      throw httpError("Har bir mahsulotda to\u2018g\u2018ri miqdor bo\u2018lishi kerak.", 400);
    }
    const product = await service.entities.Product.get(productId);
    if (!product || product.active === false || product.archived === true) {
      throw httpError("Tanlangan mahsulot hozir sotuvda mavjud emas.", 409);
    }
    const isSheet = product.production_unit === "sheet";
    const unit = isSheet ? "sheet" : "piece";
    const unitPrice = isSheet ? money2(product.sheet_price) : money2(product?.shop_prices?.[shopId] ?? product.price);
    if (!unitPrice || unitPrice <= 0) {
      throw httpError(`${product.name || "Mahsulot"} narxi sozlanmagan.`, 409);
    }
    const qty = Math.floor(quantity);
    const piecesPerSheet = isSheet ? orderType === "toy_va_bazmlar" ? WEDDING_PIECES_PER_SHEET : Math.max(1, Number(product.pieces_per_sheet) || 20) : 0;
    normalized.push({
      product_id: product.id,
      product_name_snapshot: String(product.name || ""),
      product_image_snapshot: String(product.image_url || ""),
      category_name_snapshot: String(product.category_name || ""),
      unit_snapshot: unit,
      quantity: qty,
      event_pieces_per_sheet_snapshot: piecesPerSheet,
      unit_price_snapshot: unitPrice,
      line_total: unitPrice * qty,
      customization_note: String(requested?.customization_note || "")
    });
  }
  return normalized;
}
async function createCustomerOrder(service, user, body, botGuard = null) {
  let createdOrder = null;
  let createdItems = [];
  let createdPayment = null;
  let requestStarted = false;
  try {
    const idempotencyKey = String(body?.idempotency_key || "");
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return Response.json({ request_not_started: !requestStarted, error: "Idempotency kaliti kerak." }, { status: 400 });
    }
    const requestFingerprint = await orderRequestFingerprint({
      ...body,
      action: "create_order",
      actor_id: user.id,
      shop_id: ["cashier", "manager"].includes(user.role) ? user.shop_id : body.shop_id
    });
    const existingOrders = await service.entities.CustomerOrder.filter({ idempotency_key: idempotencyKey });
    if (existingOrders && existingOrders.length) {
      requestStarted = true;
      if (existingOrders.length !== 1) throw paymentPending("Takroriy buyurtma yozuvlari bor. Egasi tekshirishi kerak.");
      const existing = existingOrders[0];
      if (botGuard) {
        const current = await botGuard.authorize();
        if (!current || current.active !== true || current.data?.active === false || current.id !== user.id || current.shop_id !== botGuard.shopId || !["admin", "manager", "cashier"].includes(current.role)) {
          throw httpError("Xodim ruxsati o\u2018zgargan.", 403);
        }
      }
      if (["cashier", "manager"].includes(user.role) && existing.shop_id !== user.shop_id || existing.creator_id !== user.id) return Response.json({ request_not_started: !requestStarted, error: "Bu so\u2018rov boshqa xodim yoki do\u2018konga tegishli." }, { status: 403 });
      if (existing.request_fingerprint && existing.request_fingerprint !== requestFingerprint) throw httpError("Bu so\u2018rov kaliti boshqa buyurtma uchun ishlatilgan.", 409);
      const items = await service.entities.CustomerOrderItem.filter({ order_id: existing.id }, "id", 1e4);
      if (!existing.request_fingerprint) return Response.json({ order: existing, items, already_exists: true });
      if (items.length !== existing.creation_item_count) throw paymentPending("Buyurtma mahsulotlari to\u2018liq tasdiqlanmadi. Egasi tekshirishi kerak.");
      if (body.advance_payment) {
        const result = await recordCustomerOrderPayment(service, user, {
          order_id: existing.id,
          payment_kind: "advance",
          method: body.advance_payment.method,
          amount: body.advance_payment.amount,
          idempotency_key: String(body.advance_payment.idempotency_key || `${idempotencyKey}-adv`)
        }, true);
        createdPayment = result.payment;
      }
      await service.entities.CustomerOrder.updateMany({ id: existing.id, request_fingerprint: requestFingerprint }, { $set: { creation_state: "completed" } });
      return Response.json({ order: await service.entities.CustomerOrder.get(existing.id), items, payment: createdPayment, already_exists: true });
    }
    const orderType = String(body?.order_type || "");
    if (!ORDER_TYPES.has(orderType)) {
      return Response.json({ request_not_started: !requestStarted, error: "Buyurtma turi noto\u2018g\u2018ri." }, { status: 400 });
    }
    const customerName = String(body?.customer_name || "").trim();
    const customerPhone = String(body?.customer_phone || "").trim();
    const requiredDate = String(body?.required_date || "");
    const requiredTime = String(body?.required_time || "");
    const fulfilmentType = String(body?.fulfilment_type || "");
    if (!customerName || !customerPhone || !requiredDate || !requiredTime) {
      return Response.json({ request_not_started: !requestStarted, error: "Mijoz ismi, telefoni, sana va vaqt majburiy." }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredDate) || !/^\d{2}:\d{2}$/.test(requiredTime)) {
      return Response.json({ request_not_started: !requestStarted, error: "Sana yoki vaqt formati noto\u2018g\u2018ri." }, { status: 400 });
    }
    {
      const [yy, mm, dd] = requiredDate.split("-").map(Number);
      const probe = new Date(Date.UTC(yy, mm - 1, dd));
      if (probe.getUTCFullYear() !== yy || probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) {
        return Response.json({ request_not_started: !requestStarted, error: "Noto\u2018g\u2018ri sana." }, { status: 400 });
      }
      const [hh, mi] = requiredTime.split(":").map(Number);
      if (hh > 23 || mi > 59) {
        return Response.json({ request_not_started: !requestStarted, error: "Noto\u2018g\u2018ri vaqt." }, { status: 400 });
      }
      const np = tashkentNowParts();
      const reqStamp = `${yy}${String(mm).padStart(2, "0")}${String(dd).padStart(2, "0")}${requiredTime.replace(":", "")}`;
      const nowStamp = `${np.year}${String(np.month).padStart(2, "0")}${String(np.day).padStart(2, "0")}${String(np.hour).padStart(2, "0")}${String(np.minute).padStart(2, "0")}`;
      if (reqStamp < nowStamp) {
        return Response.json({ request_not_started: !requestStarted, error: "Topshirish sanasi yoki vaqti o\u2018tib ketgan." }, { status: 400 });
      }
    }
    if (!["pickup", "delivery"].includes(fulfilmentType)) {
      return Response.json({ request_not_started: !requestStarted, error: "Yetkazib berish turi noto\u2018g\u2018ri." }, { status: 400 });
    }
    if (botGuard) {
      const current = await botGuard.authorize();
      if (!current || current.active !== true || current.data?.active === false || current.id !== user.id || current.shop_id !== botGuard.shopId || !["admin", "manager", "cashier"].includes(current.role)) {
        throw httpError("Xodim ruxsati o\u2018zgargan.", 403);
      }
    }
    let shopId = String(body?.shop_id || "");
    if (["cashier", "manager"].includes(user.role)) {
      if (!user.shop_id) {
        return Response.json({ request_not_started: !requestStarted, error: "Sizga do\u2018kon biriktirilmagan." }, { status: 403 });
      }
      shopId = user.shop_id;
    }
    if (!shopId) {
      return Response.json({ request_not_started: !requestStarted, error: "Do\u2018kon tanlanishi kerak." }, { status: 400 });
    }
    const shop = await service.entities.Shop.get(shopId);
    if (!shop || shop.active === false) {
      return Response.json({ request_not_started: !requestStarted, error: "Do\u2018kon topilmadi yoki faol emas." }, { status: 404 });
    }
    const { customer_id: resolvedCustomerId } = await ensureCustomer(service, {
      customer_id: String(body?.customer_id || ""),
      name: customerName,
      phone: customerPhone
    });
    const requestedItems = Array.isArray(body?.items) ? body.items : [];
    if (!requestedItems.length) {
      return Response.json({ request_not_started: !requestStarted, error: "Kamida bitta mahsulot qo\u2018shing." }, { status: 400 });
    }
    const normalizedItems = await normalizeOrderItems(service, requestedItems, orderType, shop.id, botGuard);
    const subtotal = normalizedItems.reduce((sum, item) => sum + item.line_total, 0);
    let deliveryFee = 0;
    if (fulfilmentType === "delivery") {
      if (orderType === "toy_va_bazmlar") {
        deliveryFee = 0;
      } else {
        deliveryFee = money2(body?.delivery_fee || 0);
        if (deliveryFee < 0) {
          return Response.json({ request_not_started: !requestStarted, error: "Yetkazib berish narxi manfiy bo\u2018lishi mumkin emas." }, { status: 400 });
        }
      }
    }
    const adjustmentAmount = money2(body?.adjustment_amount || 0);
    const adjustmentReason = String(body?.adjustment_reason || "").trim();
    if (adjustmentAmount !== 0) {
      if (user.role !== "admin") {
        return Response.json({ request_not_started: !requestStarted, error: "Chegirma yoki qo\u2018shimcha faqat egasi tomonidan kiritiladi." }, { status: 403 });
      }
      if (adjustmentReason.length < 3) {
        return Response.json({ request_not_started: !requestStarted, error: "Chegirma/qo\u2018shimcha uchun izoh majburiy." }, { status: 400 });
      }
    }
    const originalCalculatedTotal = subtotal + deliveryFee;
    const total = Math.max(0, originalCalculatedTotal + adjustmentAmount);
    if (botGuard && (total !== botGuard.expectedTotal || body?.advance_payment || fulfilmentType !== "pickup" || adjustmentAmount !== 0 || normalizedItems.length !== 1 || normalizedItems[0].quantity !== 1)) {
      throw httpError("Buyurtma shartlari o\u2018zgardi. Qayta tekshirish kerak.", 409);
    }
    const advance = body?.advance_payment || null;
    let paidAmount = 0;
    let shiftForPayment = null;
    let advanceMethod = "";
    if (advance) {
      advanceMethod = String(advance?.method || "");
      const advanceAmount = money2(advance?.amount || 0);
      if (!PAYMENT_METHODS.has(advanceMethod) || advanceAmount <= 0) {
        return Response.json({ request_not_started: !requestStarted, error: "Avans to\u2018lov usuli yoki summasi noto\u2018g\u2018ri." }, { status: 400 });
      }
      if (advanceAmount > total) {
        return Response.json({ request_not_started: !requestStarted, error: "Avans summasi buyurtma summasidan oshmasligi kerak." }, { status: 400 });
      }
      paidAmount = advanceAmount;
      shiftForPayment = await findOpenShift(service, user.id, shop.id);
      if (!shiftForPayment && advanceMethod === "cash") {
        return Response.json({ request_not_started: !requestStarted, error: "Naqd avans uchun ushbu do\u2018konda smenani oching." }, { status: 409 });
      }
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const day = now.slice(0, 10).replaceAll("-", "");
    const orderNumber = `BO-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const userName = user.full_name || user.email || "Noma\u2019lum xodim";
    if (botGuard) {
      const current = await botGuard.authorize();
      const currentShop = await service.entities.Shop.get(botGuard.shopId);
      if (!current || current.active !== true || current.data?.active === false || current.id !== user.id || current.shop_id !== shop.id || current.shop_id !== botGuard.shopId || !["admin", "manager", "cashier"].includes(current.role) || !currentShop || currentShop.active === false) {
        throw httpError("Xodim ruxsati yoki do\u2018koni o\u2018zgargan.", 403);
      }
    }
    const settingsRows = await service.entities.Settings.list("-created_date", 2);
    if (settingsRows.length !== 1) throw paymentPending("Buyurtma sozlamasi tekshirilsin.");
    const claimKey = await orderRequestFingerprint({ key: idempotencyKey });
    requestStarted = true;
    const creationClaim = await service.entities.Settings.updateMany(
      { id: settingsRows[0].id, customer_order_request_keys: { $nin: [claimKey] } },
      { $push: { customer_order_request_keys: claimKey } }
    );
    if (!creationClaim?.success || Number(creationClaim.updated || 0) !== 1) throw paymentPending("Buyurtma oldin boshlangan. Natijani qayta tekshiring; yangi buyurtma yaratmang.");
    const orderSequence = await allocateCustomerOrderSequence(service);
    try {
      const orderPayload = {
        order_sequence: orderSequence,
        order_number: orderNumber,
        order_type: orderType,
        shop_id: shop.id,
        shop_name_snapshot: shop.name,
        customer_id: resolvedCustomerId || void 0,
        customer_name: customerName,
        customer_phone: customerPhone,
        required_date: requiredDate,
        required_time: requiredTime,
        fulfilment_type: fulfilmentType,
        delivery_address: fulfilmentType === "delivery" ? String(body?.delivery_address || "") : "",
        reference_image: String(body?.reference_image || ""),
        notes: String(body?.notes || ""),
        cake_shape: String(body?.cake_shape || ""),
        subtotal,
        delivery_fee: deliveryFee,
        adjustment_amount: adjustmentAmount,
        adjustment_reason: adjustmentReason || void 0,
        original_calculated_total: originalCalculatedTotal,
        total,
        paid_amount: 0,
        remaining_balance: total,
        payment_status: total <= 0 ? "paid" : "unpaid",
        order_status: "qabul_qilindi",
        ready_inventory_state: "pending",
        creator_id: user.id,
        creator_name: userName,
        creator_role: user.role,
        idempotency_key: idempotencyKey,
        request_fingerprint: requestFingerprint,
        creation_state: "pending",
        creation_item_count: normalizedItems.length,
        ...advance ? { creation_advance_shift_id: shiftForPayment?.id || "" } : {},
        created_at: now
      };
      try {
        createdOrder = await service.entities.CustomerOrder.create(orderPayload);
      } catch {
        const saved = await service.entities.CustomerOrder.filter({ idempotency_key: idempotencyKey });
        if (saved.length !== 1 || saved[0].request_fingerprint !== requestFingerprint) throw paymentPending();
        createdOrder = saved[0];
      }
      const itemPayloads = normalizedItems.map((item) => ({
        order_id: createdOrder.id,
        order_number_snapshot: orderNumber,
        shop_id: shop.id,
        ...item
      }));
      try {
        createdItems = await service.entities.CustomerOrderItem.bulkCreate(itemPayloads);
      } catch {
        createdItems = await service.entities.CustomerOrderItem.filter({ order_id: createdOrder.id }, "id", 1e4);
        if (createdItems.length !== itemPayloads.length) throw paymentPending("Buyurtma mahsulotlari to\u2018liq tasdiqlanmadi. Egasi tekshirishi kerak.");
      }
      if (advance) {
        const paymentIdempotency = String(advance?.idempotency_key || `${idempotencyKey}-adv`);
        const result = await recordCustomerOrderPayment(service, user, {
          order_id: createdOrder.id,
          payment_kind: "advance",
          method: advanceMethod,
          amount: paidAmount,
          idempotency_key: paymentIdempotency
        }, true);
        createdPayment = result.payment;
        createdOrder = result.order;
      }
      await service.entities.CustomerOrder.updateMany({ id: createdOrder.id, request_fingerprint: requestFingerprint }, { $set: { creation_state: "completed" } });
      createdOrder = await service.entities.CustomerOrder.get(createdOrder.id);
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: userName,
        action: "order_created",
        details: `${orderNumber} \xB7 ${shop.name} \xB7 ${total} UZS${paidAmount ? ` \xB7 avans ${paidAmount}` : ""}`
      }).catch(() => {
      });
      return Response.json({
        order: createdOrder,
        items: createdItems,
        payment: createdPayment,
        runtime_version: ORDER_RUNTIME_VERSION
      });
    } catch (error) {
      throw error;
    }
  } catch (error) {
    if (!requestStarted && !error?.operation_pending) error.request_not_started = true;
    if (requestStarted) error.operation_pending = true;
    throw error;
  }
}

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/bridge.js
var InternalOrderBridge = class {
  constructor(service, { bindingForSender = async () => null } = {}) {
    this.service = service;
    this.bindingForSender = bindingForSender;
  }
  async staff(id, binding = null, selectedShop = "") {
    try {
      return await resolveOrderBotStaff(this.service, id, binding, selectedShop);
    } catch {
      return null;
    }
  }
  async shopActive(id) {
    return Boolean(await this.service.entities.Shop.get(id).then((s) => s && s.active !== false && s.allows_pos !== false && s.location_type !== "production"));
  }
  async createConfirmed({ draft: d, image, staffId }) {
    const u = await this.staff(staffId, await this.bindingForSender(d.sender), d.shop);
    if (!u || u.active !== true || u.data?.active === false || u.id !== d.staff || u.shop_id !== d.shop || !["admin", "manager", "cashier"].includes(u.role) || !await this.shopActive(d.shop))
      throw Error("scope");
    const products = await this.service.entities.Product.filter({ active: true, name: `TORT ${d.tier}` });
    const candidates = products.filter((p) => p.archived !== true && p.production_unit !== "sheet" && p.name.trim().toUpperCase() === `TORT ${d.tier}` && Number(p.shop_prices?.[d.shop] ?? p.price) === d.tier);
    if (candidates.length > 1)
      throw Error("catalog ambiguity");
    const unlisted = candidates.length === 0;
    if (d.reference_image !== image)
      throw Error("photo binding");
    const url = new URL(image);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.hostname === "api.telegram.org" || !this.service.approvedPhotoHosts?.includes(url.hostname))
      throw Error("photo");
    const body = { action: "create_order", idempotency_key: d.key, shop_id: u.shop_id, order_type: d.type, customer_name: d.name, customer_phone: d.phone, required_date: d.date, required_time: d.time, fulfilment_type: "pickup", reference_image: image, notes: orderNotes(d), items: [{ product_id: unlisted ? "" : candidates[0].id, quantity: 1, customization_note: orderNotes(d) }], advance_payment: null, delivery_fee: 0, adjustment_amount: 0 };
    if ((await this.service.entities.CustomerOrder.filter({ idempotency_key: d.key })).length)
      throw Error("reconcile");
    const response = await createCustomerOrder(this.service, u, body, { staffId: d.staff, shopId: d.shop, expectedTotal: d.tier, allowUnlistedCake: unlisted, authorize: async () => this.staff(d.staff, await this.bindingForSender(d.sender), d.shop) });
    if (!response.ok)
      throw Error("create");
    return this.reconcile(d);
  }
  async reconcile(d) {
    const u = await this.staff(d.staff, await this.bindingForSender(d.sender), d.shop);
    if (!u || u.active !== true || u.data?.active === false || u.shop_id !== d.shop || !["admin", "manager", "cashier"].includes(u.role) || !await this.shopActive(d.shop))
      return null;
    const rows = await this.service.entities.CustomerOrder.filter({ idempotency_key: d.key });
    if (rows.length !== 1)
      return null;
    const o = rows[0];
    if (o.creator_id !== d.staff || o.shop_id !== d.shop || o.customer_name !== d.name || o.customer_phone !== d.phone || o.required_date !== d.date || o.required_time !== d.time || o.order_type !== d.type || o.fulfilment_type !== "pickup" || o.notes !== orderNotes(d) || o.reference_image !== d.reference_image || o.total !== d.tier || o.paid_amount !== 0 || o.remaining_balance !== d.tier || o.payment_status !== "unpaid")
      return null;
    if (!o.customer_id || !await this.service.entities.Customer.get(o.customer_id))
      return null;
    const items = await this.service.entities.CustomerOrderItem.filter({ order_id: o.id });
    const payments = await this.service.entities.OrderPayment.filter({ order_id: o.id });
    const audit = await this.service.entities.ActionHistory.filter({ user_id: d.staff, action: "order_created" });
    const unlisted = items.length === 1 && items[0].item_type === "custom" && !items[0].product_id && items[0].product_name_snapshot === "Oddiy buyurtma (tort)";
    const catalogued = items.length === 1 && items[0].item_type !== "custom" && Boolean(items[0].product_id) && items[0].product_name_snapshot === `TORT ${d.tier}`;
    if (!unlisted && !catalogued || items[0].shop_id !== d.shop || items[0].quantity !== 1 || items[0].unit_price_snapshot !== d.tier || items[0].line_total !== d.tier || items[0].unit_snapshot !== "piece" || items[0].customization_note !== orderNotes(d) || payments.length || !audit.some((a) => a.details.startsWith(o.order_number + " \xB7 ")))
      return null;
    return { complete: true, key: d.key, staff: d.staff, shop: d.shop, total: o.total, paid_amount: o.paid_amount, remaining_balance: o.remaining_balance, payment_status: o.payment_status, order_number: o.order_number, order_sequence: o.order_sequence, catalog_missing: unlisted };
  }
};

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/photos.js
var ReferencePhotos = class {
  constructor({ downloadBytes, uploadBytes, approvedHosts = [] }) {
    Object.assign(this, { downloadBytes, uploadBytes, approvedHosts });
  }
  async rehost({ file_id }) {
    try {
      if (typeof file_id !== "string" || file_id.length > 512 || /[/:?]/.test(file_id))
        throw Error();
      const bytes = await this.downloadBytes(file_id);
      if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 10485760)
        throw Error();
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
      if (!jpeg && !png)
        throw Error();
      const url = new URL(await this.uploadBytes(bytes, jpeg ? "image/jpeg" : "image/png"));
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !this.approvedHosts.includes(url.hostname))
        throw Error();
      return url.href;
    } catch {
      throw Error("Rasmni saqlab bo\u2018lmadi.");
    }
  }
};

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/transport.js
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";
function localWebhook(bot, { secret = "" } = {}) {
  return async (req) => {
    const supplied = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    const a = Buffer.from(secret), b = Buffer.from(supplied);
    if (!a.length || a.length !== b.length || !timingSafeEqual2(a, b))
      return new Response("Ruxsat yo\u2018q.", { status: 403 });
    if (req.method !== "POST")
      return new Response("Amal noto\u2018g\u2018ri.", { status: 405 });
    const reader = req.body?.getReader();
    let length = 0;
    const chunks = [];
    if (!reader)
      return new Response("Ma\u2019lumot yo\u2018q.", { status: 400 });
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      length += value.length;
      if (length > 32768) {
        await reader.cancel();
        return new Response("Ma\u2019lumot juda katta.", { status: 413 });
      }
      chunks.push(value);
    }
    try {
      return Response.json(await bot.handle(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    } catch {
      return new Response("So\u2018rov yakunlanmadi.", { status: 503 });
    }
  };
}

// ../odina-editor-baseline-2026-10-20/base44/shared/order-bot/hosted.js
function prepareHostedOrderBot({ service, canonicalIds = {}, approvedPhotoHosts = [], token = "", webhookSecret = "", fetchImpl, acceptUpdates = false, deliveryEnabled = false, submissionEnabled = false, atomicVerified = false }) {
  const store = new Base44StateStore(service.entities.TelegramOrderBotState, { canonicalIds });
  const bindingProvider = (s) => store.binding(s);
  const pos = new InternalOrderBridge({ ...service, approvedPhotoHosts }, { bindingForSender: bindingProvider });
  const telegram = new TelegramAdapter({ token, fetchImpl, enabled: deliveryEnabled });
  const photos = new ReferencePhotos({ downloadBytes: (id) => telegram.downloadBytes(id), uploadBytes: base44PhotoUpload(service), approvedHosts: approvedPhotoHosts });
  const bot = new OrderBot({ store, pos, photos, bindingProvider, submissionEnabled: submissionEnabled && atomicVerified });
  const boundary = localWebhook({ handle: async (update) => {
    const message = update?.callback_query?.message ?? update?.message;
    const from = update?.callback_query?.from ?? update?.message?.from;
    if (!Number.isSafeInteger(update?.update_id) || !Number.isSafeInteger(from?.id) || from.id <= 0 || from?.is_bot || message?.chat?.type !== "private" || String(message.chat.id) !== String(from.id)) return { ok: true };
    const sender = String(from.id);
    if (!await bot.auth(sender)) {
      if (deliveryEnabled && !update.callback_query && message.text === "/start" && !message.forward_origin && !message.forward_from && !message.forward_date) {
        try {
          await telegram.sendReply(sender, { text: "Siz ro\u2018yxatda yo\u2018qsiz. Mas\u2019ul xodimga murojaat qiling." });
        } catch {
        }
      }
      return { ok: true };
    }
    const response = await bot.handle(update);
    if (deliveryEnabled && await bot.auth(sender)) {
      const pending = await store.claimReply(sender, String(update.update_id));
      if (pending) {
        const current = await store.get(sender), staff = await bot.auth(sender);
        if (!staff || current && !bot.scopeMatches(current, staff))
          throw Error("scope");
        let id;
        try {
          id = await telegram.sendReply(sender, pending);
        } catch {
        }
        await store.finishReply(sender, String(update.update_id), id);
      }
      if (update.callback_query?.id)
        try {
          await telegram.acknowledge(update.callback_query.id);
        } catch {
        }
    }
    return { ok: true, response };
  } }, { secret: webhookSecret });
  return { bot, store, handler: async (req) => {
    if (!acceptUpdates || !atomicVerified)
      return new Response("Bot hali yoqilmagan.", { status: 503 });
    const result = await boundary(req);
    if (!result.ok)
      return result;
    return Response.json({ ok: true });
  } };
}

// ../odina-editor-baseline-2026-10-20/base44/functions/telegram-order-webhook/ingress.ts
async function ingress_default(req) {
  try {
    const secret = secrets2.get("ODINA_ORDER_BOT_WEBHOOK_SECRET") || "";
    const supplied = req.headers.get("x-telegram-bot-api-secret-token") || "";
    const a = new TextEncoder().encode(secret), b = new TextEncoder().encode(supplied);
    if (!a.length || a.length !== b.length || !timingSafeEqual3(a, b)) return new Response("Ruxsat yo\u2018q. (order-intake-v8)", { status: 403, headers: { "x-odina-order-revision": "order-intake-v8" } });
    if (req.method !== "POST") return new Response("Amal noto\u2018g\u2018ri.", { status: 405 });
    const ownerId = secrets2.get("ODINA_ORDER_BOT_OWNER_TELEGRAM_ID") || "";
    const token = secrets2.get("ODINA_ORDER_BOT_TOKEN") || "";
    if (!/^[1-9]\d*$/.test(ownerId) || !Number.isSafeInteger(Number(ownerId)) || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) return new Response("Sozlamalar tekshirilsin.", { status: 503 });
    const client = createClientFromRequest2(req), service = client.asServiceRole;
    const control = await controlRow(service.entities.TelegramOrderBotState);
    const state = JSON.parse(control.payload_json);
    if (control.phase !== "complete" || state.probe?.passed !== true || !state.ownerStateId || state.activation !== "active") return new Response("Bot hali yoqilmagan.", { status: 503 });
    const draftResponse = await maybeDraft(req, service);
    if (draftResponse) return draftResponse;
    return await prepareHostedOrderBot({
      service,
      canonicalIds: { [ownerId]: state.ownerStateId },
      approvedPhotoHosts: INTAKE_CONFIG.approvedPhotoHosts,
      token,
      webhookSecret: secret,
      fetchImpl: (url, init) => globalThis.fetch(url, init),
      acceptUpdates: true,
      deliveryEnabled: true,
      submissionEnabled: true,
      atomicVerified: true
    }).handler(req);
  } catch {
    return new Response("So\u2018rov yakunlanmadi.", { status: 503 });
  }
}
export {
  ingress_default as default
};
