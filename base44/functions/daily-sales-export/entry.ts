import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole } from "../../shared/user-helpers.ts";
import { TELEGRAM_GROUP_ID, localClock } from "../../shared/telegram-alert-logic.ts";
import {
  computeShopReport,
  reportToRow,
} from "../../shared/daily-report-logic.ts";

const CONFIG_KEY = "daily-export";

const VIEW_ROLES = ["admin", "manager", "accountant"];
const ADMIN_ROLES = ["admin"];

async function readAll(entity: any, query: any = {}, sort = "id", limit = 500): Promise<any[]> {
  const rows: any[] = [];
  for (let skip = 0; skip < 10000; skip += limit) {
    const page = await entity.filter(query, sort, limit, skip);
    rows.push(...page);
    if (page.length < limit) return rows;
  }
  return rows;
}

async function getConfig(service: any) {
  const rows = await service.entities.DailyExportConfig.filter({ key: CONFIG_KEY }, "created_date", 2);
  if (rows.length) return rows[0];
  return await service.entities.DailyExportConfig.create({
    key: CONFIG_KEY,
    recipient_email: "",
    auto_send_enabled: true,
    reminder_enabled: true,
  });
}

// Compute per-shop metrics for one business date from Sale + SaleItem records.
async function computeReportsForDate(service: any, businessDate: string) {
  const allShops = await readAll(service.entities.Shop, {}, "name");
  const shops = allShops.filter((s: any) => s.active !== false);
  const sales = await readAll(service.entities.Sale, { business_date: businessDate }, "id");
  const saleIds = sales.map((s: any) => s.id).filter(Boolean);
  const saleItems = saleIds.length
    ? await readAll(service.entities.SaleItem, { sale_id: { $in: saleIds } }, "id")
    : [];
  const itemsBySale = new Map<string, any[]>();
  for (const it of saleItems) {
    if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, []);
    itemsBySale.get(it.sale_id)!.push(it);
  }

  const reports: any[] = [];
  for (const shop of shops) {
    const shopSales = sales.filter((s: any) => s.shop_id === shop.id);
    const m = computeShopReport(shopSales, itemsBySale);
    reports.push({
      business_date: businessDate,
      shop_id: shop.id,
      shop_name: shop.name,
      total_revenue: m.revenue,
      total_cost: m.cost,
      real_profit: m.realProfit,
      sale_count: m.saleCount,
      refund_count: m.refundCount,
      cash_total: m.cash,
      uzcard_total: m.uzcard,
      humo_total: m.humo,
      online_total: m.online,
      bank_transfer_total: m.bank_transfer,
      _empty: shopSales.length === 0,
    });
  }
  return reports;
}

async function upsertReport(service: any, r: any) {
  const existing = await service.entities.DailyShopReport.filter(
    { business_date: r.business_date, shop_id: r.shop_id },
    "id",
    2,
  );
  const payload = {
    business_date: r.business_date,
    shop_id: r.shop_id,
    shop_name: r.shop_name,
    total_revenue: r.total_revenue,
    total_cost: r.total_cost,
    real_profit: r.real_profit,
    sale_count: r.sale_count,
    refund_count: r.refund_count,
    cash_total: r.cash_total,
    uzcard_total: r.uzcard_total,
    humo_total: r.humo_total,
    online_total: r.online_total,
    bank_transfer_total: r.bank_transfer_total,
    generated_at: new Date().toISOString(),
  };
  if (existing.length) {
    return await service.entities.DailyShopReport.update(existing[0].id, payload);
  }
  return await service.entities.DailyShopReport.create({
    ...payload,
    email_sent: false,
    sheet_appended: false,
  });
}

// ---- Google Sheets ----

function sheetErr(data: any): string {
  const msg = String(data?.error?.message || "Google Sheets bilan ishlashda xato.");
  if (/insufficient|permission|scope|forbidden/i.test(msg)) {
    return "Google Sheets ga yozish uchun ruxsat berilmadi. Google hisobni qayta ulang (spreadsheets ruxsati kerak).";
  }
  return msg;
}

async function getSheetsToken(service: any): Promise<string> {
  try {
    const { accessToken } = await service.connectors.getConnection("googlesheets");
    return accessToken || "";
  } catch {
    return "";
  }
}

const SHEET_HEADERS = [
  "Sana",
  "Do'kon",
  "Tushum (UZS)",
  "Tannarx (UZS)",
  "Real foyda (UZS)",
  "Sotuv soni",
  "Qaytar soni",
  "Naqd",
  "Uzcard",
  "Humo",
  "Online",
  "Bank",
  "Yuborildi",
  "Yuborilgan vaqt",
];

function reportToSheetRow(r: any): any[] {
  return reportToRow(r, "ha");
}

