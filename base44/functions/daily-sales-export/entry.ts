import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole, userShopId } from "../../shared/user-helpers.ts";
import { TELEGRAM_GROUP_ID, localClock } from "../../shared/telegram-alert-logic.ts";
import {
  computeShopReport,
  reportToRow, REPORT_HEADERS,
} from "../../shared/daily-report-logic.ts";
import { loadReportActivity, readReportRows, reportDate, reportRange } from "../../shared/report-activity.ts";

const CONFIG_KEY = "daily-export";

const VIEW_ROLES = ["admin", "manager", "accountant"];
const ADMIN_ROLES = ["admin"];

const readAll = readReportRows;

function scopeReportActivity(activity: any, shopId: string) {
  if (!shopId) return activity;
  const scoped = { ...activity };
  for (const key of ["sales", "allSales", "refunds", "orderPayments", "expenses"]) {
    if (Array.isArray(activity[key])) scoped[key] = activity[key].filter((row: any) => row.shop_id === shopId);
  }
  return scoped;
}

function activityMetrics(activity: any, shopId = "", date = "") {
  const match = (row: any, day: string) => (!shopId || row.shop_id === shopId) && (!date || day === date);
  return computeShopReport(
    activity.sales.filter((row: any) => match(row, row.business_date)), activity.itemsBySale,
    { allSales: activity.allSales,
      refunds: activity.refunds.filter((row: any) => match(row, reportDate(row.created_at || row.created_date))),
      orderPayments: activity.orderPayments.filter((row: any) => match(row, reportDate(row.paid_at))),
      expenses: activity.expenses.filter((row: any) => match(row, reportDate(row.created_at || row.created_date))),
    },
  );
}
const extraMetrics = (m: any) => ({
  orderPayments: m.orderPayments, collections: m.collections, expenses: m.expenses,
  netProfit: m.netProfit, unknownCostCount: m.unknownCostCount,
  cash: m.cash, uzcard: m.uzcard, humo: m.humo, online: m.online, bank_transfer: m.bank_transfer,
});

async function getConfig(service: any) {
  const rows = await service.entities.DailyExportConfig.filter({ key: CONFIG_KEY }, "created_date", 2);
  if (rows.length > 1) throw new Error("Eksport sozlamalari takrorlangan. Avval egasi tekshirishi kerak.");
  if (rows.length) return rows[0];
  return await service.entities.DailyExportConfig.create({
    key: CONFIG_KEY,
    recipient_email: "",
    auto_send_enabled: true,
    reminder_enabled: true,
  });
}

// Compute per-shop metrics for one business date from Sale + SaleItem records.
async function computeReportsForDate(service: any, businessDate: string, scopedShopId = "") {
  const allShops = await readAll(service.entities.Shop, {}, "name");
  const shops = allShops.filter((s: any) => s.active !== false && (!scopedShopId || s.id === scopedShopId));
  const activity = scopeReportActivity(await loadReportActivity(service, businessDate, businessDate), scopedShopId);
  const sales = activity.sales;

  const reports: any[] = [];
  for (const shop of shops) {
    const shopSales = sales.filter((s: any) => s.shop_id === shop.id);
    const m = activityMetrics(activity, shop.id);
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
      order_payment_total: m.orderPayments,
      collections_total: m.collections,
      expenses_total: m.expenses,
      net_profit: m.netProfit,
      unknown_cost_count: m.unknownCostCount,
      _empty: shopSales.length === 0 && m.orderPaymentCount === 0 && m.refundCount === 0,
    });
  }
  return reports;
}

