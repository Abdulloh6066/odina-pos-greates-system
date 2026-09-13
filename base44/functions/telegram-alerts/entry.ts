import { createClientFromRequest } from "npm:@base44/sdk";
import { userRole } from "../../shared/user-helpers.ts";
import { buildProductionIngredientForecast } from "../../shared/production-forecast-logic.ts";
import { TELEGRAM_GROUP_ID, localClock, orderCandidates, forecastCandidate } from "../../shared/telegram-alert-logic.ts";

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
    if (auth.active === false || auth.data?.active === false || userRole(auth) !== "admin") {
      return Response.json({ error: "Faqat egasi/admin uchun." }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const action = body.action || "run";
    if (!["status", "preview", "run", "toggle", "birthdays"].includes(action)) return Response.json({ error: "Noma’lum amal." }, { status: 400 });
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
      const clock = localClock(Date.now());
      const todayParts = clock.today.split("-").map(Number);
      const tomorrowParts = clock.tomorrow.split("-").map(Number);
      const readCustomers = async () => {
        const rows: any[] = [];
        for (let skip = 0; skip < 10000; skip += 500) {
          const page = await service.entities.Customer.filter({}, "id", 500, skip);
          rows.push(...page);
          if (page.length < 500) return rows;
        }
        throw new Error("DATA_LIMIT");
      };
      const allCustomers = await readCustomers();
      const matches = allCustomers.filter((c: any) => {
        const bd = String(c?.birth_date || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return false;
        const [, mm, dd] = bd.split("-").map(Number);
        const isToday = mm === todayParts[1] && dd === todayParts[2];
        const isTomorrow = mm === tomorrowParts[1] && dd === tomorrowParts[2];
        return isToday || isTomorrow;
      });
      const keys = matches.map((c: any) => "birthday:" + c.id + ":" + (String(c.birth_date).slice(5) === clock.today.slice(5) ? clock.today : clock.tomorrow));
      if (!matches.length) return Response.json({ sent: false, pending: 0 });
      const readDeliveries = async (query: any) => {
        const rows: any[] = [];
        for (let skip = 0; skip < 10000; skip += 500) {
          const page = await service.entities.TelegramDelivery.filter(query, "id", 500, skip);
          rows.push(...page);
          if (page.length < 500) return rows;
        }
        return rows;
      };
      const existing = await readDeliveries({ keys: { $in: keys } });
      const used = new Set(existing.flatMap((r: any) => r.keys || []));
      const fresh = matches.filter((c: any) => {
        const key = "birthday:" + c.id + ":" + (String(c.birth_date).slice(5) === clock.today.slice(5) ? clock.today : clock.tomorrow);
        return !used.has(key);
      });
      if (!fresh.length) return Response.json({ sent: false, pending: 0 });
      const lines = fresh.map((c: any) => {
        const bd = String(c.birth_date);
        const isToday = bd.slice(5) === clock.today.slice(5);
        const name = cleanLabel([c.first_name, c.last_name].filter(Boolean).join(" "));
        const phone = cleanLabel(c.phone);
        return (isToday ? "🎂 Bugun " : "📅 Ertaga ") + name + " tug'ilgan kuni! Telefon: " + (phone || "—");
      });
      const text = "🍰 Odina — Tug'ilgan kun eslatmasi\n" + clock.today + "\n\n" + lines.join("\n");
      const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
      if (!token) return Response.json({ error: "TELEGRAM_BOT_TOKEN topilmadi." }, { status: 400 });
      const reservation = await service.entities.TelegramDelivery.create({ keys: fresh.map((c: any) => "birthday:" + c.id + ":" + (String(c.birth_date).slice(5) === clock.today.slice(5) ? clock.today : clock.tomorrow)), status: "reserved", text });
      try {
        const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TELEGRAM_GROUP_ID, text }), signal: AbortSignal.timeout(12000),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          await service.entities.TelegramDelivery.update(reservation.id, { status: "rejected", error: "Telegram xabarni qabul qilmadi." }).catch(() => {});
          return Response.json({ error: "Telegram xabarni qabul qilmadi." }, { status: 502 });
        }
        await service.entities.TelegramDelivery.update(reservation.id, { status: "sent", message_id: data.result.message_id, sent_at: new Date().toISOString() });
        return Response.json({ sent: true, count: fresh.length });
      } catch {
        await service.entities.TelegramDelivery.update(reservation.id, { status: "uncertain", error: "Yetkazilish noaniq." }).catch(() => {});
        return Response.json({ error: "Tug'ilgan kun xabarini yuborib bo'lmadi." }, { status: 502 });
      }
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