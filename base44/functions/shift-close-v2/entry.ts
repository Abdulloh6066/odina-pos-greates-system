import { createClientFromRequest } from "npm:@base44/sdk";
import {
  money, resolveAppUser, httpError, buildShiftStockReport,
  cleanupShiftStockSnapshots, creditBudgetBalance, rollbackBudgetBalance,
} from "../../shared/shift-close-helpers.ts";

const SHIFT_CLOSE_V2_RUNTIME_VERSION = "shift-close-v2-2026-09-15-telegram";
const SHIFT_TELEGRAM_GROUP_ID = "-5570444945";

const formatUzs = (value: unknown) => `${money(value).toLocaleString("en-US")} UZS`;

function formatTashkentDateTime(value: unknown): string {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("uz-UZ", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function buildShiftTelegramText(shift: any, opts: {
  userName: string;
  actualCash: number;
  budgetCashSubmitted: number;
  cashLeftForNextShift: number;
  testMode: boolean;
}): string {
  const title = opts.testMode ? "🧪 TEST · Smena yopildi" : "✅ Smena yopildi";
  const expectedCash = money(shift.expected_cash);
  const difference = opts.actualCash - expectedCash;
  const lines = [
    title,
    `🏪 ${String(shift.shop_name || "Do‘kon")}`,
    `👤 ${String(shift.user_name || opts.userName || "Xodim")}`,
    `🕐 ${formatTashkentDateTime(shift.opened_at)} → ${formatTashkentDateTime(shift.closed_at)}`,
    "",
    `🛒 Savdolar: ${Number(shift.order_count || 0)} ta · ${formatUzs(shift.total_sales)}`,
    `💵 Naqd: ${formatUzs(shift.cash_sales)}`,
    `💳 Uzcard: ${formatUzs(shift.uzcard_sales)}`,
    `💳 Humo: ${formatUzs(shift.humo_sales)}`,
    `📱 Online: ${formatUzs(shift.online_sales)}`,
    `🏦 Bank: ${formatUzs(shift.bank_transfer_sales)}`,
    `↩️ Qaytarish: ${formatUzs(shift.refunds_total)}`,
    `📤 Kassadan chiqim: ${formatUzs(shift.cash_removed)}`,
    "",
    `🧮 Kutilgan naqd: ${formatUzs(expectedCash)}`,
    `✅ Sanalgan naqd: ${formatUzs(opts.actualCash)}`,
    `➗ Farq: ${formatUzs(difference)}`,
    `🏦 Budgetga topshirildi: ${formatUzs(opts.budgetCashSubmitted)}`,
    `💼 Keyingi smenaga qoldi: ${formatUzs(opts.cashLeftForNextShift)}`,
  ];
  return lines.join("\n");
}

export async function sendShiftTelegram(shift: any, opts: {
  userName: string;
  actualCash: number;
  budgetCashSubmitted: number;
  cashLeftForNextShift: number;
  testMode: boolean;
}): Promise<{ sent: boolean; message_id?: number; reason?: string }> {
  const token = (globalThis as any)?.Deno?.env?.get?.("TELEGRAM_BOT_TOKEN") || "";
  if (!token) return { sent: false, reason: "missing_token" };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: SHIFT_TELEGRAM_GROUP_ID,
        text: buildShiftTelegramText(shift, opts),
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) return { sent: false, reason: "telegram_rejected" };
    return { sent: true, message_id: Number(data?.result?.message_id || 0) || undefined };
  } catch {
    return { sent: false, reason: "network_error" };
  }
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    const user = await resolveAppUser(service, authenticatedUser);
    if (user.active === false) {
      return Response.json({ error: "Xodim akkaunti faol emas." }, { status: 403 });
    }
    if (!["admin", "cashier"].includes(user.role)) {
      return Response.json({ error: "Your role cannot close Kassa shifts." }, { status: 403 });
    }

    const body = await req.json();
    const action = String(body?.action || "close_shift");

    if (action === "runtime_status") {
      return Response.json({ ok: true, runtime_version: SHIFT_CLOSE_V2_RUNTIME_VERSION });
    }

    if (action !== "close_shift") {
      return Response.json({ error: "shift-close-v2 only handles close_shift." }, { status: 400 });
    }

    const shiftId = String(body?.shift_id || "");
    const actualCashRaw = Number(body?.actual_cash);
    if (!shiftId || !Number.isFinite(actualCashRaw) || actualCashRaw < 0) {
      return Response.json({ error: "Smena va sanalgan naqd pul to‘g‘ri kiritilishi kerak." }, { status: 400 });
    }
    const actualCash = Math.round(actualCashRaw);
    const hasCashSplit = body?.budget_cash_submitted !== undefined
      || body?.cash_left_for_next_shift !== undefined;
    const submittedRaw = hasCashSplit ? Number(body?.budget_cash_submitted) : actualCash;
    const leftRaw = hasCashSplit ? Number(body?.cash_left_for_next_shift) : 0;
    if (
      !Number.isFinite(submittedRaw)
      || !Number.isFinite(leftRaw)
      || submittedRaw < 0
      || leftRaw < 0
    ) {
      return Response.json({ error: "Budgetga topshirilgan va qoldirilgan naqd pul manfiy bo‘lishi mumkin emas." }, { status: 400 });
    }
    const budgetCashSubmitted = Math.round(submittedRaw);
    const cashLeftForNextShift = Math.round(leftRaw);
    if (budgetCashSubmitted + cashLeftForNextShift !== actualCash) {
      return Response.json({
        error: "Budgetga topshirilgan pul bilan keyingi smenaga qoldirilgan pul yig‘indisi sanalgan naqd pulga teng bo‘lishi kerak.",
      }, { status: 400 });
    }

    const closingShift = await service.entities.Shift.get(shiftId);
    if (!closingShift || closingShift.status !== "open") {
      return Response.json({ error: "Smena ochiq emas yoki allaqachon yopilgan." }, { status: 409 });
    }
    if (closingShift.user_id !== user.id) {
      return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
    }
    const claim = await service.entities.Shift.updateMany(
      { id: closingShift.id, user_id: user.id, status: "open" },
      { $set: { status: "closing" } },
    );
    if (!claim?.success || Number(claim.updated || 0) !== 1) {
      return Response.json({ error: "Smena bir vaqtda o‘zgardi yoki allaqachon yopilmoqda." }, { status: 409 });
    }

    const expected = money(closingShift.expected_cash);
    const closedAt = new Date().toISOString();
    const userName = user.full_name || user.email || "Noma’lum xodim";
    const settlementReference = `SM-${closedAt.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const deposits = [
      { account: "cash", amount: budgetCashSubmitted },
      { account: "uzcard", amount: Math.max(0, money(closingShift.uzcard_sales)) },
      { account: "humo", amount: Math.max(0, money(closingShift.humo_sales)) },
      { account: "online", amount: Math.max(0, money(closingShift.online_sales)) },
      { account: "bank", amount: Math.max(0, money(closingShift.bank_transfer_sales)) },
    ].filter((deposit) => deposit.amount > 0);
    const balanceChanges: any[] = [];
    const budgetTransactions: any[] = [];
    let stockReport: any = null;
    let stockSnapshotPayloads: any[] = [];
    let stockSnapshotSucceeded = false;
    const stockDifferenceQuantity = 0;
    const stockDifferenceProductCount = 0;

    try {
      try {
        stockReport = await buildShiftStockReport(service, closingShift, closedAt);
        stockSnapshotPayloads = stockReport.rows.map((row: any) => ({
          shift_id: closingShift.id,
          shop_id: closingShift.shop_id,
          shop_name: closingShift.shop_name,
          cashier_id: closingShift.user_id,
          cashier_name: closingShift.user_name || userName,
          product_id: row.product_id,
          product_name_snapshot: row.product_name_snapshot,
          image_url_snapshot: row.image_url_snapshot,
          unit: "piece",
          opening_quantity: row.opening_quantity,
          received_quantity: row.received_quantity,
          sold_quantity: row.sold_quantity,
          waste_quantity: row.waste_quantity,
          returned_quantity: row.returned_quantity,
          other_change_quantity: row.other_change_quantity,
          expected_quantity: row.expected_quantity,
          counted_quantity: row.expected_quantity,
          difference: 0,
          counted_by_id: "",
          counted_by_name: "",
          closed_at: closedAt,
        }));
        if (stockSnapshotPayloads.length) {
          await service.entities.ShiftProductSnapshot.bulkCreate(stockSnapshotPayloads);
        }
        stockSnapshotSucceeded = true;
      } catch (stockError) {
        console.warn("Shift stock snapshot skipped:", stockError);
        await cleanupShiftStockSnapshots(service, closingShift.id);
        stockReport = {
          shift_id: closingShift.id,
          shop_id: closingShift.shop_id,
          opened_at: closingShift.opened_at,
          generated_at: closedAt,
          rows: [],
          warning: "Mahsulot qoldig‘i tarixini avtomatik saqlab bo‘lmadi.",
        };
        stockSnapshotPayloads = [];
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "shift_stock_snapshot_skipped",
          details: `${closingShift.shop_name} · smena yopildi, mahsulot qoldig‘i tarixi saqlanmadi · backend ${SHIFT_CLOSE_V2_RUNTIME_VERSION}`,
        }).catch(() => {});
      }

      for (const deposit of deposits) {
        const balanceChange = await creditBudgetBalance(
          service,
          deposit.account,
          deposit.amount,
          user,
          closedAt,
        );
        balanceChanges.push(balanceChange);
        const transaction = await service.entities.BudgetTransaction.create({
          transaction_number: `${settlementReference}-${deposit.account.toUpperCase()}`,
          type: "shift_deposit",
          direction: "in",
          account: deposit.account,
          amount: deposit.amount,
          balance_before: balanceChange.before,
          balance_after: balanceChange.after,
          shift_id: closingShift.id,
          shop_id: closingShift.shop_id,
          shop_name: closingShift.shop_name,
          reference_id: settlementReference,
          reference_type: "shift_settlement",
          description: `${closingShift.shop_name} smenasi · ${deposit.account}`,
          performed_by_id: user.id,
          performed_by_name: userName,
          created_at: closedAt,
          status: "completed",
        });
        budgetTransactions.push(transaction);
      }

      const finalized = await service.entities.Shift.updateMany(
        { id: closingShift.id, status: "closing" },
        { $set: {
          status: "closed",
          closed_at: closedAt,
          actual_cash: actualCash,
          difference: actualCash - expected,
          stock_count_completed: stockSnapshotSucceeded,
          stock_snapshot_count: stockSnapshotPayloads.length,
          stock_difference_quantity: stockDifferenceQuantity,
          stock_difference_product_count: stockDifferenceProductCount,
          budget_settled: true,
          budget_settlement_reference: settlementReference,
          budget_cash_submitted: budgetCashSubmitted,
          cash_left_for_next_shift: cashLeftForNextShift,
          budget_settled_at: closedAt,
          budget_settled_by_id: user.id,
          budget_settled_by_name: userName,
        } },
      );
      if (!finalized?.success || Number(finalized.updated || 0) !== 1) {
        throw httpError("Smenani yakuniy yopib bo‘lmadi.", 409);
      }

      const updated = {
        ...closingShift,
        status: "closed",
        closed_at: closedAt,
        actual_cash: actualCash,
        difference: actualCash - expected,
        stock_count_completed: stockSnapshotSucceeded,
        stock_snapshot_count: stockSnapshotPayloads.length,
        stock_difference_quantity: stockDifferenceQuantity,
        stock_difference_product_count: stockDifferenceProductCount,
        budget_settled: true,
        budget_settlement_reference: settlementReference,
        budget_cash_submitted: budgetCashSubmitted,
        cash_left_for_next_shift: cashLeftForNextShift,
        budget_settled_at: closedAt,
        budget_settled_by_id: user.id,
        budget_settled_by_name: userName,
      };
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: userName,
        action: "shift_closed",
        details: `${closingShift.shop_name} · Budgetga ${budgetCashSubmitted} UZS naqd · qoldirildi ${cashLeftForNextShift} UZS · pul farqi ${actualCash - expected} UZS · tizim qoldig‘i ${stockSnapshotSucceeded ? `${stockSnapshotPayloads.length} tur` : "saqlanmadi"} · backend ${SHIFT_CLOSE_V2_RUNTIME_VERSION}`,
      }).catch(() => {});

      const telegramNotification = await sendShiftTelegram(updated, {
        userName,
        actualCash,
        budgetCashSubmitted,
        cashLeftForNextShift,
        testMode: body?.test_mode === true,
      });
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: userName,
        action: telegramNotification.sent ? "shift_telegram_sent" : "shift_telegram_failed",
        details: telegramNotification.sent
          ? `${closingShift.shop_name} · Telegram message ${telegramNotification.message_id || "ok"}`
          : `${closingShift.shop_name} · Telegram yuborilmadi · ${telegramNotification.reason || "unknown"}`,
      }).catch(() => {});

      return Response.json({
        runtime_version: SHIFT_CLOSE_V2_RUNTIME_VERSION,
        shift: updated,
        stock_report: {
          ...stockReport,
          rows: stockSnapshotPayloads,
        },
        budget_transactions: budgetTransactions,
        telegram_notification: telegramNotification,
        print_report_required: true,
      });
    } catch (error) {
      await cleanupShiftStockSnapshots(service, closingShift.id);
      for (const transaction of [...budgetTransactions].reverse()) {
        await service.entities.BudgetTransaction.delete(transaction.id).catch(() => {});
      }
      for (const balanceChange of [...balanceChanges].reverse()) {
        await rollbackBudgetBalance(service, balanceChange, user);
      }
      await service.entities.Shift.updateMany(
        { id: closingShift.id, status: "closing" },
        { $set: { status: "open" } },
      ).catch(() => {});
      throw error;
    }
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Smenani yopib bo‘lmadi.",
      runtime_version: SHIFT_CLOSE_V2_RUNTIME_VERSION,
    }, { status: Number((error as any)?.status || 500) });
  }
}