import { createClientFromRequest } from "npm:@base44/sdk";

const PAYMENT_METHODS = new Set([
  "cash",
  "uzcard",
  "humo",
  "click",
  "payme",
  "bank_transfer",
  "other",
]);

const money = (value: unknown) => Math.round(Number(value) || 0);
const stockNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : 0;
};

const httpError = (message: string, status: number) => {
  const error: any = new Error(message);
  error.status = status;
  return error;
};

const BUDGET_ACCOUNT_LABELS: Record<string, string> = {
  cash: "Naqd pul",
  uzcard: "Uzcard",
  humo: "Humo",
  online: "Onlayn",
  bank: "Bank",
};

async function creditBudgetBalance(service: any, account: string, amount: number, user: any, now: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await service.entities.BudgetBalance.filter({ account });
    if ((rows || []).length > 1) {
      throw httpError(`${BUDGET_ACCOUNT_LABELS[account]} uchun takroriy Budget balansi topildi.`, 409);
    }

    const current = rows?.[0];
    if (!current) {
      try {
        const created = await service.entities.BudgetBalance.create({
          account,
          label: BUDGET_ACCOUNT_LABELS[account],
          balance: amount,
          updated_at: now,
          updated_by_id: user.id,
          updated_by_name: user.full_name || user.email,
        });
        return { record: created, before: 0, after: amount };
      } catch (_) {
        continue;
      }
    }

    const before = money(current.balance);
    const after = before + amount;
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

  throw httpError("Budget balansi bir vaqtda o‘zgardi. Yangilab qayta urinib ko‘ring.", 409);
}

async function rollbackBudgetBalance(service: any, change: any, user: any) {
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

async function normalizeSaleItems(service: any, requestedItems: any[]) {
  const quantities = new Map<string, number>();
  for (const requested of requestedItems) {
    const quantity = Math.floor(Number(requested?.quantity));
    const productId = String(requested?.product_id || "");
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
      throw httpError("Har bir mahsulotda to‘g‘ri dona soni bo‘lishi kerak.", 400);
    }
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }

  const normalizedItems = [];
  for (const [productId, quantity] of quantities.entries()) {
    const product = await service.entities.Product.get(productId);
    if (!product || product.active === false || product.archived === true) {
      throw httpError("Tanlangan mahsulotlardan biri hozir sotuvda mavjud emas.", 409);
    }
    const unitPrice = money(product.price);
    normalizedItems.push({
      product_id: product.id,
      product_name: product.name,
      image_url: product.image_url || "",
      price: unitPrice,
      quantity,
      subtotal: unitPrice * quantity,
      source_type: product.source_type || "central_produced",
      stock_tracked: product.track_stock !== false,
      stock_location_id: "",
      stock_quantity_change: product.track_stock === false ? 0 : -quantity,
    });
  }
  return normalizedItems;
}

async function stockPolicy(service: any) {
  const settings = await service.entities.Settings.list();
  return settings?.[0]?.allow_negative_stock !== false;
}

