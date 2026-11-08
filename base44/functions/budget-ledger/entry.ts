import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";
import { financialRequestKey, runBudgetAdjustment, runSupplierPayment, ensureBudgetAccount } from "../../shared/supplier-payment-recovery.ts";

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

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const PIN_FAILURE_LIMIT = 5;
const PIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

async function recentPinFailureCount(service: any, actorKey: string) {
  const events = await service.entities.ActionHistory.filter(
    { user_id: actorKey },
    "-created_date",
    20,
  );
  const cutoff = Date.now() - PIN_FAILURE_WINDOW_MS;
  let failures = 0;
  for (const event of events || []) {
    const occurredAt = Date.parse(String(event.created_date || event.created_at || ""));
    if (!Number.isFinite(occurredAt) || occurredAt < cutoff) break;
    if (event.action === "owner_pin_verified" || event.action === "owner_pin_updated") break;
    if (event.action === "owner_pin_failed") failures += 1;
  }
  return failures;
}

async function recordPinAttempt(service: any, actor: any, ok: boolean) {
  await service.entities.ActionHistory.create({
    user_id: String(actor?.id || actor?.email || "unknown"),
    user_name: String(actor?.full_name || actor?.email || "Noma’lum xodim"),
    action: ok ? "owner_pin_verified" : "owner_pin_failed",
    details: ok ? "Himoyalangan amal uchun PIN tasdiqlandi." : "Noto‘g‘ri PIN urinishi bloklandi.",
  });
}

async function verifyOwnerPin(service: any, pinValue: unknown, actor: any) {
  const actorKey = String(actor?.id || actor?.email || "");
  if (!actorKey) return false;
  if (await recentPinFailureCount(service, actorKey) >= PIN_FAILURE_LIMIT) return false;

  const pin = String(pinValue || "");
  if (!/^\d{4,8}$/.test(pin)) {
    await recordPinAttempt(service, actor, false);
    return false;
  }
  const records = await service.entities.SecuritySettings.filter({ key: "owner_approval_pin" });
  const security = records?.[0];
  if (
    !security?.pin_hash ||
    !security?.pin_salt ||
    security.pin_algorithm !== "PBKDF2-SHA256"
  ) return false;

  const configuredIterations = Number(security.pin_iterations || 100000);
  const iterations = Math.min(Math.max(configuredIterations, 100000), 600000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: new TextEncoder().encode(security.pin_salt),
    iterations,
  }, key, 256);
  const verified = constantTimeEqual(hex(new Uint8Array(derived)), String(security.pin_hash));
  await recordPinAttempt(service, actor, verified);
  return verified;
}


function bankCardError(message, status = 503, pending = true) {
  return Object.assign(new Error(message), { status, operation_pending: pending });
}

function readBankCardJournal(row, field) {
  if (!row) throw bankCardError("Moliyaviy yozuv topilmadi.", 404);
  if (!row[field]) return {};
  try {
    const value = JSON.parse(row[field]);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw bankCardError("Moliyaviy amal holatini egasi tekshirishi kerak.");
  }
}

async function updateBankCardState(entity, id, field, key, change) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const row = await entity.get(id);
    const journal = readBankCardJournal(row, field);
    const current = journal[key];
    const next = change(current ? structuredClone(current) : null, row);
    if (!next) return current;
    next.revision = crypto.randomUUID();
    journal[key] = next;
    const query = { id, [field]: row[field] === undefined ? { $exists: false } : row[field] };
    try {
      const result = await entity.updateMany(query, { $set: { [field]: JSON.stringify(journal) } });
      if (result?.success && Number(result.updated) === 1) return next;
    } catch (error) {
      const latest = await entity.get(id);
      if (readBankCardJournal(latest, field)[key]?.revision === next.revision) return next;
      if (Number(error?.status || error?.response?.status) >= 400
        && Number(error?.status || error?.response?.status) < 500) throw error;
    }
  }
  throw bankCardError("Bank card amali bir vaqtda o‘zgardi. Shu so‘rovni tekshiring.");
}

