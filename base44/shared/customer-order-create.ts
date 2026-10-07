import { money, httpError } from "./shift-close-helpers.ts";
import { ensureCustomer } from "./customer-helpers.ts";
import { allocateCustomerOrderSequence } from "./customer-order-sequence.js";

const ORDER_RUNTIME_VERSION = "customer-orders-v3-2026-09-13";
export const PAYMENT_METHODS = new Set([
  "cash", "bank_card", "online", "uzcard", "humo", "click", "payme", "bank_transfer", "other",
]);
const ORDER_TYPES = new Set(["toy_va_bazmlar", "tugilgan_kun_va_boshqa"]);
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

export function tashkentStamp(): string {
  const np = tashkentNowParts();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${np.year}-${pad(np.month)}-${pad(np.day)}T${pad(np.hour)}:${pad(np.minute)}:00+05:00`;
}

export function methodToShiftField(method: string): string | null {
  if (method === "cash") return "cash_sales";
  if (method === "uzcard" || method === "bank_card") return "uzcard_sales";
  if (method === "humo") return "humo_sales";
  if (method === "bank_transfer") return "bank_transfer_sales";
  if (["online", "click", "payme", "other"].includes(method)) return "online_sales";
  return null;
}

export async function findOpenShift(service: any, userId: string, shopId: string) {
  const shifts = await service.entities.Shift.filter({
    user_id: userId, status: "open", shop_id: shopId,
  });
  return (shifts && shifts[0]) || null;
}

export async function applyPaymentToShift(
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

export async function reversePaymentOnShift(
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

async function normalizeOrderItems(service: any, requestedItems: any[], orderType: string, shopId: string, botGuard: any = null) {
  const normalized: any[] = [];
  for (const requested of requestedItems) {
    const productId = String(requested?.product_id || "");
    const quantity = Number(requested?.quantity);
    // Only the authenticated internal Telegram bridge may create an unlisted cake.
    // The price comes from its validated draft, never from a browser item price.
    if (!productId && botGuard?.allowUnlistedCake === true) {
      const price = botGuard.expectedTotal;
      if (requestedItems.length !== 1 || quantity !== 1 || !Number.isSafeInteger(price) || price <= 0 || price > 1000000000) {
        throw httpError("Oddiy buyurtma narxi yoki miqdori noto‘g‘ri.", 400);
      }
      const products = await service.entities.Product.filter({ active: true, name: `TORT ${price}` });
      const matching = products.filter((p: any) => p.archived !== true && p.production_unit !== "sheet"
        && String(p.name).trim().toUpperCase() === `TORT ${price}`
        && Number(p.shop_prices?.[shopId] ?? p.price) === price);
      if (matching.length) throw httpError("Katalog o‘zgardi. Buyurtmani qayta tekshirish kerak.", 409);
      normalized.push({
        product_id: "", item_type: "custom", product_name_snapshot: "Oddiy buyurtma (tort)",
        product_image_snapshot: "", category_name_snapshot: "Buyurtmalar",
        unit_snapshot: "piece", quantity: 1, event_pieces_per_sheet_snapshot: 0,
        unit_price_snapshot: price, line_total: price,
        customization_note: String(requested?.customization_note || ""),
      });
      continue;
    }
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
      throw httpError("Har bir mahsulotda to‘g‘ri miqdor bo‘lishi kerak.", 400);
    }
    const product = await service.entities.Product.get(productId);
    if (!product || product.active === false || product.archived === true) {
      throw httpError("Tanlangan mahsulot hozir sotuvda mavjud emas.", 409);
    }
    const isSheet = product.production_unit === "sheet";
    const unit = isSheet ? "sheet" : "piece";
    const unitPrice = isSheet ? money(product.sheet_price) : money(product?.shop_prices?.[shopId] ?? product.price);
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

// Internal only. Callers authenticate and authorize before invoking; never expose directly.
export async function createCustomerOrder(service: any, user: any, body: any, botGuard: null | { staffId: string; shopId: string; expectedTotal: number; allowUnlistedCake?: boolean; authorize: () => Promise<any> } = null): Promise<Response> {
  let createdOrder: any = null;
  let createdItems: any[] = [];
  let createdPayment: any = null;
  let shiftApplied: { shiftId: string; method: string; amount: number } | null = null;
      const idempotencyKey = String(body?.idempotency_key || "");
      if (!idempotencyKey) {
        return Response.json({ error: "Idempotency kaliti kerak." }, { status: 400 });
      }
      const existingOrders = await service.entities.CustomerOrder.filter({ idempotency_key: idempotencyKey });
      if (existingOrders && existingOrders.length) {
        if (user.role === "manager" && existingOrders[0].shop_id !== user.shop_id) return Response.json({ error: "Boshqa do‘kon buyurtmasiga ruxsat yo‘q." }, { status: 403 });
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

      if (botGuard) {
        const current = await botGuard.authorize();
        if (!current || current.active !== true || current.data?.active === false || current.id !== user.id || current.shop_id !== botGuard.shopId || !["admin", "manager", "cashier"].includes(current.role)) {
          throw httpError("Xodim ruxsati o‘zgargan.", 403);
        }
      }

      const { customer_id: resolvedCustomerId } = await ensureCustomer(service, {
        customer_id: String(body?.customer_id || ""),
        name: customerName,
        phone: customerPhone,
      });

      let shopId = String(body?.shop_id || "");
      if (["cashier", "manager"].includes(user.role)) {
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
      const normalizedItems = await normalizeOrderItems(service, requestedItems, orderType, shop.id, botGuard);
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

      if (botGuard && (total !== botGuard.expectedTotal || body?.advance_payment || fulfilmentType !== "pickup" || adjustmentAmount !== 0 || normalizedItems.length !== 1 || normalizedItems[0].quantity !== 1)) {
        throw httpError("Buyurtma shartlari o‘zgardi. Qayta tekshirish kerak.", 409);
      }
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

      if (botGuard) {
        const current = await botGuard.authorize();
        const currentShop = await service.entities.Shop.get(botGuard.shopId);
        if (!current || current.active !== true || current.data?.active === false || current.id !== user.id || current.shop_id !== shop.id || current.shop_id !== botGuard.shopId || !["admin", "manager", "cashier"].includes(current.role) || !currentShop || currentShop.active === false) {
          throw httpError("Xodim ruxsati yoki do‘koni o‘zgargan.", 403);
        }
      }

      const orderSequence = await allocateCustomerOrderSequence(service);
      try {
        createdOrder = await service.entities.CustomerOrder.create({
          order_sequence: orderSequence,
          order_number: orderNumber,
          order_type: orderType,
          shop_id: shop.id,
          shop_name_snapshot: shop.name,
          customer_id: resolvedCustomerId || undefined,
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
          ready_inventory_state: "pending",
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
        // Bot submissions reconcile uncertain/partial results. Never destructively
        // compensate a write whose outcome may be ambiguous.
        if (botGuard) throw error;
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
