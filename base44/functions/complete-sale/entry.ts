// base44/shared/shift-pending-financial.ts
function pendingFinancialCloseGuard(shift) {
  const predicate2 = {};
  for (const [field, stateField, finished] of [
    ["supplier_payment_operations_json", "status", ["completed", "reversed"]],
    ["order_payment_operations_json", "state", ["applied"]]
  ]) {
    let journal2;
    try {
      const raw = shift[field];
      if (raw !== void 0 && raw !== null && typeof raw !== "string") throw new Error();
      journal2 = raw === void 0 || raw === null || raw === "" ? {} : JSON.parse(raw);
      if (!journal2 || typeof journal2 !== "object" || Array.isArray(journal2)) throw new Error();
    } catch {
      throw Object.assign(new Error("Smena to\u2018lovlari holatini egasi tekshirishi kerak."), { status: 409 });
    }
    if (Object.values(journal2).some((operation) => !finished.includes(operation?.[stateField]))) {
      throw Object.assign(new Error("Smena to\u2018lovi yakunlanmagan. Avval saqlangan so\u2018rovni tekshiring."), { status: 409 });
    }
    predicate2[field] = shift[field] === void 0 ? { $exists: false } : shift[field];
  }
  return predicate2;
}

// base44/shared/user-helpers.ts
var APP_ROLES = /* @__PURE__ */ new Set(["admin", "manager", "cashier", "accountant", "production", "warehouse"]);
var userLabel = (user) => user?.display_name || user?.data?.display_name || user?.full_name || user?.email || "Noma\u2019lum xodim";
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

// base44/shared/pending-sale-management.ts
var fail = (message, status = 409) => Object.assign(new Error(message), { status });
function pendingSaleResolutions(shift) {
  const raw = shift?.pos_queue_resolutions_json;
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw fail("Navbat qarorlari tarixini o\u2018qib bo\u2018lmadi. Egasi tekshirishi kerak.");
  }
}
async function managePendingSale(service, user, body, deps) {
  const original = body?.original_request;
  const key = String(original?.idempotency_key || "");
  if (!/^[a-zA-Z0-9:_-]{16,128}$/.test(key) || !original?.shift_id || !Array.isArray(original.items) || !original.items.length || original.items.length > 100 || !Array.isArray(original.payments) || original.payments.length > 10) {
    throw fail("Saqlangan savdo ma\u2019lumoti to\u2018liq emas.", 400);
  }
  if (original.table_number != null || original.table_order_id || original.takeaway_order_id) {
    throw fail("Stol yoki saqlangan buyurtmani o\u2018z oynasidan tekshiring.");
  }
  const shift = await service.entities.Shift.get(String(original.shift_id));
  if (!shift || shift.user_id !== user.id || user.role !== "admin" && userShopId(user) !== shift.shop_id) {
    throw fail("Faqat o\u2018z smenangizdagi savdolarni tekshirishingiz mumkin.", 403);
  }
  const shop = await service.entities.Shop.get(shift.shop_id);
  if (!shop || shop.active === false) throw fail("Faol do\u2018kon topilmadi.", 403);
  const fingerprint = await deps.fingerprint(original);
  const resolving = body.action === "resolve_pending_sale";
  const operation = String(body.operation || "");
  if (resolving && !["edit", "cancel"].includes(operation)) throw fail("Amal noto\u2018g\u2018ri.", 400);
  if (resolving && !await deps.verifyPin(service, body.owner_pin, user)) {
    throw fail("Tahrirlash yoki bekor qilish uchun egasi PIN-kodi kerak.", 403);
  }
  const resolutions = pendingSaleResolutions(shift);
  const prior = resolutions[key];
  if (prior) {
    if (prior.original_fingerprint !== fingerprint || prior.user_id !== user.id || resolving && (prior.state !== (operation === "edit" ? "edited" : "cancelled") || operation === "edit" && prior.final_total !== body.final_total)) {
      throw fail("Bu savdo uchun boshqa qaror saqlangan. Holatini qayta tekshiring.");
    }
    return { ...prior, original_key: key, shift_status: shift.status };
  }
  const matches = await service.entities.Sale.filter({ idempotency_key: key }, "-created_date", 2);
  if ((matches || []).length > 1) throw fail("Takroriy savdo yozuvi topildi. Egasi tekshirishi kerak.");
  const sale = matches?.[0];
  if (sale) {
    if (sale.user_id !== user.id || sale.shift_id !== shift.id || sale.shop_id !== shift.shop_id || sale.request_fingerprint && sale.request_fingerprint !== fingerprint) {
      throw fail("Savdo kaliti boshqa yozuvga tegishli.", 403);
    }
    if (resolving) throw fail("Savdo serverda mavjud. Uni navbatdan tahrirlab yoki bekor qilib bo\u2018lmaydi; savdolar tarixini tekshiring.");
    const complete = sale.financial_records_version < 3 || !sale.financial_records_version || (shift.sale_request_keys || []).includes("sale-completed:" + key);
    return {
      state: complete ? "confirmed" : "processing",
      original_key: key,
      shift_status: shift.status,
      ...complete ? { sale, shift } : {}
    };
  }
  if ((shift.sale_request_keys || []).includes(key)) {
    if (resolving) throw fail("Savdo serverda yakunlanmoqda yoki tekshiruv talab qiladi. Hozir tahrirlamang yoki bekor qilmang.");
    return { state: "processing", original_key: key, shift_status: shift.status };
  }
  let items = [], pricingError = "";
  if (!resolving || operation === "edit") {
    try {
      items = await deps.normalizeItems(service, original.items, shift.shop_id);
    } catch (error) {
      pricingError = error instanceof Error ? error.message : "Narxni tekshirib bo\u2018lmadi.";
    }
  }
  const subtotal = items.reduce((sum, row) => sum + row.subtotal, 0);
  const paidTotal = original.payments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  if (!resolving) return {
    state: "pending",
    original_key: key,
    shift_status: shift.status,
    subtotal: pricingError ? null : subtotal,
    paid_total: paidTotal,
    items,
    pricing_error: pricingError
  };
  const reason = String(body.reason || "").trim();
  if (!reason || reason.length > 500) throw fail("Sababni kiriting (500 belgigacha).", 400);
  if (!["open", "closed"].includes(shift.status)) throw fail("Smena yopilmoqda. Tugashini kuting.");
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const result = {
    state: operation === "edit" ? "edited" : "cancelled",
    original_key: key,
    original_fingerprint: fingerprint,
    original_request_json: deps.canonical(original),
    user_id: user.id,
    user_name: userLabel(user),
    shop_id: shift.shop_id,
    shift_id: shift.id,
    reason,
    resolved_at: now,
    shift_status: shift.status
  };
  if (operation === "edit") {
    if (shift.status !== "open") throw fail("Smena yopilgan. Tahrirlab qayta yuborish yopiq smena hisobotini o\u2018zgartiradi; egasi alohida tekshirishi kerak.");
    if (pricingError) throw fail(pricingError);
    const total = body.final_total;
    if (!Number.isSafeInteger(total) || total <= 0 || total > subtotal || !Number.isSafeInteger(subtotal)) {
      throw fail("Yakuniy summa musbat bo\u2018lsin va mahsulotlar jamidan oshmasin.", 400);
    }
    const methods = deps.paymentMethods;
    if (!original.payments.length || original.payments.some((row) => !methods.has(row.method) || !Number.isFinite(row.amount) || row.amount <= 0) || !Number.isFinite(paidTotal) || paidTotal <= 0) {
      throw fail("Saqlangan to\u2018lov usullari yoki summasi noto\u2018g\u2018ri.", 400);
    }
    let assigned = 0;
    const payments = original.payments.map((row, index) => {
      const amount = index === original.payments.length - 1 ? deps.money(total - assigned) : Math.floor(total * 100 * row.amount / paidTotal) / 100;
      assigned = deps.money(assigned + amount);
      return { method: row.method, amount, reference: String(row.reference || "").slice(0, 200) };
    }).filter((row) => row.amount > 0);
    result.final_total = total;
    result.subtotal = subtotal;
    result.items = items;
    result.request = {
      action: "complete_sale",
      shift_id: shift.id,
      items: JSON.parse(deps.canonical(original)).items,
      payments,
      ...original.is_delivery === true ? { is_delivery: true } : {},
      ...subtotal > total ? { manual_discount_amount: subtotal - total } : {},
      idempotency_key: "pos-repair-" + crypto.randomUUID(),
      recorded_at: original.recorded_at
    };
  }
  const journalQuery = shift.pos_queue_resolutions_json == null ? { $or: [{ pos_queue_resolutions_json: { $exists: false } }, { pos_queue_resolutions_json: null }] } : { pos_queue_resolutions_json: shift.pos_queue_resolutions_json };
  const claim = await service.entities.Shift.updateMany({
    id: shift.id,
    user_id: user.id,
    status: shift.status,
    sale_request_keys: { $ne: key },
    ...journalQuery
  }, {
    $push: { sale_request_keys: key },
    $set: { pos_queue_resolutions_json: JSON.stringify({ ...resolutions, [key]: result }) }
  });
  if (!claim?.success || Number(claim.updated) !== 1) {
    throw fail("Savdo yoki smena holati o\u2018zgardi. Holatini qayta tekshiring.");
  }
  try {
    await service.entities.ActionHistory.create({
      user_id: user.id,
      user_name: userLabel(user),
      action: operation === "edit" ? "pending_sale_edited" : "pending_sale_cancelled",
      details: JSON.stringify({
        original_key: key,
        shift_id: shift.id,
        shop_id: shift.shop_id,
        final_total: result.final_total,
        reason
      })
    });
  } catch {
  }
  return result;
}
async function cancelPendingSales(service, user, body, deps) {
  const originals = body.original_requests;
  const reason = String(body.reason || "").trim();
  if (!Array.isArray(originals) || !originals.length || originals.length > 50 || new Set(originals.map((row) => row?.idempotency_key)).size !== originals.length) {
    throw fail("Bir so\u2018rovda 1\u201350 ta takrorlanmagan savdo bo\u2018lishi kerak.", 400);
  }
  if (!reason || reason.length > 500) throw fail("Bekor qilish sababini kiriting.", 400);
  if (!await deps.verifyPin(service, body.owner_pin, user)) {
    throw fail("Hammasini bekor qilish uchun egasi PIN-kodi kerak.", 403);
  }
  const approved = { ...deps, verifyPin: async () => true };
  const results = [], errors = [];
  for (const original of originals) {
    const originalKey = String(original?.idempotency_key || "");
    try {
      results.push(await managePendingSale(service, user, {
        action: "resolve_pending_sale",
        operation: "cancel",
        original_request: original,
        reason
      }, approved));
    } catch (error) {
      try {
        const state = await managePendingSale(service, user, {
          action: "inspect_pending_sale",
          original_request: original
        }, approved);
        if (["confirmed", "cancelled"].includes(state.state)) {
          results.push(state);
          continue;
        }
      } catch {
      }
      errors.push({
        original_key: originalKey,
        error: error instanceof Error ? error.message : "Savdo bekor qilinmadi.",
        status: Number(error?.status || 500)
      });
    }
  }
  return { results, errors };
}

// base44/shared/manager-request-scope.ts
async function assertManagerRequestScope(service, user, body) {
  if (userRole(user) !== "manager") return;
  const shopId = userShopId(user);
  const deny = () => {
    throw Object.assign(new Error("Faqat biriktirilgan ish joyi uchun ruxsat berilgan."), { status: 403 });
  };
  const shop = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
  if (!shop || shop.active === false) deny();
  for (const field of ["shop_id", "location_id"]) {
    if (body?.[field] && String(body[field]) !== shopId) deny();
  }
  for (const [key, entity, scope] of [
    ["shift_id", "Shift", "shop_id"],
    ["sale_id", "Sale", "shop_id"],
    ["order_id", "CustomerOrder", "shop_id"],
    ["receipt_id", "SupplierReceipt", "location_id"],
    ["count_id", "StockCount", "location_id"]
  ]) {
    if (!body?.[key]) continue;
    const row = await service.entities[entity].get(String(body[key])).catch(() => null);
    if (!row || row[scope] !== shopId) deny();
  }
}

// base44/shared/supplier-payment-recovery.ts
var INIT_JOURNAL = "budget_account_initialization_json";
var fail2 = (message, status = 503, pending = true) => Object.assign(new Error(message), { status, operation_pending: pending });
var journal = (row, field) => {
  if (!row?.[field]) return {};
  try {
    const parsed = JSON.parse(row[field]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw fail2("Moliyaviy operatsiya holatini egasi tekshirishi kerak.");
  }
};
var journalPredicate = (row, field) => row[field] === void 0 ? { $exists: false } : row[field];
var rejected = (error) => [400, 401, 403, 404, 422].includes(
  Number(error?.response?.status || error?.status || 0)
);
async function ensureBudgetAccount(service, account, label, user) {
  const find = async () => {
    const rows = await service.entities.BudgetBalance.filter({ account });
    if (rows.length > 1) throw fail2(`${label} uchun takroriy Budget balansi topildi.`, 409);
    return rows[0] || null;
  };
  const found = await find();
  if (found) return found;
  const settings = await service.entities.Settings.list("created_date", 2);
  if (settings.length !== 1) throw fail2("Budget hisobini yaratish uchun ilova sozlamasini egasi tekshirishi kerak.", 409);
  const entity = service.entities.Settings;
  const id = settings[0].id;
  const token = crypto.randomUUID();
  let claimed = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await entity.get(id);
    const operations2 = journal(row, INIT_JOURNAL);
    const prior = operations2[account];
    if (prior && prior.status !== "rejected") {
      const existing2 = await find();
      if (existing2) return existing2;
      throw fail2("Budget hisobi yaratilmoqda yoki javobi noaniq. Shu amalni qayta tekshiring.");
    }
    operations2[account] = { token, status: "creating" };
    const result = await entity.updateMany(
      { id, [INIT_JOURNAL]: journalPredicate(row, INIT_JOURNAL) },
      { $set: { [INIT_JOURNAL]: JSON.stringify(operations2) } }
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
  if (!claimed) throw fail2("Budget hisobi boshqa oynada yaratilmoqda.");
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
      const operations2 = journal(row, INIT_JOURNAL);
      if (operations2[account]?.token === token) {
        operations2[account].status = "rejected";
        await entity.updateMany(
          { id, [INIT_JOURNAL]: journalPredicate(row, INIT_JOURNAL) },
          { $set: { [INIT_JOURNAL]: JSON.stringify(operations2) } }
        );
      }
      throw error;
    }
    throw fail2("Budget hisobini yaratish javobi noaniq. Egasi tekshirishi kerak.");
  }
}

// base44/shared/report-activity.ts
async function readReportRows(entity, query = {}, sort = "id") {
  if (!entity?.filter) throw new Error("Hisobot ma\u2019lumot manbasi mavjud emas.");
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (let skip = 0; skip < 1e4; skip += 500) {
    const rows = await entity.filter(query, sort, 500, skip);
    if (!Array.isArray(rows)) throw new Error("Hisobot javobi noto\u2018g\u2018ri.");
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) throw new Error("Hisobot sahifalari takrorlandi. To\u2018liq bo\u2018lmagan natija ko\u2018rsatilmaydi.");
      seen.add(row.id);
      result.push(row);
    }
    if (rows.length < 500) return result;
  }
  throw new Error("Hisobot juda katta. Sana oralig\u2018ini qisqartiring; to\u2018liq bo\u2018lmagan jami ko\u2018rsatilmaydi.");
}

// base44/shared/service-ticket-cycle.ts
var serviceTicketVersion = (shop) => Number.isSafeInteger(shop?.service_ticket_version) && shop.service_ticket_version >= 0 ? shop.service_ticket_version : 0;
var serviceTicketVersionQuery = (version) => version === 0 ? { $or: [{ service_ticket_version: 0 }, { service_ticket_version: { $exists: false } }] } : { service_ticket_version: version };
async function finishServiceTicketCycleIfLastShift(service, shopId) {
  if (!shopId || !service?.entities?.Shop?.get || !service?.entities?.Shift?.filter) return false;
  const shop = await service.entities.Shop.get(shopId).catch(() => null);
  if (!shop || shop.service_ticket_cycle_active !== true) return false;
  const version = serviceTicketVersion(shop);
  const [opened, closing] = await Promise.all([
    service.entities.Shift.filter({ shop_id: shopId, status: "open" }, "-opened_at", 1),
    service.entities.Shift.filter({ shop_id: shopId, status: "closing" }, "-opened_at", 1)
  ]);
  if (opened?.length || closing?.length) return false;
  const result = await service.entities.Shop.updateMany(
    { id: shopId, service_ticket_cycle_active: true, ...serviceTicketVersionQuery(version) },
    { $set: { service_ticket_cycle_active: false }, $inc: { service_ticket_version: 1 } }
  );
  return Boolean(result?.success && Number(result.updated || 0) === 1);
}

