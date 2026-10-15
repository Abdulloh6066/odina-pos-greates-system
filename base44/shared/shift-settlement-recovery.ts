import { ensureBudgetAccount } from "./supplier-payment-recovery.ts";
import { readReportRows } from "./report-activity.ts";
import { finishServiceTicketCycleIfLastShift } from "./service-ticket-cycle.ts";

const FIELD = "shift_settlement_operations_json";
const fail = (message: string, status = 503) => Object.assign(new Error(message), { status, operation_pending: true });
const operations = (row: any) => {
  if (!row?.[FIELD]) return {};
  try {
    const value = JSON.parse(row[FIELD]);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail("Smena topshirig‘i holatini egasi tekshirishi kerak."); }
};
const predicate = (row: any) => row[FIELD] === undefined ? { $exists: false } : row[FIELD];

export async function creditShiftBudget(service: any, account: string, amount: number,
  label: string, user: any, now: string, operationKey: string) {
  const initial = await ensureBudgetAccount(service, account, label, user);
  const entity = service.entities.BudgetBalance;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await entity.get(initial.id);
    const journal = operations(row);
    const existing = journal[operationKey];
    if (existing) {
      if (existing.actor !== user.id || existing.account !== account || existing.amount !== amount) {
        throw fail("Smena topshirig‘i kaliti boshqa amal uchun ishlatilgan.", 409);
      }
      if (existing.state !== "credited") throw fail("Smena topshirig‘i qaytarilgan. Egasi tekshirishi kerak.", 409);
      return { record: row, before: existing.before, after: existing.after, amount, operationKey };
    }
    const before = Math.round(Number(row.balance) || 0);
    const saved = { actor: user.id, account, amount, before, after: before + amount, state: "credited" };
    journal[operationKey] = saved;
    let result;
    try {
      result = await entity.updateMany(
        { id: row.id, balance: Number(row.balance || 0), [FIELD]: predicate(row),
          shift_settlement_keys: { $nin: [operationKey] } },
        { $inc: { balance: amount }, $push: { shift_settlement_keys: operationKey },
          $set: { [FIELD]: JSON.stringify(journal), updated_at: now,
            updated_by_id: user.id, updated_by_name: user.full_name || user.email } },
      );
    } catch (error) {
      const latest = await entity.get(row.id);
      const confirmed = operations(latest)[operationKey];
      if (confirmed?.actor === user.id && confirmed?.account === account
        && confirmed?.amount === amount && confirmed?.state === "credited") {
        return { record: latest, before: confirmed.before, after: confirmed.after, amount, operationKey };
      }
      throw fail("Budget topshirig‘i javobi noaniq. Mablag‘ni takroran topshirmang.");
    }
    if (result?.success && Number(result.updated) === 1) {
      return { record: { ...row, balance: saved.after }, before, after: saved.after, amount, operationKey };
    }
  }
  throw fail("Budget balansi boshqa operatsiyada o‘zgardi. Egasi tekshirishi kerak.", 409);
}

export async function reverseShiftBudget(service: any, change: any, user: any) {
  if (!change?.record?.id || !change.operationKey) throw fail("Smena topshirig‘ini xavfsiz qaytarib bo‘lmadi.");
  const entity = service.entities.BudgetBalance;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await entity.get(change.record.id);
    const journal = operations(row);
    const operation = journal[change.operationKey];
    if (!operation || operation.actor !== user.id || operation.amount !== change.amount) {
      throw fail("Smena topshirig‘i yozuvi topilmadi.");
    }
    if (operation.state === "reversed") return;
    const reversalKey = `${change.operationKey}-reversed`;
    journal[change.operationKey] = { ...operation, state: "reversed" };
    try {
      const result = await entity.updateMany(
        { id: row.id, [FIELD]: predicate(row), balance: { $gte: operation.amount },
          shift_settlement_keys: { $nin: [reversalKey] } },
        { $inc: { balance: -operation.amount }, $push: { shift_settlement_keys: reversalKey },
          $set: { [FIELD]: JSON.stringify(journal), updated_at: new Date().toISOString(),
            updated_by_id: user.id, updated_by_name: user.full_name || user.email } },
      );
      if (result?.success && Number(result.updated) === 1) return;
    } catch (error) {
      const latest = await entity.get(row.id);
      if (operations(latest)[change.operationKey]?.state === "reversed") return;
      throw fail("Smena topshirig‘ini qaytarish javobi noaniq. Egasi tekshirishi kerak.");
    }
  }
  throw fail("Smena topshirig‘ini qaytarish yakunlanmadi. Keyingi operatsiyalar saqlandi.");
}