async function planSaleStock(service: any, shopId: string, items: any[]) {
  const plans = [];
  const shortages = [];
  for (const item of items.filter((row) => row.stock_tracked)) {
    const rows = await service.entities.ProductStock.filter({
      location_id: shopId,
      product_id: item.product_id,
    });
    if ((rows || []).length > 1) {
      throw httpError(`${item.product_name} uchun takroriy ombor qoldig‘i topildi.`, 409);
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
        missing: stockNumber(-after),
      });
    }
    plans.push({ item, stock, before, after });
  }
  return { plans, shortages };
}

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

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;
  let sale: any = null;
  let saleItems: any[] = [];
  let paymentRecords: any[] = [];
  let claimedDiscount: any = null;
  let stockChanges: any[] = [];
  let stockMovementRecords: any[] = [];

  try {
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    if (!["admin", "cashier"].includes(user.role)) {
      return Response.json({ error: "Your role cannot complete Kassa sales." }, { status: 403 });
    }

    const body = await req.json();
    const action = String(body?.action || "complete_sale");

    if (action === "open_shift") {
      const startingCash = money(body?.starting_cash);
      if (startingCash < 0) return Response.json({ error: "Starting cash must be zero or more." }, { status: 400 });
      const existing = await service.entities.Shift.filter({ user_id: user.id, status: "open" });
      if (existing?.length) return Response.json({ error: "You already have an open shift." }, { status: 409 });
      let shopId = String(body?.shop_id || "");
      if (user.role === "cashier") {
        if (!user.shop_id) return Response.json({ error: "Owner must assign this cashier to a shop first." }, { status: 403 });
        shopId = user.shop_id;
      }
      const shop = shopId ? await service.entities.Shop.get(shopId) : null;
      if (!shop) return Response.json({ error: "Shop not found." }, { status: 404 });
      if (shop.allows_pos === false || shop.location_type === "production") {
        return Response.json({ error: "Kassa shifts cannot be opened at a production-only location." }, { status: 403 });
      }
      const now = new Date().toISOString();
      const newShift = await service.entities.Shift.create({
        user_id: user.id, user_name: user.full_name || user.email,
        shop_id: shop.id, shop_name: shop.name, status: "open", opened_at: now,
        starting_cash: startingCash, expected_cash: startingCash,
      });
      await service.entities.ActionHistory.create({
        user_id: user.id, user_name: user.full_name || user.email,
        action: "shift_opened", details: `${shop.name}, starting cash ${startingCash} UZS`,
      });
      return Response.json({ shift: newShift });
    }

    if (action === "close_shift") {
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

      try {
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
            description: `${closingShift.shop_name} smenasi · ${BUDGET_ACCOUNT_LABELS[deposit.account]}`,
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

        const updated = await service.entities.Shift.get(closingShift.id);
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "shift_closed",
          details: `${closingShift.shop_name} · Budgetga ${budgetCashSubmitted} UZS naqd · qoldirildi ${cashLeftForNextShift} UZS · farq ${actualCash - expected} UZS`,
        }).catch(() => {});
        return Response.json({
          shift: updated,
          budget_transactions: budgetTransactions,
          print_report_required: true,
        });
      } catch (error) {
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
    }

    if (action === "validate_discount") {
      if (user.role === "cashier" && !(await verifyOwnerPin(service, body?.owner_pin))) {
        return Response.json({ error: "Owner PIN is incorrect." }, { status: 403 });
      }
      const code = String(body?.code || "").trim().toUpperCase();
      const matches = code ? await service.entities.DiscountCode.filter({ code, active: true }) : [];
      const discount = matches?.[0];
      if (!discount || (discount.single_use !== false && Number(discount.usage_count || 0) >= 1)) {
        return Response.json({ error: "Invalid, inactive, or already-used discount code." }, { status: 404 });
      }
      return Response.json({ code: discount.code, percentage: Number(discount.percentage) });
    }

    if (action === "cash_withdrawal") {
      const shiftId = String(body?.shift_id || "");
      const amount = money(body?.amount);
      const reason = String(body?.reason || "").trim();
      const expenseCategory = String(body?.expense_category || "");
      const recipientId = String(body?.recipient_id || "");
      const requestedRecipientName = String(body?.recipient_name || "").trim();
      const allowedCategories = new Set(["shop_expense", "goods_payment", "owner_withdrawal", "other_expense"]);
      const employeeName = user.full_name || user.email || "Noma’lum xodim";

      if (!shiftId || amount <= 0 || !reason || !allowedCategories.has(expenseCategory)) {
        return Response.json({ error: "Miqdor, chiqim turi va izoh majburiy." }, { status: 400 });
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

      const shift = await service.entities.Shift.get(shiftId);
      if (!shift || shift.status !== "open") return Response.json({ error: "Smena ochiq emas." }, { status: 409 });
      if (shift.user_id !== user.id) return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
      if (amount > Number(shift.expected_cash || 0)) {
        return Response.json({ error: "Kassada kutilayotgan naqd pul yetarli emas." }, { status: 400 });
      }

      const movement = await service.entities.CashMovement.create({
        shift_id: shift.id,
        shop_id: shift.shop_id,
        user_id: user.id,
        user_name: user.full_name || user.email,
        employee_name: employeeName,
        type: "withdrawal",
        expense_category: expenseCategory,
        recipient_id: verifiedRecipientId || undefined,
        recipient_name_snapshot: recipientName || undefined,
        amount,
        reason,
        created_at: new Date().toISOString(),
      });

      await service.entities.Shift.update(shift.id, {
        expected_cash: Number(shift.expected_cash || 0) - amount,
        cash_removed: Number(shift.cash_removed || 0) + amount,
      });
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: user.full_name || user.email,
        action: "cash_withdrawal",
        details: `${amount} UZS. ${expenseCategory}. ${recipientName || "Qabul qiluvchi yo‘q"}. ${reason}. Xodim: ${employeeName}`,
      });
      return Response.json({
        movement,
        shift: {
          ...shift,
          expected_cash: Number(shift.expected_cash || 0) - amount,
          cash_removed: Number(shift.cash_removed || 0) + amount,
        },
      });
    }

    if (action === "check_stock") {
      const shiftId = String(body?.shift_id || "");
      const requestedItems = Array.isArray(body?.items) ? body.items : [];
      if (!shiftId || !requestedItems.length) {
        return Response.json({ error: "Smena va mahsulotlar kerak." }, { status: 400 });
      }
      const shift = await service.entities.Shift.get(shiftId);
      if (!shift || shift.status !== "open") {
        return Response.json({ error: "Smena ochiq emas." }, { status: 409 });
      }
      if (shift.user_id !== user.id) {
        return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
      }
      if (user.role === "cashier" && user.shop_id !== shift.shop_id) {
        return Response.json({ error: "Kassir boshqa do‘konga biriktirilgan." }, { status: 403 });
      }
      const normalizedItems = await normalizeSaleItems(service, requestedItems);
      const allowNegativeStock = await stockPolicy(service);
      const { shortages } = await planSaleStock(service, shift.shop_id, normalizedItems);
      if (shortages.length && !allowNegativeStock) {
        return Response.json({
          error: "Omborda mahsulot yetarli emas. Qoldiqsiz sotuv bloklangan.",
          shortages,
          allow_negative_stock: false,
        }, { status: 409 });
      }
      return Response.json({ shortages, allow_negative_stock: allowNegativeStock });
    }

    if (action === "refund_sale") {
      if (!(await verifyOwnerPin(service, body?.owner_pin))) {
        return Response.json({ error: "Egasi PIN kodi noto‘g‘ri." }, { status: 403 });
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
        shop_id: original.shop_id,
      });
      const refundShift = openShifts?.[0];
      if (!refundShift) {
        return Response.json({ error: "Qaytarish uchun savdo qilingan do‘konda smenani oching." }, { status: 409 });
      }

      const refundPayments = Array.isArray(original.payments) ? original.payments : [];
      const byMethod = (method: string) => refundPayments
        .filter((payment: any) => payment.method === method)
        .reduce((sum: number, payment: any) => sum + money(payment.amount), 0);
      const cash = byMethod("cash");
      const uzcard = byMethod("uzcard");
      const humo = byMethod("humo");
      const online = byMethod("click") + byMethod("payme") + byMethod("other");
      const bank = byMethod("bank_transfer");
      if (cash > Number(refundShift.expected_cash || 0)) {
        return Response.json({ error: "Qaytarish uchun kassada kutilayotgan naqd pul yetarli emas." }, { status: 409 });
      }

      const now = new Date().toISOString();
      const day = now.slice(0, 10).replaceAll("-", "");
      const refundNumber = `RF-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const saleItemRows = await service.entities.SaleItem.filter({ sale_id: original.id });
      const restockItems = (saleItemRows || []).filter(
        (item: any) => item.stock_tracked_snapshot === true && Number(item.quantity || 0) > 0,
      );

      let refund: any = null;
      let saleClaimed = false;
      let shiftAdjusted = false;
      const restocks: any[] = [];
      const refundMovements: any[] = [];

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
          created_at: now,
        });

        const saleClaim = await service.entities.Sale.updateMany(
          { id: original.id, status: "completed" },
          { $set: {
            status: "refunded",
            refunded_at: now,
            refunded_by: user.id,
            refund_id: refund.id,
            refund_reason: reason,
          } },
        );
        if (!saleClaim?.success || Number(saleClaim.updated || 0) !== 1) {
          throw httpError("Savdo boshqa qurilmada o‘zgargan. Yangilang va qayta urinib ko‘ring.", 409);
        }
        saleClaimed = true;

        const shiftUpdate = await service.entities.Shift.updateMany(
          { id: refundShift.id, status: "open" },
          { $inc: {
            cash_sales: -cash,
            uzcard_sales: -uzcard,
            humo_sales: -humo,
            online_sales: -online,
            bank_transfer_sales: -bank,
            total_sales: -money(original.total),
            expected_cash: -cash,
            refunds_total: money(original.total),
          } },
        );
        if (!shiftUpdate?.success || Number(shiftUpdate.updated || 0) !== 1) {
          throw httpError("Smena boshqa qurilmada o‘zgargan. Yangilang va qayta urinib ko‘ring.", 409);
        }
        shiftAdjusted = true;

        for (const item of restockItems) {
          const locationId = item.stock_location_id || original.shop_id;
          const rows = await service.entities.ProductStock.filter({
            location_id: locationId,
            product_id: item.product_id,
          });
          if ((rows || []).length > 1) {
            throw httpError(`${item.product_name_snapshot} uchun takroriy ombor qoldig‘i topildi.`, 409);
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
                updated_by_name: user.full_name || user.email,
              } },
            );
            if (!update?.success || Number(update.updated || 0) !== 1) {
              throw httpError(`${item.product_name_snapshot} qoldig‘i boshqa qurilmada o‘zgardi.`, 409);
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
              updated_by_name: user.full_name || user.email,
            });
          }
          restocks.push({ stockRecord, quantity, product_id: item.product_id, after });

          const movement = await service.entities.StockMovement.create({
            movement_number: `ST-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
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
            created_at: now,
          });
          refundMovements.push(movement);
        }

        try {
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: user.full_name || user.email,
            action: "sale_refunded",
            details: `${original.sale_number || original.id}. ${money(original.total)} UZS. ${reason}`,
          });
        } catch {}

        return Response.json({
          refund,
          sale: {
            ...original,
            status: "refunded",
            refunded_at: now,
            refund_id: refund.id,
            refund_reason: reason,
          },
          stock_updates: restocks.map((item) => ({
            product_id: item.product_id,
            quantity: item.after,
          })),
        });
      } catch (error) {
        for (const movement of refundMovements) {
          try { await service.entities.StockMovement.delete(movement.id); } catch {}
        }
        for (const restock of restocks) {
          try {
            await service.entities.ProductStock.updateMany(
              { id: restock.stockRecord.id },
              { $inc: { quantity: -restock.quantity } },
            );
          } catch {}
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
                refunds_total: -money(original.total),
              } },
            );
          } catch {}
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
                  refund_reason: "",
                },
              },
            );
          } catch {}
        }
        if (refund?.id) {
          try { await service.entities.Refund.delete(refund.id); } catch {}
        }
        throw error;
      }
    }

    if (action !== "complete_sale") {
      return Response.json({ error: "Unknown Kassa action." }, { status: 400 });
    }
    const shiftId = String(body?.shift_id || "");
    const requestedItems = Array.isArray(body?.items) ? body.items : [];
    const requestedPayments = Array.isArray(body?.payments) ? body.payments : [];
    const requestedDiscountCode = String(body?.discount_code || "").trim().toUpperCase();

    if (!shiftId || requestedItems.length === 0 || requestedPayments.length === 0) {
      return Response.json({ error: "Shift, items, and payments are required." }, { status: 400 });
    }

    const shift = await service.entities.Shift.get(shiftId);
    if (!shift || shift.status !== "open") {
      return Response.json({ error: "The shift is not open." }, { status: 409 });
    }
    if (shift.user_id !== user.id) {
      return Response.json({ error: "This shift belongs to another user." }, { status: 403 });
    }
    if (user.role === "cashier" && !user.shop_id) {
      return Response.json({ error: "Owner must assign this cashier to a shop first." }, { status: 403 });
    }
    if (user.role === "cashier" && user.shop_id !== shift.shop_id) {
      return Response.json({ error: "This cashier is assigned to a different shop." }, { status: 403 });
    }

    const normalizedItems = await normalizeSaleItems(service, requestedItems);
    const allowNegativeStock = await stockPolicy(service);
    const { plans: stockPlans, shortages: stockWarnings } =
      await planSaleStock(service, shift.shop_id, normalizedItems);
    if (stockWarnings.length && !allowNegativeStock) {
      return Response.json({
        error: "Omborda mahsulot yetarli emas. Qoldiqsiz sotuv bloklangan.",
        shortages: stockWarnings,
        allow_negative_stock: false,
      }, { status: 409 });
    }

    const subtotal = normalizedItems.reduce((sum, item) => sum + item.subtotal, 0);
    let discountCode = "";
    let discountPercentage = 0;

    if (requestedDiscountCode) {
      const matches = await service.entities.DiscountCode.filter({
        code: requestedDiscountCode,
        active: true,
      });
      const discount = matches?.[0];
      if (!discount) {
        return Response.json({ error: "Discount code is invalid or inactive." }, { status: 409 });
      }
      if (discount.single_use !== false && Number(discount.usage_count || 0) >= 1) {
        return Response.json({ error: "This discount code has already been used." }, { status: 409 });
      }
      discountPercentage = Number(discount.percentage);
      if (!Number.isFinite(discountPercentage) || discountPercentage <= 0 || discountPercentage > 100) {
        return Response.json({ error: "Discount percentage is invalid." }, { status: 409 });
      }
      discountCode = discount.code;
      claimedDiscount = discount;
    }

    const discountAmount = money(subtotal * discountPercentage / 100);
    const total = Math.max(0, subtotal - discountAmount);

    const normalizedPayments = requestedPayments.map((payment) => ({
      method: String(payment?.method || ""),
      amount: money(payment?.amount),
      reference: String(payment?.reference || "").trim(),
    }));

    if (normalizedPayments.some((payment) => !PAYMENT_METHODS.has(payment.method) || payment.amount <= 0)) {
      return Response.json({ error: "A payment method or amount is invalid." }, { status: 400 });
    }

    const paidTotal = normalizedPayments.reduce((sum, payment) => sum + payment.amount, 0);
    if (paidTotal !== total) {
      return Response.json({
        error: `Payments must equal the sale total. Expected ${total}, received ${paidTotal}.`,
      }, { status: 400 });
    }

    const now = new Date().toISOString();
    const day = now.slice(0, 10).replaceAll("-", "");
    const saleNumber = `OD-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const paymentSummary = normalizedPayments.map((payment) => payment.method).join(" + ");

    for (const plan of stockPlans) {
      let stockRecord = plan.stock;
      if (stockRecord) {
        const update = await service.entities.ProductStock.updateMany(
          { id: stockRecord.id, quantity: plan.before },
          { $set: {
            quantity: plan.after,
            location_name: shift.shop_name,
            product_name: plan.item.product_name,
            unit: "piece",
            updated_at: now,
            updated_by: user.id,
            updated_by_name: user.full_name || user.email,
          } },
        );
        if (!update?.success || Number(update.updated || 0) !== 1) {
          throw httpError(`${plan.item.product_name} qoldig‘i boshqa qurilmada o‘zgardi. Yangilang va qayta urinib ko‘ring.`, 409);
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
          updated_at: now,
          updated_by: user.id,
          updated_by_name: user.full_name || user.email,
        });
      }
      stockChanges.push({ ...plan, stockRecord });
    }

    sale = await service.entities.Sale.create({
      sale_number: saleNumber,
      financial_records_version: 2,
      sale_items_count: normalizedItems.length,
      shift_id: shift.id,
      user_id: user.id,
      user_name: user.full_name || user.email,
      shop_id: shift.shop_id,
      shop_name: shift.shop_name,
      items: normalizedItems,
      subtotal,
      discount_code: discountCode || undefined,
      discount_amount: discountAmount,
      total,
      payments: normalizedPayments.map(({ method, amount }) => ({ method, amount })),
      payment_methods_summary: paymentSummary,
      status: "completed",
    });

    let allocatedDiscount = 0;
    const itemPayloads = normalizedItems.map((item, index) => {
      const itemDiscount = index === normalizedItems.length - 1
        ? discountAmount - allocatedDiscount
        : money(discountAmount * item.subtotal / subtotal);
      allocatedDiscount += itemDiscount;
      return {
        sale_id: sale.id,
        sale_number: saleNumber,
        shop_id: shift.shop_id,
        shift_id: shift.id,
        cashier_id: user.id,
        product_id: item.product_id,
        source_type_snapshot: item.source_type,
        stock_tracked_snapshot: item.stock_tracked,
        stock_location_id: item.stock_location_id || undefined,
        stock_quantity_change: item.stock_quantity_change,
        product_name_snapshot: item.product_name,
        image_url_snapshot: item.image_url,
        quantity: item.quantity,
        unit_price: item.price,
        discount_amount: itemDiscount,
        line_total: item.subtotal - itemDiscount,
        created_at: now,
      };
    });

    saleItems = await service.entities.SaleItem.bulkCreate(itemPayloads);
    paymentRecords = await service.entities.Payment.bulkCreate(
      normalizedPayments.map((payment) => ({
        sale_id: sale.id,
        sale_number: saleNumber,
        shop_id: shift.shop_id,
        shift_id: shift.id,
        cashier_id: user.id,
        method: payment.method,
        amount: payment.amount,
        reference: payment.reference || undefined,
        created_at: now,
      })),
    );

    for (const change of stockChanges) {
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
        created_at: now,
      });
      stockMovementRecords.push(movement);
    }

    if (claimedDiscount) {
      await service.entities.DiscountCode.update(claimedDiscount.id, {
        usage_count: Number(claimedDiscount.usage_count || 0) + 1,
        used_at: now,
        used_by_sale_id: sale.id,
        active: claimedDiscount.single_use === false,
      });
    }

    const cashIncrement = normalizedPayments
      .filter((payment) => payment.method === "cash")
      .reduce((sum, payment) => sum + payment.amount, 0);
    const uzcardIncrement = normalizedPayments
      .filter((payment) => payment.method === "uzcard")
      .reduce((sum, payment) => sum + payment.amount, 0);
    const humoIncrement = normalizedPayments
      .filter((payment) => payment.method === "humo")
      .reduce((sum, payment) => sum + payment.amount, 0);
    const onlineIncrement = normalizedPayments
      .filter((payment) => ["click", "payme", "other"].includes(payment.method))
      .reduce((sum, payment) => sum + payment.amount, 0);
    const bankTransferIncrement = normalizedPayments
      .filter((payment) => payment.method === "bank_transfer")
      .reduce((sum, payment) => sum + payment.amount, 0);

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
          order_count: 1,
        },
      },
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
      order_count: Number(shift.order_count || 0) + 1,
    };

    try {
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: user.full_name || user.email,
        action: "sale_completed",
        details: `${saleNumber}. Total ${total} UZS via ${paymentSummary}. ${normalizedItems.length} lines.`,
      });
    } catch {
      // Audit logging must not invalidate a completed financial transaction.
    }

    return Response.json({
      sale,
      sale_items: saleItems,
      payments: paymentRecords,
      shift: updatedShift,
      stock_warnings: stockWarnings,
      allow_negative_stock: allowNegativeStock,
      stock_updates: stockChanges.map((change) => ({
        product_id: change.item.product_id,
        quantity: change.after,
      })),
    });
  } catch (error) {
    for (const movement of stockMovementRecords) {
      try { await base44.asServiceRole.entities.StockMovement.delete(movement.id); } catch {}
    }
    for (const change of stockChanges) {
      try {
        await base44.asServiceRole.entities.ProductStock.updateMany(
          { id: change.stockRecord.id },
          { $inc: { quantity: change.item.quantity } },
        );
      } catch {}
    }
    if (claimedDiscount && sale) {
      try {
        await base44.asServiceRole.entities.DiscountCode.update(claimedDiscount.id, {
          usage_count: Number(claimedDiscount.usage_count || 0),
          used_at: claimedDiscount.used_at,
          used_by_sale_id: claimedDiscount.used_by_sale_id,
          active: claimedDiscount.active,
        });
      } catch {
        // Preserve the original failure.
      }
    }
    for (const record of paymentRecords) {
      try { await base44.asServiceRole.entities.Payment.delete(record.id); } catch {}
    }
    for (const record of saleItems) {
      try { await base44.asServiceRole.entities.SaleItem.delete(record.id); } catch {}
    }
    if (sale) {
      try { await base44.asServiceRole.entities.Sale.delete(sale.id); } catch {}
    }

    return Response.json({
      error: error instanceof Error ? error.message : "Savdoni yakunlab bo‘lmadi.",
    }, { status: Number((error as any)?.status || 500) });
  }
}