// Compute per-shop, per-day metrics across a date range (for the real-profit dashboard).
async function computeReportsForRange(service: any, dateFrom: string, dateTo: string, scopedShopId = "") {
  const allShops = await readAll(service.entities.Shop, {}, "name");
  const shops = allShops.filter((s: any) => s.active !== false && (!scopedShopId || s.id === scopedShopId));
  let f = dateFrom;
  let t = dateTo;
  if (f > t) {
    const tmp = f;
    f = t;
    t = tmp;
  }
  const activity = scopeReportActivity(await loadReportActivity(service, f, t), scopedShopId);
  const sales = activity.sales;

  const dateSet = new Set<string>();
  const salesByDate = new Map<string, any[]>();
  for (const s of sales) {
    const d = s.business_date;
    dateSet.add(d);
    if (!salesByDate.has(d)) salesByDate.set(d, []);
    salesByDate.get(d)!.push(s);
  }
  for (const row of activity.refunds) dateSet.add(reportDate(row.created_at || row.created_date));
  for (const row of activity.orderPayments) dateSet.add(reportDate(row.paid_at));
  for (const row of activity.expenses) dateSet.add(reportDate(row.created_at || row.created_date));
  const dates = Array.from(dateSet).filter(Boolean).sort();

  const shopsOut = shops.map((shop: any) => {
    const dayRows: any[] = [];
    let revenue = 0;
    let cost = 0;
    let profit = 0;
    let salesCount = 0;
    let refunds = 0;
    for (const date of dates) {
      const ds = (salesByDate.get(date) || []).filter((s: any) => s.shop_id === shop.id);
      const m = activityMetrics(activity, shop.id, date);
      dayRows.push({
        date,
        revenue: m.revenue,
        cost: m.cost,
        profit: m.realProfit,
        sales: m.saleCount,
        refunds: m.refundCount,
        ...extraMetrics(m),
      });
      revenue += m.revenue;
      cost += m.cost;
      profit += m.realProfit;
      salesCount += m.saleCount;
      refunds += m.refundCount;
    }
    return {
      shop_id: shop.id,
      shop_name: shop.name,
      totals: { revenue, cost, profit, sales: salesCount, refunds, ...extraMetrics(activityMetrics(activity, shop.id)) },
      days: dayRows,
    };
  });

  const byDay = dates.map((date: string) => {
    const ds = salesByDate.get(date) || [];
    const m = activityMetrics(activity, "", date);
    return {
      date,
      revenue: m.revenue,
      cost: m.cost,
      profit: m.realProfit,
      sales: m.saleCount,
      refunds: m.refundCount,
      ...extraMetrics(m),
    };
  });
  const grand = byDay.reduce(
    (a: any, d: any) => ({
      revenue: a.revenue + d.revenue,
      cost: a.cost + d.cost,
      profit: a.profit + d.profit,
      sales: a.sales + d.sales,
      refunds: a.refunds + d.refunds,
    }),
    { revenue: 0, cost: 0, profit: 0, sales: 0, refunds: 0 },
  );

  return { date_from: f, date_to: t, dates, shops: shopsOut, byDay,
    grand: { ...grand, ...extraMetrics(activityMetrics(activity)) },
    notice: 'Buyurtma to‘lovlari pul tushumiga kiradi, lekin Kassa foydasiga qo‘shilmaydi. Noma’lum tannarx bo‘lsa foyda taxminiy.',
  };
}