// base44/shared/shift-settlement-recovery.ts
var FIELD = "shift_settlement_operations_json";
var fail3 = (message, status = 503) => Object.assign(new Error(message), { status, operation_pending: true });
var operations = (row) => {
  if (!row?.[FIELD]) return {};
  try {
    const value = JSON.parse(row[FIELD]);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw fail3("Smena topshirig\u2018i holatini egasi tekshirishi kerak.");
  }
};
var predicate = (row) => row[FIELD] === void 0 ? { $exists: false } : row[FIELD];
async function creditShiftBudget(service, account, amount, label, user, now, operationKey) {
  const initial = await ensureBudgetAccount(service, account, label, user);
  const entity = service.entities.BudgetBalance;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await entity.get(initial.id);
    const journal2 = operations(row);
    const existing = journal2[operationKey];
    if (existing) {
      if (existing.actor !== user.id || existing.account !== account || existing.amount !== amount) {
        throw fail3("Smena topshirig\u2018i kaliti boshqa amal uchun ishlatilgan.", 409);
      }
      if (existing.state !== "credited") throw fail3("Smena topshirig\u2018i qaytarilgan. Egasi tekshirishi kerak.", 409);
      return { record: row, before: existing.before, after: existing.after, amount, operationKey };
    }
    const before = Math.round(Number(row.balance) || 0);
    const saved = { actor: user.id, account, amount, before, after: before + amount, state: "credited" };
    journal2[operationKey] = saved;
    let result;
    try {
      result = await entity.updateMany(
        {
          id: row.id,
          balance: Number(row.balance || 0),
          [FIELD]: predicate(row),
          shift_settlement_keys: { $nin: [operationKey] }
        },
        {
          $inc: { balance: amount },
          $push: { shift_settlement_keys: operationKey },
          $set: {
            [FIELD]: JSON.stringify(journal2),
            updated_at: now,
            updated_by_id: user.id,
            updated_by_name: user.full_name || user.email
          }
        }
      );
    } catch (error) {
      const latest = await entity.get(row.id);
      const confirmed = operations(latest)[operationKey];
      if (confirmed?.actor === user.id && confirmed?.account === account && confirmed?.amount === amount && confirmed?.state === "credited") {
        return { record: latest, before: confirmed.before, after: confirmed.after, amount, operationKey };
      }
      throw fail3("Budget topshirig\u2018i javobi noaniq. Mablag\u2018ni takroran topshirmang.");
    }
    if (result?.success && Number(result.updated) === 1) {
      return { record: { ...row, balance: saved.after }, before, after: saved.after, amount, operationKey };
    }
  }
  throw fail3("Budget balansi boshqa operatsiyada o\u2018zgardi. Egasi tekshirishi kerak.", 409);
}
async function savedShiftCloseResponse(service, shift, runtimeVersion) {
  const warnings = [];
  await finishServiceTicketCycleIfLastShift(service, shift.shop_id).catch(() => {
    warnings.push("Xizmat cheki raqamlash holatini qayta tekshirish kerak.");
  });
  const results = await Promise.allSettled([
    readReportRows(service.entities.ShiftProductSnapshot, { shift_id: shift.id }, "product_name_snapshot"),
    readReportRows(service.entities.BudgetTransaction, { shift_id: shift.id, type: "shift_deposit", status: "completed" })
  ]);
  const stockComplete = results[0].status === "fulfilled";
  const budgetComplete = results[1].status === "fulfilled";
  const rows = stockComplete ? results[0].value : [];
  const transactions = budgetComplete ? results[1].value : [];
  if (!stockComplete) warnings.push("Yopilishdagi mahsulot qoldig\u2018i tafsilotlari yuklanmadi. Tarixdan qayta oching.");
  if (!budgetComplete) warnings.push("Budget topshirig\u2018i tafsilotlari yuklanmadi. Tarixdan qayta tekshiring.");
  const detailsWarning = warnings.length ? "Smena yopilgani va mablag\u2018lar saqlangani tasdiqlandi. " + warnings.join(" ") : "";
  return Response.json({
    runtime_version: runtimeVersion,
    shift,
    already_closed: true,
    stock_report: {
      shift_id: shift.id,
      shop_id: shift.shop_id,
      rows,
      complete: stockComplete,
      ...stockComplete ? {} : { warning: warnings.find((text) => text.startsWith("Yopilishdagi")) }
    },
    budget_transactions: transactions,
    print_report_required: true,
    details_complete: stockComplete && budgetComplete,
    budget_transactions_complete: budgetComplete,
    ...detailsWarning ? { details_warning: detailsWarning } : {},
    telegram_notification: { sent: false, reason: "saved_closure_replayed" }
  });
}
async function reconcileShiftCloseFailure(service, shiftId, actorId, reference, runtimeVersion, error) {
  const shift = await service.entities.Shift.get(shiftId).catch(() => null);
  if (shift?.user_id === actorId && shift.status === "closed" && shift.budget_settled === true && shift.budget_settlement_reference === reference) {
    return savedShiftCloseResponse(service, shift, runtimeVersion);
  }
  if (shift?.user_id === actorId && shift.status === "closing" && shift.closing_operation_token === reference) {
    await service.entities.Shift.updateMany(
      { id: shift.id, status: "closing", closing_operation_token: reference },
      { $set: { closing_review_required: true } }
    ).catch(() => {
    });
  }
  return Response.json({
    error: "Smena topshirig\u2018i natijasi noaniq. Mablag\u2018ni takroran topshirmang; egasi yozuvlarni tekshirsin.",
    operation_pending: true,
    review_required: true,
    runtime_version: runtimeVersion,
    cause: error instanceof Error ? error.message : "Smenani yakunlab bo\u2018lmadi."
  }, { status: 503 });
}

// base44/functions/complete-sale/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk";

// base44/shared/checkout-reads.ts
var checkoutClock = () => typeof performance === "undefined" ? Date.now() : performance.now();
function isTransientCheckoutError(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  if ([408, 429, 502, 503, 504].includes(status)) return true;
  if (status >= 400 && status < 500) return false;
  const message = String(error?.response?.data?.error || error?.message || "");
  return /timed?\s*out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|server selection|connection pool|network|socket/i.test(message);
}
function checkoutReadKey(entityName, method, args) {
  const seen = /* @__PURE__ */ new Set();
  const encode = (value) => {
    if (value === null) return ["null"];
    const type = typeof value;
    if (type === "undefined") return [type];
    if (type === "string" || type === "boolean") return [type, value];
    if (type === "number" && Number.isFinite(value)) return [type, value];
    if (type !== "object" || seen.has(value) || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Uncacheable read arguments");
    seen.add(value);
    const encoded = Array.isArray(value) ? ["array", value.map(encode)] : ["object", Object.keys(value).sort().map((key) => [key, encode(value[key])])];
    seen.delete(value);
    return encoded;
  };
  try {
    return JSON.stringify([entityName, method, encode(args)]);
  } catch {
    return "";
  }
}
function createCheckoutReadTracker(originalService) {
  const started = checkoutClock();
  const reads = /* @__PURE__ */ new Set(["get", "filter", "list"]);
  const writes = /* @__PURE__ */ new Set(["create", "bulkCreate", "update", "updateMany", "delete", "deleteMany"]);
  const validationEntities = /* @__PURE__ */ new Set(["User", "Shop", "Shift", "Product"]);
  const cache = /* @__PURE__ */ new Map();
  const inFlight = /* @__PURE__ */ new Map();
  const entities = /* @__PURE__ */ new Map();
  const operations2 = [];
  let cachedReads = 0;
  let retriesLeft = 2;
  let retries = 0;
  let mutationsInFlight = 0;
  const clearReads = () => {
    cache.clear();
    inFlight.clear();
  };
  const entityProxy = new Proxy(originalService.entities, {
    get(target, entityName) {
      const entity = target[entityName];
      if (!entity || typeof entityName !== "string") return entity;
      if (entities.has(entityName)) return entities.get(entityName);
      const wrapped = new Proxy(entity, {
        get(record, method) {
          const original = record[method];
          if (typeof original !== "function" || !reads.has(method) && !writes.has(method)) return original;
          return (...args) => {
            if (writes.has(method)) {
              clearReads();
              mutationsInFlight++;
              try {
                return Promise.resolve(original.apply(record, args)).finally(() => {
                  mutationsInFlight--;
                  clearReads();
                });
              } catch (error) {
                mutationsInFlight--;
                clearReads();
                throw error;
              }
            }
            const key = mutationsInFlight === 0 ? checkoutReadKey(entityName, method, args) : "";
            const reusable = key && (cache.get(key) || inFlight.get(key));
            if (reusable) {
              cachedReads++;
              return reusable;
            }
            const run = async () => {
              const readStarted = checkoutClock();
              let attempts = 0;
              try {
                for (; ; ) {
                  attempts++;
                  try {
                    return await original.apply(record, args);
                  } catch (error) {
                    if (attempts > 1 || retriesLeft === 0 || !isTransientCheckoutError(error)) throw error;
                    retriesLeft--;
                    retries++;
                    console.warn("[Odina database read retry]", JSON.stringify({ entity: entityName, method }));
                  }
                }
              } finally {
                if (operations2.length < 60) operations2.push({
                  entity: entityName,
                  method,
                  ms: Math.round(checkoutClock() - readStarted),
                  attempts
                });
              }
            };
            const pending = run();
            if (key && mutationsInFlight === 0) {
              inFlight.set(key, pending);
              if (method === "get" && validationEntities.has(entityName)) cache.set(key, pending);
              pending.then(() => {
                if (inFlight.get(key) === pending) inFlight.delete(key);
              }, () => {
                if (inFlight.get(key) === pending) inFlight.delete(key);
                if (cache.get(key) === pending) cache.delete(key);
              });
            }
            return pending;
          };
        }
      });
      entities.set(entityName, wrapped);
      return wrapped;
    }
  });
  return {
    service: new Proxy(originalService, { get(target, property) {
      return property === "entities" ? entityProxy : target[property];
    } }),
    snapshot: () => ({
      total_ms: Math.round(checkoutClock() - started),
      cached_reads: cachedReads,
      read_retries: retries,
      reads: operations2.map((row) => ({ ...row }))
    })
  };
}

// base44/shared/shift-close-helpers.ts
async function allocateServiceTicketNumber(service, shopId, initialShop = null) {
  if (!shopId || !service?.entities?.Shop?.get || !service?.entities?.Shop?.updateMany) {
    throw httpError("Xizmat cheki uchun do\u2018kon aniqlanmadi.", 409);
  }
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const shop = attempt === 0 && initialShop?.id === shopId ? initialShop : await service.entities.Shop.get(shopId);
    if (!shop || shop.active === false || shop.allows_pos === false || shop.location_type === "production") {
      throw httpError("Xizmat cheki do\u2018koni faol emas.", 409);
    }
    const version = serviceTicketVersion(shop);
    const counter = Number.isSafeInteger(shop.service_ticket_counter) && shop.service_ticket_counter >= 0 ? shop.service_ticket_counter : 0;
    if (shop.service_ticket_cycle_active !== true) {
      const opened = await service.entities.Shift.filter({ shop_id: shopId, status: "open" }, "-opened_at", 1e3);
      if (!opened?.length) throw httpError("Xizmat cheki uchun do\u2018konda ochiq smena kerak.", 409);
      const legacyBaseline = counter === 0 ? (opened || []).reduce((sum, shift) => sum + Math.max(0, Number(shift.order_count) || 0), 0) + (Array.isArray(shop.restaurant_table_orders) ? shop.restaurant_table_orders.filter((order) => !Number.isSafeInteger(order?.ticket_number)).length : 0) : 0;
      if (!Number.isSafeInteger(legacyBaseline) || legacyBaseline >= 1e9) {
        throw httpError("Buyurtma raqamlashini tekshirish kerak. Egaga xabar bering.", 409);
      }
      const activated = await service.entities.Shop.updateMany(
        { id: shopId, ...serviceTicketVersionQuery(version) },
        {
          $set: { service_ticket_cycle_active: true, service_ticket_counter: legacyBaseline + 1 },
          $inc: { service_ticket_version: 1 }
        }
      );
      if (activated?.success && Number(activated.updated || 0) === 1) return legacyBaseline + 1;
      continue;
    }
    if (counter >= 1e9) throw httpError("Xizmat cheki raqamlash chegarasiga yetdi.", 409);
    const claimed = await service.entities.Shop.updateMany(
      { id: shopId, service_ticket_cycle_active: true, ...serviceTicketVersionQuery(version) },
      { $inc: { service_ticket_counter: 1, service_ticket_version: 1 } }
    );
    if (claimed?.success && Number(claimed.updated || 0) === 1) return counter + 1;
  }
  throw httpError("Buyurtma raqami boshqa kassada o\u2018zgardi. Qayta urinib ko\u2018ring.", 409);
}
var money = (value) => Math.round(Number(value) || 0);
var stockNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1e3) / 1e3 : 0;
};
var httpError = (message, status) => {
  const error = new Error(message);
  error.status = status;
  return error;
};
var SHIFT_STOCK_ROW_LIMIT = 1e3;
var stockMovementTime = (movement) => Date.parse(movement?.created_at || movement?.created_date || "");
async function buildShiftStockReport(service, shift, generatedAt) {
  const openedAt = String(shift?.opened_at || shift?.created_date || "");
  const openedMs = Date.parse(openedAt);
  const generatedMs = Date.parse(generatedAt);
  if (!shift?.shop_id || !Number.isFinite(openedMs) || !Number.isFinite(generatedMs)) {
    throw httpError("Smenaning boshlanish vaqti yoki do\u2018koni topilmadi.", 409);
  }
  const [stocks, movements, products] = await Promise.all([
    service.entities.ProductStock.filter(
      { location_id: shift.shop_id },
      "product_name",
      SHIFT_STOCK_ROW_LIMIT
    ),
    service.entities.StockMovement.filter(
      {
        location_id: shift.shop_id,
        item_kind: "product",
        created_at: { $gte: openedAt, $lte: generatedAt }
      },
      "created_at",
      SHIFT_STOCK_ROW_LIMIT
    ),
    service.entities.Product.list("name", SHIFT_STOCK_ROW_LIMIT)
  ]);
  if ((stocks || []).length >= SHIFT_STOCK_ROW_LIMIT || (movements || []).length >= SHIFT_STOCK_ROW_LIMIT) {
    throw httpError("Bu smenada mahsulot harakatlari juda ko\u2018p. Hisobotni administrator tekshirishi kerak.", 409);
  }
  const productById = new Map((products || []).map((product) => [String(product.id), product]));
  const rowsByProduct = /* @__PURE__ */ new Map();
  const stockIds = /* @__PURE__ */ new Set();
  const ensureRow = (productIdValue, fallbackName = "Noma\u2019lum mahsulot") => {
    const productId = String(productIdValue || "");
    if (!productId) return null;
    const product = productById.get(productId) || {};
    if (product.track_stock === false) return null;
    if (!rowsByProduct.has(productId)) {
      rowsByProduct.set(productId, {
        product_id: productId,
        product_name_snapshot: String(product.name || fallbackName || "Noma\u2019lum mahsulot"),
        image_url_snapshot: String(product.image_url || ""),
        unit: "piece",
        current_quantity: 0,
        total_change: 0,
        received_quantity: 0,
        sold_quantity: 0,
        waste_quantity: 0,
        returned_quantity: 0,
        latest_movement_at: Number.NEGATIVE_INFINITY,
        latest_balance_after: null
      });
    }
    const row = rowsByProduct.get(productId);
    if ((!row.product_name_snapshot || row.product_name_snapshot === "Noma\u2019lum mahsulot") && fallbackName) {
      row.product_name_snapshot = String(fallbackName);
    }
    return row;
  };
  for (const stock of stocks || []) {
    const productId = String(stock?.product_id || "");
    if (!productId) continue;
    if (stockIds.has(productId)) {
      throw httpError(`${stock?.product_name || "Mahsulot"} uchun takroriy do\u2018kon qoldig\u2018i topildi.`, 409);
    }
    stockIds.add(productId);
    const row = ensureRow(productId, stock?.product_name);
    if (!row) continue;
    if (stock?.unit && stock.unit !== "piece") {
      throw httpError(`${row.product_name_snapshot} do\u2018kon qoldig\u2018i dona formatida emas.`, 409);
    }
    row.current_quantity = stockNumber(stock?.quantity);
  }
  for (const movement of movements || []) {
    const movementMs = stockMovementTime(movement);
    if (!Number.isFinite(movementMs) || movementMs < openedMs || movementMs > generatedMs) continue;
    const row = ensureRow(movement?.item_id, movement?.item_name);
    if (!row) continue;
    if (movement?.unit && movement.unit !== "piece") {
      throw httpError(`${row.product_name_snapshot} harakati dona formatida emas.`, 409);
    }
    const change = stockNumber(movement?.quantity_change);
    row.total_change = stockNumber(row.total_change + change);
    if (movementMs >= row.latest_movement_at && Number.isFinite(Number(movement?.balance_after))) {
      row.latest_movement_at = movementMs;
      row.latest_balance_after = stockNumber(movement.balance_after);
    }
    if (movement.movement_type === "transfer_in" && change > 0) {
      row.received_quantity = stockNumber(row.received_quantity + change);
    } else if (movement.movement_type === "sale" && change < 0) {
      row.sold_quantity = stockNumber(row.sold_quantity - change);
    } else if (movement.movement_type === "waste" && change < 0) {
      row.waste_quantity = stockNumber(row.waste_quantity - change);
    } else if (movement.movement_type === "refund" && change > 0) {
      row.returned_quantity = stockNumber(row.returned_quantity + change);
    }
  }
  const rows = Array.from(rowsByProduct.values()).map((row) => {
    const expectedQuantity = row.latest_balance_after === null ? stockNumber(row.current_quantity) : stockNumber(row.latest_balance_after);
    const openingQuantity = stockNumber(expectedQuantity - row.total_change);
    const explainedChange = stockNumber(
      row.received_quantity - row.sold_quantity - row.waste_quantity + row.returned_quantity
    );
    return {
      product_id: row.product_id,
      product_name_snapshot: row.product_name_snapshot,
      image_url_snapshot: row.image_url_snapshot,
      unit: "piece",
      opening_quantity: openingQuantity,
      received_quantity: row.received_quantity,
      sold_quantity: row.sold_quantity,
      waste_quantity: row.waste_quantity,
      returned_quantity: row.returned_quantity,
      other_change_quantity: stockNumber(row.total_change - explainedChange),
      expected_quantity: expectedQuantity
    };
  }).sort(
    (left, right) => String(left.product_name_snapshot).localeCompare(String(right.product_name_snapshot), "uz")
  );
  return {
    shift_id: shift.id,
    shop_id: shift.shop_id,
    opened_at: openedAt,
    generated_at: generatedAt,
    rows
  };
}
async function cleanupShiftStockSnapshots(service, shiftId) {
  const snapshotsEntity = service?.entities?.ShiftProductSnapshot;
  if (!snapshotsEntity?.filter || !snapshotsEntity?.delete) return;
  const snapshots = await snapshotsEntity.filter({ shift_id: shiftId }, "-closed_at", SHIFT_STOCK_ROW_LIMIT).catch(() => []);
  for (const snapshot of snapshots || []) {
    await snapshotsEntity.delete(snapshot.id).catch(() => {
    });
  }
}
var BUDGET_ACCOUNT_LABELS = {
  cash: "Naqd pul",
  uzcard: "Bank card",
  humo: "Humo",
  online: "Online",
  bank: "Bank"
};
async function creditBudgetBalance(service, account, amount, user, now, operationKey = `SM-${crypto.randomUUID()}`) {
  return creditShiftBudget(service, account, amount, BUDGET_ACCOUNT_LABELS[account], user, now, operationKey);
}

