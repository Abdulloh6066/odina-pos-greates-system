// Shared helpers for shift-closing logic. Pure module: no SDK import, no Deno.serve.
// Both complete-sale and shift-close-v2 import from here to avoid duplication.

// Shop-wide sequential KITCHEN TICKET numbers are distinct from immutable Sale.sale_number
// and CustomerOrder.order_number. The counter is atomically claimed on Shop so all cashiers
// and all shifts in the same shop share it, regardless of date or device.
const serviceTicketVersion = (shop: any) => Number.isSafeInteger(shop?.service_ticket_version)
  && shop.service_ticket_version >= 0 ? shop.service_ticket_version : 0;
const serviceTicketVersionQuery = (version: number) => version === 0
  ? { $or: [{ service_ticket_version: 0 }, { service_ticket_version: { $exists: false } }] }
  : { service_ticket_version: version };

export async function allocateServiceTicketNumber(service: any, shopId: string, initialShop: any = null): Promise<number> {
  if (!shopId || !service?.entities?.Shop?.get || !service?.entities?.Shop?.updateMany) {
    throw httpError("Xizmat cheki uchun do‘kon aniqlanmadi.", 409);
  }
  for (let attempt = 0; attempt < 128; attempt += 1) {
    // Reuse this request’s verified shop only for the first attempt. A failed
    // version claim always rereads the counter, retaining concurrency safety.
    const shop = attempt === 0 && initialShop?.id === shopId
      ? initialShop : await service.entities.Shop.get(shopId);
    if (!shop || shop.active === false || shop.allows_pos === false || shop.location_type === "production") {
      throw httpError("Xizmat cheki do‘koni faol emas.", 409);
    }
    const version = serviceTicketVersion(shop);
    const counter = Number.isSafeInteger(shop.service_ticket_counter) && shop.service_ticket_counter >= 0
      ? shop.service_ticket_counter : 0;
    if (shop.service_ticket_cycle_active !== true) {
      // Existing open shifts at rollout may already have completed ordinary sales.
      // Bootstrap their saved order counts without editing their historical records.
      const opened = await service.entities.Shift.filter({ shop_id: shopId, status: "open" }, "-opened_at", 1000);
      if (!opened?.length) throw httpError("Xizmat cheki uchun do‘konda ochiq smena kerak.", 409);
      const legacyBaseline = counter === 0
        ? (opened || []).reduce((sum: number, shift: any) => sum + Math.max(0, Number(shift.order_count) || 0), 0)
          + (Array.isArray(shop.restaurant_table_orders)
            ? shop.restaurant_table_orders.filter((order: any) => !Number.isSafeInteger(order?.ticket_number)).length : 0)
        : 0;
      if (!Number.isSafeInteger(legacyBaseline) || legacyBaseline >= 1_000_000_000) {
        throw httpError("Buyurtma raqamlashini tekshirish kerak. Egaga xabar bering.", 409);
      }
      // Start the cycle and claim its first ticket in the same version-checked
      // write. A competing cashier rereads after a failed claim as before.
      const activated = await service.entities.Shop.updateMany(
        { id: shopId, ...serviceTicketVersionQuery(version) },
        { $set: { service_ticket_cycle_active: true, service_ticket_counter: legacyBaseline + 1 },
          $inc: { service_ticket_version: 1 } },
      );
      if (activated?.success && Number(activated.updated || 0) === 1) return legacyBaseline + 1;
      continue; // Another cashier initialized this shop; read its counter again.
    }
    if (counter >= 1_000_000_000) throw httpError("Xizmat cheki raqamlash chegarasiga yetdi.", 409);
    const claimed = await service.entities.Shop.updateMany(
      { id: shopId, service_ticket_cycle_active: true, ...serviceTicketVersionQuery(version) },
      { $inc: { service_ticket_counter: 1, service_ticket_version: 1 } },
    );
    if (claimed?.success && Number(claimed.updated || 0) === 1) return counter + 1;
  }
  throw httpError("Buyurtma raqami boshqa kassada o‘zgardi. Qayta urinib ko‘ring.", 409);
}

// Called ONLY after a shift is durably closed. A second still-open or closing
// shift keeps the sequence alive. Leave the old counter as an audit clue;
// the first request of the next cycle starts again at 1.
export async function finishServiceTicketCycleIfLastShift(service: any, shopId: string): Promise<boolean> {
  if (!shopId || !service?.entities?.Shop?.get || !service?.entities?.Shift?.filter) return false;
  const shop = await service.entities.Shop.get(shopId).catch(() => null);
  if (!shop || shop.service_ticket_cycle_active !== true) return false;
  const version = serviceTicketVersion(shop);
  const [opened, closing] = await Promise.all([
    service.entities.Shift.filter({ shop_id: shopId, status: "open" }, "-opened_at", 1),
    service.entities.Shift.filter({ shop_id: shopId, status: "closing" }, "-opened_at", 1),
  ]);
  if (opened?.length || closing?.length) return false;
  const result = await service.entities.Shop.updateMany(
    { id: shopId, service_ticket_cycle_active: true, ...serviceTicketVersionQuery(version) },
    { $set: { service_ticket_cycle_active: false }, $inc: { service_ticket_version: 1 } },
  );
  return Boolean(result?.success && Number(result.updated || 0) === 1);
}

export const money = (value: unknown) => Math.round(Number(value) || 0);

export { APP_ROLES, userRole, userShopId, resolveAppUser } from "./user-helpers.ts";

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
  uzcard: "Bank card",
  humo: "Humo",
  online: "Online",
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