async function handleRange(service: any, body: any, scopedShopId = "") {
  const clock = localClock(Date.now());
  const dateFrom = String(body.date_from || clock.today);
  const dateTo = String(body.date_to || dateFrom);
  const data = await computeReportsForRange(service, dateFrom, dateTo, scopedShopId);
  return Response.json(data);
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
    order_payment_total: r.order_payment_total || 0,
    collections_total: r.collections_total ?? r.total_revenue,
    expenses_total: r.expenses_total || 0,
    net_profit: r.net_profit ?? r.real_profit,
    unknown_cost_count: r.unknown_cost_count || 0,
  };
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  const fingerprint = Array.from(new Uint8Array(bytes)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (existing.length > 1) throw new Error("Bir sana/do‘kon uchun takroriy hisobot topildi. Avtomatik yuborilmadi.");
  const previous = existing[0];
  const same = previous?.delivery_fingerprint === fingerprint;
  const record = { ...payload, delivery_fingerprint: fingerprint, generated_at: new Date().toISOString(),
    ...(!same ? { email_sent: false, sheet_appended: false, sent_at: "" } : {}),
  };
  if (previous) return await service.entities.DailyShopReport.update(previous.id, record);
  return await service.entities.DailyShopReport.create(record);
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

const SHEET_HEADERS = REPORT_HEADERS;

function reportToSheetRow(r: any): any[] {
  return reportToRow(r, "Google Sheets");
}

async function ensureSheet(service: any, token: string, config: any) {
  if (config.google_sheet_id) return config;
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
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
  // Headers are written with the report rows after the new sheet ID is saved.
  // A failed header response must not cause a second spreadsheet to be created.
  const updated = await service.entities.DailyExportConfig.update(config.id, {
    google_sheet_id: spreadsheetId,
    google_sheet_url: url,
    sheet_created_at: new Date().toISOString(),
  });
  return { ...config, google_sheet_id: spreadsheetId, google_sheet_url: url };
}

async function upsertSheetRows(token: string, sheetId: string, reports: any[]) {
  const root = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const read = await fetch(`${root}/Hisobot!A:T`, { headers, signal: AbortSignal.timeout(15000) });
  const current = await read.json();
  if (!read.ok) throw new Error(sheetErr(current));
  const rows: any[][] = current.values || [];
  const writes: any[] = [{ range: "Hisobot!A1:T1", values: [SHEET_HEADERS] }];
  let nextRow = Math.max(2, rows.length + 1);
  for (const report of reports) {
    // New exports match stable shop ID; pre-existing 14-column rows match their
    // original date/shop name without moving or deleting any historical rows.
    const matches = rows.map((row, index) => ({ row, index })).filter(({ row, index }) => index > 0
      && row[0] === report.business_date
      && (row[19] ? row[19] === report.shop_id : row[1] === report.shop_name));
    if (matches.length > 1) throw new Error("Google Sheetsda shu sana/do‘kon takrorlangan. Mavjud qatorlarga tegilmadi.");
    const rowNumber = matches.length ? matches[0].index + 1 : nextRow++;
    writes.push({ range: `Hisobot!A${rowNumber}:T${rowNumber}`, values: [reportToSheetRow(report)] });
  }
  const res = await fetch(`${root}:batchUpdate`, {
    method: "POST", headers, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ valueInputOption: "RAW", data: writes }),
  });
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
    `<tr><th>Do'kon</th><th>Kassa sof savdo</th><th>Kassa tannarxi</th><th>Kassa yalpi foyda</th><th>Sotuv</th><th>Qaytar</th><th>Buyurtma to‘lovlari</th><th>Jami olingan pul</th><th>Xarajatlar</th><th>Tannarx holati</th></tr>` +
    reports
      .map(
        (r: any) =>
          `<tr><td>${String(r.shop_name).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c))}</td><td>${Math.round(r.total_revenue).toLocaleString("en-US")}</td><td>${Math.round(r.total_cost).toLocaleString("en-US")}</td><td>${Math.round(r.real_profit).toLocaleString("en-US")}</td><td>${r.sale_count}</td><td>${r.refund_count}</td><td>${Math.round(r.order_payment_total || 0).toLocaleString("en-US")}</td><td>${Math.round(r.collections_total ?? r.total_revenue).toLocaleString("en-US")}</td><td>${Math.round(r.expenses_total || 0).toLocaleString("en-US")}</td><td>${r.unknown_cost_count ? 'Taxminiy / noma’lum' : 'Saqlangan tannarx'}</td></tr>`,
      )
      .join("") +
    `</table><p>Buyurtma to‘lovlari olingan kunida pul tushumiga kiradi; ular Kassa foydasiga qo‘shilmaydi. Yalpi foydadan boshqa xarajatlar ayrilmagan. Noma’lum tannarx bo‘lsa natija taxminiy.</p>`;
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
  retryUncertainEmail = false,
) {
  const lockToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const locked = await service.entities.DailyExportConfig.updateMany({ id: config.id,
    $or: [{ delivery_lock_token: { $exists: false } }, { delivery_lock_token: "" },
      { delivery_lock_until: { $lt: now } }],
  }, { $set: { delivery_lock_token: lockToken, delivery_lock_until: new Date(Date.now() + 300000).toISOString() } });
  if (!locked?.success || Number(locked.updated || 0) !== 1) {
    throw new Error("Hisobot boshqa so‘rovda yuborilmoqda. Qayta yuborilmadi.");
  }
  const renewLease = async () => {
    const renewed = await service.entities.DailyExportConfig.updateMany({ id: config.id,
      delivery_lock_token: lockToken, delivery_lock_until: { $gt: new Date().toISOString() },
    }, { $set: { delivery_lock_until: new Date(Date.now() + 300000).toISOString() } });
    if (!renewed?.success || Number(renewed.updated || 0) !== 1) throw new Error("Eksport so‘rovi eskirgan. Yuborish to‘xtadi.");
  };
  try {
    config = await service.entities.DailyExportConfig.get(config.id);
    const persisted: any[] = [];
    for (const r of reports) persisted.push(await upsertReport(service, r));
    let sheetError = "";
    let emailError = "";
    const neededSheet = persisted.filter(rec => !rec.sheet_appended || rec.sheet_fingerprint !== rec.delivery_fingerprint);
    if (neededSheet.length) {
      const token = await getSheetsToken(service);
      if (!token) sheetError = "Google Sheets ulanmagan.";
      else {
        try {
          await renewLease();
          config = await ensureSheet(service, token, config);
          await renewLease();
          await upsertSheetRows(token, config.google_sheet_id, neededSheet);
          for (const rec of neededSheet) {
            await service.entities.DailyShopReport.update(rec.id, { sheet_appended: true,
              sheet_fingerprint: rec.delivery_fingerprint, sheet_append_at: new Date().toISOString() });
            rec.sheet_appended = true; rec.sheet_fingerprint = rec.delivery_fingerprint;
          }
        } catch (error) { sheetError = error instanceof Error ? error.message : String(error); }
      }
    }
    const recipient = String(config.recipient_email || "").trim();
    const neededEmail = recipient ? persisted.filter(rec => !rec.email_sent
      || rec.email_fingerprint !== rec.delivery_fingerprint || rec.email_recipient_snapshot !== recipient) : [];
    const uncertain = neededEmail.filter(rec => ["sending", "uncertain"].includes(rec.email_delivery_state));
    const eligibleEmail = neededEmail.filter(rec => retryUncertainEmail || !uncertain.includes(rec));
    if (uncertain.length && !retryUncertainEmail) emailError = "Email natijasi noaniq. Pochtani tekshiring; tasdiqsiz takroriy email yuborilmaydi.";
    if (eligibleEmail.length) {
      await renewLease();
      for (const rec of eligibleEmail) {
        await service.entities.DailyShopReport.update(rec.id, { email_delivery_state: "sending",
          email_attempted_at: new Date().toISOString(), email_recipient_snapshot: recipient });
        rec.email_delivery_state = "sending";
        rec.email_sent = false;
        rec.email_recipient_snapshot = recipient;
      }
      try {
        await sendEmailReport(service, recipient, businessDate, eligibleEmail);
        for (const rec of eligibleEmail) {
          await service.entities.DailyShopReport.update(rec.id, { email_sent: true, email_delivery_state: "sent",
            email_fingerprint: rec.delivery_fingerprint, email_sent_at: new Date().toISOString(), email_recipient_snapshot: recipient });
          rec.email_sent = true; rec.email_fingerprint = rec.delivery_fingerprint;
          rec.email_recipient_snapshot = recipient; rec.email_delivery_state = "sent";
        }
      } catch (error) {
        const status = Number((error as any)?.response?.status || (error as any)?.status || 0);
        const state = [400, 401, 403, 404, 422, 429].includes(status) ? "failed" : "uncertain";
        emailError = state === "uncertain" ? "Email yetib borganligi noaniq. Takrorlamasdan avval pochtani tekshiring."
          : "Email xizmati so‘rovni rad etdi. Keyingi urinishda qayta yuboriladi.";
        for (const rec of eligibleEmail) {
          if (rec.email_delivery_state === "sent" && rec.email_fingerprint === rec.delivery_fingerprint) continue;
          rec.email_delivery_state = state;
          await service.entities.DailyShopReport.update(rec.id, { email_sent: false, email_delivery_state: state }).catch(() => {});
        }
      }
    }
    let sent = 0;
    for (const rec of persisted) {
      const sheetDone = rec.sheet_appended === true && rec.sheet_fingerprint === rec.delivery_fingerprint;
      const emailDone = !recipient || (rec.email_sent === true && rec.email_fingerprint === rec.delivery_fingerprint
        && rec.email_recipient_snapshot === recipient);
      const complete = sheetDone && emailDone;
      await service.entities.DailyShopReport.update(rec.id, {
        sent_at: complete ? new Date().toISOString() : "", delivery_attempted_at: new Date().toISOString(),
        delivery_error: [sheetDone ? "" : sheetError, emailDone ? "" : emailError].filter(Boolean).join(" · "),
        sent_by_id: ctx.userId, sent_by_name: ctx.userName, trigger,
      });
      if (complete) sent++;
    }
    return { sent, attempted: reports.length,
      sheet_ok: persisted.every(rec => rec.sheet_appended && rec.sheet_fingerprint === rec.delivery_fingerprint),
      sheet_error: sheetError,
      email_ok: Boolean(recipient) && persisted.every(rec => rec.email_sent && rec.email_fingerprint === rec.delivery_fingerprint && rec.email_recipient_snapshot === recipient),
      email_skipped: !recipient, email_error: emailError,
      email_uncertain: persisted.some(rec => ["sending", "uncertain"].includes(rec.email_delivery_state)),
      targetDate: businessDate, sheet_url: config.google_sheet_url || "",
    };
  } finally {
    await service.entities.DailyExportConfig.updateMany({ id: config.id, delivery_lock_token: lockToken },
      { $set: { delivery_lock_token: "", delivery_lock_until: new Date().toISOString() } }).catch(() => {});
  }
}