async function bankCardRequestDigest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

// The parent freezes a server-calculated allocation. Each child uses the existing
// durable Budget adjustment engine and its original idempotent recovery protocol.
async function runCombinedBankCardAdjustment(service, user, input, labels) {
  const field = "financial_operations_json";
  const fingerprint = JSON.stringify(["manual_adjustment", user.id, "bank_card",
    input.direction, input.amount, input.description,
    ...(input.expense_category_id ? [input.expense_category_id] : [])]);
  const digest = await bankCardRequestDigest(fingerprint);
  const settings = await service.entities.Settings.list("created_date", 2);
  if (settings.length !== 1) throw bankCardError("Ilova sozlamasini egasi tekshirishi kerak.", 409, false);
  await updateBankCardState(service.entities.Settings, settings[0].id,
    "budget_account_initialization_json", "request:" + input.key, prior => {
      if (prior) {
        if (prior.actor !== user.id || prior.digest !== digest) {
          throw bankCardError("Bu so‘rov kaliti boshqa moliyaviy amal uchun ishlatilgan.", 409, false);
        }
        return null;
      }
      return { actor: user.id, digest };
    });

  const cards = await Promise.all(["uzcard", "humo"].map(account =>
    ensureBudgetAccount(service, account, labels[account], user)));
  const anchor = cards[0];
  const childKeys = await Promise.all(cards.map(async card => ({
    account: card.account,
    key: "bc_" + await bankCardRequestDigest(JSON.stringify([user.id, input.key, card.account, "apply"])),
    reverseKey: "bc_" + await bankCardRequestDigest(JSON.stringify([user.id, input.key, card.account, "reverse"])),
  })));
  let operation = await updateBankCardState(service.entities.BudgetBalance, anchor.id, field, input.key,
    (prior, current) => {
      if (prior) {
        if (prior.actor !== user.id || prior.fingerprint !== fingerprint) {
          throw bankCardError("Bu so‘rov kaliti boshqa Budget amali uchun ishlatilgan.", 409, false);
        }
        return null;
      }
      const available = Number(current.balance || 0) + Number(cards[1].balance || 0);
      if (input.direction === "out" && input.amount > available) {
        throw bankCardError("Bank card hisobida mablag‘ yetarli emas.", 400, false);
      }
      const first = input.direction === "in" ? input.amount
        : Math.min(input.amount, Math.max(0, money(current.balance)));
      const amounts = [first, input.amount - first];
      return {
        actor: user.id, fingerprint, direction: input.direction, amount: input.amount,
        description: input.description, expense_category_id: input.expense_category_id,
        expense_category_name: input.expense_category_name, status: "processing",
        allocations: childKeys.map((part, index) => ({ ...part, amount: amounts[index] }))
          .filter(part => part.amount > 0),
      };
    });

  const saveState = change => updateBankCardState(service.entities.BudgetBalance,
    anchor.id, field, input.key, change);
  const reversed = () => Object.assign(
    bankCardError("Bank card amali bajarilmadi va mablag‘ qaytarildi. Qayta urinib ko‘ring.", 409, false),
    { operation_reversed: true });
  if (operation.status === "reversed") throw reversed();
  if (operation.status === "completed") {
    const transactions = await Promise.all(operation.transaction_ids.map(id =>
      service.entities.BudgetTransaction.get(id)));
    if (transactions.some(transaction => !transaction)) throw bankCardError("Budget tarixi topilmadi.");
    return { transaction: transactions[0], transactions, already_processed: true };
  }

  const compensate = async () => {
    for (const part of operation.allocations) {
      const transactions = await service.entities.BudgetTransaction.filter({
        idempotency_key: part.key, performed_by_id: user.id,
      }, "created_date", 2);
      if (transactions.length > 1) throw bankCardError("Takroriy Budget tarixi topildi.");
      if (!transactions.length) continue;
      const transaction = transactions[0];
      if (transaction.account !== part.account || transaction.amount !== part.amount
        || transaction.direction !== operation.direction) throw bankCardError("Budget tarixi so‘rovga mos emas.");
      await runBudgetAdjustment(service, user, {
        key: part.reverseKey, account: part.account,
        direction: operation.direction === "out" ? "in" : "out",
        amount: part.amount, is_budget_refund: true, description: "Bank card amalini qaytarish · " + operation.description,
        expense_category_id: operation.expense_category_id, expense_category_name: operation.expense_category_name,
      }, labels);
    }
    await saveState(prior => ({ ...prior, status: "reversed" }));
    throw reversed();
  };
  if (operation.compensation_requested) {
    try { return await compensate(); }
    catch (error) {
      if (error.operation_reversed) throw error;
      throw Object.assign(error, { operation_pending: true });
    }
  }

  try {
    const transactions = [];
    for (const part of operation.allocations) {
      const latest = readBankCardJournal(await service.entities.BudgetBalance.get(anchor.id), field)[input.key];
      if (latest.compensation_requested) throw bankCardError("Bank card amali qaytarilmoqda.");
      const result = await runBudgetAdjustment(service, user, {
        key: part.key, account: part.account, direction: operation.direction,
        amount: part.amount, description: operation.description,
        expense_category_id: operation.expense_category_id, expense_category_name: operation.expense_category_name,
      }, labels);
      transactions.push(result.transaction);
    }
    await saveState(prior => {
      if (prior.compensation_requested) throw bankCardError("Bank card amali qaytarilmoqda.");
      return { ...prior, status: "completed", transaction_ids: transactions.map(transaction => transaction.id) };
    });
    return { transaction: transactions[0], transactions, already_processed: false };
  } catch (error) {
    const status = Number(error?.status || error?.response?.status || 0);
    const definite = error.operation_reversed
      || (!error.operation_pending && [400, 403, 404, 422].includes(status));
    if (!definite) throw Object.assign(error, { operation_pending: true });
    operation = await saveState(prior => ({ ...prior, compensation_requested: true }));
    try { return await compensate(); }
    catch (failure) {
      if (failure.operation_reversed) throw failure;
      throw Object.assign(failure, { operation_pending: true });
    }
  }
}

