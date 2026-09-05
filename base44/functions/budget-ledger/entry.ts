import { createClientFromRequest } from "npm:@base44/sdk";

const ACCOUNTS = new Set(["cash", "uzcard", "humo", "online", "bank"]);
const ACCOUNT_LABELS: Record<string, string> = {
  cash: "Naqd pul",
  uzcard: "Uzcard",
  humo: "Humo",
  online: "Onlayn",
  bank: "Bank",
};

const money = (value: unknown) => Math.round(Number(value) || 0);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function verifyOwnerPin(service: any, pinValue: unknown) {
  const pin = String(pinValue || "");
  if (!/^\d{4,8}$/.test(pin)) return false;
  const records = await service.entities.SecuritySettings.filter({ key: "owner_approval_pin" });
  const security = records?.[0];
  if (!security?.pin_hash || !security?.pin_salt) return false;

  if (security.pin_algorithm === "PBKDF2-SHA256") {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(security.pin_salt),
      iterations: Number(security.pin_iterations || 100000),
    }, key, 256);
    return hex(new Uint8Array(derived)) === security.pin_hash;
  }

  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`${security.pin_salt}:${pin}`),
  );
  return hex(new Uint8Array(digest)) === security.pin_hash;
}

const receiptStatus = (remaining: number, originalDebt: number) => {
  if (remaining <= 0) return "paid";
  if (remaining < originalDebt) return "partial";
  return "unpaid";
};

async function changeBalance(
  service: any,
  account: string,
  delta: number,
  user: any,
  now: string,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await service.entities.BudgetBalance.filter({ account });
    if ((rows || []).length > 1) {
      throw new Error(`${ACCOUNT_LABELS[account]} uchun takroriy Budget balansi topildi.`);
    }

    const current = rows?.[0];
    if (!current) {
      if (delta < 0) throw new Error(`${ACCOUNT_LABELS[account]} balansida pul yetarli emas.`);
      try {
        const created = await service.entities.BudgetBalance.create({
          account,
          label: ACCOUNT_LABELS[account],
          balance: delta,
          updated_at: now,
          updated_by_id: user.id,
          updated_by_name: user.full_name || user.email,
        });
        return { record: created, before: 0, after: delta };
      } catch (_) {
        continue;
      }
    }

    const before = money(current.balance);
    const after = before + delta;
    if (after < 0) {
      throw new Error(
        `${ACCOUNT_LABELS[account]} balansida pul yetarli emas. Mavjud: ${before} UZS.`,
      );
    }

    const update = await service.entities.BudgetBalance.updateMany(
      { id: current.id, balance: Number(current.balance || 0) },
      { $set: {
        balance: after,
        updated_at: now,
        updated_by_id: user.id,
        updated_by_name: user.full_name || user.email,
      } },
    );
    if (update?.success && Number(update.updated || 0) === 1) {
      return { record: { ...current, balance: after }, before, after };
    }
  }

  throw new Error("Budget balansi bir vaqtda o‘zgardi. Yangilab qayta urinib ko‘ring.");
}

async function rollbackBalance(service: any, change: any, user: any) {
  if (!change?.record?.id) return;
  await service.entities.BudgetBalance.updateMany(
    { id: change.record.id, balance: change.after },
    { $set: {
      balance: change.before,
      updated_at: new Date().toISOString(),
      updated_by_id: user.id,
      updated_by_name: user.full_name || user.email,
    } },
  ).catch(() => {});
}