async function ensureSheet(service: any, token: string, config: any) {
  if (config.google_sheet_id) return config;
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title: "Odina — Kunlik Hisobot" },
      sheets: [{ properties: { title: "Hisobot" } }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(sheetErr(data));
  const spreadsheetId = data.spreadsheetId;
  const url = data.spreadsheetUrl;
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Hisobot!A1`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [SHEET_HEADERS] }),
  });
  const updated = await service.entities.DailyExportConfig.update(config.id, {
    google_sheet_id: spreadsheetId,
    google_sheet_url: url,
    sheet_created_at: new Date().toISOString(),
  });
  return { ...config, google_sheet_id: spreadsheetId, google_sheet_url: url };
}

async function appendRows(token: string, sheetId: string, rows: any[][]) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Hisobot!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(sheetErr(data));
}

// ---- Email ----

async function sendEmailReport(
  service: any,
  recipientEmail: string,
  businessDate: string,
  reports: any[],
) {
  if (!recipientEmail) return { sent: false, reason: "no-email" };
  const html =
    `<h2>Odina — kunlik hisobot (${businessDate})</h2>` +
    `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Inter,Arial,sans-serif;font-size:13px">` +
    `<tr><th>Do'kon</th><th>Tushum</th><th>Tannarx</th><th>Real foyda</th><th>Sotuv</th><th>Qaytar</th></tr>` +
    reports
      .map(
        (r: any) =>
          `<tr><td>${r.shop_name}</td><td>${Math.round(r.total_revenue).toLocaleString("en-US")}</td><td>${Math.round(r.total_cost).toLocaleString("en-US")}</td><td>${Math.round(r.real_profit).toLocaleString("en-US")}</td><td>${r.sale_count}</td><td>${r.refund_count}</td></tr>`,
      )
      .join("") +
    `</table>`;
  await service.integrations.Core.SendEmail({
    to: recipientEmail,
    subject: `Odina — kunlik hisobot ${businessDate}`,
    html,
  });
  return { sent: true };
}

// ---- Telegram reminder ----

async function sendTelegramReminder(token: string, shopNames: string[]) {
  const text =
    "⚠️ Odina — smena yopilmadi\nQuyidagi do'konlarda smena hali yopilmadi. Kunlik hisobot shu do'konlar uchun yuborilmaydi:\n" +
    shopNames.map((n) => "• " + n).join("\n");
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_GROUP_ID, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error("Telegram eslatma yuborilmadi.");
}

// ---- Core delivery: persist + sheet + email for a set of shop reports ----

