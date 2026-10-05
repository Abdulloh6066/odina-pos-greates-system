import { assertManagerRequestScope } from "../../shared/manager-request-scope.ts";
import { createClientFromRequest } from "npm:@base44/sdk";
import { money, httpError, resolveAppUser, stockNumber } from "../../shared/shift-close-helpers.ts";
import {
  completeOrderReadyProduction,
  reservedOrderProductionPieces,
} from "../../shared/order-ready-production.ts";
import { createCustomerOrder, PAYMENT_METHODS, tashkentStamp, findOpenShift, applyPaymentToShift, reversePaymentOnShift } from "../../shared/customer-order-create.ts";

const ORDER_RUNTIME_VERSION = "customer-orders-v3-2026-09-13";

const PAYMENT_KINDS = new Set(["advance", "balance", "additional"]);

async function stockPolicy(service: any) {
  const settings = await service.entities.Settings.list();
  return settings?.[0]?.allow_negative_stock !== false;
}

async function planOrderStock(
  service: any, shopId: string, deductionItems: any[],
) {
  const plans = [];
  const shortages = [];
  for (const item of deductionItems) {
    const rows = await service.entities.ProductStock.filter({
      location_id: shopId,
      product_id: item.productId,
    });
    if ((rows || []).length > 1) {
      throw httpError(`${item.productName} uchun takroriy ombor qoldig‘i topildi.`, 409);
    }
    const stock = rows?.[0] || null;
    const before = stockNumber(stock?.quantity || 0);
    const after = stockNumber(before - item.pieces);
    if (after < 0) {
      shortages.push({
        product_id: item.productId,
        product_name: item.productName,
        requested: item.pieces,
        available: before,
        missing: stockNumber(-after),
      });
    }
    plans.push({
      productId: item.productId,
      productName: item.productName,
      pieces: item.pieces,
      stock, before, after,
    });
  }
  return { plans, shortages };
}