// base44/shared/cost-engine.ts
var num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
var PURCHASE_TO_BASE_FACTOR = {
  kg: 1e3,
  l: 1e3,
  g: 1,
  ml: 1,
  piece: 1
};
function receiptBaseQuantity(line) {
  if (line?.base_quantity != null && Number(line.base_quantity) > 0) {
    return num(line.base_quantity);
  }
  const qty = num(line?.purchase_quantity);
  const factor = PURCHASE_TO_BASE_FACTOR[String(line?.purchase_unit || "")] || 1;
  return qty * factor;
}
function weightedAvgIngredientCost(lines) {
  let totalCost = 0;
  let totalBase = 0;
  for (const line of lines || []) {
    const base = receiptBaseQuantity(line);
    if (base <= 0) continue;
    const lineTotal = num(line?.line_total);
    if (lineTotal > 0) {
      totalCost += lineTotal;
      totalBase += base;
    }
  }
  if (totalBase <= 0 || totalCost <= 0) return { cost: 0, hasPrice: false };
  return { cost: totalCost / totalBase, hasPrice: true };
}
function recipeCostFromMap(recipeItems, ingredientCosts, takeaway = false) {
  let batchCost = 0;
  const missing = [];
  const items = (recipeItems || []).filter((item) => takeaway || item.takeaway_only !== true);
  let hasAllPrices = items.length > 0;
  for (const ri of items) {
    const ic = ingredientCosts.get(String(ri.ingredient_id));
    if (!ic || !ic.hasPrice) {
      missing.push(String(ri.ingredient_name_snapshot || ri.ingredient_id));
      hasAllPrices = false;
      continue;
    }
    batchCost += num(ri.quantity) * ic.cost;
  }
  return { batchCost, missing, hasAllPrices };
}
function costPerPiece(batchCost, outputQuantity, outputUnit, piecesPerSheet) {
  const out = num(outputQuantity);
  if (out <= 0) return 0;
  const perOutput = batchCost / out;
  if (outputUnit === "sheet") {
    const pps = num(piecesPerSheet) || 1;
    return pps > 0 ? perOutput / pps : 0;
  }
  return perOutput;
}
async function loadIngredientCosts(service, ingredientIds) {
  let receipts;
  let items;
  if (ingredientIds === void 0) {
    [receipts, items] = await Promise.all([
      service.entities.SupplierReceipt.list("-received_at", 500),
      service.entities.SupplierReceiptItem.list("-created_date", 1e3)
    ]);
  } else {
    const ids = [...new Set(ingredientIds.map(String).filter(Boolean))];
    if (!ids.length) return /* @__PURE__ */ new Map();
    items = [];
    const seen = /* @__PURE__ */ new Set();
    for (let skip = 0; ; skip += 500) {
      const rows = await service.entities.SupplierReceiptItem.filter(
        { ingredient_id: { $in: ids } },
        "id",
        500,
        skip,
        ["id", "receipt_id", "ingredient_id", "line_total", "base_quantity", "purchase_quantity", "purchase_unit"]
      );
      if (!Array.isArray(rows)) throw new Error("Masalliq tannarxi javobi noto\u2018g\u2018ri.");
      for (const row of rows) {
        if (!row.id || seen.has(row.id) || !ids.includes(String(row.ingredient_id))) {
          throw new Error("Masalliq tannarxi sahifalari noto\u2018g\u2018ri.");
        }
        seen.add(row.id);
        items.push(row);
      }
      if (rows.length < 500) break;
      if (skip >= 99500) throw new Error("Masalliq tannarxi tarixi juda katta.");
    }
    const receiptIds = [...new Set(items.map((row) => String(row.receipt_id || "")).filter(Boolean))];
    receipts = [];
    for (let start = 0; start < receiptIds.length; start += 2e3) {
      const batch = receiptIds.slice(start, start + 2e3);
      const pages = await Promise.all(Array.from({ length: Math.ceil(batch.length / 500) }, (_, index) => service.entities.SupplierReceipt.filter(
        { id: { $in: batch.slice(index * 500, (index + 1) * 500) } },
        "id",
        500,
        0,
        ["id", "status"]
      )));
      for (const rows of pages) {
        if (!Array.isArray(rows)) throw new Error("Kirim tannarxi javobi noto\u2018g\u2018ri.");
        receipts.push(...rows);
      }
    }
  }
  const validIds = new Set(
    (receipts || []).filter((r) => r.status !== "cancelled" && r.status !== "cancelling" && r.status !== "receiving").map((r) => r.id)
  );
  const byIngredient = /* @__PURE__ */ new Map();
  for (const it of items || []) {
    if (!validIds.has(it.receipt_id)) continue;
    const key = String(it.ingredient_id);
    if (!byIngredient.has(key)) byIngredient.set(key, []);
    byIngredient.get(key).push(it);
  }
  const result = /* @__PURE__ */ new Map();
  for (const [id, lines] of byIngredient.entries()) {
    result.set(id, weightedAvgIngredientCost(lines));
  }
  return result;
}

// base44/shared/checkout-recipes.ts
async function readScopedRows(entity, query, sort) {
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (let skip = 0; skip < 1e4; skip += 500) {
    const rows = await entity.filter(query, sort, 500, skip);
    if (!Array.isArray(rows)) throw new Error("Tex-karta javobi noto\u2018g\u2018ri.");
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) throw new Error("Tex-karta sahifalari takrorlandi.");
      seen.add(row.id);
      result.push(row);
    }
    if (rows.length < 500) return result;
  }
  throw new Error("Tex-karta ma\u2019lumotlari juda katta.");
}
var groupRows = (rows, key) => {
  const groups = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const id = String(row[key] || "");
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return groups;
};
var orderedRecipeItems = (rows) => [...rows].sort((left, right) => (Number(left.position) || 0) - (Number(right.position) || 0) || String(left.id).localeCompare(String(right.id)));
function createCheckoutRecipeLoader(service, inputIds) {
  const productIds = [...new Set(inputIds.map(String).filter(Boolean))];
  const allowedIds = new Set(productIds);
  let recipesPromise;
  let itemsPromise;
  const recipeFallbacks = /* @__PURE__ */ new Map();
  const itemFallbacks = /* @__PURE__ */ new Map();
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < 4 && waiting.length) waiting.shift()();
  };
  const fallbackRead = (read) => new Promise((resolve, reject) => {
    waiting.push(() => {
      active += 1;
      Promise.resolve().then(read).then(resolve, reject).finally(() => {
        active -= 1;
        pump();
      });
    });
    pump();
  });
  const recipes = () => recipesPromise ??= (async () => {
    if (!productIds.length) return /* @__PURE__ */ new Map();
    return groupRows(await readScopedRows(
      service.entities.Recipe,
      { product_id: { $in: productIds }, active: true }
    ), "product_id");
  })();
  const items = () => itemsPromise ??= (async () => {
    const byProduct = await recipes();
    const recipeIds = [...new Set([...byProduct.values()].flat().map((row) => String(row.id)))];
    if (!recipeIds.length) return /* @__PURE__ */ new Map();
    const byRecipe = groupRows(await readScopedRows(
      service.entities.RecipeItem,
      { recipe_id: { $in: recipeIds } },
      "id"
    ), "recipe_id");
    for (const [recipeId, rows] of byRecipe) byRecipe.set(recipeId, orderedRecipeItems(rows));
    return byRecipe;
  })();
  return {
    async recipesForProduct(productId, required = false) {
      if (!allowedIds.has(productId)) throw new Error("Mahsulot to\u2018lov savatida mavjud emas.");
      try {
        return [...(await recipes()).get(productId) || []];
      } catch (error) {
        if (required) throw error;
        if (!recipeFallbacks.has(productId)) {
          recipeFallbacks.set(productId, fallbackRead(() => readScopedRows(
            service.entities.Recipe,
            { product_id: productId, active: true }
          )));
        }
        return [...await recipeFallbacks.get(productId)];
      }
    },
    async itemsForRecipe(recipeId, required = false) {
      try {
        return [...(await items()).get(recipeId) || []];
      } catch (error) {
        if (required) throw error;
        if (!itemFallbacks.has(recipeId)) {
          itemFallbacks.set(recipeId, fallbackRead(async () => orderedRecipeItems(
            await readScopedRows(service.entities.RecipeItem, { recipe_id: recipeId }, "id")
          )));
        }
        return [...await itemFallbacks.get(recipeId)];
      }
    }
  };
}

// base44/shared/shop-pricing.ts
function priceForShop(product, shopId) {
  const override = shopId && product?.shop_prices?.[shopId];
  return Number(override === void 0 || override === null ? product?.price : override);
}

// base44/shared/sale-options.js
var CAKE_EXTRA_AMOUNT = 5e3;
var CAKE_CATEGORY_ID = "6ab57e00ab3a0a5019ea99db";
var canChooseCakeExtra = (product, shopId) => product?.sale_unit !== "gram" && (product?.shop_category_ids?.[shopId] || product?.category_id) === CAKE_CATEGORY_ID;
function validateCakeExtra(row) {
  if (row?.cake_extra == null || row.cake_extra === false) return false;
  if (row.cake_extra !== true || row.fries_option || row.tea_option) {
    throw Object.assign(new Error("Tort qo\u2018shimchasi tanlovi noto\u2018g\u2018ri."), { status: 400 });
  }
  return true;
}
var cakeExtraSurcharge = (row) => row?.cake_extra === true ? CAKE_EXTRA_AMOUNT : 0;
var saleLineKey = (row) => String(row?.product_id || "") + (row?.fries_option === "with" ? "::fries" : "") + (row?.tea_option === "cup" ? "::tea-cup" : "") + (row?.cake_extra === true ? "::cake-extra" : "");
var saleOptionFields = (row) => ({
  ...["with", "without"].includes(row?.fries_option) ? { fries_option: row.fries_option } : {},
  ...["cup", "pot"].includes(row?.tea_option) ? { tea_option: row.tea_option } : {},
  ...row?.cake_extra === true ? { cake_extra: true } : {}
});

// base44/shared/burger-fries.js
var BURGER_FRIES_SHOP_ID = "6a96f0a4ecc85c2fc57f3174";
var BURGER_PRODUCT_IDS = ["6ab747c5c1c33517e6eea448", "6ab747c5c1c33517e6eea449"];
var FRIES_INGREDIENT_ID = "6aca42bb8a3025f47521338e";
var FRIES_GRAMS = 150;
var FRIES_SURCHARGE = 5e3;
var canChooseBurgerFries = (productId, shopId) => shopId === BURGER_FRIES_SHOP_ID && BURGER_PRODUCT_IDS.includes(String(productId));
function validateFriesOption(row, shopId) {
  const option = row?.fries_option;
  if (option === void 0 || option === null || option === "") return "";
  if (!["with", "without"].includes(option) || !canChooseBurgerFries(row?.product_id, shopId)) {
    const error = new Error("Fri tanlovi ushbu mahsulot yoki do\u2018kon uchun noto\u2018g\u2018ri.");
    error.status = 400;
    throw error;
  }
  return option;
}
var friesSurcharge = (row) => row?.fries_option === "with" ? FRIES_SURCHARGE : 0;
var burgerOptionName = (name, option) => option === "with" ? name + " \u2014 Fri bilan" : option === "without" ? name + " \u2014 Frisiz" : name;
function recipeWithBurgerFries(line, recipe) {
  if (line?.fries_option !== "with") return recipe;
  if (!BURGER_PRODUCT_IDS.includes(String(line.product_id)) || !recipe?.items?.length || !Number.isFinite(Number(recipe.output_quantity)) || Number(recipe.output_quantity) <= 0) {
    const error = new Error("Fri bilan burger uchun to\u2018liq faol tex-karta kerak.");
    error.status = 409;
    throw error;
  }
  return { ...recipe, items: [...recipe.items, {
    ingredient_id: FRIES_INGREDIENT_ID,
    ingredient_name_snapshot: "Kartoshka fri",
    quantity: FRIES_GRAMS * Number(recipe.output_quantity),
    unit: "g"
  }] };
}
function costWithBurgerFries(line, baseCost, ingredientCosts) {
  if (line?.fries_option !== "with") return baseCost;
  const fries = ingredientCosts.get(FRIES_INGREDIENT_ID);
  return {
    ...baseCost,
    costPerPiece: baseCost.costPerPiece + FRIES_GRAMS * Number(fries?.cost || 0),
    hasPrice: baseCost.hasPrice && fries?.hasPrice === true,
    missing: fries?.hasPrice ? baseCost.missing : [...baseCost.missing || [], "Kartoshka fri"]
  };
}

// base44/shared/tea-options.js
var TEA_PRODUCT_IDS = [
  "6ab66ca8ae6223ce0f93e60c",
  // Legacy combined green / black tea
  "6ace05d7ea4cdff9020d4a8d",
  // Ko‘k choy
  "6ace05d7ea4cdff9020d4a8c",
  // Qora choy
  "6ab6b03dfa815d9efa74363e",
  // Limon choy
  "6ab66ca8ae6223ce0f93e611",
  // Marokash
  "6ab66ca8ae6223ce0f93e610",
  // Oblepixa
  "6ab66ca8ae6223ce0f93e60f",
  // Imbir
  "6ab66ca8ae6223ce0f93e60e",
  // Mango marakuya
  "6ab66ca8ae6223ce0f93e60d"
  // Yagodniy
];
var canChooseTeaServing = (productId) => TEA_PRODUCT_IDS.includes(String(productId));
function validateTeaOption(row) {
  const option = row?.tea_option;
  if (option === void 0 || option === null || option === "") return "";
  if (!["cup", "pot"].includes(option) || !canChooseTeaServing(row?.product_id)) {
    const error = new Error("Choy tanlovi ushbu mahsulot uchun noto\u2018g\u2018ri.");
    error.status = 400;
    throw error;
  }
  return option;
}
var teaServingPrice = (basePrice, option) => Number(basePrice) / (option === "cup" ? 2 : 1);
var teaOptionName = (name, option) => option === "cup" ? name + " \u2014 Stakan" : option === "pot" ? name + " \u2014 Choynik" : name;

// base44/shared/shop-ingredient-deduction.ts
var dedNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1e3) / 1e3 : 0;
};
function shopPreparedLines(items, recipeItemsByProduct) {
  const lines = [];
  const missing = [];
  for (const item of items || []) {
    if (item.source_type !== "shop_prepared") continue;
    const recipe = recipeItemsByProduct.get(String(item.product_id)) || null;
    if (!recipe || !recipe.items?.length) {
      missing.push(String(item.product_name || item.product_id));
      continue;
    }
    lines.push({ ...item, recipe });
  }
  return { lines, missing };
}
function aggregateIngredientRequirements(lines) {
  const agg = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const output = dedNum(line.recipe.output_quantity) || 1;
    for (const ri of line.recipe.items) {
      const perUnit = dedNum(ri.quantity) / output;
      const used = dedNum(perUnit * dedNum(line.quantity));
      if (used <= 0) continue;
      const key = String(ri.ingredient_id);
      if (!agg.has(key)) {
        agg.set(key, {
          ingredient_id: ri.ingredient_id,
          ingredient_name: String(ri.ingredient_name_snapshot || ri.ingredient_id),
          unit: String(ri.unit || ""),
          total_required: 0,
          sources: []
        });
      }
      const entry = agg.get(key);
      entry.total_required = dedNum(entry.total_required + used);
      entry.sources.push({
        product_id: line.product_id,
        product_name: line.product_name,
        quantity: dedNum(line.quantity),
        used
      });
    }
  }
  return Array.from(agg.values());
}
function planIngredientDeductions(requirements, stockByIngredient) {
  const plans = [];
  const shortages = [];
  for (const req of requirements) {
    const stock = stockByIngredient.get(req.ingredient_id) || null;
    const before = dedNum(stock?.quantity || 0);
    const after = dedNum(before - req.total_required);
    if (after < 0) {
      shortages.push({
        ingredient_id: req.ingredient_id,
        ingredient_name: req.ingredient_name,
        required: req.total_required,
        available: before,
        missing: dedNum(-after),
        unit: req.unit
      });
    }
    plans.push({ requirement: req, stock, before, after, unit: req.unit });
  }
  return { plans, shortages };
}
function saleIngredientReason(productNames) {
  const names = (productNames || []).filter(Boolean);
  const head = names.slice(0, 3).join(", ");
  const suffix = names.length > 3 ? " va boshqalar" : "";
  return `Kassa savdosi \u2014 ${head || "noma\u2019lum mahsulot"}${suffix}`;
}
function ingredientsDeductedForSale(movements, saleId) {
  const agg = /* @__PURE__ */ new Map();
  for (const m of movements || []) {
    if (String(m?.reference_id || "") !== String(saleId)) continue;
    if (m?.item_kind !== "ingredient") continue;
    if (m?.movement_type !== "sale") continue;
    const change = dedNum(m?.quantity_change);
    if (change >= 0) continue;
    const key = String(m?.item_id || "");
    if (!key) continue;
    const restored = dedNum(-change);
    if (!agg.has(key)) {
      agg.set(key, {
        ingredient_id: key,
        ingredient_name: String(m?.item_name || key),
        quantity: 0,
        unit: String(m?.unit || "")
      });
    }
    agg.get(key).quantity = dedNum(agg.get(key).quantity + restored);
  }
  return Array.from(agg.values());
}

