import { resolveAppUser } from "../../shared/user-helpers.ts";
import { assertManagerRequestScope } from "../../shared/manager-request-scope.ts";
import { createClientFromRequest } from "npm:@base44/sdk";
import { financialRequestKey, runSupplierPayment } from "../../shared/supplier-payment-recovery.ts";

const money = (value: unknown) => Math.round(Number(value) || 0);
const quantity = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : NaN;
};
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

function receiptStatus(remaining: number, debt: number) {
  if (remaining <= 0) return "paid";
  if (remaining < debt) return "partial";
  return "unpaid";
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const auth = await base44.auth.me();
    if (!auth) return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });
    const user = await resolveAppUser(service, auth);

    const body = await req.json();
    if (user.role === "manager") await assertManagerRequestScope(service, user, body);
    const action = String(body?.action || "");

    if (action === "get_debts") {
      if (!["admin", "manager", "cashier", "warehouse", "accountant"].includes(user.role)) {
        return Response.json({ error: "Qarzlarni ko‘rishga ruxsat yo‘q." }, { status: 403 });
      }
      const openReceipts = (await service.entities.SupplierReceipt.filter(
        { remaining_debt: { $gt: 0 }, ...(user.role === "manager" ? { location_id: user.shop_id } : {}) }, "received_at", 500,
      )) || [];
      const totals: Record<string, number> = {};
      for (const receipt of openReceipts) {
        totals[receipt.supplier_id] = money(totals[receipt.supplier_id] || 0) + money(receipt.remaining_debt);
      }
      return Response.json({ debts: totals });
    }

    if (action === "create_receipt") {
      if (!["admin", "manager", "warehouse"].includes(user.role)) {
        return Response.json({ error: "Faqat owner yoki Omborchi kirim qila oladi." }, { status: 403 });
      }

      const supplierId = String(body?.supplier_id || "");
      const locationId = String(body?.location_id || "");
      const invoiceReference = String(body?.invoice_reference || "").trim();
      const notes = String(body?.notes || "").trim();
      const inputItems = Array.isArray(body?.items) ? body.items : [];

      if (!supplierId || !locationId || inputItems.length === 0 || inputItems.length > 100) {
        return Response.json({ error: "Yetkazib beruvchi, ombor va kamida bitta masalliq majburiy." }, { status: 400 });
      }
      if (["warehouse", "manager"].includes(user.role) && (!user.shop_id || user.shop_id !== locationId)) {
        return Response.json({ error: "Siz faqat biriktirilgan omborga kirim qila olasiz." }, { status: 403 });
      }

      const [supplier, location] = await Promise.all([
        service.entities.CashRecipient.get(supplierId),
        service.entities.Shop.get(locationId),
      ]);
      if (!supplier || supplier.active === false || !["supplier", "company"].includes(supplier.recipient_type)) {
        return Response.json({ error: "Faol yetkazib beruvchini tanlang." }, { status: 404 });
      }
      if (!location || location.active === false) {
        return Response.json({ error: "Ombor topilmadi yoki faol emas." }, { status: 404 });
      }

      const ids = [...new Set(inputItems.map((item: any) => String(item?.ingredient_id || "")).filter(Boolean))];
      if (ids.length !== inputItems.length) {
        return Response.json({ error: "Bir masalliqni bitta kirimda ikki marta qo‘shmang." }, { status: 400 });
      }

      const ingredients = await Promise.all(ids.map((id) => service.entities.Ingredient.get(id)));
      const ingredientMap = new Map(ingredients.filter(Boolean).map((item: any) => [item.id, item]));
      const verifiedItems = inputItems.map((input: any) => {
        const ingredient: any = ingredientMap.get(String(input?.ingredient_id || ""));
        const purchaseQuantity = quantity(input?.purchase_quantity);
        const unitPrice = money(input?.unit_price);
        if (!ingredient || ingredient.active === false) throw new Error("Masalliq topilmadi yoki faol emas.");
        if (!Number.isFinite(purchaseQuantity) || purchaseQuantity <= 0 || unitPrice < 0) {
          throw new Error("Miqdor va xarid narxini to‘g‘ri kiriting.");
        }
        if (ingredient.is_cake_layer === true && (location.location_type !== "production"
          || ingredient.base_unit !== "piece" || ingredient.purchase_unit !== "piece"
          || Number(ingredient.conversion_to_base) !== 1
          || !Number.isSafeInteger(Number(input.purchase_quantity)))) {
          const error: any = new Error("Qavatlar faqat markaziy omborga, butun list sonida kirim qilinadi.");
          error.status = 400;
          throw error;
        }
        const baseQuantity = quantity(purchaseQuantity * Number(ingredient.conversion_to_base || 1));
        return {
          ingredient,
          purchaseQuantity,
          unitPrice,
          baseQuantity,
          lineTotal: money(purchaseQuantity * unitPrice),
        };
      });
      const totalAmount = verifiedItems.reduce((sum: number, item: any) => sum + item.lineTotal, 0);
      if (totalAmount <= 0) {
        return Response.json({ error: "Kirimning jami summasi noldan katta bo‘lishi kerak." }, { status: 400 });
      }

      const now = new Date().toISOString();
      const userName = user.full_name || user.email || "Noma’lum xodim";
      const receiptNumber = `KR-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      let receipt: any = null;
      const createdItems: any[] = [];
      const createdMovements: any[] = [];
      const stockRollbacks: any[] = [];

      try {
        receipt = await service.entities.SupplierReceipt.create({
          receipt_number: receiptNumber,
          supplier_id: supplier.id,
          supplier_name_snapshot: supplier.name,
          location_id: location.id,
          location_name_snapshot: location.name,
          total_amount: totalAmount,
          paid_at_receipt: 0,
          debt_amount: totalAmount,
          remaining_debt: totalAmount,
          status: "unpaid",
          invoice_reference: invoiceReference || undefined,
          notes: notes || undefined,
          received_at: now,
          created_by: user.id,
          created_by_name: userName,
        });

        for (const item of verifiedItems) {
          const matches = await service.entities.IngredientStock.filter({
            location_id: location.id,
            ingredient_id: item.ingredient.id,
          });
          if ((matches || []).length > 1) throw new Error("Takroriy ombor qoldig‘i topildi. Owner tekshirishi kerak.");
          const existing = matches?.[0] || null;
          const before = quantity(existing?.quantity || 0);
          const after = quantity(before + item.baseQuantity);
          let stock: any;

          if (existing) {
            const update = await service.entities.IngredientStock.updateMany(
              { id: existing.id, quantity: before },
              { $set: {
                quantity: after,
                location_name: location.name,
                ingredient_name: item.ingredient.name,
                unit: item.ingredient.base_unit,
                updated_at: now,
                updated_by: user.id,
                updated_by_name: userName,
              } },
            );
            if (!update?.success || Number(update.updated || 0) !== 1) {
              throw new Error("Ombor qoldig‘i bir vaqtda o‘zgardi. Yangilab qayta urinib ko‘ring.");
            }
            stock = existing;
          } else {
            stock = await service.entities.IngredientStock.create({
              location_id: location.id,
              location_name: location.name,
              ingredient_id: item.ingredient.id,
              ingredient_name: item.ingredient.name,
              unit: item.ingredient.base_unit,
              quantity: after,
              low_stock_level: 0,
              updated_at: now,
              updated_by: user.id,
              updated_by_name: userName,
            });
          }
          stockRollbacks.push({ existing, stock, before });

          const receiptItem = await service.entities.SupplierReceiptItem.create({
            receipt_id: receipt.id,
            location_id: location.id,
            ingredient_id: item.ingredient.id,
            ingredient_name_snapshot: item.ingredient.name,
            purchase_quantity: item.purchaseQuantity,
            purchase_unit: item.ingredient.purchase_unit,
            base_quantity: item.baseQuantity,
            base_unit: item.ingredient.base_unit,
            unit_price: item.unitPrice,
            line_total: item.lineTotal,
          });
          createdItems.push(receiptItem);

          const movement = await service.entities.StockMovement.create({
            movement_number: `ST-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            location_id: location.id,
            location_name: location.name,
            item_kind: "ingredient",
            item_id: item.ingredient.id,
            item_name: item.ingredient.name,
            unit: item.ingredient.base_unit,
            movement_type: "receipt",
            quantity_change: item.baseQuantity,
            balance_before: before,
            balance_after: after,
            reason: `${supplier.name}dan kirim · ${receiptNumber}`,
            reference_id: receipt.id,
            reference_type: "supplier_receipt",
            user_id: user.id,
            user_name: userName,
            created_at: now,
          });
          createdMovements.push(movement);
        }

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "supplier_receipt_created",
          details: `${receiptNumber}. ${supplier.name}. ${location.name}. ${totalAmount} UZS qarz.`,
        });
        return Response.json({ receipt, items: createdItems });
      } catch (error) {
        for (const movement of createdMovements.reverse()) {
          try { await service.entities.StockMovement.delete(movement.id); } catch {}
        }
        for (const item of createdItems.reverse()) {
          try { await service.entities.SupplierReceiptItem.delete(item.id); } catch {}
        }
        for (const rollback of stockRollbacks.reverse()) {
          try {
            if (rollback.existing) {
              await service.entities.IngredientStock.update(rollback.existing.id, { quantity: rollback.before });
            } else if (rollback.stock?.id) {
              await service.entities.IngredientStock.delete(rollback.stock.id);
            }
          } catch {}
        }
        if (receipt?.id) {
          try { await service.entities.SupplierReceipt.delete(receipt.id); } catch {}
        }
        throw error;
      }
    }

    if (action === "cancel_receipt") {
      if (!["admin", "manager", "warehouse"].includes(user.role)) {
        return Response.json({ error: "Faqat owner yoki Omborchi kirimni bekor qila oladi." }, { status: 403 });
      }
      if (!(await verifyOwnerPin(service, body?.owner_pin, user))) {
        return Response.json({ error: "Owner PIN-kodi noto‘g‘ri." }, { status: 403 });
      }

      const receiptId = String(body?.receipt_id || "");
      const reason = String(body?.reason || "").trim();
      if (!receiptId || reason.length < 3) {
        return Response.json({ error: "Kirim va bekor qilish sababi majburiy." }, { status: 400 });
      }

      const receipt = await service.entities.SupplierReceipt.get(receiptId);
      if (!receipt) return Response.json({ error: "Kirim topilmadi." }, { status: 404 });
      if (receipt.status === "cancelled") {
        return Response.json({ error: "Bu kirim avval bekor qilingan." }, { status: 409 });
      }
      if (receipt.status === "cancelling") {
        return Response.json({ error: "Bu kirim bekor qilinish jarayonida. Owner tekshirishi kerak." }, { status: 409 });
      }
      if (["warehouse", "manager"].includes(user.role) && (!user.shop_id || user.shop_id !== receipt.location_id)) {
        return Response.json({ error: "Siz faqat biriktirilgan ombordagi kirimni bekor qila olasiz." }, { status: 403 });
      }

      const [items, payments] = await Promise.all([
        service.entities.SupplierReceiptItem.filter({ receipt_id: receipt.id }, "created_date", 500),
        service.entities.SupplierPayment.filter({ receipt_id: receipt.id }, "paid_at", 1),
      ]);
      if (!items?.length) {
        return Response.json({ error: "Kirim tarkibi topilmadi. Avtomatik bekor qilib bo‘lmaydi." }, { status: 409 });
      }
      if (
        payments?.length ||
        money(receipt.paid_at_receipt) > 0 ||
        money(receipt.remaining_debt) !== money(receipt.debt_amount)
      ) {
        return Response.json({
          error: "Bu kirim bo‘yicha pul to‘langan. Kassa va qarz tarixi buzilmasligi uchun uni avtomatik bekor qilib bo‘lmaydi.",
        }, { status: 409 });
      }

      const stockPlans: any[] = [];
      for (const item of items) {
        const matches = await service.entities.IngredientStock.filter({
          location_id: receipt.location_id,
          ingredient_id: item.ingredient_id,
        });
        if ((matches || []).length !== 1) {
          return Response.json({
            error: item.ingredient_name_snapshot + " uchun ombor qoldig‘i topilmadi yoki takroriy yozuv bor.",
          }, { status: 409 });
        }
        const stock = matches[0];
        const before = quantity(stock.quantity);
        const receivedQuantity = quantity(item.base_quantity);
        const after = quantity(before - receivedQuantity);
        if (!Number.isFinite(receivedQuantity) || receivedQuantity <= 0) {
          return Response.json({ error: "Kirim miqdori noto‘g‘ri saqlangan." }, { status: 409 });
        }
        if (after < 0) {
          return Response.json({
            error: item.ingredient_name_snapshot + " qoldig‘i yetarli emas. Kirimdan keyin masalliq ishlatilgan, shuning uchun bekor qilish bloklandi.",
          }, { status: 409 });
        }
        stockPlans.push({ item, stock, before, after, receivedQuantity });
      }

      const originalStatus = receipt.status;
      const originalRemaining = money(receipt.remaining_debt);
      const now = new Date().toISOString();
      const userName = user.full_name || user.email || "Noma’lum xodim";
      let claimed = false;
      const changedStocks: any[] = [];
      const reverseMovements: any[] = [];

      try {
        const claim = await service.entities.SupplierReceipt.updateMany(
          { id: receipt.id, status: originalStatus, remaining_debt: originalRemaining },
          { $set: { status: "cancelling" } },
        );
        if (!claim?.success || Number(claim.updated || 0) !== 1) {
          return Response.json({
            error: "Kirim boshqa qurilmada o‘zgargan. Yangilang va qayta urinib ko‘ring.",
          }, { status: 409 });
        }
        claimed = true;

        for (const plan of stockPlans) {
          const stockUpdate = await service.entities.IngredientStock.updateMany(
            { id: plan.stock.id, quantity: plan.before },
            { $set: {
              quantity: plan.after,
              updated_at: now,
              updated_by: user.id,
              updated_by_name: userName,
            } },
          );
          if (!stockUpdate?.success || Number(stockUpdate.updated || 0) !== 1) {
            throw new Error(plan.item.ingredient_name_snapshot + " qoldig‘i bir vaqtda o‘zgardi. Yangilang va qayta urinib ko‘ring.");
          }
          changedStocks.push(plan);

          const movement = await service.entities.StockMovement.create({
            movement_number: "ST-" + now.slice(0, 10).replaceAll("-", "") + "-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
            location_id: receipt.location_id,
            location_name: receipt.location_name_snapshot,
            item_kind: "ingredient",
            item_id: plan.item.ingredient_id,
            item_name: plan.item.ingredient_name_snapshot,
            unit: plan.item.base_unit,
            movement_type: "receipt_cancel",
            quantity_change: -plan.receivedQuantity,
            balance_before: plan.before,
            balance_after: plan.after,
            reason: "Kirim bekor qilindi · " + receipt.receipt_number + " · " + reason,
            reference_id: receipt.id,
            reference_type: "supplier_receipt_cancel",
            user_id: user.id,
            user_name: userName,
            created_at: now,
          });
          reverseMovements.push(movement);
        }

        const finalized = await service.entities.SupplierReceipt.updateMany(
          { id: receipt.id, status: "cancelling" },
          { $set: {
            status: "cancelled",
            remaining_debt: 0,
            cancelled_at: now,
            cancelled_by: user.id,
            cancelled_by_name: userName,
            cancellation_reason: reason,
          } },
        );
        if (!finalized?.success || Number(finalized.updated || 0) !== 1) {
          throw new Error("Kirimni yakuniy bekor qilishda yozuv o‘zgardi.");
        }

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "supplier_receipt_cancelled",
          details: receipt.receipt_number + ". " + receipt.supplier_name_snapshot + ". " + receipt.total_amount + " UZS. " + reason,
        });

        return Response.json({
          receipt: {
            ...receipt,
            status: "cancelled",
            remaining_debt: 0,
            cancelled_at: now,
            cancelled_by: user.id,
            cancelled_by_name: userName,
            cancellation_reason: reason,
          },
          reversed_items: stockPlans.length,
        });
      } catch (error) {
        for (const movement of reverseMovements.reverse()) {
          try { await service.entities.StockMovement.delete(movement.id); } catch {}
        }
        for (const plan of changedStocks.reverse()) {
          try {
            await service.entities.IngredientStock.updateMany(
              { id: plan.stock.id, quantity: plan.after },
              { $set: {
                quantity: plan.before,
                updated_at: new Date().toISOString(),
                updated_by: user.id,
                updated_by_name: userName,
              } },
            );
          } catch {}
        }
        if (claimed) {
          try {
            await service.entities.SupplierReceipt.updateMany(
              { id: receipt.id, status: "cancelling" },
              {
                $set: { status: originalStatus, remaining_debt: originalRemaining },
                $unset: {
                  cancelled_at: "",
                  cancelled_by: "",
                  cancelled_by_name: "",
                  cancellation_reason: "",
                },
              },
            );
          } catch {}
        }
        throw error;
      }
    }

    if (action === "pay_debt") {
      if (!["admin", "manager", "cashier"].includes(user.role)) {
        return Response.json({ error: "Faqat owner yoki kassir qarzni to‘lay oladi." }, { status: 403 });
      }
      if (user.role === "cashier" && !(await verifyOwnerPin(service, body?.owner_pin, user))) {
        return Response.json({ error: "Owner PIN-kodi noto‘g‘ri." }, { status: 403 });
      }

      const supplierId = String(body?.supplier_id || "");
      const shiftId = String(body?.shift_id || "");
      const amount = money(body?.amount);
      const notes = String(body?.notes || "").trim();
      if (!supplierId || !shiftId || !Number.isSafeInteger(amount) || amount <= 0) {
        return Response.json({ error: "Yetkazib beruvchi, smena va summa majburiy." }, { status: 400 });
      }

      const result = await runSupplierPayment(service, user, {
        key: financialRequestKey(body), action, supplier_id: supplierId, shift_id: shiftId, amount, notes,
      });
      return Response.json(result);
    }

    return Response.json({ error: "Noma’lum amal." }, { status: 400 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Yetkazib beruvchi amali bajarilmadi.",
      operation_pending: Boolean((error as any)?.operation_pending),
      operation_reversed: Boolean((error as any)?.operation_reversed),
    }, { status: Number((error as any)?.status) || 500 });
  }
}