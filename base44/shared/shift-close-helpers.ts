// Shared helpers for shift-closing logic. Pure module: no SDK import, no Deno.serve.
// Both complete-sale and shift-close-v2 import from here to avoid duplication.

export const money = (value: unknown) => Math.round(Number(value) || 0);

export const APP_ROLES = new Set(["admin", "manager", "cashier", "accountant", "production", "warehouse"]);

export const userRole = (value: any) => {
  const rootRole = String(value?.role || "");
  const nestedRole = String(value?.data?.role || "");
  if (APP_ROLES.has(rootRole)) return rootRole;
  if (APP_ROLES.has(nestedRole)) return nestedRole;
  return rootRole || nestedRole;
};

export const userShopId = (value: any) =>
  String(value?.shop_id || value?.data?.shop_id || "");

export const resolveAppUser = async (service: any, authenticatedUser: any) => {
  let storedUser: any = null;
  const authenticatedId = String(authenticatedUser?.id || "");
  const email = String(authenticatedUser?.email || "").trim().toLowerCase();

  if (authenticatedId) {
    storedUser = await service.entities.User.get(authenticatedId).catch(() => null);
  }
  if (!storedUser && email) {
    const matches = await service.entities.User.filter({ email }, "-updated_date", 5);
    storedUser = (matches || []).find(
      (candidate: any) => String(candidate?.email || "").trim().toLowerCase() === email,
    ) || null;
  }

  const storedRole = userRole(storedUser);
  return {
    ...authenticatedUser,
    id: authenticatedUser?.id || storedUser?.id,
    email: authenticatedUser?.email || storedUser?.email,
    full_name: storedUser?.full_name || authenticatedUser?.full_name,
    role: APP_ROLES.has(storedRole) ? storedRole : userRole(authenticatedUser),
    shop_id: userShopId(storedUser) || userShopId(authenticatedUser),
    shop_name: storedUser?.shop_name || storedUser?.data?.shop_name
      || authenticatedUser?.shop_name || authenticatedUser?.data?.shop_name || "",
    active: storedUser?.active ?? authenticatedUser?.active,
  };
};

export const stockNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : 0;
};

export const httpError = (message: string, status: number) => {
  const error: any = new Error(message);
  error.status = status;
  return error;
};

export const SHIFT_STOCK_ROW_LIMIT = 1000;

export const stockMovementTime = (movement: any) =>
  Date.parse(movement?.created_at || movement?.created_date || "");

export async function buildShiftStockReport(service: any, shift: any, generatedAt: string) {
  const openedAt = String(shift?.opened_at || shift?.created_date || "");
  const openedMs = Date.parse(openedAt);
  const generatedMs = Date.parse(generatedAt);
  if (!shift?.shop_id || !Number.isFinite(openedMs) || !Number.isFinite(generatedMs)) {
    throw httpError("Smenaning boshlanish vaqti yoki do‘koni topilmadi.", 409);
  }

  const [stocks, movements, products] = await Promise.all([
    service.entities.ProductStock.filter(
      { location_id: shift.shop_id },
      "product_name",
      SHIFT_STOCK_ROW_LIMIT,
    ),
    service.entities.StockMovement.filter(
      {
        location_id: shift.shop_id,
        item_kind: "product",
        created_at: { $gte: openedAt, $lte: generatedAt },
      },
      "created_at",
      SHIFT_STOCK_ROW_LIMIT,
    ),
    service.entities.Product.list("name", SHIFT_STOCK_ROW_LIMIT),
  ]);

  if ((stocks || []).length >= SHIFT_STOCK_ROW_LIMIT || (movements || []).length >= SHIFT_STOCK_ROW_LIMIT) {
    throw httpError("Bu smenada mahsulot harakatlari juda ko‘p. Hisobotni administrator tekshirishi kerak.", 409);
  }

  const productById = new Map((products || []).map((product: any) => [String(product.id), product]));
  const rowsByProduct = new Map<string, any>();
  const stockIds = new Set<string>();

  const ensureRow = (productIdValue: unknown, fallbackName = "Noma’lum mahsulot") => {
    const productId = String(productIdValue || "");
    if (!productId) return null;
    const product: any = productById.get(productId) || {};
    if (product.track_stock === false) return null;
    if (!rowsByProduct.has(productId)) {
      rowsByProduct.set(productId, {
        product_id: productId,
        product_name_snapshot: String(product.name || fallbackName || "Noma’lum mahsulot"),
        image_url_snapshot: String(product.image_url || ""),
        unit: "piece",
        current_quantity: 0,
        total_change: 0,
        received_quantity: 0,
        sold_quantity: 0,
        waste_quantity: 0,
        returned_quantity: 0,
        latest_movement_at: Number.NEGATIVE_INFINITY,
        latest_balance_after: null,
      });
    }
    const row = rowsByProduct.get(productId);
    if ((!row.product_name_snapshot || row.product_name_snapshot === "Noma’lum mahsulot") && fallbackName) {
      row.product_name_snapshot = String(fallbackName);
    }
    return row;
  };

  for (const stock of stocks || []) {
    const productId = String(stock?.product_id || "");
    if (!productId) continue;
    if (stockIds.has(productId)) {
      throw httpError(`${stock?.product_name || "Mahsulot"} uchun takroriy do‘kon qoldig‘i topildi.`, 409);
    }
    stockIds.add(productId);
    const row = ensureRow(productId, stock?.product_name);
    if (!row) continue;
    if (stock?.unit && stock.unit !== "piece") {
      throw httpError(`${row.product_name_snapshot} do‘kon qoldig‘i dona formatida emas.`, 409);
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

  const rows = Array.from(rowsByProduct.values()).map((row: any) => {
    const expectedQuantity = row.latest_balance_after === null
      ? stockNumber(row.current_quantity)
      : stockNumber(row.latest_balance_after);
    const openingQuantity = stockNumber(expectedQuantity - row.total_change);
    const explainedChange = stockNumber(
      row.received_quantity
      - row.sold_quantity
      - row.waste_quantity
      + row.returned_quantity,
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
      expected_quantity: expectedQuantity,
    };
  }).sort((left: any, right: any) =>
    String(left.product_name_snapshot).localeCompare(String(right.product_name_snapshot), "uz")
  );

  return {
    shift_id: shift.id,
    shop_id: shift.shop_id,
    opened_at: openedAt,
    generated_at: generatedAt,
    rows,
  };
}

export async function cleanupShiftStockSnapshots(service: any, shiftId: string) {
  const snapshotsEntity = service?.entities?.ShiftProductSnapshot;
  if (!snapshotsEntity?.filter || !snapshotsEntity?.delete) return;
  const snapshots = await snapshotsEntity
    .filter({ shift_id: shiftId }, "-closed_at", SHIFT_STOCK_ROW_LIMIT)
    .catch(() => []);
  for (const snapshot of snapshots || []) {
    await snapshotsEntity.delete(snapshot.id).catch(() => {});
  }
}

export const BUDGET_ACCOUNT_LABELS: Record<string, string> = {
  cash: "Naqd pul",
  uzcard: "Uzcard",
  humo: "Humo",
  online: "Onlayn",
  bank: "Bank",
};

export async function creditBudgetBalance(service: any, account: string, amount: number, user: any, now: string) {
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

export async function rollbackBudgetBalance(service: any, change: any, user: any) {
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