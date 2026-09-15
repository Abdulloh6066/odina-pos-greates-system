import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole } from "../../shared/user-helpers.ts";
import { buildProductionIngredientForecast } from "../../shared/production-forecast-logic.ts";
import { TELEGRAM_GROUP_ID, TELEGRAM_WEBHOOK_URL, cleanLabel, localClock, orderCandidates, forecastCandidate } from "../../shared/telegram-alert-logic.ts";
import { birthdayWindowMatches, buildBirthdayMessage, buildBirthdayKeyboard, birthdayDedupKey, birthdayDisplay } from "../../shared/birthday-logic.ts";

// Birthday follow-up: load all customers / followups / deliveries with pagination.
async function readAll(service: any, entityName: string, query: any = {}): Promise<any[]> {
  const rows: any[] = [];
  for (let skip = 0; skip < 10000; skip += 500) {
    const page = await service.entities[entityName].filter(query, "id", 500, skip);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
  return rows;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function telegramApi(token: string, method: string, body: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error("TELEGRAM_API_FAILED");
  return data.result;
}

async function ensureTelegramWebhook(token: string): Promise<void> {
  const info = await telegramApi(token, "getWebhookInfo");
  if (String(info?.url || "") === TELEGRAM_WEBHOOK_URL) return;
  const secret = (await sha256Hex(token)).slice(0, 32);
  await telegramApi(token, "setWebhook", {
    url: TELEGRAM_WEBHOOK_URL,
    secret_token: secret,
    allowed_updates: ["callback_query"],
  });
  const verified = await telegramApi(token, "getWebhookInfo");
  if (String(verified?.url || "") !== TELEGRAM_WEBHOOK_URL) throw new Error("TELEGRAM_WEBHOOK_NOT_VERIFIED");
}

// Ensure a BirthdayFollowup record exists for each window match (per customer + campaign year).
// New follow-ups default to "hali_aloqa_qilinmadi". Returns Map<"customer_id:campaign_year", record>.
async function ensureBirthdayFollowups(
  service: any,
  matches: any[],
): Promise<Map<string, any>> {
  const byKey = new Map<string, any>();
  if (!matches.length) return byKey;
  const customerIds = Array.from(new Set(matches.map((m: any) => m.customer_id)));
  const existing = await readAll(service, "BirthdayFollowup", { customer_id: { $in: customerIds } });
  for (const f of existing || []) {
    byKey.set(`${f.customer_id}:${f.campaign_year}`, f);
  }
  for (const m of matches) {
    const key = `${m.customer_id}:${m.campaign_year}`;
    if (byKey.has(key)) continue;
    const created = await service.entities.BirthdayFollowup.create({
      customer_id: m.customer_id,
      customer_name_snapshot: m.customer_name,
      phone_snapshot: m.phone,
      birthday_month: m.birthday_month,
      birthday_day: m.birthday_day,
      birth_year: m.birth_year,
      campaign_year: m.campaign_year,
      contact_status: "hali_aloqa_qilinmadi",
      contacted_at: "",
      contacted_by_id: "",
      contacted_by_name: "",
      last_telegram_alert_date: "",
    });
    byKey.set(key, created);
  }
  return byKey;
}

// Read-only list for the CRM birthday panel. Creates follow-ups if missing.
async function handleBirthdayList(service: any): Promise<Response> {
  const clock = localClock(Date.now());
  const todayKey = clock.today;
  const customers = await readAll(service, "Customer");
  const matches = birthdayWindowMatches(customers, todayKey);
  const byKey = await ensureBirthdayFollowups(service, matches);

  const dedupKeys = matches.map((m: any) => birthdayDedupKey(m.customer_id, m.birthday_date));
  const sentKeys = new Set<string>();
  if (dedupKeys.length) {
    const deliveries = await readAll(service, "TelegramDelivery", { keys: { $in: dedupKeys } });
    for (const d of deliveries || []) {
      if (d.status === "sent" || d.status === "reserved") {
        (d.keys || []).forEach((k: string) => sentKeys.add(k));
      }
    }
  }

  const items = matches.map((m: any) => {
    const f = byKey.get(`${m.customer_id}:${m.campaign_year}`);
    const status = f?.contact_status || "hali_aloqa_qilinmadi";
    const sentKey = birthdayDedupKey(m.customer_id, m.birthday_date);
    return {
      customer_id: m.customer_id,
      customer_name: m.customer_name,
      phone: m.phone,
      birth_date: m.birth_date,
      birthday_display: birthdayDisplay(m.birthday_month, m.birthday_day),
      days_remaining: m.days_remaining,
      label: m.label,
      campaign_year: m.campaign_year,
      contact_status: status,
      contacted_at: f?.contacted_at || "",
      contacted_by_name: f?.contacted_by_name || "",
      already_sent_today: sentKeys.has(sentKey),
    };
  });

  const counters = {
    need_contact: items.filter((i: any) => i.contact_status === "hali_aloqa_qilinmadi").length,
    no_answer: items.filter((i: any) => i.contact_status === "qongiroq_javob_bolmadi").length,
    reached: items.filter((i: any) => i.contact_status === "aloqa_chiqildi").length,
    total: items.length,
  };
  return Response.json({
    items,
    counters,
    today: todayKey,
    already_sent_today: items.some((i: any) => i.already_sent_today),
  });
}

// Owner/admin updates a follow-up contact status. Idempotent upsert; preserves who/when.
async function handleBirthdayContact(service: any, body: any, ctx: { userId: string; userName: string }): Promise<Response> {
  const customerId = String(body?.customer_id || "");
  const campaignYear = Number(body?.campaign_year);
  const status = String(body?.contact_status || "");
  if (!customerId || !Number.isFinite(campaignYear)) {
    return Response.json({ error: "Ma’lumot yetishmayapti." }, { status: 400 });
  }
  if (!["hali_aloqa_qilinmadi", "qongiroq_javob_bolmadi", "aloqa_chiqildi"].includes(status)) {
    return Response.json({ error: "Noma’lum holat." }, { status: 400 });
  }
  const existing = await service.entities.BirthdayFollowup.filter(
    { customer_id: customerId, campaign_year: campaignYear }, "id", 50,
  );
  const now = new Date().toISOString();
  let record: any = null;
  if (existing && existing.length) {
    record = await service.entities.BirthdayFollowup.update(existing[0].id, {
      contact_status: status,
      contacted_at: now,
      contacted_by_id: ctx.userId,
      contacted_by_name: ctx.userName,
    });
  } else {
    const customer = await service.entities.Customer.get(customerId).catch(() => null);
    if (!customer) return Response.json({ error: "Mijoz topilmadi." }, { status: 404 });
    const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(customer.birth_date || ""));
    record = await service.entities.BirthdayFollowup.create({
      customer_id: customerId,
      customer_name_snapshot: [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim(),
      phone_snapshot: String(customer.phone || ""),
      birthday_month: parsed ? Number(parsed[2]) : 0,
      birthday_day: parsed ? Number(parsed[3]) : 0,
      birth_year: parsed ? Number(parsed[1]) : 0,
      campaign_year: campaignYear,
      contact_status: status,
      contacted_at: now,
      contacted_by_id: ctx.userId,
      contacted_by_name: ctx.userName,
      last_telegram_alert_date: "",
    });
  }
  return Response.json({
    ok: true,
    followup: {
      id: record.id,
      contact_status: status,
      contacted_at: now,
      contacted_by_name: ctx.userName,
    },
  });
}

// Consolidated birthday Telegram send (used by both automatic and manual triggers).
// Excludes "aloqa_chiqildi"; dedups per customer per birthday date so the same
// occurrence is never sent twice on the same calendar day.
const NO_ELIGIBLE_MESSAGE = "Yaqin 3 kun ichida bog‘lanish kerak bo‘lgan mijoz topilmadi.";

async function handleBirthdaySend(service: any, opts: { manual: boolean }): Promise<Response> {
  const clock = localClock(Date.now());
  const todayKey = clock.today;
  const customers = await readAll(service, "Customer");
  const matches = birthdayWindowMatches(customers, todayKey);
  if (!matches.length) {
    return Response.json({ sent: false, pending: 0, message: NO_ELIGIBLE_MESSAGE });
  }
  const byKey = await ensureBirthdayFollowups(service, matches);
  const eligible = matches.filter((m: any) => {
    const f = byKey.get(`${m.customer_id}:${m.campaign_year}`);
    return (f?.contact_status || "hali_aloqa_qilinmadi") !== "aloqa_chiqildi";
  });
  if (!eligible.length) {
    return Response.json({ sent: false, pending: 0, message: NO_ELIGIBLE_MESSAGE });
  }

  const dedupKeys = eligible.map((m: any) => birthdayDedupKey(m.customer_id, m.birthday_date));
  const existing = await readAll(service, "TelegramDelivery", { keys: { $in: dedupKeys } });
  const used = new Set<string>();
  for (const d of existing || []) {
    if (d.status === "sent" || d.status === "reserved") {
      (d.keys || []).forEach((k: string) => used.add(k));
    }
  }
  // Manual admin trigger may force a fresh send (e.g. to attach the interactive
  // keyboard) even if the automatic workflow already sent the day's message.
  const fresh = opts.manual
    ? eligible
    : eligible.filter((m: any) => !used.has(birthdayDedupKey(m.customer_id, m.birthday_date)));
  if (!fresh.length) {
    return Response.json({
      sent: false,
      pending: 0,
      message: opts.manual ? "Yuboriladigan mijoz topilmadi." : NO_ELIGIBLE_MESSAGE,
    });
  }

  const followupByCustomer = new Map<string, any>();
  for (const m of fresh) {
    followupByCustomer.set(m.customer_id, byKey.get(`${m.customer_id}:${m.campaign_year}`));
  }
  const text = buildBirthdayMessage(fresh, followupByCustomer);
  if (!text) {
    return Response.json({ sent: false, pending: 0, message: NO_ELIGIBLE_MESSAGE });
  }
  const keyboard = buildBirthdayKeyboard(fresh, followupByCustomer);

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) {
    return Response.json({ error: "Telegram sozlamasi to‘g‘ridan to‘g‘ri emas. Admin bilan bog‘laning." }, { status: 400 });
  }
  try {
    await ensureTelegramWebhook(token);
  } catch {
    return Response.json({ error: "Telegram tugmalari ulanmagan. Webhookni qayta ulab ko‘ring." }, { status: 502 });
  }

  const reservation = await service.entities.TelegramDelivery.create({
    keys: fresh.map((m: any) => birthdayDedupKey(m.customer_id, m.birthday_date)),
    status: "reserved",
    text,
  });
  try {
    const payload: any = { chat_id: TELEGRAM_GROUP_ID, text };
    if (keyboard) payload.reply_markup = keyboard;
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      await service.entities.TelegramDelivery.update(reservation.id, { status: "rejected", error: "Telegram xabarni qabul qilmadi." }).catch(() => {});
      return Response.json({ error: "Telegram xabar yuborilmadi. Internet yoki guruh sozlamasini tekshiring." }, { status: 502 });
    }
    await service.entities.TelegramDelivery.update(reservation.id, {
      status: "sent",
      message_id: data.result.message_id,
      sent_at: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    for (const m of fresh) {
      const f = byKey.get(`${m.customer_id}:${m.campaign_year}`);
      if (f) await service.entities.BirthdayFollowup.update(f.id, { last_telegram_alert_date: now }).catch(() => {});
    }
    return Response.json({
      sent: true,
      count: fresh.length,
      message: fresh.length + " ta mijoz uchun tug‘ilgan kun eslatmasi yuborildi.",
    });
  } catch {
    await service.entities.TelegramDelivery.update(reservation.id, { status: "uncertain", error: "Yetkazilish noaniq." }).catch(() => {});
    return Response.json({ error: "Telegram xabar yuborilmadi. Internetni tekshiring va guruhda xabar paydo bo‘lganini tasdiqlang." }, { status: 502 });
  }
}

// Scheduled invocations must retain the creating admin's authenticated identity.
// No public webhook, browser token, or authentication bypass is accepted.
Deno.serve(async (req) => {
  let service: any, control: any, lease = "", reservation: any = null;
  let finalResult = "Tekshiruv bajarilmadi.";
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth?.id) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    service = client.asServiceRole;
    const stored = await resolveStoredAppUser(service, auth);
    if (!stored || stored.active === false || stored.data?.active === false) {
      return Response.json({ error: "Faqat egasi/admin uchun." }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const action = body.action || "run";
    const BIRTHDAY_ACTIONS = ["birthdays", "birthdayList", "birthdayContact", "birthdaySend"];
    if (!["status", "preview", "run", "toggle", ...BIRTHDAY_ACTIONS].includes(action)) {
      return Response.json({ error: "Noma’lum amal." }, { status: 400 });
    }
    const role = userRole(stored);
    const userName = String(stored.full_name || auth.full_name || auth.email || "Egasi");
    const userId = String(stored.id || auth.id || "");
    if (BIRTHDAY_ACTIONS.includes(action)) {
      if (action === "birthdayList") {
        if (!["admin", "manager", "cashier", "accountant"].includes(role)) {
          return Response.json({ error: "Mijozlar ma’lumotiga ruxsat yo‘q." }, { status: 403 });
        }
        return await handleBirthdayList(service);
      }
      if (action === "birthdayContact") {
        if (role !== "admin") return Response.json({ error: "Faqat egasi/admin uchun." }, { status: 403 });
        return await handleBirthdayContact(service, body, { userId, userName });
      }
      if (action === "birthdaySend") {
        if (role !== "admin") return Response.json({ error: "Faqat egasi/admin uchun." }, { status: 403 });
        return await handleBirthdaySend(service, { manual: true });
      }
      // "birthdays" — automatic workflow path, requires admin + enabled control
    } else if (role !== "admin") {
      return Response.json({ error: "Faqat egasi/admin uchun." }, { status: 403 });
    }
    const controls = await service.entities.TelegramControl.filter({ key: "odina-work-group" }, "created_date", 2);
    if (controls.length !== 1) return Response.json({ error: "Telegram sozlamasi topilmadi yoki takrorlangan. Admin tekshiruvi kerak." }, { status: 409 });
    control = controls[0];
    if (action === "toggle") {
      if (typeof body.enabled !== "boolean") return Response.json({ error: "Yoqish holati noto‘g‘ri." }, { status: 400 });
      await service.entities.TelegramControl.update(control.id, { enabled: body.enabled });
      return Response.json({ enabled: body.enabled });
    }
    if (action === "status") {
      const recent = await service.entities.TelegramDelivery.list("-created_date", 5);
      return Response.json({ enabled: control.enabled, last_run_at: control.last_run_at, last_result: control.last_result,
        recent: recent.map((r: any) => ({ id: r.id, status: r.status, sent_at: r.sent_at, created_date: r.created_date, error: r.error })) });
    }
    if (action === "birthdays") {
      if (control.enabled !== true) return Response.json({ paused: true });
      return await handleBirthdaySend(service, { manual: false });
    }

    if (action === "run" && control.enabled !== true) return Response.json({ paused: true });
    const started = Date.now();
    if (action === "run") {
      lease = crypto.randomUUID();
      const claimed = await service.entities.TelegramControl.updateMany(
        { id: control.id, enabled: true, lock_until: { $lte: started } },
        { $set: { lock_token: lease, lock_until: started + 180000 } },
      );
      if (!claimed?.success || Number(claimed.updated) !== 1) { lease = ""; return Response.json({ busy: true }); }
    }
    const readAll = async (entity: any, query: any = {}, sort = "id") => {
      const rows: any[] = [];
      for (let skip = 0; skip < 10000; skip += 500) {
        const page = await entity.filter(query, sort, 500, skip);
        rows.push(...page);
        if (page.length < 500) return rows;
      }
      throw new Error("DATA_LIMIT");
    };
    const clock = localClock(started);
    const orders = await readAll(service.entities.CustomerOrder, {
      order_status: { $in: ["qabul_qilindi", "tayyorlanmoqda", "tayyor"] },
      required_date: { $lte: clock.tomorrow },
    });
    const candidates = orderCandidates(orders, started);
    const forecastKeys: string[] = [];
    const activeLocations = (await readAll(service.entities.Shop, { location_type: "production" }, "name")).filter((r: any) => r.active !== false);
    const mainLocation = activeLocations.find((r: any) => r.is_main === true) || activeLocations[0];
    const locations = mainLocation ? [mainLocation] : [];
    // Forecast calculation is only needed for the daily evening digest.
    if (clock.hour >= 18) {
      const previous = await readAll(service.entities.TelegramDelivery, { keys: { $in: locations.map((l: any) => "forecast:" + l.id + ":" + clock.tomorrow) } });
      const used = new Set(previous.flatMap((r: any) => r.keys || []));
      const pendingLocations = locations.filter((l: any) => !used.has("forecast:" + l.id + ":" + clock.tomorrow));
      if (pendingLocations.length) {
        const relevant = orders.filter((o: any) => [clock.today, clock.tomorrow].includes(o.required_date));
        const ids = relevant.map((o: any) => o.id);
        const [products, recipes, recipeItems, orderItems] = await Promise.all([
          readAll(service.entities.Product), readAll(service.entities.Recipe, { active: true }),
          readAll(service.entities.RecipeItem),
          ids.length ? readAll(service.entities.CustomerOrderItem, { order_id: { $in: ids } }) : [],
        ]);
        for (const location of pendingLocations) {
          const ingredientStocks = await readAll(service.entities.IngredientStock, { location_id: location.id });
          const forecast = buildProductionIngredientForecast({ orders: relevant, orderItems, products, recipes, recipeItems, ingredientStocks,
            todayDate: clock.today, tomorrowDate: clock.tomorrow });
          const item = forecastCandidate(forecast, location, clock.tomorrow);
          if (item) { candidates.push(item); forecastKeys.push(item.key); }
        }
      }
    }
    const existing = candidates.length ? await readAll(service.entities.TelegramDelivery, { keys: { $in: candidates.map((c: any) => c.key) } }) : [];
    const used = new Set(existing.flatMap((r: any) => r.keys || []));
    const fresh = candidates.filter((c: any) => !used.has(c.key));
    // Prioritize the daily digest, then overdue and upcoming orders. One Telegram
    // message per run avoids group flooding; remaining candidates wait for next run.
    fresh.sort((a: any, b: any) => Number(forecastKeys.includes(b.key)) - Number(forecastKeys.includes(a.key)));
    let text = "🍰 Odina — Ish jarayoni\n" + clock.today + "\n";
    const selected: any[] = [];
    for (const item of fresh) {
      if (selected.length >= 8 || text.length + item.text.length + 2 > 3400) break;
      selected.push(item); text += "\n" + item.text + "\n";
    }
    if (fresh.length > selected.length) text += "\nYana " + (fresh.length - selected.length) + " ta ogohlantirish keyingi tekshiruvda yuboriladi.";
    if (action === "preview") return Response.json({ text: selected.length ? text : "", pending: fresh.length, evening_forecast_hour: 18 });
    if (!selected.length) {
      finalResult = "Yangi ogohlantirish yo‘q.";
      return Response.json({ sent: false, pending: 0 });
    }
    if (Date.now() - started > 120000) throw new Error("RUN_EXPIRED");
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    if (!token) { finalResult = "TELEGRAM_BOT_TOKEN topilmadi."; return Response.json({ error: finalResult }, { status: 400 }); }
    // Recheck pause/lease just before reserving a delivery.
    const current = await service.entities.TelegramControl.get(control.id);
    if (!current.enabled || current.lock_token !== lease || current.lock_until < Date.now() + 20000) {
      finalResult = "Yuborish to‘xtatildi."; return Response.json({ paused: true });
    }
    reservation = await service.entities.TelegramDelivery.create({ keys: selected.map((c: any) => c.key), status: "reserved", text });
    // Never retry a send automatically: a lost response can still mean delivery.
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_GROUP_ID, text }), signal: AbortSignal.timeout(12000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      finalResult = "Telegram xabarni qabul qilmadi. Guruh ruxsati/tokenni tekshiring.";
      await service.entities.TelegramDelivery.update(reservation.id, { status: "rejected", error: finalResult });
      reservation = null;
      return Response.json({ error: finalResult }, { status: 502 });
    }
    await service.entities.TelegramDelivery.update(reservation.id, { status: "sent", message_id: data.result.message_id, sent_at: new Date().toISOString() });
    reservation = null;
    finalResult = selected.length + " ta ogohlantirish guruhga yuborildi.";
    return Response.json({ sent: true, count: selected.length, pending: fresh.length - selected.length });
  } catch {
    finalResult = reservation ? "Yetkazilish noaniq. Qayta yuborishdan oldin guruhni tekshiring." : "Tekshiruvda xato. Ma’lumotlar va ulanishni tekshiring.";
    if (reservation) await service.entities.TelegramDelivery.update(reservation.id, { status: "uncertain", error: finalResult }).catch(() => {});
    return Response.json({ error: finalResult }, { status: 502 });
  } finally {
    if (lease && control && service) {
      await service.entities.TelegramControl.updateMany({ id: control.id, lock_token: lease }, {
        $set: { lock_token: "", lock_until: 0, last_run_at: new Date().toISOString(), last_result: finalResult },
      }).catch(() => {});
    }
  }
});