async function deliverReports(
  service: any,
  config: any,
  reports: any[],
  businessDate: string,
  ctx: { userId: string; userName: string },
  trigger: string,
) {
  const persisted: any[] = [];
  for (const r of reports) {
    persisted.push(await upsertReport(service, r));
  }

  let sheetOk = false;
  let sheetError = "";
  const token = await getSheetsToken(service);
  if (token) {
    try {
      const cfg = await ensureSheet(service, token, config);
      const rows = reports.map(reportToSheetRow);
      await appendRows(token, cfg.google_sheet_id, rows);
      sheetOk = true;
      config = cfg;
    } catch (e) {
      sheetError = e instanceof Error ? e.message : String(e);
    }
  } else {
    sheetError = "Google Sheets ulanmagan.";
  }
  if (sheetOk) {
    for (const rec of persisted) {
      await service.entities.DailyShopReport.update(rec.id, {
        sheet_appended: true,
        sheet_append_at: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  let emailOk = false;
  let emailError = "";
  try {
    const r = await sendEmailReport(service, config.recipient_email, businessDate, reports);
    emailOk = r.sent;
    if (!emailOk) emailError = r.reason || "email yuborilmadi";
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }

  const now = new Date().toISOString();
  for (const rec of persisted) {
    await service.entities.DailyShopReport.update(rec.id, {
      email_sent: emailOk,
      email_sent_at: emailOk ? now : "",
      sent_at: now,
      sent_by_id: ctx.userId,
      sent_by_name: ctx.userName,
      trigger,
    }).catch(() => {});
  }

  return {
    sent: reports.length,
    sheet_ok: sheetOk,
    sheet_error: sheetError,
    email_ok: emailOk,
    email_error: emailError,
    targetDate: businessDate,
    sheet_url: config.google_sheet_url || "",
  };
}

// ---- Actions ----

async function handlePreview(service: any, businessDate: string) {
  const reports = await computeReportsForDate(service, businessDate);
  return Response.json({ business_date: businessDate, reports });
}

async function handleSend(
  service: any,
  body: any,
  ctx: { userId: string; userName: string },
) {
  const businessDate = String(body.business_date || localClock(Date.now()).today);
  const reports = await computeReportsForDate(service, businessDate);
  const config = await getConfig(service);
  return Response.json(
    await deliverReports(service, config, reports, businessDate, ctx, body.trigger || "manual"),
  );
}

async function handleAutoSend(service: any, body: any, ctx: { userId: string; userName: string }) {
  const config = await getConfig(service);
  if (!config.auto_send_enabled) return Response.json({ skipped: true, reason: "disabled" });
  const clock = localClock(Date.now());
  if (clock.hour < 23) return Response.json({ skipped: true, reason: "before-23" });
  const targetDate = String(body.business_date || clock.today);

  const shops = (await readAll(service.entities.Shop, {}, "name")).filter(
    (s: any) => s.active !== false,
  );
  const openShifts = await readAll(service.entities.Shift, { status: "open" }, "id");
  const openShopIds = new Set(openShifts.map((s: any) => s.shop_id).filter(Boolean));
  const sent = await readAll(service.entities.DailyShopReport, { business_date: targetDate }, "id");
  const sentShopIds = new Set(
    sent.filter((r: any) => r.sent_at).map((r: any) => r.shop_id),
  );

  const readyShopIds = new Set(
    shops
      .filter((s: any) => !openShopIds.has(s.id) && !sentShopIds.has(s.id))
      .map((s: any) => s.id),
  );
  if (!readyShopIds.size) return Response.json({ sent: 0, targetDate, skipped: [] });

  const allReports = await computeReportsForDate(service, targetDate);
  const reports = allReports.filter((r: any) => readyShopIds.has(r.shop_id));
  if (!reports.length) return Response.json({ sent: 0, targetDate });

  const result = await deliverReports(service, config, reports, targetDate, ctx, "auto");
  return Response.json({ ...result, ready_shops: reports.map((r: any) => r.shop_name) });
}

async function handleReminder(service: any) {
  const config = await getConfig(service);
  if (!config.reminder_enabled) return Response.json({ skipped: true, reason: "disabled" });
  const openShifts = await readAll(service.entities.Shift, { status: "open" }, "id");
  if (!openShifts.length) return Response.json({ open: 0, reminded: false });
  const shopIds = Array.from(new Set(openShifts.map((s: any) => s.shop_id).filter(Boolean)));
  const shops = await readAll(service.entities.Shop, {}, "name");
  const names = shopIds
    .map((id) => shops.find((s: any) => s.id === id))
    .filter(Boolean)
    .map((s: any) => s.name);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return Response.json({ error: "TELEGRAM_BOT_TOKEN topilmadi." }, { status: 400 });
  await sendTelegramReminder(token, names);
  return Response.json({ open: shopIds.length, reminded: true, shops: names });
}

async function handleGetConfig(service: any) {
  const config = await getConfig(service);
  let connected = false;
  try {
    await service.connectors.getConnection("googlesheets");
    connected = true;
  } catch {
    connected = false;
  }
  return Response.json({ config, sheets_connected: connected });
}

async function handleSaveConfig(service: any, body: any) {
  const config = await getConfig(service);
  const update: any = {};
  if (typeof body.recipient_email === "string")
    update.recipient_email = body.recipient_email.trim();
  if (typeof body.auto_send_enabled === "boolean")
    update.auto_send_enabled = body.auto_send_enabled;
  if (typeof body.reminder_enabled === "boolean")
    update.reminder_enabled = body.reminder_enabled;
  const updated = await service.entities.DailyExportConfig.update(config.id, update);
  return Response.json({ config: updated });
}

export default async function(req: Request): Promise<Response> {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth?.id) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const service = client.asServiceRole;
    const stored = await resolveStoredAppUser(service, auth);
    if (!stored || stored.active === false || stored.data?.active === false) {
      return Response.json({ error: "Hisob o‘chirilgan." }, { status: 403 });
    }
    const role = userRole(stored);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "getConfig");
    const ctx = {
      userId: String(stored.id || auth.id || ""),
      userName: String(stored.full_name || auth.full_name || auth.email || "Egasi"),
    };

    if (!["getConfig", "saveConfig", "preview", "send", "autoSend", "reminder"].includes(action)) {
      return Response.json({ error: "Noma’lum amal." }, { status: 400 });
    }

    // Read-only / preview actions: admin, manager, accountant.
    if (action === "preview" || action === "getConfig") {
      if (!VIEW_ROLES.includes(role))
        return Response.json({ error: "Ruxsat yo‘q." }, { status: 403 });
      if (action === "getConfig") return await handleGetConfig(service);
      return await handlePreview(service, String(body.business_date || localClock(Date.now()).today));
    }

    // Everything else: admin only.
    if (!ADMIN_ROLES.includes(role))
      return Response.json({ error: "Faqat egasi/admin uchun." }, { status: 403 });

    if (action === "saveConfig") return await handleSaveConfig(service, body);
    if (action === "send") return await handleSend(service, body, ctx);
    if (action === "autoSend") return await handleAutoSend(service, body, ctx);
    if (action === "reminder") return await handleReminder(service);

    return Response.json({ error: "Noma’lum amal." }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Hisobda xato yuz berdi." },
      { status: 500 },
    );
  }
}