export async function savedShiftCloseResponse(service: any, shift: any, runtimeVersion: string) {
  const warnings: string[] = [];
  // A replay must finish the same operational step as a normal successful close.
  // Another open/closing shift keeps its current numbering cycle intact.
  await finishServiceTicketCycleIfLastShift(service, shift.shop_id)
    .catch(() => { warnings.push("Xizmat cheki raqamlash holatini qayta tekshirish kerak."); });
  const results = await Promise.allSettled([
    readReportRows(service.entities.ShiftProductSnapshot, { shift_id: shift.id }, "product_name_snapshot"),
    readReportRows(service.entities.BudgetTransaction, { shift_id: shift.id, type: "shift_deposit", status: "completed" }),
  ]);
  const stockComplete = results[0].status === "fulfilled";
  const budgetComplete = results[1].status === "fulfilled";
  const rows = stockComplete ? (results[0] as PromiseFulfilledResult<any[]>).value : [];
  const transactions = budgetComplete ? (results[1] as PromiseFulfilledResult<any[]>).value : [];
  if (!stockComplete) warnings.push("Yopilishdagi mahsulot qoldig‘i tafsilotlari yuklanmadi. Tarixdan qayta oching.");
  if (!budgetComplete) warnings.push("Budget topshirig‘i tafsilotlari yuklanmadi. Tarixdan qayta tekshiring.");
  const detailsWarning = warnings.length ? "Smena yopilgani va mablag‘lar saqlangani tasdiqlandi. " + warnings.join(" ") : "";
  return Response.json({ runtime_version: runtimeVersion, shift, already_closed: true,
    stock_report: { shift_id: shift.id, shop_id: shift.shop_id, rows,
      complete: stockComplete, ...(stockComplete ? {} : { warning: warnings.find((text) => text.startsWith("Yopilishdagi")) }) },
    budget_transactions: transactions, print_report_required: true,
    details_complete: stockComplete && budgetComplete, budget_transactions_complete: budgetComplete,
    ...(detailsWarning ? { details_warning: detailsWarning } : {}),
    telegram_notification: { sent: false, reason: "saved_closure_replayed" } });
}

// Unknown write replies must retain financial evidence. A fully saved closure is
// returned as success; a partial/unknown settlement remains locked for review.
export async function reconcileShiftCloseFailure(service: any, shiftId: string,
  actorId: string, reference: string, runtimeVersion: string, error: any) {
  const shift = await service.entities.Shift.get(shiftId).catch(() => null);
  if (shift?.user_id === actorId && shift.status === "closed" && shift.budget_settled === true
    && shift.budget_settlement_reference === reference) {
    return savedShiftCloseResponse(service, shift, runtimeVersion);
  }
  if (shift?.user_id === actorId && shift.status === "closing"
    && shift.closing_operation_token === reference) {
    await service.entities.Shift.updateMany(
      { id: shift.id, status: "closing", closing_operation_token: reference },
      { $set: { closing_review_required: true } },
    ).catch(() => {});
  }
  return Response.json({ error: "Smena topshirig‘i natijasi noaniq. Mablag‘ni takroran topshirmang; egasi yozuvlarni tekshirsin.",
    operation_pending: true, review_required: true, runtime_version: runtimeVersion,
    cause: error instanceof Error ? error.message : "Smenani yakunlab bo‘lmadi." }, { status: 503 });
}