export default async function(req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;
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
    const body = await req.json();
    if (user.role === "manager") await assertManagerRequestScope(service, user, body);
    const action = String(body?.action || "");
    // Production staff may change production status only, never create orders
    // or accept payments. Authorize the requested action before any writes.
    const allowedRoles = action === "update_production_status"
      ? ["admin", "production"] : ["admin", "manager", "cashier"];
    if (!allowedRoles.includes(user.role)) {
      return Response.json({ error: "Bu buyurtma amali uchun ruxsat yo‘q." }, { status: 403 });
    }

    if (action === "runtime_status") {
      return Response.json({ ok: true, runtime_version: ORDER_RUNTIME_VERSION });
    }

    if (action === "create_order") {
      return await createCustomerOrder(service, user, body);
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
      if (["cashier", "manager"].includes(user.role) && order.shop_id !== user.shop_id) {
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

    if (action === "update_production_status") {
      const orderId = String(body?.order_id || "");
      const step = String(body?.step || "");
      if (!orderId) {
        return Response.json({ error: "Buyurtma ID majburiy." }, { status: 400 });
      }
      if (!["admin", "production"].includes(user.role)) {
        return Response.json({ error: "Ishlab chiqarish ekrani uchun ruxsat yo‘q." }, { status: 403 });
      }
      const order = await service.entities.CustomerOrder.get(orderId);
      if (!order) {
        return Response.json({ error: "Buyurtma topilmadi." }, { status: 404 });
      }
      if (user.role === "production") {
        const assigned = user.shop_id ? await service.entities.Shop.get(user.shop_id).catch(() => null) : null;
        if (!assigned || assigned.active === false || assigned.location_type !== "production"
          || (order.ready_inventory_location_id && order.ready_inventory_location_id !== assigned.id)) {
          return Response.json({ error: "Siz faol ishlab chiqarish omboriga biriktirilmagansiz." }, { status: 403 });
        }
      }

      if (step === "ready") {
        const result = await completeOrderReadyProduction({
          service,
          user,
          order,
          readyStamp: tashkentStamp(),
        });
        return Response.json({
          ...result,
          runtime_version: ORDER_RUNTIME_VERSION,
        });
      }
      if (step !== "shipped") {
        return Response.json({ error: "Noto‘g‘ri amal." }, { status: 400 });
      }

      const prev = String(order.order_status || "qabul_qilindi");
      if (prev !== "tayyor") {
        return Response.json({ error: "Yuborish uchun avval Tayyor bo‘lishi kerak." }, { status: 409 });
      }
      const nextStatus = "yuborildi_olib_ketildi";
      const stamp = tashkentStamp();
      const claim = await service.entities.CustomerOrder.updateMany(
        { id: order.id, order_status: prev },
        {
          $set: {
            order_status: nextStatus,
            shipped_at: stamp,
            updated_at: new Date().toISOString(),
          },
        },
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ error: "Buyurtma holati o‘zgardi. Yangilang va qayta urinib ko‘ring." }, { status: 409 });
      }
      const userName = user.full_name || user.email || "Noma’lum xodim";
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: userName,
        action: "production_status_change",
        details: `${order.order_number} · ${prev} → ${nextStatus} · ${userName} · ${stamp}`,
      }).catch(() => {});
      return Response.json({
        order: { ...order, order_status: nextStatus, shipped_at: stamp },
        previous_status: prev,
        runtime_version: ORDER_RUNTIME_VERSION,
      });
    }

    if (action === "complete_order") {
      const orderId = String(body?.order_id || "");
      const idempotencyKey = String(body?.idempotency_key || "");
      if (!orderId) {
        return Response.json({ error: "Buyurtma ID majburiy." }, { status: 400 });
      }
      if (!["admin", "manager", "cashier"].includes(user.role)) {
        return Response.json({ error: "Buyurtmani yakunlash uchun ruxsat yo‘q." }, { status: 403 });
      }

      const order = await service.entities.CustomerOrder.get(orderId);
      if (!order) {
        return Response.json({ error: "Buyurtma topilmadi." }, { status: 404 });
      }
      if (String(order.order_status || "") === "yakunlandi") {
        return Response.json({ order, already_completed: true, runtime_version: ORDER_RUNTIME_VERSION });
      }
      if (["cashier", "manager"].includes(user.role) && order.shop_id !== user.shop_id) {
        return Response.json({ error: "Bu buyurtma boshqa do‘konga tegishli." }, { status: 403 });
      }
      const prevStatus = String(order.order_status || "");
      if (prevStatus !== "tayyor" && prevStatus !== "yuborildi_olib_ketildi") {
        return Response.json({ error: "Buyurtma tayyor yoki yuborilgan holatda bo‘lishi kerak." }, { status: 409 });
      }

      const total = money(order.total);
      const currentPaid = money(order.paid_amount);
      const remaining = money(total - currentPaid);

      let method = "";
      let shift: any = null;
      if (remaining > 0) {
        method = String(body?.method || "");
        if (!PAYMENT_METHODS.has(method)) {
          return Response.json({ error: "To‘lov usuli noto‘g‘ri." }, { status: 400 });
        }
        const providedAmount = money(body?.amount || 0);
        if (providedAmount !== remaining) {
          return Response.json({ error: `Qoldiq to‘lov aniq ${remaining} UZS bo‘lishi kerak.` }, { status: 400 });
        }
        if (!idempotencyKey) {
          return Response.json({ error: "Idempotency kaliti kerak." }, { status: 400 });
        }
        shift = await findOpenShift(service, user.id, order.shop_id);
        if (!shift && method === "cash") {
          return Response.json({ error: "Naqd to‘lov uchun ushbu do‘konda smenani oching." }, { status: 409 });
        }
      }

      const orderItems = await service.entities.CustomerOrderItem.filter({ order_id: order.id });
      const deductionMap = new Map<string, { productId: string; productName: string; pieces: number }>();
      for (const item of (orderItems || [])) {
        const productId = String(item.product_id || "");
        if (!productId) continue;
        const product = await service.entities.Product.get(productId);
        if (!product || product.track_stock === false) continue;
        const unit = String(item.unit_snapshot || "piece");
        const qty = Math.floor(Number(item.quantity) || 0);
        const piecesPerSheet = Math.max(1, Number(item.event_pieces_per_sheet_snapshot) || 0);
        const pieces = unit === "sheet" ? qty * piecesPerSheet : qty;
        if (pieces <= 0) continue;
        const existing = deductionMap.get(productId);
        if (existing) {
          existing.pieces += pieces;
        } else {
          deductionMap.set(productId, {
            productId,
            productName: String(item.product_name_snapshot || product.name || ""),
            pieces,
          });
        }
      }
      const reservedPiecesByProduct = await reservedOrderProductionPieces(service, order.id);
      for (const [productId, deduction] of deductionMap.entries()) {
        const reservedPieces = stockNumber(reservedPiecesByProduct.get(productId) || 0);
        if (reservedPieces <= 0) continue;
        const uncoveredPieces = Math.max(0, stockNumber(deduction.pieces - reservedPieces));
        if (uncoveredPieces <= 0) {
          deductionMap.delete(productId);
        } else {
          deduction.pieces = uncoveredPieces;
        }
      }
      const deductionItems = Array.from(deductionMap.values());

      const existingMovements = await service.entities.StockMovement.filter({
        reference_id: order.id, reference_type: "customer_order", movement_type: "sale",
      });
      const stockAlreadyDeducted = (existingMovements && existingMovements.length) > 0;

      let stockPlans: any[] = [];
      let shortages: any[] = [];
      if (!stockAlreadyDeducted && deductionItems.length) {
        const allowNegativeStock = await stockPolicy(service);
        const planned = await planOrderStock(service, order.shop_id, deductionItems);
        stockPlans = planned.plans;
        shortages = planned.shortages;
        if (shortages.length && !allowNegativeStock) {
          return Response.json({
            error: "Omborda mahsulot yetarli emas. Qoldiqsiz yakunlash bloklangan.",
            shortages,
            allow_negative_stock: false,
          }, { status: 409 });
        }
      }

      const now = new Date().toISOString();
      const day = now.slice(0, 10).replaceAll("-", "");
      const userName = user.full_name || user.email || "Noma’lum xodim";
      let createdPayment: any = null;
      let shiftApplied: { shiftId: string; method: string; amount: number } | null = null;
      let orderPaidUpdated = false;
      let newPaid = currentPaid;
      let newRemaining = remaining;
      let newPayStatus = String(order.payment_status || "unpaid");
      const stockChanges: any[] = [];
      const stockMovementRecords: any[] = [];

      try {
        if (remaining > 0) {
          const existingPayment = await service.entities.OrderPayment.filter({ idempotency_key: idempotencyKey });
          if (existingPayment && existingPayment.length) {
            createdPayment = existingPayment[0];
          } else {
            newPaid = currentPaid + remaining;
            newRemaining = money(total - newPaid);
            newPayStatus = newRemaining <= 0 ? "paid" : (newPaid > 0 ? "partial" : "unpaid");
            const orderClaim = await service.entities.CustomerOrder.updateMany(
              { id: order.id, paid_amount: currentPaid },
              { $set: {
                paid_amount: newPaid,
                remaining_balance: newRemaining,
                payment_status: newPayStatus,
                updated_at: now,
              } },
            );
            if (!orderClaim?.success || Number(orderClaim.updated || 0) !== 1) {
              throw httpError("Buyurtma o‘zgardi. Yangilang va qayta urinib ko‘ring.", 409);
            }
            orderPaidUpdated = true;

            createdPayment = await service.entities.OrderPayment.create({
              order_id: order.id,
              order_number_snapshot: order.order_number,
              payment_kind: "balance",
              payment_method: method,
              amount: remaining,
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
                await applyPaymentToShift(service, shift, method, remaining);
                shiftApplied = { shiftId: shift.id, method, amount: remaining };
              } catch (shiftError) {
                await service.entities.OrderPayment.delete(createdPayment.id).catch(() => {});
                createdPayment = null;
                if (orderPaidUpdated) {
                  await service.entities.CustomerOrder.updateMany(
                    { id: order.id, paid_amount: newPaid },
                    { $set: {
                      paid_amount: currentPaid,
                      remaining_balance: remaining,
                      payment_status: String(order.payment_status || "unpaid"),
                    } },
                  ).catch(() => {});
                  orderPaidUpdated = false;
                }
                throw shiftError;
              }
            }
          }
        }

        if (!stockAlreadyDeducted) {
          for (const plan of stockPlans) {
            let stockRecord = plan.stock;
            if (stockRecord) {
              const update = await service.entities.ProductStock.updateMany(
                { id: stockRecord.id, quantity: plan.before },
                { $set: {
                  quantity: plan.after,
                  location_name: order.shop_name_snapshot,
                  product_name: plan.productName,
                  unit: "piece",
                  updated_at: now,
                  updated_by: user.id,
                  updated_by_name: userName,
                } },
              );
              if (!update?.success || Number(update.updated || 0) !== 1) {
                throw httpError(`${plan.productName} qoldig‘i boshqa qurilmada o‘zgardi. Yangilang va qayta urinib ko‘ring.`, 409);
              }
            } else {
              stockRecord = await service.entities.ProductStock.create({
                location_id: order.shop_id,
                location_name: order.shop_name_snapshot,
                product_id: plan.productId,
                product_name: plan.productName,
                unit: "piece",
                quantity: plan.after,
                low_stock_level: 0,
                updated_at: now,
                updated_by: user.id,
                updated_by_name: userName,
              });
            }
            stockChanges.push({ ...plan, stockRecord });

            const movement = await service.entities.StockMovement.create({
              movement_number: `ST-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
              location_id: order.shop_id,
              location_name: order.shop_name_snapshot,
              item_kind: "product",
              item_id: plan.productId,
              item_name: plan.productName,
              unit: "piece",
              movement_type: "sale",
              quantity_change: -plan.pieces,
              balance_before: plan.before,
              balance_after: plan.after,
              reason: `Buyurtma yakunlandi: ${order.order_number}`,
              reference_id: order.id,
              reference_type: "customer_order",
              user_id: user.id,
              user_name: userName,
              created_at: now,
            });
            stockMovementRecords.push(movement);
          }
        }

        const statusClaim = await service.entities.CustomerOrder.updateMany(
          { id: order.id, order_status: prevStatus },
          { $set: {
            order_status: "yakunlandi",
            updated_at: now,
          } },
        );
        if (!statusClaim?.success || Number(statusClaim.updated || 0) !== 1) {
          throw httpError("Buyurtma holati o‘zgardi. Yangilang va qayta urinib ko‘ring.", 409);
        }

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "order_completed",
          details: `${order.order_number} · ${order.shop_name_snapshot} · yakunlandi · ${userName} · ${now}${remaining > 0 ? ` · qoldiq ${remaining} (${method})` : ""}`,
        }).catch(() => {});

        const completedOrder = {
          ...order,
          paid_amount: remaining > 0 ? newPaid : currentPaid,
          remaining_balance: remaining > 0 ? newRemaining : remaining,
          payment_status: remaining > 0 ? newPayStatus : String(order.payment_status || "unpaid"),
          order_status: "yakunlandi",
        };

        return Response.json({
          order: completedOrder,
          payment: createdPayment,
          stock_updates: stockChanges.map((c) => ({ product_id: c.productId, quantity: c.after })),
          runtime_version: ORDER_RUNTIME_VERSION,
        });
      } catch (error) {
        for (const movement of stockMovementRecords) {
          await service.entities.StockMovement.delete(movement.id).catch(() => {});
        }
        for (const change of stockChanges) {
          await service.entities.ProductStock.updateMany(
            { id: change.stockRecord.id },
            { $inc: { quantity: change.pieces } },
          ).catch(() => {});
        }
        if (shiftApplied) {
          await reversePaymentOnShift(service, shiftApplied.shiftId, shiftApplied.method, shiftApplied.amount);
        }
        if (createdPayment?.id) {
          await service.entities.OrderPayment.delete(createdPayment.id).catch(() => {});
        }
        if (orderPaidUpdated) {
          await service.entities.CustomerOrder.updateMany(
            { id: order.id, paid_amount: newPaid },
            { $set: {
              paid_amount: currentPaid,
              remaining_balance: remaining,
              payment_status: String(order.payment_status || "unpaid"),
            } },
          ).catch(() => {});
        }
        throw error;
      }
    }

    return Response.json({ error: "Noto‘g‘ri amal." }, { status: 400 });
  } catch (error) {
    const payload: Record<string, unknown> = {
      error: error instanceof Error ? error.message : "Buyurtma amali bajarilmadi.",
    };
    if (Array.isArray((error as any)?.shortages)) {
      payload.shortages = (error as any).shortages;
    }
    return Response.json(payload, { status: Number((error as any)?.status || 500) });
  }
}