// ---- Actions ----

async function handlePreview(service: any, businessDate: string, scopedShopId = "") {
  const reports = await computeReportsForDate(service, businessDate, scopedShopId);
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
    await deliverReports(service, config, reports, businessDate, ctx, "manual", body.retry_uncertain_email === true),
  );
}

async function handleAutoSend(service: any, body: any, ctx: { userId: string; userName: string }) {
  const config = await getConfig(service);
  if (!config.auto_send_enabled) return Response.json({ skipped: true, reason: "disabled" });
  const clock = localClock(Date.now());
  if (clock.hour !== 23 && clock.hour !== 0) return Response.json({ skipped: true, reason: "outside-export-window" });
  const previousDay = new Date(Date.parse(clock.today + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
  const targetDate = String(body.business_date || (clock.hour === 0 ? previousDay : clock.today));
  reportRange(targetDate, targetDate);

  const shops = (await readAll(service.entities.Shop, {}, "name")).filter(
    (s: any) => s.active !== false,
  );
  const openShifts = await readAll(service.entities.Shift, { status: { $in: ["open", "closing"] } }, "id");
  const endOfDay = reportRange(targetDate, targetDate).end;
  const openShopIds = new Set(openShifts.filter((s: any) => !s.opened_at || s.opened_at < endOfDay).map((s: any) => s.shop_id).filter(Boolean));
  const sent = await readAll(service.entities.DailyShopReport, { business_date: targetDate }, "id");
  const sentShopIds = new Set(
    sent.filter((r: any) => r.sheet_appended === true && r.sheet_fingerprint === r.delivery_fingerprint
      && r.delivery_fingerprint && (!config.recipient_email || (r.email_sent === true
        && r.email_fingerprint === r.delivery_fingerprint && r.email_recipient_snapshot === config.recipient_email.trim())))
      .map((r: any) => r.shop_id),
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
    const scopedShopId = role === "manager" ? userShopId(stored) : "";
    if (role === "manager") {
      const assigned = scopedShopId ? await service.entities.Shop.get(scopedShopId).catch(() => null) : null;
      if (!assigned || assigned.active === false) return Response.json({ error: "Faol ish joyi kerak." }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "getConfig");
    const ctx = {
      userId: String(stored.id || auth.id || ""),
      userName: String(stored.full_name || auth.full_name || auth.email || "Egasi"),
    };

    if (!["getConfig", "saveConfig", "preview", "range", "send", "autoSend", "reminder"].includes(action)) {
      return Response.json({ error: "Noma’lum amal." }, { status: 400 });
    }

    // Read-only / preview actions: admin, manager, accountant.
    if (action === "preview" || action === "getConfig" || action === "range") {
      if (!VIEW_ROLES.includes(role))
        return Response.json({ error: "Ruxsat yo‘q." }, { status: 403 });
      if (action === "getConfig") {
        if (role === "manager") return Response.json({ error: "Global eksport sozlamalari egasi uchun." }, { status: 403 });
        return await handleGetConfig(service);
      }
      if (action === "range") return await handleRange(service, body, scopedShopId);
      return await handlePreview(service, String(body.business_date || localClock(Date.now()).today), scopedShopId);
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