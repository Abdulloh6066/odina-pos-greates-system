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
      const actualCash = money(body?.actual_cash);
      if (!shiftId || actualCash < 0) return Response.json({ error: "Valid shift and counted cash are required." }, { status: 400 });
      const closingShift = await service.entities.Shift.get(shiftId);
      if (!closingShift || closingShift.status !== "open") return Response.json({ error: "The shift is not open." }, { status: 409 });
      if (closingShift.user_id !== user.id) return Response.json({ error: "This shift belongs to another user." }, { status: 403 });
      const expected = money(closingShift.expected_cash);
      const updated = await service.entities.Shift.update(closingShift.id, {
        status: "closed", closed_at: new Date().toISOString(),
        actual_cash: actualCash, difference: actualCash - expected,
      });
      await service.entities.ActionHistory.create({
        user_id: user.id, user_name: user.full_name || user.email,
        action: "shift_closed", details: `${closingShift.shop_name}. Difference ${actualCash - expected} UZS`,
      });
      return Response.json({ shift: updated, print_report_required: true });
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
      const employeeName = user.full_name || user.email || "Unknown user";
      if (!shiftId || amount <= 0 || !reason) {
        return Response.json({ error: "Amount and reason are required." }, { status: 400 });
      }
      const shift = await service.entities.Shift.get(shiftId);
      if (!shift || shift.status !== "open") return Response.json({ error: "The shift is not open." }, { status: 409 });
      if (shift.user_id !== user.id) return Response.json({ error: "This shift belongs to another user." }, { status: 403 });
      if (amount > Number(shift.expected_cash || 0)) {
        return Response.json({ error: "Withdrawal is greater than expected drawer cash." }, { status: 400 });
      }
      const movement = await service.entities.CashMovement.create({
        shift_id: shift.id, shop_id: shift.shop_id, user_id: user.id,
        user_name: user.full_name || user.email, employee_name: employeeName,
        type: "withdrawal", amount, reason, created_at: new Date().toISOString(),
      });
      await service.entities.Shift.update(shift.id, {
        expected_cash: Number(shift.expected_cash || 0) - amount,
        cash_removed: Number(shift.cash_removed || 0) + amount,
      });
      await service.entities.ActionHistory.create({
        user_id: user.id, user_name: user.full_name || user.email,
        action: "cash_withdrawal", details: `${amount} UZS. ${reason}. Employee: ${employeeName}`,
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

    if (action === "refund_sale") {
      if (!(await verifyOwnerPin(service, body?.owner_pin))) {
        return Response.json({ error: "Owner PIN is incorrect." }, { status: 403 });
      }
      const saleId = String(body?.sale_id || "");
      const reason = String(body?.reason || "").trim();
      if (!saleId || !reason) return Response.json({ error: "Sale and refund reason are required." }, { status: 400 });
      const original = await service.entities.Sale.get(saleId);
      if (!original) return Response.json({ error: "Sale not found." }, { status: 404 });
      if (original.status !== "completed") return Response.json({ error: "This sale is already refunded." }, { status: 409 });

      const openShifts = await service.entities.Shift.filter({ user_id: user.id, status: "open", shop_id: original.shop_id });
      const refundShift = openShifts?.[0];
      if (!refundShift) {
        return Response.json({ error: "Open a shift at the sale's shop before refunding." }, { status: 409 });
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
        return Response.json({ error: "Not enough expected drawer cash for this refund." }, { status: 409 });
      }

      const now = new Date().toISOString();
      const refundNumber = `RF-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const refund = await service.entities.Refund.create({
        refund_number: refundNumber, sale_id: original.id, sale_number: original.sale_number,
        shop_id: original.shop_id, shift_id: refundShift.id, cashier_id: user.id,
        cashier_name: user.full_name || user.email, amount: money(original.total), reason,
        payments: refundPayments, payment_summary: original.payment_methods_summary, created_at: now,
      });
      await service.entities.Sale.update(original.id, {
        status: "refunded", refunded_at: now, refunded_by: user.id,
        refund_id: refund.id, refund_reason: reason,
      });
      await service.entities.Shift.update(refundShift.id, {
        cash_sales: Number(refundShift.cash_sales || 0) - cash,
        uzcard_sales: Number(refundShift.uzcard_sales || 0) - uzcard,
        humo_sales: Number(refundShift.humo_sales || 0) - humo,
        online_sales: Number(refundShift.online_sales || 0) - online,
        bank_transfer_sales: Number(refundShift.bank_transfer_sales || 0) - bank,
        total_sales: Number(refundShift.total_sales || 0) - money(original.total),
        expected_cash: Number(refundShift.expected_cash || 0) - cash,
        refunds_total: Number(refundShift.refunds_total || 0) + money(original.total),
      });
      await service.entities.ActionHistory.create({
        user_id: user.id, user_name: user.full_name || user.email,
        action: "sale_refunded", details: `${original.sale_number || original.id}. ${money(original.total)} UZS. ${reason}`,
      });
      return Response.json({ refund, sale: { ...original, status: "refunded", refunded_at: now, refund_id: refund.id, refund_reason: reason } });
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

    const normalizedItems = [];
    for (const requested of requestedItems) {
      const quantity = Math.floor(Number(requested?.quantity));
      if (!requested?.product_id || !Number.isFinite(quantity) || quantity <= 0) {
        return Response.json({ error: "Every item needs a valid product and quantity." }, { status: 400 });
      }
      const product = await service.entities.Product.get(String(requested.product_id));
      if (!product || product.active === false) {
        return Response.json({ error: "A selected product is unavailable." }, { status: 409 });
      }
      const unitPrice = money(product.price);
      normalizedItems.push({
        product_id: product.id,
        product_name: product.name,
        image_url: product.image_url || "",
        price: unitPrice,
        quantity,
        subtotal: unitPrice * quantity,
      });
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
    });
  } catch (error) {
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
      error: error instanceof Error ? error.message : "Could not complete sale.",
    }, { status: 500 });
  }
}