// Fetch every page: report totals must not silently stop at the latest 500 rows.
async function listAll(entity, sort) {
  const rows = [];
  for (let skip = 0; ; skip += 500) {
    const page = await entity.list(sort, 500, skip);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const auth = await base44.auth.me();
    if (!auth) return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });
    const user = await resolveAppUser(service, auth);
    if (user.role !== "admin") {
      return Response.json({ error: "Budget faqat egasi uchun ochiq." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    if (action === "summary") {
      const [balances, transactions, categories] = await Promise.all([
        service.entities.BudgetBalance.list("account", 20),
        listAll(service.entities.BudgetTransaction, "-created_at"),
        listAll(service.entities.BudgetExpenseCategory, "name"),
      ]);
      return Response.json({
        balances: (balances || []).map(({ financial_operations_json: _operations, shift_settlement_operations_json: _settlements, shift_settlement_keys: _keys, ...balance }: any) => balance),
        transactions: transactions || [], categories,
      });
    }

    if (action === "create_expense_category") {
      const name = String(body?.name || "").trim().replace(/\s+/g, " ");
      if (!name || name.length > 80) return Response.json({ error: "Kategoriya nomi 1–80 belgidan iborat bo‘lsin." }, { status: 400 });
      const categories = await listAll(service.entities.BudgetExpenseCategory, "name");
      const existing = categories.find(row => row.name.trim().toLowerCase() === name.toLowerCase());
      const category = existing || await service.entities.BudgetExpenseCategory.create({ name });
      return Response.json({ category });
    }

    if (action === "manual_adjustment") {
      if (!(await verifyOwnerPin(service, body?.owner_pin, user))) {
        return Response.json({ error: "Owner PIN noto‘g‘ri." }, { status: 403 });
      }

      const account = String(body?.account || "");
      const direction = String(body?.direction || "");
      const amount = money(body?.amount);
      const description = String(body?.description || "").trim();
      if ((!ACCOUNTS.has(account) && account !== "bank_card") || !["in", "out"].includes(direction) || !Number.isSafeInteger(amount) || amount <= 0 || description.length < 3) {
        return Response.json({ error: "Hisob, amal, musbat summa va izoh majburiy." }, { status: 400 });
      }

      const categoryId = String(body?.expense_category_id || "");
      let category = null;
      if (categoryId) {
        if (direction !== "out") return Response.json({ error: "Kategoriya faqat chiqim uchun." }, { status: 400 });
        // Existing financial requests must remain recoverable even if a category
        // is renamed or removed. The journal owns the frozen historical snapshot.
        const balances = await service.entities.BudgetBalance.list("account", 20);
        const requestKey = financialRequestKey(body);
        for (const balance of balances) {
          const prior = readBankCardJournal(balance, "financial_operations_json")[requestKey];
          if (prior?.actor === user.id && prior.expense_category_id === categoryId) {
            category = { id: categoryId, name: prior.expense_category_name };
            break;
          }
        }
        if (!category) category = await service.entities.BudgetExpenseCategory.get(categoryId);
        if (!category) return Response.json({ error: "Xarajat kategoriyasi topilmadi." }, { status: 400 });
      }
      const adjust = account === "bank_card" ? runCombinedBankCardAdjustment : runBudgetAdjustment;
      const result = await adjust(service, user, {
        key: financialRequestKey(body), account, direction, amount, description,
        ...(category ? { expense_category_id: category.id, expense_category_name: category.name } : {}),
      }, ACCOUNT_LABELS);
      return Response.json(result);
    }

    if (action === "pay_supplier") {
      if (!(await verifyOwnerPin(service, body?.owner_pin, user))) {
        return Response.json({ error: "Owner PIN noto‘g‘ri." }, { status: 403 });
      }

      const account = String(body?.account || "");
      const supplierId = String(body?.supplier_id || "");
      const amount = money(body?.amount);
      const notes = String(body?.notes || "").trim();
      const targeted = body?.opening_debt_id !== undefined;
      if ((targeted && (typeof body.opening_debt_id !== "string" || !body.opening_debt_id.trim()
        || typeof body.amount !== "number" || !Number.isSafeInteger(body.amount) || notes.length > 2000))
        || (body?.location_id !== undefined && (!targeted || typeof body.location_id !== "string" || !body.location_id.trim()))) {
        return Response.json({ error: "Boshlang‘ich qarz, joylashuv yoki to‘lov ma’lumotlari noto‘g‘ri." }, { status: 400 });
      }
      if (!ACCOUNTS.has(account) || !supplierId || !Number.isSafeInteger(amount) || amount <= 0) {
        return Response.json({ error: "Yetkazib beruvchi, Budget hisobi va musbat summa majburiy." }, { status: 400 });
      }

      const result = await runSupplierPayment(service, user, {
        key: financialRequestKey(body), action, account, supplier_id: supplierId, amount, notes,
        ...(targeted ? { opening_debt_id: body.opening_debt_id,
          ...(body.location_id !== undefined ? { location_id: body.location_id } : {}) } : {}),
      }, ACCOUNT_LABELS);
      return Response.json(result);
    }

    return Response.json({ error: "Noto‘g‘ri amal." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Budget amali bajarilmadi.";
    return Response.json({ error: message,
      operation_pending: Boolean((error as any)?.operation_pending),
      operation_reversed: Boolean((error as any)?.operation_reversed),
      request_not_started: Boolean((error as any)?.request_not_started),
    }, { status: Number((error as any)?.status) || 500 });
  }
}
