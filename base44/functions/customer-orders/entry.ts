import { createClientFromRequest } from "npm:@base44/sdk";
import { money, httpError, resolveAppUser } from "../../shared/shift-close-helpers.ts";

const ORDER_RUNTIME_VERSION = "customer-orders-v1-2026-09-09";

const PAYMENT_METHODS = new Set([
  "cash", "uzcard", "humo", "click", "payme", "bank_transfer", "other",
]);
const ORDER_TYPES = new Set(["toy_va_bazmlar", "tugilgan_kun_va_boshqa"]);
const PAYMENT_KINDS = new Set(["advance", "balance", "additional"]);
const WEDDING_PIECES_PER_SHEET = 40;

function tashkentNowParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const o: any = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour === "24" ? "0" : o.hour),
    minute: Number(o.minute),
  };
}

function methodToShiftField(method: string): string | null {
  if (method === "cash") return "cash_sales";
  if (method === "uzcard") return "uzcard_sales";
  if (method === "humo") return "humo_sales";
  if (method === "bank_transfer") return "bank_transfer_sales";
  if (["click", "payme", "other"].includes(method)) return "online_sales";
  return null;
}

async function findOpenShift(service: any, userId: string, shopId: string) {
  const shifts = await service.entities.Shift.filter({
    user_id: userId, status: "open", shop_id: shopId,
  });
  return (shifts && shifts[0]) || null;
}

async function applyPaymentToShift(
  service: any, shift: any, method: string, amount: number,
) {
  const field = methodToShiftField(method);
  const inc: Record<string, number> = { total_sales: amount, order_count: 1 };
  if (field) inc[field] = amount;
  if (method === "cash") inc.expected_cash = amount;
  const update = await service.entities.Shift.updateMany(
    { id: shift.id, status: "open" },
    { $inc: inc },
  );
  if (!update?.success || Number(update.updated || 0) !== 1) {
    throw httpError("Smena o‘zgardi. Yangilab qayta urinib ko‘ring.", 409);
  }
}

async function reversePaymentOnShift(
  service: any, shiftId: string, method: string, amount: number,
) {
  const field = methodToShiftField(method);
  const dec: Record<string, number> = { total_sales: -amount, order_count: -1 };
  if (field) dec[field] = -amount;
  if (method === "cash") dec.expected_cash = -amount;
  await service.entities.Shift.updateMany(
    { id: shiftId, status: "open" },
    { $inc: dec },
  ).catch(() => {});
}

async function normalizeOrderItems(service: any, requestedItems: any[], orderType: string) {
  const normalized: any[] = [];
  for (const requested of requestedItems) {
    const productId = String(requested?.product_id || "");
    const quantity = Number(requested?.quantity);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
      throw httpError("Har bir mahsulotda to‘g‘ri miqdor bo‘lishi kerak.", 400);
    }
    const product = await service.entities.Product.get(productId);
    if (!product || product.active === false || product.archived === true) {
      throw httpError("Tanlangan mahsulot hozir sotuvda mavjud emas.", 409);
    }
    const isSheet = product.production_unit === "sheet";
    const unit = isSheet ? "sheet" : "piece";
    const unitPrice = isSheet ? money(product.sheet_price) : money(product.price);
    if (!unitPrice || unitPrice <= 0) {
      throw httpError(`${product.name || "Mahsulot"} narxi sozlanmagan.`, 409);
    }
    const qty = Math.floor(quantity);
    const piecesPerSheet = isSheet
      ? (orderType === "toy_va_bazmlar"
        ? WEDDING_PIECES_PER_SHEET
        : Math.max(1, Number(product.pieces_per_sheet) || 20))
      : 0;
    normalized.push({
      product_id: product.id,
      product_name_snapshot: String(product.name || ""),
      product_image_snapshot: String(product.image_url || ""),
      category_name_snapshot: String(product.category_name || ""),
      unit_snapshot: unit,
      quantity: qty,
      event_pieces_per_sheet_snapshot: piecesPerSheet,
      unit_price_snapshot: unitPrice,
      line_total: unitPrice * qty,
      customization_note: String(requested?.customization_note || ""),
    });
  }
  return normalized;
}

