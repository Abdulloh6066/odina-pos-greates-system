import { createClientFromRequest } from "npm:@base44/sdk";

const money = (value: unknown) => Math.round(Number(value) || 0);
const quantity = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : NaN;
};
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
    const iterations = Math.min(Number(security.pin_iterations || 100000), 100000);
    const derived = await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-256",
      salt: new TextEncoder().encode(security.pin_salt), iterations,
    }, key, 256);
    return hex(new Uint8Array(derived)) === security.pin_hash;
  }

  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`${security.pin_salt}:${pin}`),
  );
  return hex(new Uint8Array(digest)) === security.pin_hash;
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
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });

    const body = await req.json();
    const action = String(body?.action || "");

    if (action === "get_debts") {
      if (!["admin", "cashier", "warehouse", "accountant"].includes(user.role)) {
        return Response.json({ error: "Qarzlarni ko‘rishga ruxsat yo‘q." }, { status: 403 });
      }
      const openReceipts = (await service.entities.SupplierReceipt.filter(
        { remaining_debt: { $gt: 0 } }, "received_at", 500,
      )) || [];
      const totals: Record<string, number> = {};
      for (const receipt of openReceipts) {
        totals[receipt.supplier_id] = money(totals[receipt.supplier_id] || 0) + money(receipt.remaining_debt);
      }
      return Response.json({ debts: totals });
    }

    if (action === "create_receipt") {
      if (!["admin", "warehouse"].includes(user.role)) {
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
      if (user.role === "warehouse" && (!user.shop_id || user.shop_id !== locationId)) {
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

    if (action === "pay_debt") {
      if (!["admin", "cashier"].includes(user.role)) {
        return Response.json({ error: "Faqat owner yoki kassir qarzni to‘lay oladi." }, { status: 403 });
      }
      if (user.role === "cashier" && !(await verifyOwnerPin(service, body?.owner_pin))) {
        return Response.json({ error: "Owner PIN-kodi noto‘g‘ri." }, { status: 403 });
      }

      const supplierId = String(body?.supplier_id || "");
      const shiftId = String(body?.shift_id || "");
      const amount = money(body?.amount);
      const notes = String(body?.notes || "").trim();
      if (!supplierId || !shiftId || amount <= 0) {
        return Response.json({ error: "Yetkazib beruvchi, smena va summa majburiy." }, { status: 400 });
      }

      const [supplier, shift] = await Promise.all([
        service.entities.CashRecipient.get(supplierId),
        service.entities.Shift.get(shiftId),
      ]);
      if (!supplier || supplier.active === false) return Response.json({ error: "Yetkazib beruvchi topilmadi." }, { status: 404 });
      if (!shift || shift.status !== "open") return Response.json({ error: "Smena ochiq emas." }, { status: 409 });
      if (shift.user_id !== user.id) return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
      if (amount > Number(shift.expected_cash || 0)) {
        return Response.json({ error: "Kassada kutilayotgan naqd pul yetarli emas." }, { status: 400 });
      }

      const debts = (await service.entities.SupplierReceipt.filter(
        { supplier_id: supplier.id, remaining_debt: { $gt: 0 } }, "received_at", 500,
      )) || [];
      const totalDebt = debts.reduce((sum: number, debt: any) => sum + money(debt.remaining_debt), 0);
      if (totalDebt <= 0) return Response.json({ error: "Bu yetkazib beruvchida qarz yo‘q." }, { status: 409 });
      if (amount > totalDebt) {
        return Response.json({ error: `To‘lov qolgan qarzdan oshmasligi kerak: ${totalDebt} UZS.` }, { status: 400 });
      }

      const now = new Date().toISOString();
      const userName = user.full_name || user.email || "Noma’lum xodim";
      const paymentNumber = `QT-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      let unallocated = amount;
      const changedDebts: any[] = [];
      const payments: any[] = [];
      let cashMovement: any = null;

      try {
        for (const debt of debts) {
          if (unallocated <= 0) break;
          const before = money(debt.remaining_debt);
          const applied = Math.min(before, unallocated);
          const after = before - applied;
          const update = await service.entities.SupplierReceipt.updateMany(
            { id: debt.id, remaining_debt: before },
            { $set: { remaining_debt: after, status: receiptStatus(after, money(debt.debt_amount)) } },
          );
          if (!update?.success || Number(update.updated || 0) !== 1) {
            throw new Error("Qarz bir vaqtda o‘zgardi. Yangilab qayta urinib ko‘ring.");
          }
          changedDebts.push({ debt, before });

          const payment = await service.entities.SupplierPayment.create({
            payment_number: paymentNumber,
            receipt_id: debt.id,
            receipt_number_snapshot: debt.receipt_number,
            supplier_id: supplier.id,
            supplier_name_snapshot: supplier.name,
            amount: applied,
            shop_id: shift.shop_id,
            shop_name_snapshot: shift.shop_name,
            shift_id: shift.id,
            user_id: user.id,
            user_name: userName,
            notes: notes || undefined,
            paid_at: now,
          });
          payments.push(payment);
          unallocated -= applied;
        }
        if (unallocated !== 0) throw new Error("To‘lovni qarzlarga taqsimlab bo‘lmadi.");

        const shiftUpdate = await service.entities.Shift.updateMany(
          { id: shift.id, expected_cash: Number(shift.expected_cash || 0), status: "open" },
          { $set: {
            expected_cash: Number(shift.expected_cash || 0) - amount,
            cash_removed: Number(shift.cash_removed || 0) + amount,
          } },
        );
        if (!shiftUpdate?.success || Number(shiftUpdate.updated || 0) !== 1) {
          throw new Error("Kassa summasi bir vaqtda o‘zgardi. Yangilab qayta urinib ko‘ring.");
        }

        cashMovement = await service.entities.CashMovement.create({
          shift_id: shift.id,
          shop_id: shift.shop_id,
          user_id: user.id,
          user_name: userName,
          employee_name: userName,
          type: "withdrawal",
          expense_category: "goods_payment",
          recipient_id: supplier.id,
          recipient_name_snapshot: supplier.name,
          amount,
          reason: notes || `${supplier.name} qarzini to‘lash`,
          reference_id: paymentNumber,
          reference_type: "supplier_payment",
          created_at: now,
        });
        for (const payment of payments) {
          await service.entities.SupplierPayment.update(payment.id, { cash_movement_id: cashMovement.id });
        }

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "supplier_debt_paid",
          details: `${paymentNumber}. ${supplier.name}. ${shift.shop_name}. ${amount} UZS.`,
        });

        return Response.json({
          payments,
          cash_movement: cashMovement,
          remaining_debt: totalDebt - amount,
          shift: {
            ...shift,
            expected_cash: Number(shift.expected_cash || 0) - amount,
            cash_removed: Number(shift.cash_removed || 0) + amount,
          },
        });
      } catch (error) {
        if (cashMovement?.id) {
          try { await service.entities.CashMovement.delete(cashMovement.id); } catch {}
        }
        for (const payment of payments.reverse()) {
          try { await service.entities.SupplierPayment.delete(payment.id); } catch {}
        }
        for (const changed of changedDebts.reverse()) {
          try {
            await service.entities.SupplierReceipt.update(changed.debt.id, {
              remaining_debt: changed.before,
              status: receiptStatus(changed.before, money(changed.debt.debt_amount)),
            });
          } catch {}
        }
        try {
          const latestShift = await service.entities.Shift.get(shift.id);
          if (latestShift && Number(latestShift.expected_cash) === Number(shift.expected_cash || 0) - amount) {
            await service.entities.Shift.update(shift.id, {
              expected_cash: Number(shift.expected_cash || 0),
              cash_removed: Number(shift.cash_removed || 0),
            });
          }
        } catch {}
        throw error;
      }
    }

    return Response.json({ error: "Noma’lum amal." }, { status: 400 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Yetkazib beruvchi amali bajarilmadi.",
    }, { status: 500 });
  }
}