// base44/shared/sale-ingredient-flow.ts
var httpError2 = (message, status) => {
  const error = new Error(message);
  error.status = status;
  return error;
};
var movementNumber = (now) => `ST-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
async function loadShopRecipes(service, shopPreparedItems, recipeLoader, takeaway = false) {
  const productIds = Array.from(new Set(
    shopPreparedItems.map((row) => String(row.product_id)).filter(Boolean)
  ));
  const byProduct = /* @__PURE__ */ new Map();
  for (const productId of productIds) byProduct.set(productId, null);
  if (!productIds.length) return { byProduct, missing: [] };
  const recipes = recipeLoader ? (await Promise.all(productIds.map((id) => recipeLoader.recipesForProduct(id, true)))).flat() : await service.entities.Recipe.filter({ active: true }, "-version", 1e3);
  const byProductId = /* @__PURE__ */ new Map();
  for (const r of recipes || []) {
    const key = String(r.product_id);
    if (!byProductId.has(key)) byProductId.set(key, []);
    byProductId.get(key).push(r);
  }
  const recipeIds = [];
  const chosenRecipe = /* @__PURE__ */ new Map();
  for (const productId of productIds) {
    const rows = (byProductId.get(productId) || []).sort(
      (a, b) => Number(b.version || 0) - Number(a.version || 0)
    );
    if (rows.length > 1) {
      throw httpError2("Bu mahsulot uchun bir nechta faol tex-karta topildi. Egasi tekshirishi kerak.", 409);
    }
    const recipe = rows[0] || null;
    if (recipe) {
      chosenRecipe.set(productId, recipe);
      recipeIds.push(recipe.id);
    }
  }
  let recipeItems = [];
  if (recipeIds.length) {
    recipeItems = recipeLoader ? (await Promise.all(recipeIds.map((id) => recipeLoader.itemsForRecipe(id, true)))).flat() : await service.entities.RecipeItem.filter({ recipe_id: { $in: recipeIds } }, "position", 5e3);
  }
  const itemsByRecipe = /* @__PURE__ */ new Map();
  for (const ri of recipeItems || []) {
    const key = String(ri.recipe_id);
    if (!itemsByRecipe.has(key)) itemsByRecipe.set(key, []);
    itemsByRecipe.get(key).push(ri);
  }
  for (const productId of productIds) {
    const recipe = chosenRecipe.get(productId);
    if (!recipe) {
      byProduct.set(productId, null);
      continue;
    }
    byProduct.set(productId, {
      recipe_id: recipe.id,
      output_quantity: Number(recipe.output_quantity),
      items: (itemsByRecipe.get(recipe.id) || []).filter((ri) => takeaway || ri.takeaway_only !== true).map((ri) => ({
        ingredient_id: ri.ingredient_id,
        ingredient_name_snapshot: ri.ingredient_name_snapshot,
        quantity: Number(ri.quantity),
        unit: String(ri.unit || "")
      }))
    });
  }
  return { byProduct, missing: [] };
}
async function prepareSaleIngredientDeduction(service, shopId, items, options = {}) {
  const shopPrepared = items.filter((row) => row.source_type === "shop_prepared");
  if (!shopPrepared.length) {
    return { lines: [], requirements: [], plans: [], shortages: [] };
  }
  const { byProduct } = await loadShopRecipes(service, shopPrepared, options.recipeLoader, options.takeaway === true);
  for (const recipe of byProduct.values()) {
    if (recipe && !recipe.items.length) {
      throw httpError2("Faol tex-kartada masalliqlar kiritilmagan. Egasi tekshirishi kerak.", 409);
    }
  }
  const { lines, missing } = shopPreparedLines(
    shopPrepared.map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      quantity: row.quantity,
      source_type: row.source_type,
      fries_option: row.fries_option
    })),
    byProduct
  );
  if (missing.length && !options.allowMissing) {
    throw httpError2(
      "Bu mahsulot uchun faol tex-karta topilmadi. Avval tex-kartani kiriting.",
      409
    );
  }
  if (shopPrepared.some((row) => row.fries_option === "with" && !byProduct.get(row.product_id))) {
    throw httpError2("Fri bilan burger uchun faol tex-karta kerak.", 409);
  }
  for (const line of lines) {
    line.recipe = recipeWithBurgerFries(line, line.recipe);
    if (!Number.isFinite(line.recipe.output_quantity) || line.recipe.output_quantity <= 0 || line.recipe.items.some((row) => !row.ingredient_id || !Number.isFinite(row.quantity) || row.quantity <= 0 || !["g", "ml", "piece"].includes(row.unit))) {
      throw httpError2("Tex-karta masalliqlari yoki natija miqdori noto\u2018g\u2018ri. Egasi tekshirishi kerak.", 409);
    }
  }
  const requirements = aggregateIngredientRequirements(lines);
  const ingredientIds = Array.from(new Set(requirements.map((r) => r.ingredient_id)));
  const stockRows = ingredientIds.length ? await service.entities.IngredientStock.filter(
    { location_id: shopId, ingredient_id: { $in: ingredientIds } },
    "ingredient_name",
    1e3
  ) : [];
  const stockByIngredient = /* @__PURE__ */ new Map();
  for (const row of stockRows || []) {
    const key = String(row.ingredient_id);
    if (stockByIngredient.has(key)) {
      throw httpError2(`${row.ingredient_name || "Masalliq"} uchun takroriy ombor qoldig\u2018i topildi.`, 409);
    }
    stockByIngredient.set(key, { id: row.id, quantity: dedNum(row.quantity || 0) });
  }
  const { plans, shortages } = planIngredientDeductions(requirements, stockByIngredient);
  return { lines, requirements, plans, shortages };
}
async function applySaleIngredientDeduction(service, params) {
  const { shopId, shopName, saleId, saleNumber, userId, userName, now, plans, lines } = params;
  const movements = params.movements || [];
  const applied = params.applied || [];
  const ingredientSources = /* @__PURE__ */ new Map();
  for (const line of lines || []) {
    for (const ri of line.recipe.items) {
      const key = String(ri.ingredient_id);
      if (!ingredientSources.has(key)) ingredientSources.set(key, []);
      ingredientSources.get(key).push(line.product_name);
    }
  }
  for (let start = 0; start < plans.length; start += 4) {
    const results = await Promise.allSettled(plans.slice(start, start + 4).map(async (plan) => {
      const req = plan.requirement;
      const stock = plan.stock;
      let stockRecord = stock?.id ? { id: stock.id } : null;
      if (stock?.id) {
        const update = await service.entities.IngredientStock.updateMany(
          { id: stock.id, quantity: plan.before },
          { $set: {
            quantity: plan.after,
            ingredient_name: req.ingredient_name,
            unit: plan.unit,
            location_name: shopName,
            updated_at: now,
            updated_by: userId,
            updated_by_name: userName
          } }
        );
        if (!update?.success || Number(update.updated || 0) !== 1) {
          throw httpError2(`${req.ingredient_name} qoldig\u2018i boshqa qurilmada o\u2018zgardi. Yangilang va qayta urinib ko\u2018ring.`, 409);
        }
      } else {
        stockRecord = await service.entities.IngredientStock.create({
          location_id: shopId,
          location_name: shopName,
          ingredient_id: req.ingredient_id,
          ingredient_name: req.ingredient_name,
          unit: plan.unit,
          quantity: plan.after,
          low_stock_level: 0,
          updated_at: now,
          updated_by: userId,
          updated_by_name: userName
        });
      }
      applied.push({ stockId: stockRecord.id, quantity: req.total_required, before: plan.before, after: plan.after });
      const reason = saleIngredientReason(ingredientSources.get(req.ingredient_id) || []);
      const movement = await service.entities.StockMovement.create({
        movement_number: movementNumber(now),
        location_id: shopId,
        location_name: shopName,
        item_kind: "ingredient",
        item_id: req.ingredient_id,
        item_name: req.ingredient_name,
        unit: plan.unit,
        movement_type: "sale",
        quantity_change: -req.total_required,
        balance_before: plan.before,
        balance_after: plan.after,
        reason,
        reference_id: saleId,
        reference_type: "sale",
        order_id: void 0,
        order_number_snapshot: saleNumber,
        user_id: userId,
        user_name: userName,
        created_at: now
      });
      movements.push(movement);
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  return { movements, applied };
}
async function restoreSaleIngredientsOnRefund(service, params) {
  const { shopId, shopName, saleId, saleNumber, refundId, userId, userName, now } = params;
  const allMovements = await service.entities.StockMovement.filter(
    { reference_id: saleId, location_id: shopId, item_kind: "ingredient", movement_type: "sale" },
    "created_at",
    2e3
  );
  const toRestore = ingredientsDeductedForSale(allMovements || [], saleId);
  if (!toRestore.length) return { movements: [], restocks: [] };
  const ingredientIds = toRestore.map((r) => r.ingredient_id);
  const stockRows = await service.entities.IngredientStock.filter(
    { location_id: shopId, ingredient_id: { $in: ingredientIds } },
    "ingredient_name",
    1e3
  );
  const stockByIngredient = /* @__PURE__ */ new Map();
  for (const row of stockRows || []) {
    const key = String(row.ingredient_id);
    if (stockByIngredient.has(key)) {
      throw httpError2(`${row.ingredient_name || "Masalliq"} uchun takroriy ombor qoldig\u2018i topildi.`, 409);
    }
    stockByIngredient.set(key, row);
  }
  const movements = params.movements || [];
  const restocks = params.restocks || [];
  for (const restore of toRestore) {
    const existing = stockByIngredient.get(restore.ingredient_id) || null;
    const before = dedNum(existing?.quantity || 0);
    const after = dedNum(before + restore.quantity);
    let stockRecord = existing;
    if (existing) {
      const update = await service.entities.IngredientStock.updateMany(
        { id: existing.id, quantity: before },
        { $set: {
          quantity: after,
          ingredient_name: restore.ingredient_name,
          unit: restore.unit,
          location_name: shopName,
          updated_at: now,
          updated_by: userId,
          updated_by_name: userName
        } }
      );
      if (!update?.success || Number(update.updated || 0) !== 1) {
        throw httpError2(`${restore.ingredient_name} qoldig\u2018i boshqa qurilmada o\u2018zgardi.`, 409);
      }
    } else {
      stockRecord = await service.entities.IngredientStock.create({
        location_id: shopId,
        location_name: shopName,
        ingredient_id: restore.ingredient_id,
        ingredient_name: restore.ingredient_name,
        unit: restore.unit,
        quantity: after,
        low_stock_level: 0,
        updated_at: now,
        updated_by: userId,
        updated_by_name: userName
      });
    }
    restocks.push({ stockRecord, ingredient_id: restore.ingredient_id, quantity: restore.quantity, after });
    const movement = await service.entities.StockMovement.create({
      movement_number: movementNumber(now),
      location_id: shopId,
      location_name: shopName,
      item_kind: "ingredient",
      item_id: restore.ingredient_id,
      item_name: restore.ingredient_name,
      unit: restore.unit,
      movement_type: "refund",
      quantity_change: restore.quantity,
      balance_before: before,
      balance_after: after,
      reason: `Savdo qaytarildi: ${saleNumber}`,
      reference_id: refundId,
      reference_type: "refund",
      user_id: userId,
      user_name: userName,
      created_at: now
    });
    movements.push(movement);
  }
  return { movements, restocks };
}

// base44/functions/complete-sale/entry.ts
function isDiscountExpired(discount, now = Date.now()) {
  const date = discount?.valid_until;
  if (date === void 0 || date === null || date === "") return false;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  const end = Date.parse(date + "T23:59:59.999+05:00");
  if (!Number.isFinite(end) || new Date(end + 5 * 60 * 60 * 1e3).toISOString().slice(0, 10) !== date) return true;
  return now > end;
}
var COMPLETE_SALE_RUNTIME_VERSION = "checkout-latency-v3-2026-10-16";
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
var BRANCH_TECH_CARD_SHOP_ID = "6a96f0a4ecc85c2fc57f3174";
async function prepareBranchIngredients(service, shopId, items, recipeLoader, takeaway = false) {
  const eligible = shopId === BRANCH_TECH_CARD_SHOP_ID ? items.filter((item) => item.source_type === "shop_prepared" && item.sale_unit !== "gram") : [];
  const prepared = await prepareSaleIngredientDeduction(service, shopId, eligible, { allowMissing: true, recipeLoader, takeaway });
  const linked = new Set(prepared.lines.map((line) => line.product_id));
  for (const item of items) {
    if (linked.has(item.product_id)) {
      item.stock_tracked = false;
      item.stock_quantity_change = 0;
    }
  }
  return prepared;
}
async function settleCheckoutWrites(tasks) {
  const results = await Promise.allSettled(tasks.map(async (task) => task()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
async function loadSaleCostSnapshots(service, normalizedItems, productsAtSale, recipeLoader, takeaway = false) {
  const unitCostByProduct = /* @__PURE__ */ new Map();
  const recipesByProduct = /* @__PURE__ */ new Map();
  const productIds = [...new Set(normalizedItems.map((item) => String(item.product_id)))];
  for (let start = 0; start < productIds.length; start += 4) {
    const batch = productIds.slice(start, start + 4);
    const recipes = await Promise.allSettled(batch.map((item) => recipeLoader.recipesForProduct(item)));
    for (const [index, result] of recipes.entries()) {
      if (result.status === "fulfilled") {
        if (result.value?.[0]) recipesByProduct.set(batch[index], result.value[0]);
      } else {
        console.warn("Cost snapshot skipped:", result.reason);
      }
    }
  }
  if (!recipesByProduct.size) return unitCostByProduct;
  try {
    const costProductIds = productIds.filter((id) => recipesByProduct.has(id));
    const cardsByProduct = await (async () => {
      const cards = /* @__PURE__ */ new Map();
      for (let start = 0; start < costProductIds.length; start += 4) {
        const batch = costProductIds.slice(start, start + 4);
        const results = await Promise.allSettled(batch.map(async (productId) => {
          const recipe = recipesByProduct.get(productId);
          const [rawItems, product] = await Promise.all([
            recipeLoader.itemsForRecipe(recipe.id),
            productsAtSale.get(productId) || service.entities.Product.get(productId).catch(() => null)
          ]);
          return { recipe, rawItems, product };
        }));
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") cards.set(batch[index], result.value);
          else console.warn("Cost snapshot skipped:", result.reason);
        }
      }
      return cards;
    })();
    const ingredientIds = /* @__PURE__ */ new Set();
    for (const { rawItems } of cardsByProduct.values()) {
      for (const row of rawItems) if (row.ingredient_id) ingredientIds.add(String(row.ingredient_id));
    }
    if (normalizedItems.some((item) => item.fries_option === "with" && cardsByProduct.has(item.product_id))) {
      ingredientIds.add(FRIES_INGREDIENT_ID);
    }
    const ingredientCosts = await loadIngredientCosts(service, [...ingredientIds]);
    const baseCostByProduct = /* @__PURE__ */ new Map();
    for (const [productId, { recipe, rawItems, product }] of cardsByProduct) {
      const { batchCost, missing, hasAllPrices } = recipeCostFromMap(rawItems, ingredientCosts, takeaway);
      const outputUnit = String(recipe.output_unit || product?.production_unit || "piece");
      baseCostByProduct.set(productId, {
        costPerPiece: costPerPiece(
          batchCost,
          num(recipe.output_quantity),
          outputUnit,
          num(product?.pieces_per_sheet) || 20
        ),
        hasPrice: hasAllPrices && rawItems.length > 0,
        missing,
        outputUnit
      });
    }
    for (const item of normalizedItems) {
      const baseCost = baseCostByProduct.get(item.product_id);
      if (baseCost) unitCostByProduct.set(saleLineKey(item), costWithBurgerFries(item, baseCost, ingredientCosts));
    }
  } catch (costError) {
    console.warn("Cost snapshot skipped:", costError);
  }
  return unitCostByProduct;
}
async function normalizeSaleItems(service, requestedItems, shopId, trustedTableItems = null, productsAtSale = null) {
  const requestedLines = /* @__PURE__ */ new Map();
  for (const requested of requestedItems) {
    const quantity = Number(requested?.quantity);
    const productId = String(requested?.product_id || "");
    const option = validateFriesOption(requested, shopId);
    const teaOption = validateTeaOption(requested);
    const cakeExtra = validateCakeExtra(requested);
    if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1e6) {
      throw httpError("Har bir mahsulotda to\u2018g\u2018ri dona soni bo\u2018lishi kerak.", 400);
    }
    const key = saleLineKey(requested);
    const combined = (requestedLines.get(key)?.quantity || 0) + quantity;
    if (!Number.isSafeInteger(combined) || combined > 1e6) throw httpError("Mahsulot miqdori chegaradan oshdi.", 400);
    requestedLines.set(key, {
      product_id: productId,
      quantity: combined,
      ...saleOptionFields({ fries_option: option, tea_option: teaOption, cake_extra: cakeExtra })
    });
  }
  const entries = [...requestedLines.values()];
  const savedItems = entries.map((row) => trustedTableItems?.find((item) => saleLineKey(item) === saleLineKey(row)));
  const products = await Promise.all(entries.map((row, index) => savedItems[index] || service.entities.Product.get(row.product_id)));
  const normalizedItems = [];
  for (const [index, row] of entries.entries()) {
    const { product_id: productId, quantity } = row;
    const savedItem = savedItems[index];
    if (trustedTableItems && !savedItem) throw httpError("Stol savati saqlangan buyurtmadan farq qiladi.", 409);
    const product = products[index];
    if (!product || !savedItem && (product.active === false || product.archived === true)) {
      throw httpError("Tanlangan mahsulotlardan biri hozir sotuvda mavjud emas.", 409);
    }
    if (!savedItem && product.available_shop_ids?.length && !product.available_shop_ids.includes(shopId)) {
      throw httpError("Bu mahsulot ushbu do\u2018konda sotilmaydi.", 403);
    }
    if (!savedItem && row.cake_extra && !canChooseCakeExtra(product, shopId)) {
      throw httpError("Tort qo\u2018shimchasi faqat dona bilan sotiladigan tortga qo\u2018shiladi.", 400);
    }
    if (!savedItem) productsAtSale?.set(productId, product);
    const unitPrice = savedItem ? savedItem.price : teaServingPrice(money(priceForShop(product, shopId)), row.tea_option) + friesSurcharge(row) + cakeExtraSurcharge(row);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0 || !Number.isSafeInteger(unitPrice * quantity)) {
      throw httpError("Stol buyurtmasining narxi noto\u2018g\u2018ri.", 409);
    }
    const saleUnit = product.sale_unit === "gram" ? "gram" : "piece";
    const tracked = saleUnit !== "gram" && (product.stock_tracked !== void 0 ? product.stock_tracked : product.track_stock !== false);
    normalizedItems.push({
      product_id: product.id || product.product_id,
      product_name: savedItem ? savedItem.product_name : teaOptionName(burgerOptionName(product.name, row.fries_option), row.tea_option),
      ...saleOptionFields(savedItem || row),
      image_url: product.image_url || "",
      price: unitPrice,
      sale_unit: saleUnit,
      quantity,
      subtotal: Math.round(unitPrice * quantity / (saleUnit === "gram" ? 1e3 : 1)),
      source_type: product.source_type || "central_produced",
      stock_tracked: tracked,
      stock_location_id: "",
      stock_quantity_change: tracked ? -quantity : 0
    });
  }
  return normalizedItems;
}
async function stockPolicy(service) {
  const settings = await service.entities.Settings.list();
  return settings?.[0]?.allow_negative_stock !== false;
}
async function planSaleStock(service, shopId, items) {
  const plans = [];
  const shortages = [];
  const trackedByProduct = /* @__PURE__ */ new Map();
  for (const item of items.filter((row) => row.stock_tracked)) {
    item.stock_location_id = shopId;
    const combined = trackedByProduct.get(item.product_id);
    if (combined) combined.quantity += item.quantity;
    else trackedByProduct.set(item.product_id, { ...item });
  }
  const trackedItems = [...trackedByProduct.values()];
  const stockRows = await Promise.all(trackedItems.map((item) => service.entities.ProductStock.filter({
    location_id: shopId,
    product_id: item.product_id
  })));
  for (const [index, item] of trackedItems.entries()) {
    const rows = stockRows[index];
    if ((rows || []).length > 1) {
      throw httpError(`${item.product_name} uchun takroriy ombor qoldig\u2018i topildi.`, 409);
    }
    const stock = rows?.[0] || null;
    const before = stockNumber(stock?.quantity || 0);
    const after = stockNumber(before - item.quantity);
    item.stock_location_id = shopId;
    if (after < 0) {
      shortages.push({
        product_id: item.product_id,
        product_name: item.product_name,
        requested: item.quantity,
        available: before,
        missing: stockNumber(-after)
      });
    }
    plans.push({ item, stock, before, after });
  }
  return { plans, shortages };
}
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
var IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9:_-]{16,128}$/;
function tashkentBusinessDate(value) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function saleNumberFor(idempotencyKey, soldAt) {
  const day = tashkentBusinessDate(soldAt).replaceAll("-", "");
  if (!idempotencyKey) {
    return `OD-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  }
  const suffix = idempotencyKey.replace(/[^a-zA-Z0-9]/g, "").slice(-8).toUpperCase().padStart(8, "0");
  return `OD-${day}-${suffix}`;
}
function canonicalSaleRequest(body) {
  const quantities = /* @__PURE__ */ new Map();
  for (const item of Array.isArray(body?.items) ? body.items : []) {
    const cakeExtra = validateCakeExtra(item);
    const productId = String(item?.product_id || "");
    const key = saleLineKey(item);
    const quantity = Math.floor(Number(item?.quantity));
    quantities.set(key, {
      product_id: productId,
      quantity: (quantities.get(key)?.quantity || 0) + quantity,
      ...item?.fries_option === "with" ? { fries_option: "with" } : {},
      ...item?.tea_option === "cup" ? { tea_option: "cup" } : {},
      ...cakeExtra ? { cake_extra: true } : {}
    });
  }
  const items = Array.from(quantities.values()).sort((left, right) => saleLineKey(left).localeCompare(saleLineKey(right)));
  const payments = (Array.isArray(body?.payments) ? body.payments : []).map((payment) => ({
    method: String(payment?.method || ""),
    amount: money(payment?.amount),
    reference: String(payment?.reference || "").trim()
  })).sort((left, right) => `${left.method}:${left.amount}:${left.reference}`.localeCompare(`${right.method}:${right.amount}:${right.reference}`));
  return JSON.stringify({
    shift_id: String(body?.shift_id || ""),
    ...body?.table_number !== void 0 && body?.table_number !== null ? {
      table_number: body.table_number,
      table_shop_id: String(body?.table_shop_id || ""),
      table_order_id: String(body?.table_order_id || ""),
      table_order_revision: body?.table_order_revision
    } : {},
    ...body?.takeaway_order_id ? {
      takeaway_order_id: String(body.takeaway_order_id),
      takeaway_order_revision: body.takeaway_order_revision
    } : {},
    ...body?.is_delivery === true ? { is_delivery: true } : {},
    items,
    discount_code: String(body?.discount_code || "").trim().toUpperCase(),
    ...body?.rounding_total !== void 0 && body?.rounding_total !== null ? { rounding_total: body.rounding_total } : {},
    ...body?.manual_discount_amount !== void 0 && body?.manual_discount_amount !== null ? { manual_discount_amount: body.manual_discount_amount } : {},
    payments,
    recorded_at: String(body?.recorded_at || "")
  });
}
async function saleRequestFingerprint(body) {
  const bytes = new TextEncoder().encode(canonicalSaleRequest(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}
function resolveSoldAt(rawValue, shift, receivedAt) {
  if (!rawValue) return receivedAt;
  const timestamp = Date.parse(String(rawValue));
  if (!Number.isFinite(timestamp)) {
    throw httpError("Savdo vaqti noto\u2018g\u2018ri.", 400);
  }
  const receivedTimestamp = Date.parse(receivedAt);
  if (timestamp > receivedTimestamp + 5 * 60 * 1e3) {
    throw httpError("Savdo vaqti kelajakda bo\u2018lishi mumkin emas.", 400);
  }
  const openedTimestamp = Date.parse(String(shift?.opened_at || shift?.created_date || ""));
  if (Number.isFinite(openedTimestamp) && timestamp < openedTimestamp - 60 * 1e3) {
    throw httpError("Offline savdo smena ochilishidan oldin yozilgan.", 409);
  }
  return new Date(timestamp).toISOString();
}
var tableOrders = (shop) => Array.isArray(shop?.restaurant_table_orders) ? shop.restaurant_table_orders : [];
var tableGroups = (shop) => Array.isArray(shop?.restaurant_table_groups) ? shop.restaurant_table_groups : [];
var tableGroupForNumber = (shop, number) => tableGroups(shop).find((group) => Array.isArray(group?.numbers) && group.numbers.includes(number)) || null;
var tableOrderForNumber = (shop, number) => {
  const primary = tableGroupForNumber(shop, number)?.numbers?.[0] || number;
  return tableOrders(shop).find((order) => order.number === primary) || null;
};
var tableOrdersVersion = (shop) => Number.isInteger(shop?.restaurant_table_orders_version) && shop.restaurant_table_orders_version >= 0 ? shop.restaurant_table_orders_version : 0;
var tableVersionQuery = (version) => version === 0 ? { $or: [{ restaurant_table_orders_version: 0 }, { restaurant_table_orders_version: { $exists: false } }] } : { restaurant_table_orders_version: version };
async function changeLockedTable(service, shopId, orderId, checkoutKey, clear) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const shop = await service.entities.Shop.get(shopId);
    const orders = tableOrders(shop);
    const current = orders.find((row) => row.id === orderId);
    if (!current) return true;
    if (current.state !== "paying" || current.checkout_key !== checkoutKey) return false;
    const next = clear ? orders.filter((row) => row.id !== orderId) : orders.map((row) => row.id === orderId ? { ...row, state: "occupied", checkout_key: "" } : row);
    const group = tableGroups(shop).find((row) => Array.isArray(row?.numbers) && row.numbers.includes(current.number));
    const update = await service.entities.Shop.updateMany(
      { id: shopId, ...tableVersionQuery(tableOrdersVersion(shop)) },
      {
        $set: {
          restaurant_table_orders: next,
          ...clear && group ? { restaurant_table_groups: tableGroups(shop).filter((row) => row.id !== group.id) } : {}
        },
        $inc: { restaurant_table_orders_version: 1 }
      }
    );
    if (update?.success && Number(update.updated || 0) === 1) return true;
  }
  return false;
}
async function entry_default(req) {
  const base44 = createClientFromRequest(req);
  let service = base44.asServiceRole;
  const readTracker = createCheckoutReadTracker(service);
  let trackedAction = "";
  let sale = null;
  let saleItems = [];
  let paymentRecords = [];
  let claimedDiscount = null;
  let discountChanged = false;
  let stockChanges = [];
  let stockMovementRecords = [];
  const ingredientChanges = [];
  const ingredientMovementRecords = [];
  let idempotencyClaimed = false;
  let idempotencyShiftId = "";
  let idempotencyKey = "";
  let tablePaymentLock = null;
  try {
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    const body = await req.json();
    const action = String(body?.action || "complete_sale");
    if (["complete_sale", "check_stock", "open_shift", "get_current_shift", "runtime_status"].includes(action)) {
      service = readTracker.service;
      trackedAction = action;
    }
    const user = await resolveAppUser(service, authenticatedUser);
    if (user.active === false) {
      return Response.json({ error: "Xodim akkaunti faol emas." }, { status: 403 });
    }
    if (!["admin", "manager", "cashier"].includes(user.role)) {
      return Response.json({ error: "Your role cannot complete Kassa sales." }, { status: 403 });
    }
    if (user.role === "manager") await assertManagerRequestScope(service, user, body);
    if (action === "inspect_pending_sale" || action === "resolve_pending_sale") {
      return Response.json(await managePendingSale(service, user, body, {
        verifyPin: verifyOwnerPin,
        fingerprint: saleRequestFingerprint,
        canonical: canonicalSaleRequest,
        normalizeItems: normalizeSaleItems,
        money,
        paymentMethods: PAYMENT_METHODS
      }));
    }
    if (action === "cancel_pending_sales") {
      return Response.json(await cancelPendingSales(service, user, body, {
        verifyPin: verifyOwnerPin,
        fingerprint: saleRequestFingerprint,
        canonical: canonicalSaleRequest,
        normalizeItems: normalizeSaleItems,
        money,
        paymentMethods: PAYMENT_METHODS
      }));
    }
    if (action === "runtime_status") {
      return Response.json({ ok: true, runtime_version: COMPLETE_SALE_RUNTIME_VERSION });
    }
    if (action === "get_current_shift") {
      const shifts = await service.entities.Shift.filter(
        { user_id: user.id, status: "open" },
        "-opened_at",
        2
      );
      if (shifts.length > 1) {
        return Response.json({ error: "Bir nechta ochiq smena topildi. Egasi bilan bog\u2018laning." }, { status: 409 });
      }
      const currentShift = shifts[0] || null;
      if (currentShift && user.role === "manager" && currentShift.shop_id !== user.shop_id) {
        return Response.json({ error: "Ochiq smena biriktirilgan ish joyiga mos emas. Egasi bilan bog\u2018laning." }, { status: 403 });
      }
      return Response.json({ ok: true, shift: currentShift });
    }
    if (action === "open_shift") {
      const startingCash = money(body?.starting_cash);
      if (startingCash < 0) return Response.json({ error: "Starting cash must be zero or more." }, { status: 400 });
      const existing = await service.entities.Shift.filter({ user_id: user.id, status: "open" });
      if (existing?.length) return Response.json({ error: "You already have an open shift." }, { status: 409 });
      let shopId = String(body?.shop_id || "");
      if (["cashier", "manager"].includes(user.role)) {
        if (!user.shop_id) return Response.json({ error: "Owner must assign this cashier to a shop first." }, { status: 403 });
        shopId = user.shop_id;
      }
      const shop = shopId ? await service.entities.Shop.get(shopId) : null;
      if (!shop) return Response.json({ error: "Shop not found." }, { status: 404 });
      if (shop.allows_pos === false || shop.location_type === "production") {
        return Response.json({ error: "Kassa shifts cannot be opened at a production-only location." }, { status: 403 });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const newShift = await service.entities.Shift.create({
        user_id: user.id,
        user_name: user.full_name || user.email,
        shop_id: shop.id,
        shop_name: shop.name,
        status: "open",
        opened_at: now,
        starting_cash: startingCash,
        expected_cash: startingCash
      });
      let auditLogged = true;
      try {
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: user.full_name || user.email,
          action: "shift_opened",
          details: `${shop.name}, starting cash ${startingCash} UZS`
        });
      } catch (error) {
        auditLogged = false;
        console.error("[Odina shift audit failed]", JSON.stringify({
          shift_id: newShift.id,
          transient: isTransientCheckoutError(error)
        }));
      }
      return Response.json({ shift: newShift, audit_logged: auditLogged });
    }
    if (action === "get_shift_stock_report") {
      const shiftId2 = String(body?.shift_id || "");
      if (!shiftId2) {
        return Response.json({ error: "Smena topilmadi." }, { status: 400 });
      }
      const reportShift = await service.entities.Shift.get(shiftId2);
      if (!reportShift || reportShift.status !== "open") {
        return Response.json({ error: "Smena ochiq emas yoki allaqachon yopilgan." }, { status: 409 });
      }
      if (reportShift.user_id !== user.id) {
        return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
      }
      const stockReport = await buildShiftStockReport(service, reportShift, (/* @__PURE__ */ new Date()).toISOString());
      return Response.json({ stock_report: stockReport });
    }
    if (action === "close_shift") {
      const shiftId2 = String(body?.shift_id || "");
      const actualCashRaw = Number(body?.actual_cash);
      if (!shiftId2 || !Number.isFinite(actualCashRaw) || actualCashRaw < 0) {
        return Response.json({ error: "Smena va sanalgan naqd pul to\u2018g\u2018ri kiritilishi kerak." }, { status: 400 });
      }
      const actualCash = Math.round(actualCashRaw);
      const hasCashSplit = body?.budget_cash_submitted !== void 0 || body?.cash_left_for_next_shift !== void 0;
      const submittedRaw = hasCashSplit ? Number(body?.budget_cash_submitted) : actualCash;
      const leftRaw = hasCashSplit ? Number(body?.cash_left_for_next_shift) : 0;
      if (!Number.isFinite(submittedRaw) || !Number.isFinite(leftRaw) || submittedRaw < 0 || leftRaw < 0) {
        return Response.json({ error: "Budgetga topshirilgan va qoldirilgan naqd pul manfiy bo\u2018lishi mumkin emas." }, { status: 400 });
      }
      const budgetCashSubmitted = Math.round(submittedRaw);
      const cashLeftForNextShift = Math.round(leftRaw);
      if (budgetCashSubmitted + cashLeftForNextShift !== actualCash) {
        return Response.json({
          error: "Budgetga topshirilgan pul bilan keyingi smenaga qoldirilgan pul yig\u2018indisi sanalgan naqd pulga teng bo\u2018lishi kerak."
        }, { status: 400 });
      }
      let closingShift = await service.entities.Shift.get(shiftId2);
      if (!closingShift) return Response.json({ error: "Smena topilmadi." }, { status: 404 });
      if (closingShift.user_id !== user.id) {
        return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
      }
      if (closingShift.status === "closed" && closingShift.budget_settled === true) {
        if (money(closingShift.actual_cash) !== actualCash || money(closingShift.budget_cash_submitted) !== budgetCashSubmitted || money(closingShift.cash_left_for_next_shift) !== cashLeftForNextShift) {
          return Response.json({ error: "Yopilgan smenaning saqlangan summalari o\u2018zgartirilmaydi." }, { status: 409 });
        }
        return savedShiftCloseResponse(service, closingShift, COMPLETE_SALE_RUNTIME_VERSION);
      }
      if (closingShift.status !== "open") {
        return Response.json({
          error: "Smena yopilmoqda yoki topshirig\u2018i egasi tomonidan tekshirilishi kerak.",
          review_required: closingShift.closing_review_required === true
        }, { status: 409 });
      }
      const financialClosePredicate = pendingFinancialCloseGuard(closingShift);
      const closedAt = (/* @__PURE__ */ new Date()).toISOString();
      const settlementReference = `SM-${closedAt.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      let claim;
      try {
        claim = await service.entities.Shift.updateMany(
          { id: closingShift.id, user_id: user.id, status: "open", expected_cash: Number(closingShift.expected_cash || 0), ...financialClosePredicate },
          { $set: {
            status: "closing",
            closing_operation_token: settlementReference,
            closing_payload_json: JSON.stringify({ actualCash, budgetCashSubmitted, cashLeftForNextShift }),
            closing_review_required: false
          } }
        );
      } catch (claimError) {
        const saved = await service.entities.Shift.get(closingShift.id).catch(() => null);
        if (saved?.status === "closing" && saved.closing_operation_token === settlementReference) {
          claim = { success: true, updated: 1 };
        } else {
          return reconcileShiftCloseFailure(service, closingShift.id, user.id, settlementReference, COMPLETE_SALE_RUNTIME_VERSION, claimError);
        }
      }
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ error: "Smena bir vaqtda o\u2018zgardi yoki allaqachon yopilmoqda." }, { status: 409 });
      }
      try {
        const claimed = await service.entities.Shift.get(closingShift.id);
        if (!claimed || claimed.status !== "closing" || claimed.user_id !== user.id || claimed.closing_operation_token !== settlementReference) throw httpError("Smena topshirig\u2018i egasi o\u2018zgardi.", 409);
        closingShift = claimed;
      } catch (readError) {
        return reconcileShiftCloseFailure(service, closingShift.id, user.id, settlementReference, COMPLETE_SALE_RUNTIME_VERSION, readError);
      }
      const expected = money(closingShift.expected_cash);
      const userName = user.full_name || user.email || "Noma\u2019lum xodim";
      const deposits = [
        { account: "cash", amount: budgetCashSubmitted },
        { account: "uzcard", amount: Math.max(0, money(closingShift.uzcard_sales)) },
        { account: "humo", amount: Math.max(0, money(closingShift.humo_sales)) },
        { account: "online", amount: Math.max(0, money(closingShift.online_sales)) },
        { account: "bank", amount: Math.max(0, money(closingShift.bank_transfer_sales)) }
      ].filter((deposit) => deposit.amount > 0);
      const budgetTransactions = [];
      let stockReport = null;
      let stockSnapshotPayloads = [];
      let stockSnapshotSucceeded = false;
      const stockDifferenceQuantity = 0;
      const stockDifferenceProductCount = 0;
      try {
        try {
          stockReport = await buildShiftStockReport(service, closingShift, closedAt);
          stockSnapshotPayloads = stockReport.rows.map((row) => ({
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
            closed_at: closedAt
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
            warning: "Mahsulot qoldig\u2018i tarixini avtomatik saqlab bo\u2018lmadi."
          };
          stockSnapshotPayloads = [];
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: userName,
            action: "shift_stock_snapshot_skipped",
            details: `${closingShift.shop_name} \xB7 smena yopildi, mahsulot qoldig\u2018i tarixi saqlanmadi`
          }).catch(() => {
          });
        }
        for (const deposit of deposits) {
          const balanceChange = await creditBudgetBalance(
            service,
            deposit.account,
            deposit.amount,
            user,
            closedAt,
            `${settlementReference}-${deposit.account}`
          );
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
            description: `${closingShift.shop_name} smenasi \xB7 ${BUDGET_ACCOUNT_LABELS[deposit.account]}`,
            performed_by_id: user.id,
            performed_by_name: userName,
            created_at: closedAt,
            status: "completed"
          }).catch(async (ledgerError) => {
            const saved = await service.entities.BudgetTransaction.filter({
              transaction_number: `${settlementReference}-${deposit.account.toUpperCase()}`,
              shift_id: closingShift.id
            }, "id", 2);
            if (saved.length === 1 && saved[0].account === deposit.account && Number(saved[0].amount) === deposit.amount && saved[0].performed_by_id === user.id) return saved[0];
            throw ledgerError;
          });
          budgetTransactions.push(transaction);
        }
        const finalized = await service.entities.Shift.updateMany(
          { id: closingShift.id, user_id: user.id, status: "closing", closing_operation_token: settlementReference },
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
            budget_settled_by_name: userName
          } }
        );
        if (!finalized?.success || Number(finalized.updated || 0) !== 1) {
          throw httpError("Smenani yakuniy yopib bo\u2018lmadi.", 409);
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
          budget_settled_by_name: userName
        };
        await finishServiceTicketCycleIfLastShift(service, closingShift.shop_id).catch((error) => console.error("Service-ticket cycle close needs reconciliation:", error));
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "shift_closed",
          details: `${closingShift.shop_name} \xB7 Budgetga ${budgetCashSubmitted} UZS naqd \xB7 qoldirildi ${cashLeftForNextShift} UZS \xB7 pul farqi ${actualCash - expected} UZS \xB7 tizim qoldig\u2018i ${stockSnapshotSucceeded ? `${stockSnapshotPayloads.length} tur` : "saqlanmadi"} \xB7 backend ${COMPLETE_SALE_RUNTIME_VERSION}`
        }).catch(() => {
        });
        return Response.json({
          runtime_version: COMPLETE_SALE_RUNTIME_VERSION,
          shift: updated,
          stock_report: {
            ...stockReport,
            rows: stockSnapshotPayloads
          },
          budget_transactions: budgetTransactions,
          print_report_required: true
        });
      } catch (error) {
        return reconcileShiftCloseFailure(service, closingShift.id, user.id, settlementReference, COMPLETE_SALE_RUNTIME_VERSION, error);
      }
    }
    if (action === "validate_discount") {
      const code = String(body?.code || "").trim().toUpperCase();
      const matches = code ? await service.entities.DiscountCode.filter({ code, active: true }) : [];
      const discount = matches?.[0];
      if (!discount || discount.single_use !== false && Number(discount.usage_count || 0) >= 1) {
        return Response.json({ error: "Kod noto\u2018g\u2018ri, nofaol yoki avval ishlatilgan." }, { status: 404 });
      }
      if (isDiscountExpired(discount)) {
        return Response.json({ error: "Chegirma kodining muddati tugagan." }, { status: 409 });
      }
      const percentage = Number(discount.percentage);
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
        return Response.json({ error: "Chegirma foizi noto\u2018g\u2018ri." }, { status: 409 });
      }
      const requiresOwnerPin = ["cashier", "manager"].includes(user.role) && percentage === 100;
      if (requiresOwnerPin && !await verifyOwnerPin(service, body?.owner_pin, user)) {
        return Response.json({
          error: "100% chegirma uchun OWNER PIN noto\u2018g\u2018ri yoki kiritilmagan.",
          requires_owner_pin: true
        }, { status: 403 });
      }
      return Response.json({
        code: discount.code,
        percentage,
        requires_owner_pin: false
      });
    }
    if (action === "cash_withdrawal") {
      const shiftId2 = String(body?.shift_id || "");
      const amount = money(body?.amount);
      const reason = String(body?.reason || "").trim();
      const expenseCategory = String(body?.expense_category || "");
      const recipientId = String(body?.recipient_id || "");
      const requestedRecipientName = String(body?.recipient_name || "").trim();
      const allowedCategories = /* @__PURE__ */ new Set(["shop_expense", "goods_payment", "owner_withdrawal", "other_expense"]);
      const employeeName = user.full_name || user.email || "Noma\u2019lum xodim";
      if (!shiftId2 || !Number.isSafeInteger(amount) || amount <= 0 || !allowedCategories.has(expenseCategory)) {
        return Response.json({ error: "Miqdor va chiqim turi majburiy." }, { status: 400 });
      }
      let recipientName = "";
      let verifiedRecipientId = "";
      if (expenseCategory === "goods_payment") {
        if (!recipientId) {
          return Response.json({ error: "Kompaniya yoki yetkazib beruvchini tanlang." }, { status: 400 });
        }
        const recipient = await service.entities.CashRecipient.get(recipientId);
        if (!recipient || recipient.active === false) {
          return Response.json({ error: "Tanlangan qabul qiluvchi faol emas yoki topilmadi." }, { status: 404 });
        }
        verifiedRecipientId = recipient.id;
        recipientName = recipient.name;
      } else if (expenseCategory === "owner_withdrawal") {
        recipientName = requestedRecipientName || "Abdulloh";
      }
      const requestKey = String(body?.idempotency_key || crypto.randomUUID());
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) {
        return Response.json({ error: "Pul operatsiyasi kaliti noto\u2018g\u2018ri." }, { status: 400 });
      }
      const claimKey = `cash-out:${requestKey}`;
      const shift2 = await service.entities.Shift.get(shiftId2);
      if (!shift2 || shift2.user_id !== user.id) return Response.json({ error: "Bu smena boshqa xodimga tegishli yoki topilmadi." }, { status: 403 });
      const priorClaim = (shift2.sale_request_keys || []).includes(claimKey);
      const findMovement = async () => {
        const rows = await service.entities.CashMovement.filter({ reference_id: requestKey, reference_type: "cash_withdrawal", user_id: user.id, shift_id: shift2.id }, "created_date", 2);
        if (rows.length > 1) throw httpError("Pul operatsiyasi tarixi tekshirilishi kerak. Qayta pul bermang.", 409);
        return rows[0] || null;
      };
      if (priorClaim) {
        const recorded = await findMovement();
        if (recorded) {
          if (recorded.amount !== amount || recorded.reason !== reason || recorded.expense_category !== expenseCategory || String(recorded.recipient_id || "") !== verifiedRecipientId || String(recorded.recipient_name_snapshot || "") !== recipientName) {
            return Response.json({ error: "Bu pul so\u2018rovi kaliti boshqa ma\u2019lumotlar uchun ishlatilgan.", operation_pending: true }, { status: 409 });
          }
          return Response.json({ movement: recorded, shift: shift2, already_processed: true });
        }
        return Response.json({ error: "Pul operatsiyasi yakunlanmoqda yoki tekshiruv talab qiladi. Qayta pul bermang; shu so\u2018rovni qayta tekshiring.", operation_pending: true }, { status: 503 });
      }
      if (shift2.status !== "open") return Response.json({ error: "Smena ochiq emas." }, { status: 409 });
      const debited = await service.entities.Shift.updateMany(
        { id: shift2.id, status: "open", user_id: user.id, expected_cash: { $gte: amount }, sale_request_keys: { $ne: claimKey } },
        { $inc: { expected_cash: -amount, cash_removed: amount }, $push: { sale_request_keys: claimKey } }
      );
      if (!debited?.success || Number(debited.updated || 0) !== 1) {
        const latest = await service.entities.Shift.get(shift2.id);
        const pending = (latest?.sale_request_keys || []).includes(claimKey);
        return Response.json({ error: "Kassada pul yetarli emas yoki operatsiya boshqa oynada boshlangan. Yangilab tekshiring.", operation_pending: pending }, { status: 409 });
      }
      let movement;
      try {
        movement = await service.entities.CashMovement.create({
          shift_id: shift2.id,
          shop_id: shift2.shop_id,
          user_id: user.id,
          user_name: user.full_name || user.email,
          employee_name: employeeName,
          type: "withdrawal",
          expense_category: expenseCategory,
          recipient_id: verifiedRecipientId || void 0,
          recipient_name_snapshot: recipientName || void 0,
          amount,
          reason,
          reference_id: requestKey,
          reference_type: "cash_withdrawal",
          created_at: (/* @__PURE__ */ new Date()).toISOString()
        });
      } catch (recordError) {
        let checked = false;
        try {
          movement = await findMovement();
          checked = true;
        } catch {
        }
        if (!movement) {
          const status = Number(recordError?.response?.status || recordError?.status || 0);
          if (checked && [400, 401, 403, 404, 422].includes(status)) {
            const reversed = await service.entities.Shift.updateMany(
              { id: shift2.id, sale_request_keys: { $in: [claimKey] } },
              { $inc: { expected_cash: amount, cash_removed: -amount }, $pull: { sale_request_keys: claimKey } }
            );
            if (reversed?.success && Number(reversed.updated || 0) === 1) {
              return Response.json({ error: "Pul olish yozilmadi; kassa balansi qaytarildi. Qayta urinib ko\u2018ring." }, { status: 400 });
            }
          }
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: employeeName,
            action: "cash_withdrawal_needs_review",
            details: `${requestKey} \xB7 ${shift2.id} \xB7 ${amount} UZS \xB7 ${expenseCategory} \xB7 ${reason}. Balans band qilindi; qayta pul bermang.`
          }).catch(() => {
          });
          return Response.json({ error: "Pul operatsiyasi javobi noaniq. Qayta pul bermang; tarixni tekshiring yoki egasiga xabar bering.", operation_pending: true, reference_id: requestKey }, { status: 503 });
        }
      }
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: user.full_name || user.email,
        action: "cash_withdrawal",
        details: `${amount} UZS. ${expenseCategory}. ${recipientName || "Qabul qiluvchi yo\u2018q"}. ${reason}. Xodim: ${employeeName}`
      }).catch(() => {
      });
      const updatedShift2 = await service.entities.Shift.get(shift2.id);
      return Response.json({ movement, shift: updatedShift2 });
    }
    if (action === "check_stock") {
      if (body?.is_delivery !== void 0 && typeof body.is_delivery !== "boolean") {
        return Response.json({ error: "Dostavka belgisi noto\u2018g\u2018ri." }, { status: 400 });
      }
      const shiftId2 = String(body?.shift_id || "");
      const requestedItems2 = Array.isArray(body?.items) ? body.items : [];
      if (!shiftId2 || !requestedItems2.length) {
        return Response.json({ error: "Smena va mahsulotlar kerak." }, { status: 400 });
      }
      const shift2 = await service.entities.Shift.get(shiftId2);
      if (!shift2 || shift2.status !== "open") {
        return Response.json({ error: "Smena ochiq emas." }, { status: 409 });
      }
      if (shift2.user_id !== user.id) {
        return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
      }
      if (["cashier", "manager"].includes(user.role) && user.shop_id !== shift2.shop_id) {
        return Response.json({ error: "Kassir boshqa do\u2018konga biriktirilgan." }, { status: 403 });
      }
      let tableItems = null;
      if (body?.table_number !== void 0 || body?.table_order_id !== void 0 || body?.takeaway_order_id) {
        const takeaway = Boolean(body?.takeaway_order_id);
        if (takeaway && (body?.table_number !== void 0 || body?.table_order_id !== void 0)) {
          return Response.json({ error: "Buyurtma turi noto\u2018g\u2018ri." }, { status: 400 });
        }
        const number = body?.table_number;
        if (!takeaway && (String(body?.table_shop_id || "") !== shift2.shop_id || !Number.isInteger(number))) {
          return Response.json({ error: "Stol do\u2018koni yoki raqami noto\u2018g\u2018ri." }, { status: 403 });
        }
        const shop = await service.entities.Shop.get(shift2.shop_id).catch(() => null);
        const order = takeaway ? tableOrders(shop).find((row) => row.order_type === "takeaway" && row.id === body.takeaway_order_id) : tableOrderForNumber(shop, number);
        if (!shop || shop.active === false || shop.location_type !== "shop" || shop.allows_pos === false || !takeaway && (number < 1 || number > shop.restaurant_table_count) || !order || order.id !== (takeaway ? body.takeaway_order_id : body.table_order_id) || order.revision !== (takeaway ? body.takeaway_order_revision : body.table_order_revision) || order.state !== "occupied") {
          return Response.json({ error: "Stol buyurtmasi eskirgan yoki to\u2018lovda. Yangilang." }, { status: 409 });
        }
        const requested = /* @__PURE__ */ new Map();
        for (const row of requestedItems2) {
          if (!row?.product_id || !Number.isInteger(row.quantity) || row.quantity < 1 || requested.has(saleLineKey(row))) {
            return Response.json({ error: "Stol mahsulotlarini yangilang." }, { status: 409 });
          }
          requested.set(saleLineKey(row), row.quantity);
        }
        if (requested.size !== order.items?.length || order.items.some((row) => requested.get(saleLineKey(row)) !== row.quantity)) {
          return Response.json({ error: "Saqlanmagan stol o\u2018zgarishlari bor. Avval saqlang." }, { status: 409 });
        }
        tableItems = order.items;
      }
      const [normalizedItems2, allowNegativeStock2] = await Promise.all([
        normalizeSaleItems(service, requestedItems2, shift2.shop_id, tableItems),
        stockPolicy(service)
      ]);
      const recipeLoader2 = createCheckoutRecipeLoader(service, normalizedItems2.map((item) => item.product_id));
      const ingredientPrep2 = await prepareBranchIngredients(
        service,
        shift2.shop_id,
        normalizedItems2,
        recipeLoader2,
        body?.is_delivery === true || Boolean(body?.takeaway_order_id)
      );
      if (ingredientPrep2.shortages.length && !allowNegativeStock2) {
        return Response.json({
          error: "Branch omborida tex-karta masalliqlari yetarli emas: " + ingredientPrep2.shortages.map((row) => row.ingredient_name).join(", "),
          ingredient_shortages: ingredientPrep2.shortages,
          allow_negative_stock: false
        }, { status: 409 });
      }
      const { shortages } = await planSaleStock(service, shift2.shop_id, normalizedItems2);
      if (shortages.length && !allowNegativeStock2) {
        return Response.json({
          error: "Omborda mahsulot yetarli emas. Qoldiqsiz sotuv bloklangan.",
          shortages,
          allow_negative_stock: false
        }, { status: 409 });
      }
      return Response.json({ shortages, ingredient_shortages: ingredientPrep2.shortages, allow_negative_stock: allowNegativeStock2 });
    }
    if (action === "refund_sale") {
      if (!["admin", "manager"].includes(user.role)) {
        return Response.json({ error: "Savdoni qaytarishga ruxsat yo\u2018q." }, { status: 403 });
      }
      if (!await verifyOwnerPin(service, body?.owner_pin, user)) {
        return Response.json({ error: "Egasi PIN kodi noto\u2018g\u2018ri." }, { status: 403 });
      }
      const saleId = String(body?.sale_id || "");
      const reason = String(body?.reason || "").trim();
      if (!saleId || !reason) {
        return Response.json({ error: "Savdo va qaytarish sababi majburiy." }, { status: 400 });
      }
      const original = await service.entities.Sale.get(saleId);
      if (!original) return Response.json({ error: "Savdo topilmadi." }, { status: 404 });
      if (original.status !== "completed") {
        return Response.json({ error: "Bu savdo allaqachon qaytarilgan." }, { status: 409 });
      }
      const openShifts = await service.entities.Shift.filter({
        user_id: user.id,
        status: "open",
        shop_id: original.shop_id
      });
      const refundShift = openShifts?.[0];
      if (!refundShift) {
        return Response.json({ error: "Qaytarish uchun savdo qilingan do\u2018konda smenani oching." }, { status: 409 });
      }
      const refundPayments = Array.isArray(original.payments) ? original.payments : [];
      const byMethod = (method) => refundPayments.filter((payment) => payment.method === method).reduce((sum, payment) => sum + money(payment.amount), 0);
      const cash = byMethod("cash");
      const uzcard = byMethod("uzcard") + byMethod("bank_card");
      const humo = byMethod("humo");
      const online = byMethod("online") + byMethod("click") + byMethod("payme") + byMethod("other");
      const bank = byMethod("bank_transfer");
      if (cash > Number(refundShift.expected_cash || 0)) {
        return Response.json({ error: "Qaytarish uchun kassada kutilayotgan naqd pul yetarli emas." }, { status: 409 });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const day2 = now.slice(0, 10).replaceAll("-", "");
      const refundNumber = `RF-${day2}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const saleItemRows = await service.entities.SaleItem.filter({ sale_id: original.id });
      const restockItems = (saleItemRows || []).filter(
        (item) => item.stock_tracked_snapshot === true && Number(item.quantity || 0) > 0
      );
      let refund = null;
      let saleClaimed = false;
      let shiftAdjusted = false;
      const restocks = [];
      const refundMovements = [];
      const ingredientRestocks = [];
      const refundIngredientMovements = [];
      try {
        refund = await service.entities.Refund.create({
          refund_number: refundNumber,
          sale_id: original.id,
          sale_number: original.sale_number,
          shop_id: original.shop_id,
          shift_id: refundShift.id,
          cashier_id: user.id,
          cashier_name: user.full_name || user.email,
          amount: money(original.total),
          reason,
          payments: refundPayments,
          payment_summary: original.payment_methods_summary,
          created_at: now
        });
        const saleClaim = await service.entities.Sale.updateMany(
          { id: original.id, status: "completed" },
          { $set: {
            status: "refunded",
            refunded_at: now,
            refunded_by: user.id,
            refund_id: refund.id,
            refund_reason: reason
          } }
        );
        if (!saleClaim?.success || Number(saleClaim.updated || 0) !== 1) {
          throw httpError("Savdo boshqa qurilmada o\u2018zgargan. Yangilang va qayta urinib ko\u2018ring.", 409);
        }
        saleClaimed = true;
        const shiftUpdate2 = await service.entities.Shift.updateMany(
          { id: refundShift.id, status: "open" },
          { $inc: {
            cash_sales: -cash,
            uzcard_sales: -uzcard,
            humo_sales: -humo,
            online_sales: -online,
            bank_transfer_sales: -bank,
            total_sales: -money(original.total),
            expected_cash: -cash,
            refunds_total: money(original.total)
          } }
        );
        if (!shiftUpdate2?.success || Number(shiftUpdate2.updated || 0) !== 1) {
          throw httpError("Smena boshqa qurilmada o\u2018zgargan. Yangilang va qayta urinib ko\u2018ring.", 409);
        }
        shiftAdjusted = true;
        for (const item of restockItems) {
          const locationId = item.stock_location_id || original.shop_id;
          const rows = await service.entities.ProductStock.filter({
            location_id: locationId,
            product_id: item.product_id
          });
          if ((rows || []).length > 1) {
            throw httpError(`${item.product_name_snapshot} uchun takroriy ombor qoldig\u2018i topildi.`, 409);
          }
          const existing = rows?.[0] || null;
          const before = stockNumber(existing?.quantity || 0);
          const quantity = stockNumber(item.quantity);
          const after = stockNumber(before + quantity);
          let stockRecord = existing;
          if (existing) {
            const update = await service.entities.ProductStock.updateMany(
              { id: existing.id, quantity: before },
              { $set: {
                quantity: after,
                product_name: item.product_name_snapshot,
                location_name: original.shop_name,
                unit: "piece",
                updated_at: now,
                updated_by: user.id,
                updated_by_name: user.full_name || user.email
              } }
            );
            if (!update?.success || Number(update.updated || 0) !== 1) {
              throw httpError(`${item.product_name_snapshot} qoldig\u2018i boshqa qurilmada o\u2018zgardi.`, 409);
            }
          } else {
            stockRecord = await service.entities.ProductStock.create({
              location_id: locationId,
              location_name: original.shop_name,
              product_id: item.product_id,
              product_name: item.product_name_snapshot,
              unit: "piece",
              quantity: after,
              low_stock_level: 0,
              updated_at: now,
              updated_by: user.id,
              updated_by_name: user.full_name || user.email
            });
          }
          restocks.push({ stockRecord, quantity, product_id: item.product_id, after });
          const movement = await service.entities.StockMovement.create({
            movement_number: `ST-${day2}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            location_id: locationId,
            location_name: original.shop_name,
            item_kind: "product",
            item_id: item.product_id,
            item_name: item.product_name_snapshot,
            unit: "piece",
            movement_type: "refund",
            quantity_change: quantity,
            balance_before: before,
            balance_after: after,
            reason: `Savdo qaytarildi: ${original.sale_number || original.id}`,
            reference_id: refund.id,
            reference_type: "refund",
            user_id: user.id,
            user_name: user.full_name || user.email,
            created_at: now
          });
          refundMovements.push(movement);
        }
        if (original.shop_id === BRANCH_TECH_CARD_SHOP_ID) {
          await restoreSaleIngredientsOnRefund(service, {
            shopId: original.shop_id,
            shopName: original.shop_name,
            saleId: original.id,
            saleNumber: original.sale_number || original.id,
            refundId: refund.id,
            userId: user.id,
            userName: user.full_name || user.email,
            now,
            restocks: ingredientRestocks,
            movements: refundIngredientMovements
          });
        }
        try {
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: user.full_name || user.email,
            action: "sale_refunded",
            details: `${original.sale_number || original.id}. ${money(original.total)} UZS. ${reason}`
          });
        } catch {
        }
        return Response.json({
          refund,
          sale: {
            ...original,
            status: "refunded",
            refunded_at: now,
            refund_id: refund.id,
            refund_reason: reason
          },
          stock_updates: restocks.map((item) => ({
            product_id: item.product_id,
            quantity: item.after
          }))
        });
      } catch (error) {
        for (const movement of refundIngredientMovements) {
          try {
            await service.entities.StockMovement.delete(movement.id);
          } catch {
          }
        }
        for (const restock of ingredientRestocks) {
          try {
            await service.entities.IngredientStock.updateMany(
              { id: restock.stockRecord.id },
              { $inc: { quantity: -restock.quantity } }
            );
          } catch {
          }
        }
        for (const movement of refundMovements) {
          try {
            await service.entities.StockMovement.delete(movement.id);
          } catch {
          }
        }
        for (const restock of restocks) {
          try {
            await service.entities.ProductStock.updateMany(
              { id: restock.stockRecord.id },
              { $inc: { quantity: -restock.quantity } }
            );
          } catch {
          }
        }
        if (shiftAdjusted) {
          try {
            await service.entities.Shift.updateMany(
              { id: refundShift.id },
              { $inc: {
                cash_sales: cash,
                uzcard_sales: uzcard,
                humo_sales: humo,
                online_sales: online,
                bank_transfer_sales: bank,
                total_sales: money(original.total),
                expected_cash: cash,
                refunds_total: -money(original.total)
              } }
            );
          } catch {
          }
        }
        if (saleClaimed) {
          try {
            await service.entities.Sale.updateMany(
              { id: original.id },
              {
                $set: { status: "completed" },
                $unset: {
                  refunded_at: "",
                  refunded_by: "",
                  refund_id: "",
                  refund_reason: ""
                }
              }
            );
          } catch {
          }
        }
        if (refund?.id) {
          try {
            await service.entities.Refund.delete(refund.id);
          } catch {
          }
        }
        throw error;
      }
    }
    if (action !== "complete_sale") {
      return Response.json({ error: "Unknown Kassa action." }, { status: 400 });
    }
    if (body?.is_delivery !== void 0 && typeof body.is_delivery !== "boolean") {
      return Response.json({ error: "Dostavka belgisi noto\u2018g\u2018ri." }, { status: 400 });
    }
    const isDelivery = body?.is_delivery === true;
    const shiftId = String(body?.shift_id || "");
    const requestedItems = Array.isArray(body?.items) ? body.items : [];
    const requestedPayments = Array.isArray(body?.payments) ? body.payments : [];
    const requestedDiscountCode = String(body?.discount_code || "").trim().toUpperCase();
    const roundingRequested = body?.rounding_total !== void 0 && body?.rounding_total !== null;
    const manualRequested = body?.manual_discount_amount !== void 0 && body?.manual_discount_amount !== null;
    idempotencyKey = String(body?.idempotency_key || "").trim();
    if (idempotencyKey && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return Response.json({ error: "Savdo so\u2018rovining xavfsizlik kaliti noto\u2018g\u2018ri." }, { status: 400 });
    }
    const requestFingerprint = idempotencyKey ? await saleRequestFingerprint(body) : "";
    let requestedShiftRead = null;
    if (idempotencyKey) {
      const [saleRead, shiftRead] = await Promise.allSettled([
        service.entities.Sale.filter(
          { idempotency_key: idempotencyKey },
          "-created_date",
          2
        ),
        shiftId ? service.entities.Shift.get(shiftId) : Promise.resolve(null)
      ]);
      requestedShiftRead = shiftRead;
      if (saleRead.status === "rejected") throw saleRead.reason;
      const existingMatches = saleRead.value;
      if ((existingMatches || []).length > 1) {
        return Response.json({
          error: "Bu savdo kaliti bo\u2018yicha takroriy server yozuvlari topildi. OWNER tekshirishi kerak."
        }, { status: 409 });
      }
      const existingSale = existingMatches?.[0];
      if (existingSale) {
        if (existingSale.user_id !== user.id || existingSale.shift_id !== shiftId || existingSale.is_delivery === true !== isDelivery || existingSale.request_fingerprint && existingSale.request_fingerprint !== requestFingerprint) {
          return Response.json({
            error: "Bu savdo kaliti boshqa savdo uchun ishlatilgan."
          }, { status: 409 });
        }
        const existingShift = shiftRead.status === "fulfilled" ? shiftRead.value : null;
        if (existingSale.financial_records_version >= 3 && !(existingShift?.sale_request_keys || []).includes(`sale-completed:${idempotencyKey}`)) {
          return Response.json({ error: "Savdo yozuvlari hali yakunlanmagan. Shu kalit bilan qayta tekshiriladi." }, { status: 503 });
        }
        let tableReleased2 = true;
        if (existingSale.table_order_id_snapshot) {
          try {
            tableReleased2 = await changeLockedTable(
              service,
              existingSale.shop_id,
              existingSale.table_order_id_snapshot,
              idempotencyKey,
              true
            );
          } catch {
            tableReleased2 = false;
          }
        }
        return Response.json({
          sale: existingSale,
          shift: existingShift,
          stock_updates: [],
          table_released: tableReleased2,
          already_processed: true
        });
      }
    }
    if (!shiftId || requestedItems.length === 0) {
      return Response.json({ error: "Smena va mahsulotlar majburiy." }, { status: 400 });
    }
    if (requestedShiftRead?.status === "rejected") throw requestedShiftRead.reason;
    const shift = requestedShiftRead?.status === "fulfilled" ? requestedShiftRead.value : await service.entities.Shift.get(shiftId);
    if (shift && shift.user_id === user.id && (user.role === "admin" || shift.shop_id === user.shop_id) && idempotencyKey && pendingSaleResolutions(shift)[idempotencyKey]) {
      return Response.json({
        error: "Bu navbatdagi savdo egasi PIN-kodi bilan bekor qilingan yoki tahrirlangan. Navbat oynasidan holatini tekshiring.",
        queue_resolution: true
      }, { status: 410 });
    }
    if (!shift || shift.status !== "open") {
      return Response.json({ error: "The shift is not open." }, { status: 409 });
    }
    if (shift.user_id !== user.id) {
      return Response.json({ error: "This shift belongs to another user." }, { status: 403 });
    }
    if (["cashier", "manager"].includes(user.role) && !user.shop_id) {
      return Response.json({ error: "Owner must assign this cashier to a shop first." }, { status: 403 });
    }
    if (["cashier", "manager"].includes(user.role) && user.shop_id !== shift.shop_id) {
      return Response.json({ error: "This cashier is assigned to a different shop." }, { status: 403 });
    }
    const hasTable = body?.table_number !== void 0 && body?.table_number !== null;
    const hasTakeaway = Boolean(body?.takeaway_order_id);
    if (hasTable && isDelivery) {
      return Response.json({ error: "Stol buyurtmasini dostavka deb belgilab bo\u2018lmaydi." }, { status: 400 });
    }
    if (hasTakeaway && (hasTable || body?.table_order_id || body?.table_shop_id)) {
      return Response.json({ error: "Buyurtma turi noto\u2018g\u2018ri." }, { status: 400 });
    }
    const requestedTableNumber = body?.table_number;
    const requestedTableShopId = String(body?.table_shop_id || "");
    if (!hasTable && requestedTableShopId || hasTable && (typeof requestedTableNumber !== "number" || !Number.isInteger(requestedTableNumber) || requestedTableNumber < 1 || !requestedTableShopId || requestedTableShopId !== shift.shop_id)) {
      return Response.json({ error: "Stol yoki do\u2018kon tanlovi noto\u2018g\u2018ri. Stollar xaritasidan qayta tanlang." }, { status: 403 });
    }
    const productsAtSale = /* @__PURE__ */ new Map();
    const [receiptShop, ordinaryItems, allowNegativeStock, discountRead] = await Promise.all([
      (async () => {
        if (!service.entities.Shop?.get) return null;
        try {
          return await service.entities.Shop.get(shift.shop_id);
        } catch (error) {
          console.warn("Receipt shop details could not be loaded:", error);
          return null;
        }
      })(),
      // Ordinary sale prices and shop contacts are independent reads after
      // shift ownership is verified. Saved table prices wait for the shop.
      !hasTable && !hasTakeaway ? normalizeSaleItems(service, requestedItems, shift.shop_id, null, productsAtSale) : Promise.resolve(null),
      stockPolicy(service),
      // Read coupons alongside other preflight data, but surface lookup errors
      // only after the same stock/ingredient validations as before.
      requestedDiscountCode ? Promise.allSettled([service.entities.DiscountCode.filter({
        code: requestedDiscountCode,
        active: true
      })]).then(([result]) => result) : Promise.resolve(null)
    ]);
    if (hasTable && (!receiptShop || receiptShop.active === false || receiptShop.location_type !== "shop" || receiptShop.allows_pos === false || !Number.isInteger(receiptShop.restaurant_table_count) || requestedTableNumber > receiptShop.restaurant_table_count)) {
      return Response.json({ error: "Bu do\u2018konda ko\u2018rsatilgan stol mavjud emas. Stollar xaritasini yangilang." }, { status: 409 });
    }
    const tableOrder = hasTakeaway ? tableOrders(receiptShop).find((row) => row.order_type === "takeaway" && row.id === body.takeaway_order_id) : hasTable ? tableOrderForNumber(receiptShop, requestedTableNumber) : null;
    if (hasTable || hasTakeaway) {
      const orderId = hasTakeaway ? body.takeaway_order_id : body?.table_order_id;
      const revision = hasTakeaway ? body.takeaway_order_revision : body?.table_order_revision;
      if (hasTakeaway && (!receiptShop || receiptShop.active === false || receiptShop.location_type !== "shop" || receiptShop.allows_pos === false)) {
        return Response.json({ error: "Buyurtma do\u2018koni faol emas." }, { status: 409 });
      }
      if (!tableOrder || !orderId || orderId !== tableOrder.id || !Number.isInteger(revision) || revision !== tableOrder.revision) {
        return Response.json({ error: "Stol buyurtmasi eski yoki saqlanmagan. Stolni yangilang va qayta tekshiring." }, { status: 409 });
      }
      if (hasTakeaway && tableOrder.is_delivery === true !== isDelivery) {
        return Response.json({ error: "Dostavka belgisi saqlangan buyurtmadan farq qiladi. Avval buyurtmani saqlang." }, { status: 409 });
      }
      if (tableOrder.state !== "occupied") {
        return Response.json({ error: "Bu stol bo\u2018yicha to\u2018lov allaqachon boshlangan. Savdolar tarixini tekshiring." }, { status: 409 });
      }
      const requested = /* @__PURE__ */ new Map();
      for (const row of requestedItems) {
        const id = saleLineKey(row);
        if (!row?.product_id || !Number.isInteger(row?.quantity) || row.quantity < 1 || requested.has(id)) {
          return Response.json({ error: "Stol mahsulotlari noto\u2018g\u2018ri. Buyurtmani yangilang." }, { status: 409 });
        }
        requested.set(id, row.quantity);
      }
      if (requested.size !== tableOrder.items?.length || tableOrder.items.some((item) => requested.get(saleLineKey(item)) !== item.quantity)) {
        return Response.json({ error: "Stol savati saqlangan buyurtmadan farq qiladi. Avval saqlang." }, { status: 409 });
      }
    }
    const normalizedItems = ordinaryItems || await normalizeSaleItems(service, requestedItems, shift.shop_id, tableOrder?.items || null, productsAtSale);
    const recipeLoader = createCheckoutRecipeLoader(service, normalizedItems.map((item) => item.product_id));
    const ingredientPreparation = prepareBranchIngredients(
      service,
      shift.shop_id,
      normalizedItems,
      recipeLoader,
      body?.is_delivery === true || Boolean(body?.takeaway_order_id)
    );
    const [{ plans: stockPlans, shortages: stockWarnings }, unitCostByProduct, ingredientPrep] = await Promise.all([
      // Branch recipes can turn off finished-product stock tracking. Wait for
      // that decision while independent cost snapshots read the same raw cards.
      ingredientPreparation.then(() => planSaleStock(service, shift.shop_id, normalizedItems)),
      shift.shop_id === BRANCH_TECH_CARD_SHOP_ID ? ingredientPreparation.then(() => loadSaleCostSnapshots(service, normalizedItems, productsAtSale, recipeLoader, isDelivery || hasTakeaway)) : loadSaleCostSnapshots(service, normalizedItems, productsAtSale, recipeLoader, isDelivery || hasTakeaway),
      ingredientPreparation
    ]);
    if (ingredientPrep.shortages.length && !allowNegativeStock) {
      throw httpError("Branch omborida tex-karta masalliqlari yetarli emas: " + ingredientPrep.shortages.map((row) => row.ingredient_name).join(", "), 409);
    }
    if (stockWarnings.length && !allowNegativeStock) {
      return Response.json({
        error: "Omborda mahsulot yetarli emas. Qoldiqsiz sotuv bloklangan.",
        shortages: stockWarnings,
        allow_negative_stock: false
      }, { status: 409 });
    }
    const subtotal = normalizedItems.reduce((sum, item) => sum + item.subtotal, 0);
    let discountCode = "";
    let discountPercentage = 0;
    if (requestedDiscountCode) {
      if (discountRead?.status === "rejected") throw discountRead.reason;
      const matches = discountRead?.status === "fulfilled" ? discountRead.value : [];
      const discount = matches?.[0];
      if (!discount) {
        return Response.json({ error: "Discount code is invalid or inactive." }, { status: 409 });
      }
      if (discount.single_use !== false && Number(discount.usage_count || 0) >= 1) {
        return Response.json({ error: "This discount code has already been used." }, { status: 409 });
      }
      if (isDiscountExpired(discount)) {
        return Response.json({ error: "Chegirma kodining muddati tugagan." }, { status: 409 });
      }
      discountPercentage = Number(discount.percentage);
      if (!Number.isFinite(discountPercentage) || discountPercentage <= 0 || discountPercentage > 100) {
        return Response.json({ error: "Discount percentage is invalid." }, { status: 409 });
      }
      discountCode = discount.code;
      claimedDiscount = discount;
      if (["cashier", "manager"].includes(user.role) && discountPercentage === 100 && !await verifyOwnerPin(service, body?.owner_pin, user)) {
        return Response.json({
          error: "100% chegirma bilan savdoni yakunlash uchun OWNER PIN kerak.",
          requires_owner_pin: true
        }, { status: 403 });
      }
    }
    let discountAmount = money(subtotal * discountPercentage / 100);
    if (roundingRequested || manualRequested) {
      const step = subtotal >= 1e4 ? 5e3 : subtotal >= 1e3 ? 1e3 : 100;
      const expectedRoundedTotal = Math.floor(subtotal / step) * step;
      const manualAmount = body.manual_discount_amount;
      const target = manualRequested ? subtotal - manualAmount : body.rounding_total;
      const reduction = subtotal - target;
      if (requestedDiscountCode || roundingRequested && manualRequested || !Number.isSafeInteger(subtotal) || !Number.isSafeInteger(target) || target <= 0 || manualRequested && (typeof manualAmount !== "number" || !Number.isSafeInteger(manualAmount)) || roundingRequested && (typeof body.rounding_total !== "number" || target !== expectedRoundedTotal) || reduction <= 0) {
        return Response.json({ error: "Chegirma noto\u2018g\u2018ri: kupon bilan qo\u2018shilmaydi; yaxlitlash faqat pastga va yakuniy summa kamida 1 so\u2018m bo\u2018lishi kerak." }, { status: 400 });
      }
      discountAmount = reduction;
      discountCode = manualRequested ? "QAYTIB_BERISH" : "YAXLITLASH";
    }
    const total = Math.max(0, subtotal - discountAmount);
    const normalizedPayments = requestedPayments.map((payment) => ({
      method: String(payment?.method || ""),
      amount: money(payment?.amount),
      reference: String(payment?.reference || "").trim()
    }));
    if (total > 0 && normalizedPayments.length === 0) {
      return Response.json({ error: "Kamida bitta to\u2018lov usulini kiriting." }, { status: 400 });
    }
    if (normalizedPayments.some((payment) => !PAYMENT_METHODS.has(payment.method) || payment.amount <= 0)) {
      return Response.json({ error: "To\u2018lov usuli yoki summasi noto\u2018g\u2018ri." }, { status: 400 });
    }
    const paidTotal = normalizedPayments.reduce((sum, payment) => sum + payment.amount, 0);
    if (paidTotal !== total) {
      return Response.json({
        error: `To\u2018lovlar savdo summasiga teng bo\u2018lishi kerak. Kutilgan: ${total}, kiritilgan: ${paidTotal}.`
      }, { status: 400 });
    }
    const receivedAt = (/* @__PURE__ */ new Date()).toISOString();
    const soldAt = idempotencyKey ? resolveSoldAt(body?.recorded_at, shift, receivedAt) : receivedAt;
    if (shift.shop_id === "6a96f0a4ecc85c2fc57f3173" && idempotencyKey && !tableOrder && Date.parse(receivedAt) - Date.parse(soldAt) > 6e4) {
      const nowMs = Date.parse(receivedAt);
      const resumeMs = Number(shift.checkout_queue_resume_ms || 0);
      const throttled = (retryMs) => Response.json({
        error: "Oldingi savdolar server chegarasiga mos tezlikda yuborilmoqda. Avtomatik davom etadi.",
        retry_after_ms: Math.max(1e3, retryMs)
      }, { status: 429 });
      if (resumeMs > nowMs) return throttled(resumeMs - nowMs);
      const gapMs = Math.max(2e4, (stockPlans.length + ingredientPrep.plans.length + 6) * 3e3);
      const slot = await service.entities.Shift.updateMany({
        id: shift.id,
        status: "open",
        $or: [
          { checkout_queue_resume_ms: { $exists: false } },
          { checkout_queue_resume_ms: null },
          { checkout_queue_resume_ms: { $lte: nowMs } }
        ]
      }, { $set: { checkout_queue_resume_ms: nowMs + gapMs } });
      if (!slot?.success || Number(slot.updated || 0) !== 1) return throttled(gapMs);
    }
    if (tableOrder) {
      if (!idempotencyKey) return Response.json({ error: "Stol to\u2018lovi uchun takrorlanmas kalit kerak." }, { status: 400 });
      const claim = await service.entities.Shop.updateMany(
        {
          id: receiptShop.id,
          ...hasTable ? { restaurant_table_count: receiptShop.restaurant_table_count } : {},
          ...tableVersionQuery(tableOrdersVersion(receiptShop))
        },
        {
          $set: { restaurant_table_orders: tableOrders(receiptShop).map((row) => row.id === tableOrder.id ? { ...row, state: "paying", checkout_key: idempotencyKey } : row) },
          $inc: { restaurant_table_orders_version: 1 }
        }
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ error: "Stol boshqa kassada o\u2018zgardi yoki to\u2018lov boshlangan. Xaritani yangilang." }, { status: 409 });
      }
      tablePaymentLock = { shopId: receiptShop.id, orderId: tableOrder.id, checkoutKey: idempotencyKey };
    }
    const businessDate = tashkentBusinessDate(soldAt);
    const day = businessDate.replaceAll("-", "");
    const saleNumber = saleNumberFor(idempotencyKey, soldAt);
    const paymentSummary = normalizedPayments.length ? normalizedPayments.map((payment) => payment.method).join(" + ") : "100% chegirma";
    if (idempotencyKey) {
      const claim = await service.entities.Shift.updateMany(
        { id: shift.id, status: "open", sale_request_keys: { $ne: idempotencyKey } },
        { $push: { sale_request_keys: idempotencyKey } }
      );
      console.info("[Odina checkout claim]", JSON.stringify({
        request_key: idempotencyKey,
        shift_id: shift.id,
        success: claim?.success,
        updated: claim?.updated
      }));
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        const completedMatches = await service.entities.Sale.filter(
          { idempotency_key: idempotencyKey },
          "-created_date",
          2
        );
        const completedSale = completedMatches?.[0];
        if (completedSale && completedSale.user_id === user.id && completedSale.shift_id === shift.id && (!completedSale.request_fingerprint || completedSale.request_fingerprint === requestFingerprint)) {
          const completedShift = await service.entities.Shift.get(shift.id).catch(() => null);
          if (completedSale.financial_records_version >= 3 && !(completedShift?.sale_request_keys || []).includes(`sale-completed:${idempotencyKey}`)) {
            return Response.json({ error: "Savdo yozuvlari hali yakunlanmagan. Shu kalit bilan qayta tekshiriladi." }, { status: 503 });
          }
          let tableReleased2 = true;
          if (completedSale.table_order_id_snapshot) {
            try {
              tableReleased2 = await changeLockedTable(
                service,
                completedSale.shop_id,
                completedSale.table_order_id_snapshot,
                idempotencyKey,
                true
              );
            } catch {
              tableReleased2 = false;
            }
          }
          return Response.json({
            sale: completedSale,
            shift: completedShift,
            stock_updates: [],
            table_released: tableReleased2,
            already_processed: true
          });
        }
        if (tablePaymentLock) {
          await changeLockedTable(
            service,
            tablePaymentLock.shopId,
            tablePaymentLock.orderId,
            tablePaymentLock.checkoutKey,
            false
          ).catch(() => false);
        }
        return Response.json({
          error: "Savdo serverda yakunlanmoqda. Bir ozdan so\u2018ng avtomatik qayta yuboriladi."
        }, { status: 503 });
      }
      idempotencyClaimed = true;
      idempotencyShiftId = shift.id;
    }
    if (claimedDiscount && claimedDiscount.single_use !== false) {
      const discountClaim = await service.entities.DiscountCode.updateMany(
        { id: claimedDiscount.id, active: true },
        {
          $inc: { usage_count: 1 },
          $set: { active: false, used_at: soldAt }
        }
      );
      if (!discountClaim?.success || Number(discountClaim.updated || 0) !== 1) {
        throw httpError("Bu chegirma kodi boshqa kassada ishlatildi.", 409);
      }
      discountChanged = true;
    }
    for (let start = 0; start < stockPlans.length; start += 4) {
      const batch = stockPlans.slice(start, start + 4);
      await settleCheckoutWrites(batch.map((plan) => async () => {
        let stockRecord = plan.stock;
        if (stockRecord) {
          const update = await service.entities.ProductStock.updateMany(
            { id: stockRecord.id, quantity: plan.before },
            { $set: {
              quantity: plan.after,
              location_name: shift.shop_name,
              product_name: plan.item.product_name,
              unit: "piece",
              updated_at: receivedAt,
              updated_by: user.id,
              updated_by_name: user.full_name || user.email
            } }
          );
          if (!update?.success || Number(update.updated || 0) !== 1) {
            throw httpError(`${plan.item.product_name} qoldig\u2018i boshqa qurilmada o\u2018zgardi. Yangilang va qayta urinib ko\u2018ring.`, 409);
          }
        } else {
          stockRecord = await service.entities.ProductStock.create({
            location_id: shift.shop_id,
            location_name: shift.shop_name,
            product_id: plan.item.product_id,
            product_name: plan.item.product_name,
            unit: "piece",
            quantity: plan.after,
            low_stock_level: 0,
            updated_at: receivedAt,
            updated_by: user.id,
            updated_by_name: user.full_name || user.email
          });
        }
        stockChanges.push({ ...plan, stockRecord });
      }));
    }
    stockChanges.sort((left, right) => stockPlans.findIndex((plan) => plan.item.product_id === left.item.product_id) - stockPlans.findIndex((plan) => plan.item.product_id === right.item.product_id));
    const serviceTicketNumber = Number.isSafeInteger(tableOrder?.ticket_number) && tableOrder.ticket_number > 0 ? tableOrder.ticket_number : await allocateServiceTicketNumber(service, shift.shop_id, receiptShop);
    sale = await service.entities.Sale.create({
      sale_number: saleNumber,
      service_ticket_number: serviceTicketNumber,
      is_delivery: isDelivery,
      idempotency_key: idempotencyKey || void 0,
      request_fingerprint: requestFingerprint || void 0,
      sold_at: soldAt,
      business_date: businessDate,
      financial_records_version: 3,
      sale_items_count: normalizedItems.length,
      shift_id: shift.id,
      user_id: user.id,
      user_name: user.full_name || user.email,
      shop_id: shift.shop_id,
      shop_name: shift.shop_name,
      ...hasTable ? { table_number_snapshot: requestedTableNumber } : {},
      ...tableOrder ? {
        table_order_id_snapshot: tableOrder.id,
        table_order_revision_snapshot: tableOrder.revision
      } : {},
      receipt_instagram_snapshot: String(receiptShop?.instagram || "").trim().replace(/^@/, ""),
      receipt_phone_snapshot: String(receiptShop?.phone || "").trim(),
      receipt_address_snapshot: String(receiptShop?.address || "").trim(),
      items: normalizedItems,
      subtotal,
      discount_code: discountCode || void 0,
      discount_amount: discountAmount,
      total,
      payments: normalizedPayments.map(({ method, amount }) => ({ method, amount })),
      payment_methods_summary: paymentSummary,
      status: "completed"
    });
    let allocatedDiscount = 0;
    const itemPayloads = normalizedItems.map((item, index) => {
      const itemDiscount = index === normalizedItems.length - 1 ? discountAmount - allocatedDiscount : money(discountAmount * item.subtotal / subtotal);
      allocatedDiscount += itemDiscount;
      const costInfo = unitCostByProduct.get(saleLineKey(item)) || { costPerPiece: 0, hasPrice: false };
      const snapUnitCost = item.sale_unit !== "gram" && costInfo.hasPrice ? money(costInfo.costPerPiece) : 0;
      const snapTotalCost = snapUnitCost * item.quantity;
      return {
        sale_id: sale.id,
        sale_number: saleNumber,
        shop_id: shift.shop_id,
        shift_id: shift.id,
        cashier_id: user.id,
        product_id: item.product_id,
        source_type_snapshot: item.source_type,
        stock_tracked_snapshot: item.stock_tracked,
        stock_location_id: item.stock_location_id || void 0,
        stock_quantity_change: item.stock_quantity_change,
        product_name_snapshot: item.product_name,
        ...saleOptionFields(item),
        image_url_snapshot: item.image_url,
        quantity: item.quantity,
        unit_price: item.price,
        sale_unit: item.sale_unit,
        discount_amount: itemDiscount,
        line_total: item.subtotal - itemDiscount,
        unit_cost_at_sale: snapUnitCost,
        total_cost_at_sale: snapTotalCost,
        cost_is_estimate: item.sale_unit === "gram" || !costInfo.hasPrice,
        created_at: soldAt
      };
    });
    await settleCheckoutWrites([
      async () => {
        saleItems = await service.entities.SaleItem.bulkCreate(itemPayloads);
      },
      async () => {
        paymentRecords = normalizedPayments.length ? await service.entities.Payment.bulkCreate(
          normalizedPayments.map((payment) => ({
            sale_id: sale.id,
            sale_number: saleNumber,
            shop_id: shift.shop_id,
            shift_id: shift.id,
            cashier_id: user.id,
            method: payment.method,
            amount: payment.amount,
            reference: payment.reference || void 0,
            created_at: soldAt
          }))
        ) : [];
      },
      async () => {
        for (let start = 0; start < stockChanges.length; start += 4) {
          const batch = stockChanges.slice(start, start + 4);
          await settleCheckoutWrites(batch.map((change) => async () => {
            const movement = await service.entities.StockMovement.create({
              movement_number: `ST-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
              location_id: shift.shop_id,
              location_name: shift.shop_name,
              item_kind: "product",
              item_id: change.item.product_id,
              item_name: change.item.product_name,
              unit: "piece",
              movement_type: "sale",
              quantity_change: -change.item.quantity,
              balance_before: change.before,
              balance_after: change.after,
              reason: `Kassa savdosi ${saleNumber}`,
              reference_id: sale.id,
              reference_type: "sale",
              user_id: user.id,
              user_name: user.full_name || user.email,
              created_at: soldAt
            });
            stockMovementRecords.push(movement);
          }));
        }
      },
      async () => {
        await applySaleIngredientDeduction(service, {
          shopId: shift.shop_id,
          shopName: shift.shop_name,
          saleId: sale.id,
          saleNumber,
          userId: user.id,
          userName: user.full_name || user.email,
          now: soldAt,
          plans: ingredientPrep.plans,
          lines: ingredientPrep.lines,
          applied: ingredientChanges,
          movements: ingredientMovementRecords
        });
      }
    ]);
    if (claimedDiscount) {
      if (claimedDiscount.single_use !== false) {
        await service.entities.DiscountCode.update(claimedDiscount.id, {
          used_by_sale_id: sale.id
        });
      } else {
        const discountUpdate = await service.entities.DiscountCode.updateMany(
          { id: claimedDiscount.id, active: true },
          {
            $inc: { usage_count: 1 },
            $set: { used_at: soldAt, used_by_sale_id: sale.id }
          }
        );
        if (!discountUpdate?.success || Number(discountUpdate.updated || 0) !== 1) {
          throw httpError("Chegirma kodini ishlatilgan deb belgilab bo\u2018lmadi.", 409);
        }
        discountChanged = true;
      }
    }
    const cashIncrement = normalizedPayments.filter((payment) => payment.method === "cash").reduce((sum, payment) => sum + payment.amount, 0);
    const uzcardIncrement = normalizedPayments.filter((payment) => ["bank_card", "uzcard"].includes(payment.method)).reduce((sum, payment) => sum + payment.amount, 0);
    const humoIncrement = normalizedPayments.filter((payment) => payment.method === "humo").reduce((sum, payment) => sum + payment.amount, 0);
    const onlineIncrement = normalizedPayments.filter((payment) => ["online", "click", "payme", "other"].includes(payment.method)).reduce((sum, payment) => sum + payment.amount, 0);
    const bankTransferIncrement = normalizedPayments.filter((payment) => payment.method === "bank_transfer").reduce((sum, payment) => sum + payment.amount, 0);
    const shiftUpdate = await service.entities.Shift.updateMany(
      { id: shift.id, status: "open" },
      {
        $inc: {
          cash_sales: cashIncrement,
          uzcard_sales: uzcardIncrement,
          humo_sales: humoIncrement,
          online_sales: onlineIncrement,
          bank_transfer_sales: bankTransferIncrement,
          total_sales: total,
          expected_cash: cashIncrement,
          order_count: 1
        },
        ...idempotencyKey ? { $push: { sale_request_keys: `sale-completed:${idempotencyKey}` } } : {}
      }
    );
    if (!shiftUpdate?.success || Number(shiftUpdate.updated || 0) !== 1) {
      throw new Error("The shift changed while the sale was being completed.");
    }
    const updatedShift = {
      ...shift,
      cash_sales: Number(shift.cash_sales || 0) + cashIncrement,
      uzcard_sales: Number(shift.uzcard_sales || 0) + uzcardIncrement,
      humo_sales: Number(shift.humo_sales || 0) + humoIncrement,
      online_sales: Number(shift.online_sales || 0) + onlineIncrement,
      bank_transfer_sales: Number(shift.bank_transfer_sales || 0) + bankTransferIncrement,
      total_sales: Number(shift.total_sales || 0) + total,
      expected_cash: Number(shift.expected_cash || 0) + cashIncrement,
      order_count: Number(shift.order_count || 0) + 1
    };
    let tableReleased = true;
    await Promise.all([
      (async () => {
        if (tablePaymentLock) {
          try {
            tableReleased = await changeLockedTable(
              service,
              tablePaymentLock.shopId,
              tablePaymentLock.orderId,
              tablePaymentLock.checkoutKey,
              true
            );
          } catch {
            tableReleased = false;
          }
          if (!tableReleased) console.error("Paid table still locked; retry the SAME sale key to reconcile.");
        }
      })(),
      (async () => {
        try {
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: user.full_name || user.email,
            action: "sale_completed",
            details: `${saleNumber}. Total ${total} UZS via ${paymentSummary}. ${normalizedItems.length} lines.`
          });
        } catch {
        }
      })()
    ]);
    return Response.json({
      sale,
      sale_items: saleItems,
      payments: paymentRecords,
      table_released: tableReleased,
      shift: updatedShift,
      stock_warnings: stockWarnings,
      ingredient_warnings: ingredientPrep.shortages,
      allow_negative_stock: allowNegativeStock,
      backend_timing: readTracker.snapshot(),
      stock_updates: stockChanges.map((change) => ({
        product_id: change.item.product_id,
        quantity: change.after
      }))
    });
  } catch (error) {
    console.error("[Odina checkout failure]", JSON.stringify({
      action: trackedAction,
      request_key: idempotencyKey,
      shift_id: idempotencyShiftId,
      claim_acknowledged: idempotencyClaimed,
      sale_id: sale?.id || "",
      stock_writes: stockChanges.length,
      payment_writes: paymentRecords.length,
      error: error instanceof Error ? error.message : String(error),
      status: Number(error?.status || error?.response?.status || 0)
    }));
    let rollbackSafe = true;
    for (const movement of ingredientMovementRecords) {
      try {
        await service.entities.StockMovement.delete(movement.id);
      } catch {
        rollbackSafe = false;
      }
    }
    for (const change of ingredientChanges) {
      try {
        const restored = await service.entities.IngredientStock.updateMany(
          { id: change.stockId },
          { $inc: { quantity: change.quantity } }
        );
        if (!restored?.success || Number(restored.updated || 0) !== 1) rollbackSafe = false;
      } catch {
        rollbackSafe = false;
      }
    }
    for (const movement of stockMovementRecords) {
      try {
        await base44.asServiceRole.entities.StockMovement.delete(movement.id);
      } catch {
        rollbackSafe = false;
      }
    }
    for (const change of stockChanges) {
      try {
        await base44.asServiceRole.entities.ProductStock.updateMany(
          { id: change.stockRecord.id },
          { $inc: { quantity: change.item.quantity } }
        );
      } catch {
        rollbackSafe = false;
      }
    }
    if (claimedDiscount && discountChanged) {
      try {
        await base44.asServiceRole.entities.DiscountCode.update(claimedDiscount.id, {
          usage_count: Number(claimedDiscount.usage_count || 0),
          used_at: claimedDiscount.used_at,
          used_by_sale_id: claimedDiscount.used_by_sale_id,
          active: claimedDiscount.active
        });
      } catch {
        rollbackSafe = false;
      }
    }
    for (const record of paymentRecords) {
      try {
        await base44.asServiceRole.entities.Payment.delete(record.id);
      } catch {
        rollbackSafe = false;
      }
    }
    for (const record of saleItems) {
      try {
        await base44.asServiceRole.entities.SaleItem.delete(record.id);
      } catch {
        rollbackSafe = false;
      }
    }
    if (sale) {
      try {
        await base44.asServiceRole.entities.Sale.delete(sale.id);
      } catch {
        rollbackSafe = false;
      }
    }
    if (rollbackSafe && idempotencyClaimed && idempotencyShiftId && idempotencyKey) {
      try {
        await base44.asServiceRole.entities.Shift.updateMany(
          { id: idempotencyShiftId },
          { $pull: { sale_request_keys: idempotencyKey } }
        );
      } catch {
        rollbackSafe = false;
      }
    }
    if (!rollbackSafe) console.error("[Odina checkout rollback incomplete]", JSON.stringify({
      request_key: idempotencyKey,
      shift_id: idempotencyShiftId,
      sale_id: sale?.id || ""
    }));
    if (tablePaymentLock && rollbackSafe) {
      try {
        const matches = await service.entities.Sale.filter({ idempotency_key: tablePaymentLock.checkoutKey }, "-created_date", 2);
        if (!(matches || []).length) {
          await changeLockedTable(
            service,
            tablePaymentLock.shopId,
            tablePaymentLock.orderId,
            tablePaymentLock.checkoutKey,
            false
          );
        }
      } catch {
      }
    }
    const transient = Boolean(trackedAction) && isTransientCheckoutError(error);
    return Response.json({
      error: transient ? "Server ma\u2019lumotlar bazasiga vaqtincha ulanib bo\u2018lmadi. Savdo holatini tekshiring va shu so\u2018rov bilan qayta urinib ko\u2018ring." : error instanceof Error ? error.message : "Savdoni yakunlab bo\u2018lmadi.",
      ...transient ? { server_recovery_attempted: readTracker.snapshot().read_retries > 0 } : {}
    }, { status: transient ? 503 : Number(error?.status || 500) });
  } finally {
    if (trackedAction) console.info("[Odina backend timing]", JSON.stringify({
      action: trackedAction,
      ...readTracker.snapshot()
    }));
  }
}
export {
  entry_default as default
};
