// base44/functions/budget-ledger/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk";

// base44/shared/user-helpers.ts
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
    if (!shop || shop.active === false || shop.location_type === "production") {
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

// base44/shared/supplier-opening-debt.ts
async function allOpeningDebts(service, query = {}) {
  const rows = [];
  for (let skip = 0; ; skip += 500) {
    const page = await service.entities.SupplierOpeningDebt.filter(query, "created_date", 500, skip);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

// base44/shared/supplier-payment-recovery.ts
var money = (value) => Math.round(Number(value) || 0);
var JOURNAL = "financial_operations_json";
var SHIFT_JOURNAL = "supplier_payment_operations_json";
var DEBT_JOURNAL = "payment_operations_json";
var INIT_JOURNAL = "budget_account_initialization_json";
var BANK_ACCOUNTS = ["bank", "uzcard", "humo"];
var fail = (message, status = 503, pending = true) => Object.assign(new Error(message), { status, operation_pending: pending });
var missingBankParent = () => fail("Avvalgi Bank amali topilmadi. Egasi tekshirishi kerak.", 409);
var journal = (row, field) => {
  if (!row?.[field]) return {};
  try {
    const parsed = JSON.parse(row[field]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw fail("Moliyaviy operatsiya holatini egasi tekshirishi kerak.");
  }
};
var journalPredicate = (row, field) => row[field] === void 0 ? { $exists: false } : row[field];
var rejected = (error) => [400, 401, 403, 404, 422].includes(
  Number(error?.response?.status || error?.status || 0)
);
function financialRequestKey(body) {
  const key = String(body?.idempotency_key || body?.request_id || "");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw fail("Moliyaviy so\u2018rov kaliti majburiy yoki noto\u2018g\u2018ri.", 400, false);
  }
  return key;
}
async function ensureBudgetAccount(service, account, label, user) {
  const find = async () => {
    const rows = await service.entities.BudgetBalance.filter({ account });
    if (rows.length > 1) throw fail(`${label} uchun takroriy Budget balansi topildi.`, 409);
    return rows[0] || null;
  };
  const found = await find();
  if (found) return found;
  const settings = await service.entities.Settings.list("created_date", 2);
  if (settings.length !== 1) throw fail("Budget hisobini yaratish uchun ilova sozlamasini egasi tekshirishi kerak.", 409);
  const entity = service.entities.Settings;
  const id = settings[0].id;
  const token = crypto.randomUUID();
  let claimed = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await entity.get(id);
    const operations = journal(row, INIT_JOURNAL);
    const prior = operations[account];
    if (prior && prior.status !== "rejected") {
      const existing2 = await find();
      if (existing2) return existing2;
      throw fail("Budget hisobi yaratilmoqda yoki javobi noaniq. Shu amalni qayta tekshiring.");
    }
    operations[account] = { token, status: "creating" };
    const result = await entity.updateMany(
      { id, [INIT_JOURNAL]: journalPredicate(row, INIT_JOURNAL) },
      { $set: { [INIT_JOURNAL]: JSON.stringify(operations) } }
    ).catch(async (error) => {
      const latest = await entity.get(id);
      if (journal(latest, INIT_JOURNAL)[account]?.token === token) return { success: true, updated: 1 };
      throw error;
    });
    if (result?.success && Number(result.updated) === 1) {
      claimed = true;
      break;
    }
  }
  if (!claimed) throw fail("Budget hisobi boshqa oynada yaratilmoqda.");
  const existing = await find();
  if (existing) return existing;
  try {
    return await service.entities.BudgetBalance.create({
      account,
      label,
      balance: 0,
      updated_at: (/* @__PURE__ */ new Date()).toISOString(),
      updated_by_id: user.id,
      updated_by_name: user.full_name || user.email
    });
  } catch (error) {
    const saved = await find();
    if (saved) return saved;
    if (rejected(error)) {
      const row = await entity.get(id);
      const operations = journal(row, INIT_JOURNAL);
      if (operations[account]?.token === token) {
        operations[account].status = "rejected";
        await entity.updateMany(
          { id, [INIT_JOURNAL]: journalPredicate(row, INIT_JOURNAL) },
          { $set: { [INIT_JOURNAL]: JSON.stringify(operations) } }
        );
      }
      throw error;
    }
    throw fail("Budget hisobini yaratish javobi noaniq. Egasi tekshirishi kerak.");
  }
}
async function mutate(entity, id, field, key, change) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const row = await entity.get(id);
    if (!row) throw fail("Moliyaviy yozuv topilmadi.", 404);
    const operations = journal(row, field);
    const original = operations[key];
    const next = original ? structuredClone(original) : null;
    const update = change(next, row);
    if (update?.skip) return { row, operation: original };
    const operation = update.operation || next;
    operation.revision = crypto.randomUUID();
    operations[key] = operation;
    const query = { id, [field]: journalPredicate(row, field), ...update.query || {} };
    const values = { ...update.set || {}, [field]: JSON.stringify(operations) };
    let result;
    try {
      result = await entity.updateMany(query, { $set: values, ...update.inc ? { $inc: update.inc } : {} });
    } catch (error) {
      const saved = await entity.get(id);
      const recorded = journal(saved, field)[key];
      if (recorded?.revision === operation.revision) return { row: saved, operation: recorded };
      if (rejected(error)) throw error;
      continue;
    }
    if (result?.success && Number(result.updated) === 1) {
      const saved = await entity.get(id);
      return { row: saved, operation: journal(saved, field)[key] };
    }
  }
  throw fail("Moliyaviy yozuv bir vaqtda o\u2018zgardi. Shu so\u2018rovni qayta tekshiring.");
}
function own(operation, token) {
  if (!operation || operation.worker !== token) throw fail("Bu to\u2018lov boshqa oynada yakunlanmoqda.");
}
async function claim(source, field, key, fingerprint, actor, create) {
  const token = crypto.randomUUID();
  const initial = journal(await source.entity.get(source.row.id), field)[key];
  if (source.bankWallet && source.bankParentBound && !initial) throw missingBankParent();
  if (initial && (initial.fingerprint !== fingerprint || initial.actor !== actor)) {
    throw fail("Bu so\u2018rov kaliti boshqa to\u2018lov ma\u2019lumotlari uchun ishlatilgan.", 409, false);
  }
  let blueprint = null;
  if (!initial) {
    try {
      blueprint = await create();
    } catch (error) {
      const current = journal(await source.entity.get(source.row.id), field)[key];
      if (!current) throw error;
      if (current.fingerprint !== fingerprint || current.actor !== actor) {
        throw fail("Bu so\u2018rov kaliti boshqa to\u2018lov ma\u2019lumotlari uchun ishlatilgan.", 409, false);
      }
    }
  }
  const result = await mutate(source.entity, source.row.id, field, key, (operation, row) => {
    if (operation) {
      if (operation.fingerprint !== fingerprint || operation.actor !== actor) {
        throw fail("Bu so\u2018rov kaliti boshqa to\u2018lov ma\u2019lumotlari uchun ishlatilgan.", 409, false);
      }
      if (operation.status === "completed") return { skip: true };
      if (operation.status === "reversed") {
        throw Object.assign(fail("To\u2018lov yozilmadi va mablag\u2018 qaytarildi. Yangi so\u2018rov bilan urinib ko\u2018ring.", 409, false), { operation_reversed: true });
      }
      if (operation.worker) throw fail("To\u2018lov yakunlanmoqda. Shu so\u2018rovni qayta tekshiring.");
      operation.worker = token;
      operation.status = "processing";
      return { operation };
    }
    if (source.kind === "shift" && row.status !== "open") {
      throw fail("Smena yopilmoqda yoki yopilgan. Yangi to\u2018lov boshlanmaydi.", 409, false);
    }
    return {
      operation: { ...blueprint, fingerprint, actor, worker: token, status: "processing" },
      query: source.kind === "shift" ? { status: "open" } : {}
    };
  });
  return { ...result, token, already: result.operation.status === "completed" };
}
async function stage(source, field, key, token, values) {
  return mutate(source.entity, source.row.id, field, key, (operation) => {
    own(operation, token);
    Object.assign(operation, values);
    return { operation };
  });
}
async function bankWalletRows(source) {
  const rows = await source.service.entities.BudgetBalance.filter({ account: { $in: BANK_ACCOUNTS } }, "account", 20);
  for (const account of BANK_ACCOUNTS) {
    const matching = rows.filter((row) => row.account === account);
    if (matching.length > 1 || matching.some((row) => !Number.isSafeInteger(Number(row.balance || 0)))) {
      throw fail("Bank qoldig\u2018ini egasi tekshirishi kerak.", 409);
    }
  }
  const total = rows.reduce((sum, row) => sum + Number(row.balance || 0), 0);
  if (!Number.isSafeInteger(total)) throw fail("Bank qoldig\u2018i noto\u2018g\u2018ri.", 409);
  return { rows, total };
}
async function bankWalletPart(source, operation, part, reverse = false) {
  const marker = "bank_source:" + operation.marker;
  return mutate(source.entity, part.id, JOURNAL, marker, (prior, row) => {
    if (row.account !== part.account || !BANK_ACCOUNTS.includes(row.account) || prior && (prior.delta !== part.delta || prior.parent !== operation.marker)) {
      throw fail("Bank operatsiyasi manbasi mos emas.", 409);
    }
    if (reverse && prior?.state !== "applied") {
      if (prior?.state === "reversed") return { skip: true };
      return {
        operation: { parent: operation.marker, delta: part.delta, state: "reversed" },
        query: { account: part.account }
      };
    }
    if (!reverse && prior?.state === "applied") return { skip: true };
    if (!reverse && prior?.state === "reversed") throw fail("Bank operatsiyasi qaytarilmoqda.");
    const before = Number(row.balance || 0);
    const delta = reverse ? -part.delta : part.delta;
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(before + delta)) throw fail("Bank qoldig\u2018i noto\u2018g\u2018ri.", 409);
    if (before + delta < 0) throw fail(reverse ? "Bank qaytarilishi uchun mablag\u2018 yetarli emas. Shu so\u2018rovni tekshiring." : "Bank hisobida mablag\u2018 yetarli emas.", reverse ? 503 : 400, reverse);
    return {
      operation: { parent: operation.marker, delta: part.delta, state: reverse ? "reversed" : "applied" },
      query: { account: part.account, balance: before },
      inc: { balance: delta },
      set: {
        updated_at: (/* @__PURE__ */ new Date()).toISOString(),
        updated_by_id: source.user.id,
        updated_by_name: source.user.full_name || source.user.email
      }
    };
  });
}
async function debitBankWallet(source, field, key, token) {
  let operation = journal(await source.entity.get(source.row.id), field)[key];
  own(operation, token);
  if (operation.source_applied) return { operation };
  if (!operation.bank_parts) {
    const { rows, total } = await bankWalletRows(source);
    const delta = operation.direction === "in" ? operation.amount : -operation.amount;
    if (!Number.isSafeInteger(total + delta) || total + delta < 0) throw fail("Bank hisobida mablag\u2018 yetarli emas.", 400, false);
    const parts = [];
    if (delta > 0) parts.push({ id: source.row.id, account: "bank", delta });
    else {
      let remaining = operation.amount;
      for (const account of BANK_ACCOUNTS) {
        const row = rows.find((row2) => row2.account === account);
        const amount = Math.min(remaining, Math.max(0, Number(row?.balance || 0)));
        if (amount) parts.push({ id: row.id, account, delta: -amount });
        remaining -= amount;
      }
      if (remaining) throw fail("Bank hisobida mablag\u2018 yetarli emas.", 400, false);
    }
    const planned = await stage(source, field, key, token, { bank_parts: parts });
    operation = planned.operation;
  }
  for (const part of operation.bank_parts) await bankWalletPart(source, operation, part);
  return stage(source, field, key, token, { source_applied: true });
}
async function debit(source, field, key, token, user) {
  if (source.bankWallet) return debitBankWallet(source, field, key, token);
  return mutate(source.entity, source.row.id, field, key, (operation, row) => {
    own(operation, token);
    if (operation.source_applied) return { skip: true };
    const column = source.kind === "budget" ? "balance" : "expected_cash";
    const before = money(row[column]);
    const delta = operation.direction === "in" ? operation.amount : -operation.amount;
    if (before + delta < 0) throw fail("Tanlangan hisobda pul yetarli emas.", 400, false);
    if (source.kind === "shift" && row.status !== "open") throw fail("Smena ochiq emas.", 409, false);
    operation.source_applied = true;
    operation.balance_before = before;
    operation.balance_after = before + delta;
    return {
      operation,
      query: { [column]: Number(row[column] || 0), ...source.kind === "shift" ? { status: "open" } : {} },
      inc: { [column]: delta, ...source.kind === "shift" ? { cash_removed: operation.amount } : {} },
      set: source.kind === "budget" ? { updated_at: (/* @__PURE__ */ new Date()).toISOString(), updated_by_id: user.id, updated_by_name: user.full_name || user.email } : {}
    };
  });
}
async function debtDelta(service, allocation, marker, reverse = false) {
  return mutate(
    allocation.opening_debt_id ? service.entities.SupplierOpeningDebt : service.entities.SupplierReceipt,
    allocation.opening_debt_id || allocation.receipt_id,
    DEBT_JOURNAL,
    marker,
    (operation, row) => {
      if (operation?.amount && operation.amount !== allocation.amount) throw fail("Qarz operatsiyasi ma\u2019lumotlari mos emas.", 409);
      if (reverse && operation?.state !== "applied") return { skip: true };
      if (!reverse && operation?.state === "applied") return { skip: true };
      if (!reverse && operation?.state === "reversed") throw fail("Bu qarz operatsiyasi avval qaytarilgan.", 409);
      const targeted = allocation.targeted_opening === true;
      if (!reverse && targeted && (row.supplier_id !== allocation.supplier_id || String(row.location_id || "") !== allocation.location_id)) {
        throw fail("Qarzning qabul qiluvchisi yoki joylashuvi o\u2018zgardi. To\u2018lovni qayta tekshiring.", 409, false);
      }
      const before = money(row.remaining_debt);
      if (["cancelled", "cancelling"].includes(row.status)) throw fail("Kirim bekor qilingan yoki bekor qilinmoqda.", 409, false);
      const after = before + (reverse ? allocation.amount : -allocation.amount);
      if (after < 0) throw fail("Qarz boshqa to\u2018lov bilan o\u2018zgardi. Shu to\u2018lovni tekshiring.", 409, false);
      return {
        operation: { amount: allocation.amount, state: reverse ? "reversed" : "applied" },
        query: {
          remaining_debt: Number(row.remaining_debt || 0),
          status: row.status,
          ...!reverse && targeted ? {
            supplier_id: allocation.supplier_id,
            location_id: row.location_id === void 0 ? { $exists: false } : row.location_id
          } : {}
        },
        inc: { remaining_debt: reverse ? allocation.amount : -allocation.amount },
        set: { status: after <= 0 ? "paid" : after < money(allocation.opening_debt_id ? row.corrected_debt_amount ?? row.debt_amount : row.debt_amount) ? "partial" : "unpaid" }
      };
    }
  );
}
async function ledger(source, field, key, token, stageName, entity, query, data) {
  const existing = await entity.filter(query, "created_date", 2);
  if (existing.length > 1) throw fail("Takroriy to\u2018lov tarixi topildi. Egasi tekshirishi kerak.", 409);
  if (existing[0]) {
    if (existing[0].request_fingerprint !== data().request_fingerprint) throw fail("To\u2018lov tarixi so\u2018rovga mos emas.", 409);
    await stage(source, field, key, token, { [stageName]: "saved" });
    return existing[0];
  }
  const current = journal(await source.entity.get(source.row.id), field)[key];
  own(current, token);
  if (current[stageName] === "creating" || current[stageName] === "uncertain") {
    throw fail("To\u2018lov yozuvi javobi noaniq. Yangi to\u2018lov yubormang; egasi tekshirishi kerak.");
  }
  await stage(source, field, key, token, { [stageName]: "creating" });
  try {
    const saved = await entity.create(data());
    await stage(source, field, key, token, { [stageName]: "saved" });
    return saved;
  } catch (error) {
    const saved = await entity.filter(query, "created_date", 2);
    if (saved.length === 1 && saved[0].request_fingerprint === data().request_fingerprint) {
      await stage(source, field, key, token, { [stageName]: "saved" });
      return saved[0];
    }
    if (rejected(error) && saved.length === 0) {
      await stage(source, field, key, token, { [stageName]: "rejected" });
      throw error;
    }
    await stage(source, field, key, token, { [stageName]: "uncertain" });
    throw fail("To\u2018lov yozuvi javobi noaniq. Shu so\u2018rovni qayta tekshiring.");
  }
}
async function compensate(service, source, field, key, token) {
  await stage(source, field, key, token, { compensation_requested: true });
  const sourceRow = await source.entity.get(source.row.id);
  const operation = journal(sourceRow, field)[key];
  own(operation, token);
  if (source.kind === "shift" && sourceRow.status !== "open") {
    throw fail("To\u2018lov smenasi yopilmoqda yoki yopilgan. Tarixni o\u2018zgartirmasdan egasi tekshirishi kerak.");
  }
  for (const allocation of [...operation.allocations || []].reverse()) {
    await debtDelta(service, allocation, operation.marker, true);
  }
  if (source.bankWallet) {
    for (const part of [...operation.bank_parts || []].reverse()) await bankWalletPart(source, operation, part, true);
    return stage(source, field, key, token, { source_applied: false, status: "reversed", worker: "" });
  }
  return mutate(source.entity, source.row.id, field, key, (current, row) => {
    own(current, token);
    if (source.kind === "shift" && row.status !== "open") {
      throw fail("To\u2018lov smenasi yopilmoqda yoki yopilgan. Egasi tekshirishi kerak.");
    }
    const applied = current.source_applied;
    current.source_applied = false;
    current.status = "reversed";
    current.worker = "";
    return {
      operation: current,
      query: source.kind === "shift" ? { status: "open" } : applied && current.direction === "in" ? { balance: { $gte: current.amount } } : {},
      inc: !applied ? {} : source.kind === "budget" ? { balance: current.direction === "in" ? -current.amount : current.amount } : { expected_cash: current.amount, cash_removed: -current.amount }
    };
  });
}
async function resumeCompensation(service, source, field, key, claimed) {
  if (!claimed.operation.compensation_requested || claimed.already) return;
  try {
    await compensate(service, source, field, key, claimed.token);
  } catch {
    await release(source, field, key, claimed.token).catch(() => {
    });
    throw fail("To\u2018lovni qaytarish yakunlanmadi. Shu so\u2018rovni tekshiring.");
  }
  throw Object.assign(fail("To\u2018lov yozilmadi va mablag\u2018 qaytarildi. Yangi so\u2018rov bilan urinib ko\u2018ring.", 409, false), {
    operation_reversed: true
  });
}
async function release(source, field, key, token) {
  await mutate(source.entity, source.row.id, field, key, (operation) => {
    if (!operation || operation.worker !== token || operation.status === "completed") return { skip: true };
    operation.worker = "";
    operation.status = "pending";
    return { operation };
  });
}
var paymentNumber = (prefix) => `${prefix}-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
async function requestDigest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function claimRequestScope(service, key, fingerprint, actor, bankParent) {
  const settings = await service.entities.Settings.list("created_date", 2);
  if (settings.length !== 1) throw fail("Moliyaviy so\u2018rov uchun ilova sozlamasini egasi tekshirishi kerak.", 409, false);
  const digest = await requestDigest(fingerprint);
  const bankParentDigest = bankParent ? await requestDigest(JSON.stringify([bankParent.id, bankParent.marker])) : "";
  const result = await mutate(service.entities.Settings, settings[0].id, INIT_JOURNAL, `request:${key}`, (operation) => {
    if (operation) {
      if (operation.actor !== actor || operation.digest !== digest) {
        throw fail("Bu so\u2018rov kaliti boshqa moliyaviy amal uchun ishlatilgan.", 409, false);
      }
      if (bankParentDigest) {
        if (operation.bank_parent && operation.bank_parent !== bankParentDigest) throw missingBankParent();
        if (!operation.bank_parent) return { operation: { ...operation, bank_parent: bankParentDigest } };
      }
      return { skip: true };
    }
    return { operation: { actor, digest, ...bankParentDigest ? { bank_parent: bankParentDigest } : {} } };
  });
  return result.operation;
}
async function budgetSource(service, user, input, labels, fingerprint) {
  const key = input.key;
  const balances = await service.entities.BudgetBalance.list("account", 20);
  for (const balance of balances) {
    const prior = journal(balance, JOURNAL)[key];
    if (prior && (prior.actor !== user.id || prior.fingerprint !== fingerprint)) throw fail("Bu so\u2018rov kaliti boshqa Budget amali uchun ishlatilgan.", 409, false);
  }
  const guard = await claimRequestScope(service, key, fingerprint, user.id);
  const bankWallet = input.account === "bank_all";
  const bankParentBound = bankWallet && Boolean(guard.bank_parent);
  let row;
  if (bankParentBound) {
    const current = await service.entities.BudgetBalance.filter({ account: "bank" });
    if (current.length !== 1) throw missingBankParent();
    row = current[0];
  } else row = await ensureBudgetAccount(service, bankWallet ? "bank" : input.account, labels[input.account], user);
  return { row, entity: service.entities.BudgetBalance, kind: "budget", service, user, bankWallet, bankParentBound };
}
async function bindBankWalletRequest(source, field, key, claimed) {
  if (!source.bankWallet) return;
  try {
    const { marker, fingerprint, actor } = claimed.operation;
    if (typeof marker !== "string" || !marker) throw missingBankParent();
    await claimRequestScope(source.service, key, fingerprint, actor, { id: source.row.id, marker });
  } catch (error) {
    if (!claimed.already) await release(source, field, key, claimed.token).catch(() => {
    });
    throw error;
  }
}
async function runBudgetAdjustment(service, user, input, labels) {
  const key = input.key;
  const fingerprint = JSON.stringify([
    "manual_adjustment",
    user.id,
    input.account,
    input.direction,
    input.amount,
    input.description,
    ...input.expense_category_id ? [input.expense_category_id] : []
  ]);
  const source = await budgetSource(service, user, input, labels, fingerprint);
  const { row } = source;
  const claimed = await claim(source, JOURNAL, key, fingerprint, user.id, async () => ({
    ...input,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    payment_number: paymentNumber(input.direction === "in" ? "BK" : "BC"),
    marker: crypto.randomUUID()
  }));
  const token = claimed.token;
  await bindBankWalletRequest(source, JOURNAL, key, claimed);
  await resumeCompensation(service, source, JOURNAL, key, claimed);
  try {
    if (!claimed.already) await debit(source, JOURNAL, key, token, user);
    const operation = journal(await source.entity.get(row.id), JOURNAL)[key];
    const query = { idempotency_key: key, performed_by_id: user.id };
    let transaction;
    if (claimed.already) transaction = (await service.entities.BudgetTransaction.filter(query, "created_date", 2))[0];
    else transaction = await ledger(source, JOURNAL, key, token, "transaction", service.entities.BudgetTransaction, query, () => ({
      transaction_number: operation.payment_number,
      type: input.direction === "in" ? "manual_deposit" : "manual_withdrawal",
      direction: input.direction,
      account: source.bankWallet ? "bank" : input.account,
      amount: input.amount,
      // Different physical writers can interleave; the pooled plan does not
      // claim an exact combined running balance in immutable history.
      ...!source.bankWallet ? { balance_before: operation.balance_before, balance_after: operation.balance_after } : {},
      reference_type: operation.is_budget_refund ? "manual_adjustment_reversal" : "manual_adjustment",
      description: input.description,
      performed_by_id: user.id,
      ...operation.expense_category_id ? {
        expense_category_id: operation.expense_category_id,
        expense_category_name: operation.expense_category_name
      } : {},
      performed_by_name: user.full_name || user.email,
      created_at: operation.created_at,
      status: "completed",
      idempotency_key: key,
      request_fingerprint: fingerprint
    }));
    if (!transaction) throw fail("Budget tarixi topilmadi. Egasi tekshirishi kerak.");
    if (!claimed.already) {
      await stage(source, JOURNAL, key, token, { status: "completed", worker: "" });
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: user.full_name || user.email,
        action: input.direction === "in" ? "budget_manual_deposit" : "budget_manual_withdrawal",
        details: `${labels[input.account]} \xB7 ${input.amount} UZS \xB7 ${input.description}`
      }).catch(() => {
      });
    }
    const balance = await source.entity.get(row.id);
    return {
      transaction,
      balance: source.bankWallet ? { ...balance, balance: (await bankWalletRows(source)).total } : balance,
      already_processed: claimed.already
    };
  } catch (error) {
    const recorded = await service.entities.BudgetTransaction.filter({ idempotency_key: key, performed_by_id: user.id }, "created_date", 1).catch(() => null);
    if (rejected(error) && recorded && recorded.length === 0) {
      try {
        await compensate(service, source, JOURNAL, key, token);
        throw Object.assign(error, { operation_pending: false, operation_reversed: true });
      } catch (rollbackError) {
        if (rollbackError?.operation_reversed) throw rollbackError;
        await release(source, JOURNAL, key, token).catch(() => {
        });
        throw fail("Budget qaytarilishi yakunlanmadi. Shu so\u2018rovni tekshiring.");
      }
    }
    await release(source, JOURNAL, key, token).catch(() => {
    });
    throw Object.assign(error, { operation_pending: true });
  }
}
async function supplierPaymentDebts(service, user, options = {}) {
  const supplier = options.supplier_id ? { supplier_id: options.supplier_id } : {};
  const payable = { ...supplier, remaining_debt: { $gt: 0 }, status: { $nin: ["cancelled", "cancelling"] } };
  const receipts = [];
  for (let skip = 0; ; skip += 500) {
    const page = await service.entities.SupplierReceipt.filter({
      ...payable,
      ...user.role === "manager" ? { location_id: user.shop_id } : {}
    }, "received_at", 500, skip);
    receipts.push(...page);
    if (page.length < 500) break;
  }
  const includeOpening = options.budget ? user.role === "admin" : ["admin", "manager", "cashier"].includes(user.role);
  const opening = includeOpening ? await allOpeningDebts(service, payable) : [];
  return [...opening.map((debt) => ({ ...debt, opening_debt_id: debt.id })), ...receipts];
}
async function runSupplierPayment(service, user, input, labels = {}) {
  const budget = input.action === "pay_supplier";
  const targeted = input.opening_debt_id !== void 0;
  const notStarted = (message, status = 400) => Object.assign(fail(message, status, false), { request_not_started: true });
  if (targeted && (!budget || user.role !== "admin" || user.active === false)) {
    throw fail("Boshlang\u2018ich qarzni faqat egasi Budget orqali to\u2018laydi.", 403, false);
  }
  if (targeted && (typeof input.opening_debt_id !== "string" || !input.opening_debt_id.trim() || typeof input.amount !== "number" || !Number.isSafeInteger(input.amount) || input.amount <= 0) || input.location_id !== void 0 && (!targeted || typeof input.location_id !== "string" || !input.location_id.trim())) {
    throw fail("Boshlang\u2018ich qarz, joylashuv yoki to\u2018lov summasi noto\u2018g\u2018ri.", 400, false);
  }
  const field = budget ? JOURNAL : SHIFT_JOURNAL;
  const key = input.key;
  const fingerprint = JSON.stringify([
    input.action,
    user.id,
    input.supplier_id,
    input.shift_id || "",
    input.account || "",
    input.amount,
    input.notes,
    ...targeted ? ["opening_debt", input.opening_debt_id, input.location_id || ""] : []
  ]);
  let source;
  if (budget) {
    source = await budgetSource(service, user, input, labels, fingerprint);
  } else {
    const row2 = await service.entities.Shift.get(input.shift_id);
    if (!row2 || row2.user_id !== user.id) throw fail("Bu smena boshqa xodimga tegishli yoki topilmadi.", 403, false);
    if (["cashier", "manager"].includes(user.role) && user.shop_id !== row2.shop_id) throw fail("Bu smena boshqa do\u2018konga tegishli.", 403, false);
    await claimRequestScope(service, key, fingerprint, user.id);
    source = { row: row2, entity: service.entities.Shift, kind: "shift", service, user, bankWallet: false, bankParentBound: false };
  }
  const { row } = source;
  const claimed = await claim(source, field, key, fingerprint, user.id, async () => {
    if (!budget && row.status !== "open") throw fail("Smena ochiq emas.", 409, false);
    const supplier = await service.entities.CashRecipient.get(input.supplier_id);
    if (!supplier || supplier.active === false || budget && !["supplier", "company"].includes(supplier.recipient_type)) throw fail("Yetkazib beruvchi topilmadi yoki faol emas.", 404, false);
    let selected;
    if (targeted) {
      selected = await service.entities.SupplierOpeningDebt.get(input.opening_debt_id);
      if (!selected || selected.supplier_id !== supplier.id) throw notStarted("Tanlangan boshlang\u2018ich qarz bu qabul qiluvchiga tegishli emas.", 404);
      if (input.location_id !== void 0 && selected.location_id !== input.location_id) {
        throw notStarted("Tanlangan qarz bu joylashuvga tegishli emas.", 409);
      }
      if (["cancelled", "cancelling"].includes(selected.status)) throw notStarted("Tanlangan boshlang\u2018ich qarz bekor qilingan.", 409);
    }
    const debts = targeted ? [{ ...selected, opening_debt_id: selected.id }] : await supplierPaymentDebts(service, user, { supplier_id: supplier.id, budget });
    const total = debts.reduce((sum, receipt) => sum + money(receipt.remaining_debt), 0);
    if (input.amount > total || total <= 0) throw targeted ? notStarted(`To\u2018lov tanlangan qarzdan oshmasligi kerak: ${total} UZS.`) : fail(`To\u2018lov qolgan qarzdan oshmasligi kerak: ${total} UZS.`, 400, false);
    let remaining = input.amount;
    const allocations = [];
    for (const receipt of debts) {
      if (remaining <= 0) break;
      const amount = Math.min(money(receipt.remaining_debt), remaining);
      allocations.push(receipt.opening_debt_id ? {
        opening_debt_id: receipt.id,
        opening_debt_number: receipt.debt_number,
        amount,
        targeted_opening: true,
        supplier_id: supplier.id,
        location_id: String(receipt.location_id || "")
      } : { receipt_id: receipt.id, receipt_number: receipt.receipt_number, amount });
      remaining -= amount;
    }
    return {
      ...input,
      direction: "out",
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      supplier: { id: supplier.id, name: supplier.name },
      shop_id: targeted ? String(selected.location_id || "") : budget ? "" : row.shop_id,
      shop_name: targeted ? String(selected.location_name_snapshot || "") : budget ? `Budget \xB7 ${labels[input.account]}` : row.shop_name,
      payment_number: paymentNumber(budget ? "BQ" : "QT"),
      allocations,
      marker: crypto.randomUUID()
    };
  });
  const token = claimed.token;
  await bindBankWalletRequest(source, field, key, claimed);
  await resumeCompensation(service, source, field, key, claimed);
  try {
    if (!claimed.already) await debit(source, field, key, token, user);
    const operation = journal(await source.entity.get(row.id), field)[key];
    if (!claimed.already) {
      for (const allocation of operation.allocations) {
        await debtDelta(service, allocation, operation.marker);
      }
    }
    const query = { idempotency_key: key, user_id: user.id };
    let sourceLedger;
    const sourceEntity = budget ? service.entities.BudgetTransaction : service.entities.CashMovement;
    const sourceQuery = budget ? { idempotency_key: key, performed_by_id: user.id } : { ...query, shift_id: row.id };
    if (claimed.already) sourceLedger = (await sourceEntity.filter(sourceQuery, "created_date", 2))[0];
    else sourceLedger = await ledger(source, field, key, token, "source_ledger", sourceEntity, sourceQuery, () => budget ? {
      transaction_number: operation.payment_number,
      type: "supplier_payment",
      direction: "out",
      account: source.bankWallet ? "bank" : input.account,
      amount: input.amount,
      ...!source.bankWallet ? { balance_before: operation.balance_before, balance_after: operation.balance_after } : {},
      supplier_id: operation.supplier.id,
      supplier_name: operation.supplier.name,
      reference_id: operation.payment_number,
      ...targeted ? { shop_id: operation.shop_id, shop_name: operation.shop_name } : {},
      reference_type: "supplier_payment",
      description: input.notes || `${operation.supplier.name} qarzini to\u2018lash`,
      performed_by_id: user.id,
      performed_by_name: user.full_name || user.email,
      created_at: operation.created_at,
      status: "completed",
      idempotency_key: key,
      request_fingerprint: fingerprint
    } : {
      shift_id: row.id,
      shop_id: operation.shop_id,
      user_id: user.id,
      user_name: user.full_name || user.email,
      employee_name: user.full_name || user.email || "Noma\u2019lum xodim",
      type: "withdrawal",
      expense_category: "goods_payment",
      recipient_id: operation.supplier.id,
      recipient_name_snapshot: operation.supplier.name,
      amount: input.amount,
      reason: input.notes || `${operation.supplier.name} qarzini to\u2018lash`,
      reference_id: operation.payment_number,
      reference_type: "supplier_payment",
      created_at: operation.created_at,
      idempotency_key: key,
      request_fingerprint: fingerprint
    });
    if (!sourceLedger) throw fail("To\u2018lovning pul tarixi topilmadi. Egasi tekshirishi kerak.");
    const payments = [];
    for (let index = 0; index < operation.allocations.length; index += 1) {
      const allocation = operation.allocations[index];
      const paymentQuery = { ...query, ...allocation.opening_debt_id ? { opening_debt_id: allocation.opening_debt_id } : { receipt_id: allocation.receipt_id } };
      let payment;
      if (claimed.already) payment = (await service.entities.SupplierPayment.filter(paymentQuery, "created_date", 2))[0];
      else payment = await ledger(source, field, key, token, `payment_${index}`, service.entities.SupplierPayment, paymentQuery, () => ({
        payment_number: operation.payment_number,
        receipt_id: allocation.receipt_id || "",
        ...allocation.opening_debt_id ? {
          debt_type: "opening",
          opening_debt_id: allocation.opening_debt_id,
          opening_debt_number_snapshot: allocation.opening_debt_number
        } : {},
        receipt_number_snapshot: allocation.receipt_number,
        supplier_id: operation.supplier.id,
        supplier_name_snapshot: operation.supplier.name,
        amount: allocation.amount,
        shop_id: operation.shop_id,
        shop_name_snapshot: operation.shop_name,
        shift_id: budget ? "" : row.id,
        cash_movement_id: budget ? "" : sourceLedger.id,
        payment_source: budget ? "budget" : "shift_cash",
        ...budget ? { budget_account: source.bankWallet ? "bank" : input.account, budget_transaction_id: sourceLedger.id, authorized_by_id: user.id, authorized_by_name: user.full_name || user.email } : {},
        user_id: user.id,
        user_name: user.full_name || user.email,
        notes: input.notes || void 0,
        paid_at: operation.created_at,
        idempotency_key: key,
        request_fingerprint: fingerprint
      }));
      if (!payment) throw fail("Qarz to\u2018lovi tarixi topilmadi. Egasi tekshirishi kerak.");
      payments.push(payment);
    }
    if (!claimed.already) {
      await stage(source, field, key, token, { status: "completed", worker: "" });
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: user.full_name || user.email,
        action: budget ? "supplier_debt_paid_from_budget" : "supplier_debt_paid",
        details: `${operation.payment_number}. ${operation.supplier.name}. ${operation.shop_name}. ${input.amount} UZS.`
      }).catch(() => {
      });
    }
    const remainingDebts = await supplierPaymentDebts(service, user, { supplier_id: input.supplier_id, budget });
    const remaining = remainingDebts.reduce((sum, debt) => sum + money(debt.remaining_debt), 0);
    const latest = await source.entity.get(row.id);
    const selected = targeted ? await service.entities.SupplierOpeningDebt.get(operation.opening_debt_id) : null;
    if (targeted && (!selected || sourceLedger.request_fingerprint !== fingerprint || payments.length !== 1 || payments[0].opening_debt_id !== operation.opening_debt_id || payments[0].request_fingerprint !== fingerprint || payments[0].amount !== operation.amount)) {
      throw fail("Tanlangan qarzning to\u2018lov tarixi tasdiqlanmadi. Shu so\u2018rovni tekshiring.");
    }
    return {
      paid: true,
      payment_number: operation.payment_number,
      supplier: operation.supplier,
      payments,
      remaining_debt: remaining,
      already_processed: claimed.already,
      ...targeted ? {
        opening_debt_id: operation.opening_debt_id,
        amount: operation.amount,
        account: operation.account,
        location_id: operation.shop_id,
        opening_remaining_debt: selected.remaining_debt
      } : {},
      ...budget ? { transaction: sourceLedger, budget_balance: source.bankWallet ? (await bankWalletRows(source)).total : latest.balance } : { cash_movement: sourceLedger, shift: latest }
    };
  } catch (error) {
    const sourceEntity = budget ? service.entities.BudgetTransaction : service.entities.CashMovement;
    const query = budget ? { idempotency_key: key, performed_by_id: user.id } : { idempotency_key: key, user_id: user.id, shift_id: row.id };
    const recorded = await sourceEntity.filter(query, "created_date", 1).catch(() => null);
    if ((rejected(error) || error?.operation_pending === false) && recorded && recorded.length === 0) {
      try {
        await compensate(service, source, field, key, token);
        throw Object.assign(error, { operation_pending: false, operation_reversed: true });
      } catch (rollbackError) {
        if (rollbackError?.operation_reversed) throw rollbackError;
        await release(source, field, key, token).catch(() => {
        });
        throw fail("To\u2018lovni qaytarish yakunlanmadi. Shu so\u2018rovni tekshiring.");
      }
    }
    await release(source, field, key, token).catch(() => {
    });
    throw Object.assign(error, { operation_pending: true });
  }
}

// base44/functions/budget-ledger/entry.ts
var ACCOUNTS = /* @__PURE__ */ new Set(["cash", "uzcard", "humo", "online", "bank"]);
var ACCOUNT_LABELS = {
  cash: "Naqd pul",
  uzcard: "Uzcard",
  humo: "Humo",
  online: "Onlayn",
  bank: "Bank",
  bank_all: "Bank"
};
var money2 = (value) => Math.round(Number(value) || 0);
var hex = (bytes) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
var constantTimeEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};
var PIN_FAILURE_LIMIT = 5;
var PIN_FAILURE_WINDOW_MS = 15 * 60 * 1e3;
async function recentPinFailureCount(service, actorKey) {
  const events = await service.entities.ActionHistory.filter(
    { user_id: actorKey },
    "-created_date",
    20
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
async function recordPinAttempt(service, actor, ok) {
  await service.entities.ActionHistory.create({
    user_id: String(actor?.id || actor?.email || "unknown"),
    user_name: String(actor?.full_name || actor?.email || "Noma\u2019lum xodim"),
    action: ok ? "owner_pin_verified" : "owner_pin_failed",
    details: ok ? "Himoyalangan amal uchun PIN tasdiqlandi." : "Noto\u2018g\u2018ri PIN urinishi bloklandi."
  });
}
async function verifyOwnerPin(service, pinValue, actor) {
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
  if (!security?.pin_hash || !security?.pin_salt || security.pin_algorithm !== "PBKDF2-SHA256") return false;
  const configuredIterations = Number(security.pin_iterations || 1e5);
  const iterations = Math.min(Math.max(configuredIterations, 1e5), 6e5);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: new TextEncoder().encode(security.pin_salt),
    iterations
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
    const journal2 = readBankCardJournal(row, field);
    const current = journal2[key];
    const next = change(current ? structuredClone(current) : null, row);
    if (!next) return current;
    next.revision = crypto.randomUUID();
    journal2[key] = next;
    const query = { id, [field]: row[field] === void 0 ? { $exists: false } : row[field] };
    try {
      const result = await entity.updateMany(query, { $set: { [field]: JSON.stringify(journal2) } });
      if (result?.success && Number(result.updated) === 1) return next;
    } catch (error) {
      const latest = await entity.get(id);
      if (readBankCardJournal(latest, field)[key]?.revision === next.revision) return next;
      if (Number(error?.status || error?.response?.status) >= 400 && Number(error?.status || error?.response?.status) < 500) throw error;
    }
  }
  throw bankCardError("Bank card amali bir vaqtda o\u2018zgardi. Shu so\u2018rovni tekshiring.");
}
async function bankCardRequestDigest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function runCombinedBankCardAdjustment(service, user, input, labels) {
  const field = "financial_operations_json";
  const fingerprint = JSON.stringify([
    "manual_adjustment",
    user.id,
    "bank_card",
    input.direction,
    input.amount,
    input.description,
    ...input.expense_category_id ? [input.expense_category_id] : []
  ]);
  const digest = await bankCardRequestDigest(fingerprint);
  const settings = await service.entities.Settings.list("created_date", 2);
  if (settings.length !== 1) throw bankCardError("Ilova sozlamasini egasi tekshirishi kerak.", 409, false);
  await updateBankCardState(
    service.entities.Settings,
    settings[0].id,
    "budget_account_initialization_json",
    "request:" + input.key,
    (prior) => {
      if (prior) {
        if (prior.actor !== user.id || prior.digest !== digest) {
          throw bankCardError("Bu so\u2018rov kaliti boshqa moliyaviy amal uchun ishlatilgan.", 409, false);
        }
        return null;
      }
      return { actor: user.id, digest };
    }
  );
  const cards = await Promise.all(["uzcard", "humo"].map((account) => ensureBudgetAccount(service, account, labels[account], user)));
  const anchor = cards[0];
  const childKeys = await Promise.all(cards.map(async (card) => ({
    account: card.account,
    key: "bc_" + await bankCardRequestDigest(JSON.stringify([user.id, input.key, card.account, "apply"])),
    reverseKey: "bc_" + await bankCardRequestDigest(JSON.stringify([user.id, input.key, card.account, "reverse"]))
  })));
  let operation = await updateBankCardState(
    service.entities.BudgetBalance,
    anchor.id,
    field,
    input.key,
    (prior, current) => {
      if (prior) {
        if (prior.actor !== user.id || prior.fingerprint !== fingerprint) {
          throw bankCardError("Bu so\u2018rov kaliti boshqa Budget amali uchun ishlatilgan.", 409, false);
        }
        return null;
      }
      const available = Number(current.balance || 0) + Number(cards[1].balance || 0);
      if (input.direction === "out" && input.amount > available) {
        throw bankCardError("Bank card hisobida mablag\u2018 yetarli emas.", 400, false);
      }
      const first = input.direction === "in" ? input.amount : Math.min(input.amount, Math.max(0, money2(current.balance)));
      const amounts = [first, input.amount - first];
      return {
        actor: user.id,
        fingerprint,
        direction: input.direction,
        amount: input.amount,
        description: input.description,
        expense_category_id: input.expense_category_id,
        expense_category_name: input.expense_category_name,
        status: "processing",
        allocations: childKeys.map((part, index) => ({ ...part, amount: amounts[index] })).filter((part) => part.amount > 0)
      };
    }
  );
  const saveState = (change) => updateBankCardState(
    service.entities.BudgetBalance,
    anchor.id,
    field,
    input.key,
    change
  );
  const reversed = () => Object.assign(
    bankCardError("Bank card amali bajarilmadi va mablag\u2018 qaytarildi. Qayta urinib ko\u2018ring.", 409, false),
    { operation_reversed: true }
  );
  if (operation.status === "reversed") throw reversed();
  if (operation.status === "completed") {
    const transactions = await Promise.all(operation.transaction_ids.map((id) => service.entities.BudgetTransaction.get(id)));
    if (transactions.some((transaction) => !transaction)) throw bankCardError("Budget tarixi topilmadi.");
    return { transaction: transactions[0], transactions, already_processed: true };
  }
  const compensate2 = async () => {
    for (const part of operation.allocations) {
      const transactions = await service.entities.BudgetTransaction.filter({
        idempotency_key: part.key,
        performed_by_id: user.id
      }, "created_date", 2);
      if (transactions.length > 1) throw bankCardError("Takroriy Budget tarixi topildi.");
      if (!transactions.length) continue;
      const transaction = transactions[0];
      if (transaction.account !== part.account || transaction.amount !== part.amount || transaction.direction !== operation.direction) throw bankCardError("Budget tarixi so\u2018rovga mos emas.");
      await runBudgetAdjustment(service, user, {
        key: part.reverseKey,
        account: part.account,
        direction: operation.direction === "out" ? "in" : "out",
        amount: part.amount,
        is_budget_refund: true,
        description: "Bank card amalini qaytarish \xB7 " + operation.description,
        expense_category_id: operation.expense_category_id,
        expense_category_name: operation.expense_category_name
      }, labels);
    }
    await saveState((prior) => ({ ...prior, status: "reversed" }));
    throw reversed();
  };
  if (operation.compensation_requested) {
    try {
      return await compensate2();
    } catch (error) {
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
        key: part.key,
        account: part.account,
        direction: operation.direction,
        amount: part.amount,
        description: operation.description,
        expense_category_id: operation.expense_category_id,
        expense_category_name: operation.expense_category_name
      }, labels);
      transactions.push(result.transaction);
    }
    await saveState((prior) => {
      if (prior.compensation_requested) throw bankCardError("Bank card amali qaytarilmoqda.");
      return { ...prior, status: "completed", transaction_ids: transactions.map((transaction) => transaction.id) };
    });
    return { transaction: transactions[0], transactions, already_processed: false };
  } catch (error) {
    const status = Number(error?.status || error?.response?.status || 0);
    const definite = error.operation_reversed || !error.operation_pending && [400, 403, 404, 422].includes(status);
    if (!definite) throw Object.assign(error, { operation_pending: true });
    operation = await saveState((prior) => ({ ...prior, compensation_requested: true }));
    try {
      return await compensate2();
    } catch (failure) {
      if (failure.operation_reversed) throw failure;
      throw Object.assign(failure, { operation_pending: true });
    }
  }
}
async function listAll(entity, sort) {
  const rows = [];
  for (let skip = 0; ; skip += 500) {
    const page = await entity.list(sort, 500, skip);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}
async function entry_default(req) {
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
        listAll(service.entities.BudgetExpenseCategory, "name")
      ]);
      return Response.json({
        balances: (balances || []).map(({ financial_operations_json: _operations, shift_settlement_operations_json: _settlements, shift_settlement_keys: _keys, ...balance }) => balance),
        transactions: transactions || [],
        categories
      });
    }
    if (action === "create_expense_category") {
      const name = String(body?.name || "").trim().replace(/\s+/g, " ");
      if (!name || name.length > 80) return Response.json({ error: "Kategoriya nomi 1\u201380 belgidan iborat bo\u2018lsin." }, { status: 400 });
      const categories = await listAll(service.entities.BudgetExpenseCategory, "name");
      const existing = categories.find((row) => row.name.trim().toLowerCase() === name.toLowerCase());
      const category = existing || await service.entities.BudgetExpenseCategory.create({ name });
      return Response.json({ category });
    }
    if (action === "manual_adjustment") {
      if (!await verifyOwnerPin(service, body?.owner_pin, user)) {
        return Response.json({ error: "Owner PIN noto\u2018g\u2018ri." }, { status: 403 });
      }
      const account = String(body?.account || "");
      const direction = String(body?.direction || "");
      const amount = money2(body?.amount);
      const description = String(body?.description || "").trim();
      if (!ACCOUNTS.has(account) && !["bank_card", "bank_all"].includes(account) || !["in", "out"].includes(direction) || !Number.isSafeInteger(amount) || amount <= 0 || description.length < 3) {
        return Response.json({ error: "Hisob, amal, musbat summa va izoh majburiy." }, { status: 400 });
      }
      const categoryId = String(body?.expense_category_id || "");
      let category = null;
      if (categoryId) {
        if (direction !== "out") return Response.json({ error: "Kategoriya faqat chiqim uchun." }, { status: 400 });
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
        key: financialRequestKey(body),
        account,
        direction,
        amount,
        description,
        ...category ? { expense_category_id: category.id, expense_category_name: category.name } : {}
      }, ACCOUNT_LABELS);
      return Response.json(result);
    }
    if (action === "pay_supplier") {
      if (!await verifyOwnerPin(service, body?.owner_pin, user)) {
        return Response.json({ error: "Owner PIN noto\u2018g\u2018ri." }, { status: 403 });
      }
      const account = String(body?.account || "");
      const supplierId = String(body?.supplier_id || "");
      const amount = money2(body?.amount);
      const notes = String(body?.notes || "").trim();
      const targeted = body?.opening_debt_id !== void 0;
      if (targeted && (typeof body.opening_debt_id !== "string" || !body.opening_debt_id.trim() || typeof body.amount !== "number" || !Number.isSafeInteger(body.amount) || notes.length > 2e3) || body?.location_id !== void 0 && (!targeted || typeof body.location_id !== "string" || !body.location_id.trim())) {
        return Response.json({ error: "Boshlang\u2018ich qarz, joylashuv yoki to\u2018lov ma\u2019lumotlari noto\u2018g\u2018ri." }, { status: 400 });
      }
      if (!ACCOUNTS.has(account) && account !== "bank_all" || !supplierId || !Number.isSafeInteger(amount) || amount <= 0) {
        return Response.json({ error: "Yetkazib beruvchi, Budget hisobi va musbat summa majburiy." }, { status: 400 });
      }
      const result = await runSupplierPayment(service, user, {
        key: financialRequestKey(body),
        action,
        account,
        supplier_id: supplierId,
        amount,
        notes,
        ...targeted ? {
          opening_debt_id: body.opening_debt_id,
          ...body.location_id !== void 0 ? { location_id: body.location_id } : {}
        } : {}
      }, ACCOUNT_LABELS);
      return Response.json(result);
    }
    return Response.json({ error: "Noto\u2018g\u2018ri amal." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Budget amali bajarilmadi.";
    return Response.json({
      error: message,
      operation_pending: Boolean(error?.operation_pending),
      operation_reversed: Boolean(error?.operation_reversed),
      request_not_started: Boolean(error?.request_not_started)
    }, { status: Number(error?.status) || 500 });
  }
}
export {
  entry_default as default
};