export default async function(req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;
  let createdOrder: any = null;
  let createdItems: any[] = [];
  let createdPayment: any = null;
  let shiftApplied: { shiftId: string; method: string; amount: number } | null = null;

  try {
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) {
      return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });
    }
    const user = await resolveAppUser(service, authenticatedUser);
    if (user.active === false) {
      return Response.json({ error: "Xodim akkaunti faol emas." }, { status: 403 });
    }
    if (!["admin", "cashier"].includes(user.role)) {
      return Response.json({ error: "Buyurtma yaratish uchun ruxsat yo‘q." }, { status: 403 });
    }

    const body = await req.json();
    const action = String(body?.action || "");

    if (action === "runtime_status") {
      return Response.json({ ok: true, runtime_version: ORDER_RUNTIME_VERSION });
    }

    if (action === "create_order") {
      const idempotencyKey = String(body?.idempotency_key || "");
      if (!idempotencyKey) {
        return Response.json({ error: "Idempotency kaliti kerak." }, { status: 400 });
      }
      const existingOrders = await service.entities.CustomerOrder.filter({ idempotency_key: idempotencyKey });
      if (existingOrders && existingOrders.length) {
        return Response.json({ order: existingOrders[0], already_exists: true });
      }

      const orderType = String(body?.order_type || "");
      if (!ORDER_TYPES.has(orderType)) {
        return Response.json({ error: "Buyurtma turi noto‘g‘ri." }, { status: 400 });
      }
      const customerName = String(body?.customer_name || "").trim();
      const customerPhone = String(body?.customer_phone || "").trim();
      const requiredDate = String(body?.required_date || "");
      const requiredTime = String(body?.required_time || "");
      const fulfilmentType = String(body?.fulfilment_type || "");
      if (!customerName || !customerPhone || !requiredDate || !requiredTime) {
        return Response.json({ error: "Mijoz ismi, telefoni, sana va vaqt majburiy." }, { status: 400 });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredDate) || !/^\d{2}:\d{2}$/.test(requiredTime)) {
        return Response.json({ error: "Sana yoki vaqt formati noto‘g‘ri." }, { status: 400 });
      }
      {
        const [yy, mm, dd] = requiredDate.split("-").map(Number);
        const probe = new Date(Date.UTC(yy, mm - 1, dd));
        if (probe.getUTCFullYear() !== yy || probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) {
          return Response.json({ error: "Noto‘g‘ri sana." }, { status: 400 });
        }
        const [hh, mi] = requiredTime.split(":").map(Number);
        if (hh > 23 || mi > 59) {
          return Response.json({ error: "Noto‘g‘ri vaqt." }, { status: 400 });
        }
        const np = tashkentNowParts();
        const reqStamp = `${yy}${String(mm).padStart(2, "0")}${String(dd).padStart(2, "0")}${requiredTime.replace(":", "")}`;
        const nowStamp = `${np.year}${String(np.month).padStart(2, "0")}${String(np.day).padStart(2, "0")}${String(np.hour).padStart(2, "0")}${String(np.minute).padStart(2, "0")}`;
        if (reqStamp < nowStamp) {
          return Response.json({ error: "Topshirish sanasi yoki vaqti o‘tib ketgan." }, { status: 400 });
        }
      }
      if (!["pickup", "delivery"].includes(fulfilmentType)) {
        return Response.json({ error: "Yetkazib berish turi noto‘g‘ri." }, { status: 400 });
      }

      let shopId = String(body?.shop_id || "");
      if (user.role === "cashier") {
        if (!user.shop_id) {
          return Response.json({ error: "Sizga do‘kon biriktirilmagan." }, { status: 403 });
        }
        shopId = user.shop_id;
      }
      if (!shopId) {
        return Response.json({ error: "Do‘kon tanlanishi kerak." }, { status: 400 });
      }
      const shop = await service.entities.Shop.get(shopId);
      if (!shop || shop.active === false) {
        return Response.json({ error: "Do‘kon topilmadi yoki faol emas." }, { status: 404 });
      }

      const requestedItems = Array.isArray(body?.items) ? body.items : [];
      if (!requestedItems.length) {
        return Response.json({ error: "Kamida bitta mahsulot qo‘shing." }, { status: 400 });
      }
      const normalizedItems = await normalizeOrderItems(service, requestedItems, orderType);
      const subtotal = normalizedItems.reduce((sum, item) => sum + item.line_total, 0);

      let deliveryFee = 0;
      if (fulfilmentType === "delivery") {
        if (orderType === "toy_va_bazmlar") {
          deliveryFee = 0;
        } else {
          deliveryFee = money(body?.delivery_fee || 0);
          if (deliveryFee < 0) {
            return Response.json({ error: "Yetkazib berish narxi manfiy bo‘lishi mumkin emas." }, { status: 400 });
          }
        }
      }

      const adjustmentAmount = money(body?.adjustment_amount || 0);
      const adjustmentReason = String(body?.adjustment_reason || "").trim();
      if (adjustmentAmount !== 0) {
        if (user.role !== "admin") {
          return Response.json({ error: "Chegirma yoki qo‘shimcha faqat egasi tomonidan kiritiladi." }, { status: 403 });
        }
        if (adjustmentReason.length < 3) {
          return Response.json({ error: "Chegirma/qo‘shimcha uchun izoh majburiy." }, { status: 400 });
        }
      }
      const originalCalculatedTotal = subtotal + deliveryFee;
      const total = Math.max(0, originalCalculatedTotal + adjustmentAmount);

      const advance = body?.advance_payment || null;
      let paidAmount = 0;
      let shiftId = "";
      let shiftForPayment: any = null;
      let advanceMethod = "";
      if (advance) {
        advanceMethod = String(advance?.method || "");
        const advanceAmount = money(advance?.amount || 0);
        if (!PAYMENT_METHODS.has(advanceMethod) || advanceAmount <= 0) {
          return Response.json({ error: "Avans to‘lov usuli yoki summasi noto‘g‘ri." }, { status: 400 });
        }
        if (advanceAmount > total) {
          return Response.json({ error: "Avans summasi buyurtma summasidan oshmasligi kerak." }, { status: 400 });
        }
        paidAmount = advanceAmount;
        shiftForPayment = await findOpenShift(service, user.id, shop.id);
        if (!shiftForPayment && advanceMethod === "cash") {
          return Response.json({ error: "Naqd avans uchun ushbu do‘konda smenani oching." }, { status: 409 });
        }
        if (shiftForPayment) shiftId = shiftForPayment.id;
      }

      const remainingBalance = total - paidAmount;
      const paymentStatus = remainingBalance <= 0 ? "paid" : (paidAmount > 0 ? "partial" : "unpaid");
      const now = new Date().toISOString();
      const day = now.slice(0, 10).replaceAll("-", "");
      const orderNumber = `BO-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const userName = user.full_name || user.email || "Noma’lum xodim";

      try {
        createdOrder = await service.entities.CustomerOrder.create({
          order_number: orderNumber,
          order_type: orderType,
          shop_id: shop.id,
          shop_name_snapshot: shop.name,
          customer_name: customerName,
          customer_phone: customerPhone,
          required_date: requiredDate,
          required_time: requiredTime,
          fulfilment_type: fulfilmentType,
          delivery_address: fulfilmentType === "delivery" ? String(body?.delivery_address || "") : "",
          reference_image: String(body?.reference_image || ""),
          notes: String(body?.notes || ""),
          cake_shape: String(body?.cake_shape || ""),
          subtotal,
          delivery_fee: deliveryFee,
          adjustment_amount: adjustmentAmount,
          adjustment_reason: adjustmentReason || undefined,
          original_calculated_total: originalCalculatedTotal,
          total,
          paid_amount: paidAmount,
          remaining_balance: remainingBalance,
          payment_status: paymentStatus,
          order_status: "qabul_qilindi",
          creator_id: user.id,
          creator_name: userName,
          creator_role: user.role,
          idempotency_key: idempotencyKey,
          created_at: now,
        });

        const itemPayloads = normalizedItems.map((item) => ({
          order_id: createdOrder.id,
          order_number_snapshot: orderNumber,
          shop_id: shop.id,
          ...item,
        }));
        createdItems = await service.entities.CustomerOrderItem.bulkCreate(itemPayloads);

        if (advance && shiftForPayment) {
          await applyPaymentToShift(service, shiftForPayment, advanceMethod, paidAmount);
          shiftApplied = { shiftId: shiftForPayment.id, method: advanceMethod, amount: paidAmount };
        }

        if (advance) {
          const paymentIdempotency = String(advance?.idempotency_key || `${idempotencyKey}-adv`);
          const existingPayment = await service.entities.OrderPayment.filter({ idempotency_key: paymentIdempotency });
          if (existingPayment && existingPayment.length) {
            createdPayment = existingPayment[0];
          } else {
            createdPayment = await service.entities.OrderPayment.create({
              order_id: createdOrder.id,
              order_number_snapshot: orderNumber,
              payment_kind: "advance",
              payment_method: advanceMethod,
              amount: paidAmount,
              paid_at: now,
              shop_id: shop.id,
              shop_name_snapshot: shop.name,
              employee_id: user.id,
              employee_name: userName,
              employee_role: user.role,
              shift_id: shiftId,
              idempotency_key: paymentIdempotency,
              status: "completed",
            });
          }
        }

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "order_created",
          details: `${orderNumber} · ${shop.name} · ${total} UZS${paidAmount ? ` · avans ${paidAmount}` : ""}`,
        }).catch(() => {});

        return Response.json({
          order: createdOrder,
          items: createdItems,
          payment: createdPayment,
          runtime_version: ORDER_RUNTIME_VERSION,
        });
      } catch (error) {
        if (createdPayment?.id) {
          await service.entities.OrderPayment.delete(createdPayment.id).catch(() => {});
        }
        if (shiftApplied) {
          await reversePaymentOnShift(service, shiftApplied.shiftId, shiftApplied.method, shiftApplied.amount);
        }
        for (const item of createdItems) {
          await service.entities.CustomerOrderItem.delete(item.id).catch(() => {});
        }
        if (createdOrder?.id) {
          await service.entities.CustomerOrder.delete(createdOrder.id).catch(() => {});
        }
        throw error;
      }
    }

    if (action === "record_payment") {
      const orderId = String(body?.order_id || "");
      const method = String(body?.method || "");
      const amount = money(body?.amount || 0);
      const paymentKind = String(body?.payment_kind || "balance");
      const idempotencyKey = String(body?.idempotency_key || "");
      if (!orderId || !idempotencyKey) {
        return Response.json({ error: "Buyurtma va idempotency kaliti majburiy." }, { status: 400 });
      }
      if (!PAYMENT_METHODS.has(method) || amount <= 0) {
        return Response.json({ error: "To‘lov usuli yoki summasi noto‘g‘ri." }, { status: 400 });
      }
      if (!PAYMENT_KINDS.has(paymentKind)) {
        return Response.json({ error: "To‘lov turi noto‘g‘ri." }, { status: 400 });
      }

      const existingPayment = await service.entities.OrderPayment.filter({ idempotency_key: idempotencyKey });
      if (existingPayment && existingPayment.length) {
        return Response.json({ payment: existingPayment[0], already_exists: true });
      }

      const order = await service.entities.CustomerOrder.get(orderId);
      if (!order) {
        return Response.json({ error: "Buyurtma topilmadi." }, { status: 404 });
      }
      if (user.role === "cashier" && order.shop_id !== user.shop_id) {
        return Response.json({ error: "Bu buyurtma boshqa do‘konga tegishli." }, { status: 403 });
      }
      if (order.order_status === "bekor_qilindi") {
        return Response.json({ error: "Bekor qilingan buyurtmaga to‘lov qabul qilinmaydi." }, { status: 409 });
      }

      const currentPaid = money(order.paid_amount);
      const remaining = money(order.remaining_balance);
      if (amount > remaining) {
        return Response.json({ error: `To‘lov qolgan qarzdan oshmasligi kerak: ${remaining} UZS.` }, { status: 400 });
      }

      const shift = await findOpenShift(service, user.id, order.shop_id);
      if (!shift && method === "cash") {
        return Response.json({ error: "Naqd to‘lov uchun ushbu do‘konda smenani oching." }, { status: 409 });
      }

      const now = new Date().toISOString();
      const newPaid = currentPaid + amount;
      const newRemaining = money(order.total) - newPaid;
      const newStatus = newRemaining <= 0 ? "paid" : (newPaid > 0 ? "partial" : "unpaid");
      const userName = user.full_name || user.email || "Noma’lum xodim";

      const claim = await service.entities.CustomerOrder.updateMany(
        { id: order.id, paid_amount: currentPaid },
        {
          $set: {
            paid_amount: newPaid,
            remaining_balance: newRemaining,
            payment_status: newStatus,
            updated_at: now,
          },
        },
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ error: "Buyurtma o‘zgardi. Yangilang va qayta urinib ko‘ring." }, { status: 409 });
      }

      try {
        createdPayment = await service.entities.OrderPayment.create({
          order_id: order.id,
          order_number_snapshot: order.order_number,
          payment_kind: paymentKind,
          payment_method: method,
          amount,
          paid_at: now,
          shop_id: order.shop_id,
          shop_name_snapshot: order.shop_name_snapshot,
          employee_id: user.id,
          employee_name: userName,
          employee_role: user.role,
          shift_id: shift?.id || "",
          idempotency_key: idempotencyKey,
          status: "completed",
        });

        if (shift) {
          try {
            await applyPaymentToShift(service, shift, method, amount);
            shiftApplied = { shiftId: shift.id, method, amount };
          } catch (shiftError) {
            await service.entities.OrderPayment.delete(createdPayment.id).catch(() => {});
            await service.entities.CustomerOrder.updateMany(
              { id: order.id, paid_amount: newPaid },
              {
                $set: {
                  paid_amount: currentPaid,
                  remaining_balance: remaining,
                  payment_status: order.payment_status,
                },
              },
            ).catch(() => {});
            throw shiftError;
          }
        }

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "order_payment",
          details: `${order.order_number} · ${paymentKind} · ${method} · ${amount} UZS`,
        }).catch(() => {});

        return Response.json({
          payment: createdPayment,
          order: {
            ...order,
            paid_amount: newPaid,
            remaining_balance: newRemaining,
            payment_status: newStatus,
          },
          runtime_version: ORDER_RUNTIME_VERSION,
        });
      } catch (error) {
        if (shiftApplied) {
          await reversePaymentOnShift(service, shiftApplied.shiftId, shiftApplied.method, shiftApplied.amount);
        }
        if (createdPayment?.id) {
          await service.entities.OrderPayment.delete(createdPayment.id).catch(() => {});
        }
        await service.entities.CustomerOrder.updateMany(
          { id: order.id, paid_amount: newPaid },
          {
            $set: {
              paid_amount: currentPaid,
              remaining_balance: remaining,
              payment_status: order.payment_status,
            },
          },
        ).catch(() => {});
        throw error;
      }
    }

    return Response.json({ error: "Noto‘g‘ri amal." }, { status: 400 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Buyurtma amali bajarilmadi.",
    }, { status: Number((error as any)?.status || 500) });
  }
}