const transactionNumber = (prefix: string, now: string) =>
  `${prefix}-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });
    if (user.role !== "admin") {
      return Response.json({ error: "Budget faqat egasi uchun ochiq." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    if (action === "summary") {
      const [balances, transactions] = await Promise.all([
        service.entities.BudgetBalance.list("account", 20),
        service.entities.BudgetTransaction.list("-created_at", 500),
      ]);
      return Response.json({ balances: balances || [], transactions: transactions || [] });
    }

    if (action === "manual_adjustment") {
      if (!(await verifyOwnerPin(service, body?.owner_pin))) {
        return Response.json({ error: "Owner PIN noto‘g‘ri." }, { status: 403 });
      }

      const account = String(body?.account || "");
      const direction = String(body?.direction || "");
      const amount = money(body?.amount);
      const description = String(body?.description || "").trim();
      if (!ACCOUNTS.has(account) || !["in", "out"].includes(direction) || amount <= 0 || description.length < 3) {
        return Response.json({ error: "Hisob, amal, musbat summa va izoh majburiy." }, { status: 400 });
      }

      const now = new Date().toISOString();
      const delta = direction === "in" ? amount : -amount;
      let balanceChange: any = null;
      try {
        balanceChange = await changeBalance(service, account, delta, user, now);
        const transaction = await service.entities.BudgetTransaction.create({
          transaction_number: transactionNumber(direction === "in" ? "BK" : "BC", now),
          type: direction === "in" ? "manual_deposit" : "manual_withdrawal",
          direction,
          account,
          amount,
          balance_before: balanceChange.before,
          balance_after: balanceChange.after,
          reference_type: "manual_adjustment",
          description,
          performed_by_id: user.id,
          performed_by_name: user.full_name || user.email,
          created_at: now,
          status: "completed",
        });
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: user.full_name || user.email,
          action: direction === "in" ? "budget_manual_deposit" : "budget_manual_withdrawal",
          details: `${ACCOUNT_LABELS[account]} · ${amount} UZS · ${description}`,
        }).catch(() => {});
        return Response.json({ transaction, balance: balanceChange.record });
      } catch (error) {
        await rollbackBalance(service, balanceChange, user);
        throw error;
      }
    }

    if (action === "pay_supplier") {
      if (!(await verifyOwnerPin(service, body?.owner_pin))) {
        return Response.json({ error: "Owner PIN noto‘g‘ri." }, { status: 403 });
      }

      const account = String(body?.account || "");
      const supplierId = String(body?.supplier_id || "");
      const amount = money(body?.amount);
      const notes = String(body?.notes || "").trim();
      if (!ACCOUNTS.has(account) || !supplierId || amount <= 0) {
        return Response.json({ error: "Yetkazib beruvchi, Budget hisobi va musbat summa majburiy." }, { status: 400 });
      }

      const supplier = await service.entities.CashRecipient.get(supplierId);
      if (!supplier || supplier.active === false || !["supplier", "company"].includes(supplier.recipient_type)) {
        return Response.json({ error: "Yetkazib beruvchi topilmadi yoki faol emas." }, { status: 404 });
      }

      const debts = (await service.entities.SupplierReceipt.filter(
        {
          supplier_id: supplier.id,
          remaining_debt: { $gt: 0 },
          status: { $nin: ["cancelled", "cancelling"] },
        },
        "received_at",
        500,
      )) || [];
      const totalDebt = debts.reduce((sum: number, debt: any) => sum + money(debt.remaining_debt), 0);
      if (totalDebt <= 0) {
        return Response.json({ error: "Bu yetkazib beruvchida qarz yo‘q." }, { status: 409 });
      }
      if (amount > totalDebt) {
        return Response.json(
          { error: `To‘lov qolgan qarzdan oshmasligi kerak: ${totalDebt} UZS.` },
          { status: 400 },
        );
      }

      const now = new Date().toISOString();
      const userName = user.full_name || user.email || "Egasi";
      const paymentNumber = transactionNumber("BQ", now);
      let balanceChange: any = null;
      let transaction: any = null;
      let unallocated = amount;
      const changedDebts: any[] = [];
      const payments: any[] = [];

      try {
        balanceChange = await changeBalance(service, account, -amount, user, now);
        transaction = await service.entities.BudgetTransaction.create({
          transaction_number: paymentNumber,
          type: "supplier_payment",
          direction: "out",
          account,
          amount,
          balance_before: balanceChange.before,
          balance_after: balanceChange.after,
          supplier_id: supplier.id,
          supplier_name: supplier.name,
          reference_id: paymentNumber,
          reference_type: "supplier_payment",
          description: notes || `${supplier.name} qarzini to‘lash`,
          performed_by_id: user.id,
          performed_by_name: userName,
          created_at: now,
          status: "completed",
        });

        for (const debt of debts) {
          if (unallocated <= 0) break;
          const before = money(debt.remaining_debt);
          const applied = Math.min(before, unallocated);
          const after = before - applied;
          const update = await service.entities.SupplierReceipt.updateMany(
            { id: debt.id, remaining_debt: before },
            { $set: {
              remaining_debt: after,
              status: receiptStatus(after, money(debt.debt_amount)),
            } },
          );
          if (!update?.success || Number(update.updated || 0) !== 1) {
            throw new Error("Qarz bir vaqtda o‘zgardi. Yangilab qayta urinib ko‘ring.");
          }
          changedDebts.push({ debt, before, after });

          const payment = await service.entities.SupplierPayment.create({
            payment_number: paymentNumber,
            receipt_id: debt.id,
            receipt_number_snapshot: debt.receipt_number,
            supplier_id: supplier.id,
            supplier_name_snapshot: supplier.name,
            amount: applied,
            shop_id: "",
            shop_name_snapshot: `Budget · ${ACCOUNT_LABELS[account]}`,
            shift_id: "",
            cash_movement_id: "",
            payment_source: "budget",
            budget_account: account,
            budget_transaction_id: transaction.id,
            authorized_by_id: user.id,
            authorized_by_name: userName,
            user_id: user.id,
            user_name: userName,
            notes: notes || undefined,
            paid_at: now,
          });
          payments.push(payment);
          unallocated -= applied;
        }

        if (unallocated !== 0) throw new Error("To‘lovni qarzlarga to‘liq taqsimlab bo‘lmadi.");

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "supplier_debt_paid_from_budget",
          details: `${supplier.name} · ${ACCOUNT_LABELS[account]} · ${amount} UZS · ${paymentNumber}`,
        }).catch(() => {});

        return Response.json({
          paid: true,
          payment_number: paymentNumber,
          supplier,
          transaction,
          payments,
          remaining_debt: totalDebt - amount,
          budget_balance: balanceChange.after,
        });
      } catch (error) {
        for (const payment of payments) {
          await service.entities.SupplierPayment.delete(payment.id).catch(() => {});
        }
        for (const change of [...changedDebts].reverse()) {
          await service.entities.SupplierReceipt.updateMany(
            { id: change.debt.id, remaining_debt: change.after },
            { $set: { remaining_debt: change.before, status: change.debt.status } },
          ).catch(() => {});
        }
        if (transaction?.id) {
          await service.entities.BudgetTransaction.delete(transaction.id).catch(() => {});
        }
        await rollbackBalance(service, balanceChange, user);
        throw error;
      }
    }

    return Response.json({ error: "Noto‘g‘ri amal." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Budget amali bajarilmadi.";
    return Response.json({ error: message }, { status: 500 });
  }
}
