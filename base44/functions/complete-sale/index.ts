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

Deno.serve(async (req) => {
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

    const body = await req.json();
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
    if (user.role === "cashier" && user.shop_id && user.shop_id !== shift.shop_id) {
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
});
