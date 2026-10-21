import { pendingFinancialCloseGuard } from "../../shared/shift-pending-financial.ts";
import { assertManagerRequestScope } from "../../shared/manager-request-scope.ts";
import { savedShiftCloseResponse, reconcileShiftCloseFailure } from "../../shared/shift-settlement-recovery.ts";
import { createClientFromRequest } from "npm:@base44/sdk";
import { createCheckoutReadTracker, isTransientCheckoutError } from "../../shared/checkout-reads.ts";

// Expiry uses the server clock, through the selected day's end in Uzbekistan.
function isDiscountExpired(discount: any, now = Date.now()) {
  const date = discount?.valid_until;
  if (date === undefined || date === null || date === "") return false;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  const end = Date.parse(date + "T23:59:59.999+05:00");
  if (!Number.isFinite(end) || new Date(end + 5 * 60 * 60 * 1000).toISOString().slice(0, 10) !== date) return true;
  return now > end;
}


const COMPLETE_SALE_RUNTIME_VERSION = "checkout-latency-v3-2026-10-16";

const PAYMENT_METHODS = new Set([
  "cash",
  "bank_card",
  "online",
  "uzcard",
  "humo",
  "click",
  "payme",
  "bank_transfer",
  "other",
]);

import {
  money, stockNumber, httpError, APP_ROLES, userRole, userShopId,
  resolveAppUser, SHIFT_STOCK_ROW_LIMIT, stockMovementTime,
  buildShiftStockReport, cleanupShiftStockSnapshots,
  BUDGET_ACCOUNT_LABELS, creditBudgetBalance,
  allocateServiceTicketNumber, finishServiceTicketCycleIfLastShift,
} from "../../shared/shift-close-helpers.ts";
import { loadIngredientCosts, recipeCostFromMap, costPerPiece, num } from "../../shared/cost-engine.ts";
import { createCheckoutRecipeLoader, type CheckoutRecipeLoader } from "../../shared/checkout-recipes.ts";
import { priceForShop } from "../../shared/shop-pricing.ts";
import { validateFriesOption, saleLineKey, friesOptionFields, friesSurcharge, burgerOptionName, costWithBurgerFries, FRIES_INGREDIENT_ID } from "../../shared/burger-fries.js";
import {
  prepareSaleIngredientDeduction, applySaleIngredientDeduction, restoreSaleIngredientsOnRefund,
} from "../../shared/sale-ingredient-flow.ts";

// Restore only Odina Branch's deferred tech-card connection.
const BRANCH_TECH_CARD_SHOP_ID = "6a96f0a4ecc85c2fc57f3174";
async function prepareBranchIngredients(service: any, shopId: string, items: any[], recipeLoader?: CheckoutRecipeLoader, takeaway = false) {
  const eligible = shopId === BRANCH_TECH_CARD_SHOP_ID
    ? items.filter((item) => item.source_type === "shop_prepared" && item.sale_unit !== "gram")
    : [];
  const prepared = await prepareSaleIngredientDeduction(service, shopId, eligible, { allowMissing: true, recipeLoader, takeaway });
  const linked = new Set(prepared.lines.map((line: any) => line.product_id));
  for (const item of items) {
    if (linked.has(item.product_id)) {
      // These drinks consume ingredients, never an additional finished product.
      item.stock_tracked = false;
      item.stock_quantity_change = 0;
    }
  }
  return prepared;
}

// Await every independent write before a failure enters compensation.
async function settleCheckoutWrites(tasks: Array<() => Promise<unknown>>) {
  const results = await Promise.allSettled(tasks.map(async (task) => task()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

// Preserve the existing immutable cost snapshots while stock checks run.
async function loadSaleCostSnapshots(service: any, normalizedItems: any[], productsAtSale: Map<string, any>, recipeLoader: CheckoutRecipeLoader, takeaway = false) {
  const unitCostByProduct: Map<string, any> = new Map();
  const recipesByProduct: Map<string, any> = new Map();
  // Products without recipes retain the estimate fallback without loading
  // supplier history. Reuse verified recipes and product data below.
  const productIds = [...new Set<string>(normalizedItems.map(item => String(item.product_id)))];
  for (let start = 0; start < productIds.length; start += 4) {
    const batch = productIds.slice(start, start + 4);
    const recipes = await Promise.allSettled(batch.map((item) =>
      recipeLoader.recipesForProduct(item)));
    for (const [index, result] of recipes.entries()) {
      if (result.status === "fulfilled") {
        if (result.value?.[0]) recipesByProduct.set(batch[index], result.value[0]);
      } else {
        console.warn("Cost snapshot skipped:", result.reason);
      }
    }
  }
  if (!recipesByProduct.size) return unitCostByProduct;
  try {
    const costProductIds = productIds.filter(id => recipesByProduct.has(id));
    // Resolve the basket cards first so supplier reads are scoped to exactly
    // their ingredients. The request-local recipe cache is shared with stock.
    const cardsByProduct = await (async () => {
      const cards = new Map<string, any>();
      for (let start = 0; start < costProductIds.length; start += 4) {
        const batch = costProductIds.slice(start, start + 4);
        const results = await Promise.allSettled(batch.map(async (productId) => {
          const recipe = recipesByProduct.get(productId);
          const [rawItems, product] = await Promise.all([
            recipeLoader.itemsForRecipe(recipe.id),
            productsAtSale.get(productId) || service.entities.Product.get(productId).catch(() => null),
          ]);
          return { recipe, rawItems, product };
        }));
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") cards.set(batch[index], result.value);
          else console.warn("Cost snapshot skipped:", result.reason);
        }
      }
      return cards;
    })();
    const ingredientIds = new Set<string>();
    for (const { rawItems } of cardsByProduct.values()) {
      for (const row of rawItems) if (row.ingredient_id) ingredientIds.add(String(row.ingredient_id));
    }
    if (normalizedItems.some(item => item.fries_option === "with" && cardsByProduct.has(item.product_id))) {
      ingredientIds.add(FRIES_INGREDIENT_ID);
    }
    const ingredientCosts = await loadIngredientCosts(service, [...ingredientIds]);
    const baseCostByProduct = new Map<string, any>();
    for (const [productId, { recipe, rawItems, product }] of cardsByProduct) {
      const { batchCost, missing, hasAllPrices } = recipeCostFromMap(rawItems, ingredientCosts, takeaway);
      const outputUnit = String(recipe.output_unit || product?.production_unit || "piece");
      baseCostByProduct.set(productId, {
        costPerPiece: costPerPiece(batchCost, num(recipe.output_quantity), outputUnit,
          num(product?.pieces_per_sheet) || 20),
        hasPrice: hasAllPrices && rawItems.length > 0,
        missing, outputUnit,
      });
    }
    // Cached items remain RAW: ingredient deduction and costing each apply
    // their own optional-fries rule exactly once for each sale line.
    for (const item of normalizedItems) {
      const baseCost = baseCostByProduct.get(item.product_id);
      if (baseCost) unitCostByProduct.set(saleLineKey(item), costWithBurgerFries(item, baseCost, ingredientCosts));
    }
  } catch (costError) {
    console.warn("Cost snapshot skipped:", costError);
  }
  return unitCostByProduct;
}

// Table orders are server-stored before payment. The snapshot is trusted only
// after the table is authenticated, version-checked and locked below.
async function normalizeSaleItems(service: any, requestedItems: any[], shopId: string, trustedTableItems: any[] | null = null, productsAtSale: Map<string, any> | null = null) {
  const requestedLines = new Map<string, any>();
  for (const requested of requestedItems) {
    const quantity = Number(requested?.quantity);
    const productId = String(requested?.product_id || "");
    const option = validateFriesOption(requested, shopId);
    if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1000000) {
      throw httpError("Har bir mahsulotda to‘g‘ri dona soni bo‘lishi kerak.", 400);
    }
    const key = saleLineKey(requested);
    const combined = (requestedLines.get(key)?.quantity || 0) + quantity;
    if (!Number.isSafeInteger(combined) || combined > 1000000) throw httpError("Mahsulot miqdori chegaradan oshdi.", 400);
    requestedLines.set(key, { product_id: productId, quantity: combined, ...friesOptionFields({ fries_option: option }) });
  }
  const entries = [...requestedLines.values()];
  const savedItems = entries.map((row) =>
    trustedTableItems?.find((item: any) => saleLineKey(item) === saleLineKey(row)));
  const products = await Promise.all(entries.map((row, index) =>
    savedItems[index] || service.entities.Product.get(row.product_id)));

  const normalizedItems = [];
  for (const [index, row] of entries.entries()) {
    const { product_id: productId, quantity } = row;
    const savedItem = savedItems[index];
    if (trustedTableItems && !savedItem) throw httpError("Stol savati saqlangan buyurtmadan farq qiladi.", 409);
    const product = products[index];
    if (!product || (!savedItem && (product.active === false || product.archived === true))) {
      throw httpError("Tanlangan mahsulotlardan biri hozir sotuvda mavjud emas.", 409);
    }
    if (!savedItem && product.available_shop_ids?.length && !product.available_shop_ids.includes(shopId)) {
      throw httpError("Bu mahsulot ushbu do‘konda sotilmaydi.", 403);
    }
    if (!savedItem) productsAtSale?.set(productId, product);
    const unitPrice = savedItem ? savedItem.price : money(priceForShop(product, shopId)) + friesSurcharge(row);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0 || !Number.isSafeInteger(unitPrice * quantity)) {
      throw httpError("Stol buyurtmasining narxi noto‘g‘ri.", 409);
    }
    const saleUnit = product.sale_unit === "gram" ? "gram" : "piece";
    const tracked = saleUnit !== "gram" && (product.stock_tracked !== undefined ? product.stock_tracked : product.track_stock !== false);
    normalizedItems.push({
      product_id: product.id || product.product_id,
      product_name: savedItem ? savedItem.product_name : burgerOptionName(product.name, row.fries_option),
      ...friesOptionFields(savedItem || row),
      image_url: product.image_url || "",
      price: unitPrice,
      sale_unit: saleUnit,
      quantity,
      subtotal: Math.round(unitPrice * quantity / (saleUnit === "gram" ? 1000 : 1)),
      source_type: product.source_type || "central_produced",
      stock_tracked: tracked,
      stock_location_id: "",
      stock_quantity_change: tracked ? -quantity : 0,
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
  const trackedItems = items.filter((row) => row.stock_tracked);
  const stockRows = await Promise.all(trackedItems.map((item) =>
    service.entities.ProductStock.filter({
      location_id: shopId,
      product_id: item.product_id,
    })));
  for (const [index, item] of trackedItems.entries()) {
    const rows = stockRows[index];
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

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9:_-]{16,128}$/;

function tashkentBusinessDate(value: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function saleNumberFor(idempotencyKey: string, soldAt: string) {
  const day = tashkentBusinessDate(soldAt).replaceAll("-", "");
  if (!idempotencyKey) {
    return `OD-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  }
  const suffix = idempotencyKey
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toUpperCase()
    .padStart(8, "0");
  return `OD-${day}-${suffix}`;
}

function canonicalSaleRequest(body: any) {
  const quantities = new Map<string, any>();
  for (const item of Array.isArray(body?.items) ? body.items : []) {
    const productId = String(item?.product_id || "");
    const key = saleLineKey(item);
    const quantity = Math.floor(Number(item?.quantity));
    quantities.set(key, { product_id: productId,
      quantity: (quantities.get(key)?.quantity || 0) + quantity,
      ...(item?.fries_option === "with" ? { fries_option: "with" } : {}) });
  }
  const items = Array.from(quantities.values())
    .sort((left, right) => saleLineKey(left).localeCompare(saleLineKey(right)));
  const payments = (Array.isArray(body?.payments) ? body.payments : [])
    .map((payment: any) => ({
      method: String(payment?.method || ""),
      amount: money(payment?.amount),
      reference: String(payment?.reference || "").trim(),
    }))
    .sort((left: any, right: any) =>
      `${left.method}:${left.amount}:${left.reference}`
        .localeCompare(`${right.method}:${right.amount}:${right.reference}`));

  return JSON.stringify({
    shift_id: String(body?.shift_id || ""),
    ...(body?.table_number !== undefined && body?.table_number !== null
      ? { table_number: body.table_number, table_shop_id: String(body?.table_shop_id || ""),
          table_order_id: String(body?.table_order_id || ""), table_order_revision: body?.table_order_revision } : {}),
    ...(body?.takeaway_order_id ? { takeaway_order_id: String(body.takeaway_order_id),
      takeaway_order_revision: body.takeaway_order_revision } : {}),
    ...(body?.is_delivery === true ? { is_delivery: true } : {}),
    items,
    discount_code: String(body?.discount_code || "").trim().toUpperCase(),
    ...(body?.rounding_total !== undefined && body?.rounding_total !== null
      ? { rounding_total: body.rounding_total } : {}),
    ...(body?.manual_discount_amount !== undefined && body?.manual_discount_amount !== null
      ? { manual_discount_amount: body.manual_discount_amount } : {}),
    payments,
    recorded_at: String(body?.recorded_at || ""),
  });
}

async function saleRequestFingerprint(body: any) {
  const bytes = new TextEncoder().encode(canonicalSaleRequest(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

function resolveSoldAt(rawValue: unknown, shift: any, receivedAt: string) {
  if (!rawValue) return receivedAt;
  const timestamp = Date.parse(String(rawValue));
  if (!Number.isFinite(timestamp)) {
    throw httpError("Savdo vaqti noto‘g‘ri.", 400);
  }
  const receivedTimestamp = Date.parse(receivedAt);
  if (timestamp > receivedTimestamp + 5 * 60 * 1000) {
    throw httpError("Savdo vaqti kelajakda bo‘lishi mumkin emas.", 400);
  }
  const openedTimestamp = Date.parse(String(shift?.opened_at || shift?.created_date || ""));
  if (Number.isFinite(openedTimestamp) && timestamp < openedTimestamp - 60 * 1000) {
    throw httpError("Offline savdo smena ochilishidan oldin yozilgan.", 409);
  }
  return new Date(timestamp).toISOString();
}

// CAS on the Shop document serializes edits and payment claims for all tables
// in that shop. No inventory or revenue is touched while an order is occupied.
const tableOrders = (shop: any) => Array.isArray(shop?.restaurant_table_orders) ? shop.restaurant_table_orders : [];
const tableGroups = (shop: any) => Array.isArray(shop?.restaurant_table_groups) ? shop.restaurant_table_groups : [];
const tableGroupForNumber = (shop: any, number: number) =>
  tableGroups(shop).find((group: any) => Array.isArray(group?.numbers) && group.numbers.includes(number)) || null;
const tableOrderForNumber = (shop: any, number: number) => {
  const primary = tableGroupForNumber(shop, number)?.numbers?.[0] || number;
  return tableOrders(shop).find((order: any) => order.number === primary) || null;
};
const tableOrdersVersion = (shop: any) => Number.isInteger(shop?.restaurant_table_orders_version)
  && shop.restaurant_table_orders_version >= 0 ? shop.restaurant_table_orders_version : 0;
const tableVersionQuery = (version: number) => version === 0
  ? { $or: [{ restaurant_table_orders_version: 0 }, { restaurant_table_orders_version: { $exists: false } }] }
  : { restaurant_table_orders_version: version };

async function changeLockedTable(service: any, shopId: string, orderId: string, checkoutKey: string, clear: boolean) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const shop = await service.entities.Shop.get(shopId);
    const orders = tableOrders(shop);
    const current = orders.find((row: any) => row.id === orderId);
    if (!current) return true; // Already finalized, no new order can be removed by mistake.
    if (current.state !== "paying" || current.checkout_key !== checkoutKey) return false;
    const next = clear ? orders.filter((row: any) => row.id !== orderId)
      : orders.map((row: any) => row.id === orderId
        ? { ...row, state: "occupied", checkout_key: "" } : row);
    const group = tableGroups(shop).find((row: any) =>
      Array.isArray(row?.numbers) && row.numbers.includes(current.number));
    const update = await service.entities.Shop.updateMany(
      { id: shopId, ...tableVersionQuery(tableOrdersVersion(shop)) },
      { $set: {
          restaurant_table_orders: next,
          ...(clear && group
            ? { restaurant_table_groups: tableGroups(shop).filter((row: any) => row.id !== group.id) }
            : {}),
        },
        $inc: { restaurant_table_orders_version: 1 } },
    );
    if (update?.success && Number(update.updated || 0) === 1) return true;
  }
  return false;
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  let service = base44.asServiceRole;
  const readTracker = createCheckoutReadTracker(service);
  let trackedAction = "";
  let sale: any = null;
  let saleItems: any[] = [];
  let paymentRecords: any[] = [];
  let claimedDiscount: any = null;
  let discountChanged = false;
  let stockChanges: any[] = [];
  let stockMovementRecords: any[] = [];
  const ingredientChanges: any[] = [];
  const ingredientMovementRecords: any[] = [];
  let idempotencyClaimed = false;
  let idempotencyShiftId = "";
  let idempotencyKey = "";
  let tablePaymentLock: { shopId: string; orderId: string; checkoutKey: string } | null = null;

  try {
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    const body = await req.json();
    const action = String(body?.action || "complete_sale");
    if (["complete_sale", "check_stock", "open_shift", "get_current_shift", "runtime_status"].includes(action)) {
      service = readTracker.service;
      trackedAction = action;
    }
    const user = await resolveAppUser(service, authenticatedUser);
    if (user.active === false) {
      return Response.json({ error: "Xodim akkaunti faol emas." }, { status: 403 });
    }
    if (!["admin", "manager", "cashier"].includes(user.role)) {
      return Response.json({ error: "Your role cannot complete Kassa sales." }, { status: 403 });
    }

    if (user.role === "manager") await assertManagerRequestScope(service, user, body);

    if (action === "runtime_status") {
      return Response.json({ ok: true, runtime_version: COMPLETE_SALE_RUNTIME_VERSION });
    }

    if (action === "get_current_shift") {
      // Use the same stored identity as open/close, rather than a browser's
      // paginated entity list or session user ID. This action never writes.
      const shifts = await service.entities.Shift.filter(
        { user_id: user.id, status: "open" }, "-opened_at", 2,
      );
      if (shifts.length > 1) {
        return Response.json({ error: "Bir nechta ochiq smena topildi. Egasi bilan bog‘laning." }, { status: 409 });
      }
      const currentShift = shifts[0] || null;
      if (currentShift && user.role === "manager" && currentShift.shop_id !== user.shop_id) {
        return Response.json({ error: "Ochiq smena biriktirilgan ish joyiga mos emas. Egasi bilan bog‘laning." }, { status: 403 });
      }
      return Response.json({ ok: true, shift: currentShift });
    }

    if (action === "open_shift") {
      const startingCash = money(body?.starting_cash);
      if (startingCash < 0) return Response.json({ error: "Starting cash must be zero or more." }, { status: 400 });
      const existing = await service.entities.Shift.filter({ user_id: user.id, status: "open" });
      if (existing?.length) return Response.json({ error: "You already have an open shift." }, { status: 409 });
      let shopId = String(body?.shop_id || "");
      if (["cashier", "manager"].includes(user.role)) {
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
      // The shift is already durable. An unavailable history API must not
      // turn a successful opening into a second attempt to create that shift.
      let auditLogged = true;
      try {
        await service.entities.ActionHistory.create({
          user_id: user.id, user_name: user.full_name || user.email,
          action: "shift_opened", details: `${shop.name}, starting cash ${startingCash} UZS`,
        });
      } catch (error) {
        auditLogged = false;
        console.error("[Odina shift audit failed]", JSON.stringify({ shift_id: newShift.id,
          transient: isTransientCheckoutError(error) }));
      }
      return Response.json({ shift: newShift, audit_logged: auditLogged });
    }

    if (action === "get_shift_stock_report") {
      const shiftId = String(body?.shift_id || "");
      if (!shiftId) {
        return Response.json({ error: "Smena topilmadi." }, { status: 400 });
      }
      const reportShift = await service.entities.Shift.get(shiftId);
      if (!reportShift || reportShift.status !== "open") {
        return Response.json({ error: "Smena ochiq emas yoki allaqachon yopilgan." }, { status: 409 });
      }
      if (reportShift.user_id !== user.id) {
        return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
      }
      const stockReport = await buildShiftStockReport(service, reportShift, new Date().toISOString());
      return Response.json({ stock_report: stockReport });
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

      let closingShift = await service.entities.Shift.get(shiftId);
      if (!closingShift) return Response.json({ error: "Smena topilmadi." }, { status: 404 });
      if (closingShift.user_id !== user.id) {
        return Response.json({ error: "Bu smena boshqa xodimga tegishli." }, { status: 403 });
      }
      if (closingShift.status === "closed" && closingShift.budget_settled === true) {
        if (money(closingShift.actual_cash) !== actualCash
          || money(closingShift.budget_cash_submitted) !== budgetCashSubmitted
          || money(closingShift.cash_left_for_next_shift) !== cashLeftForNextShift) {
          return Response.json({ error: "Yopilgan smenaning saqlangan summalari o‘zgartirilmaydi." }, { status: 409 });
        }
        return savedShiftCloseResponse(service, closingShift, COMPLETE_SALE_RUNTIME_VERSION);
      }
      if (closingShift.status !== "open") {
        return Response.json({ error: "Smena yopilmoqda yoki topshirig‘i egasi tomonidan tekshirilishi kerak.",
          review_required: closingShift.closing_review_required === true }, { status: 409 });
      }
      const financialClosePredicate = pendingFinancialCloseGuard(closingShift);
    const closedAt = new Date().toISOString();
      const settlementReference = `SM-${closedAt.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      let claim;
      try {
        claim = await service.entities.Shift.updateMany(
          { id: closingShift.id, user_id: user.id, status: "open", expected_cash: Number(closingShift.expected_cash || 0), ...financialClosePredicate },
          { $set: { status: "closing", closing_operation_token: settlementReference,
            closing_payload_json: JSON.stringify({ actualCash, budgetCashSubmitted, cashLeftForNextShift }),
            closing_review_required: false } },
        );
      } catch (claimError) {
        const saved = await service.entities.Shift.get(closingShift.id).catch(() => null);
        if (saved?.status === "closing" && saved.closing_operation_token === settlementReference) {
          claim = { success: true, updated: 1 };
        } else {
          return reconcileShiftCloseFailure(service, closingShift.id, user.id, settlementReference, COMPLETE_SALE_RUNTIME_VERSION, claimError);
        }
      }
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ error: "Smena bir vaqtda o‘zgardi yoki allaqachon yopilmoqda." }, { status: 409 });
      }

      try {
        const claimed = await service.entities.Shift.get(closingShift.id);
        if (!claimed || claimed.status !== "closing" || claimed.user_id !== user.id
          || claimed.closing_operation_token !== settlementReference) throw httpError("Smena topshirig‘i egasi o‘zgardi.", 409);
        closingShift = claimed;
      } catch (readError) {
        return reconcileShiftCloseFailure(service, closingShift.id, user.id, settlementReference, COMPLETE_SALE_RUNTIME_VERSION, readError);
      }

      const expected = money(closingShift.expected_cash);
      const userName = user.full_name || user.email || "Noma’lum xodim";
      const deposits = [
        { account: "cash", amount: budgetCashSubmitted },
        { account: "uzcard", amount: Math.max(0, money(closingShift.uzcard_sales)) },
        { account: "humo", amount: Math.max(0, money(closingShift.humo_sales)) },
        { account: "online", amount: Math.max(0, money(closingShift.online_sales)) },
        { account: "bank", amount: Math.max(0, money(closingShift.bank_transfer_sales)) },
      ].filter((deposit) => deposit.amount > 0);
      const budgetTransactions: any[] = [];
      let stockReport: any = null;
      let stockSnapshotPayloads: any[] = [];
      let stockSnapshotSucceeded = false;
      const stockDifferenceQuantity = 0;
      const stockDifferenceProductCount = 0;

      try {
        try {
          stockReport = await buildShiftStockReport(service, closingShift, closedAt);
          stockSnapshotPayloads = stockReport.rows.map((row: any) => ({
            shift_id: closingShift.id,
            shop_id: closingShift.shop_id,
            shop_name: closingShift.shop_name,
            cashier_id: closingShift.user_id,
            cashier_name: closingShift.user_name || userName,
            product_id: row.product_id,
            product_name_snapshot: row.product_name_snapshot,
            image_url_snapshot: row.image_url_snapshot,
            unit: "piece",
            opening_quantity: row.opening_quantity,
            received_quantity: row.received_quantity,
            sold_quantity: row.sold_quantity,
            waste_quantity: row.waste_quantity,
            returned_quantity: row.returned_quantity,
            other_change_quantity: row.other_change_quantity,
            expected_quantity: row.expected_quantity,
            counted_quantity: row.expected_quantity,
            difference: 0,
            counted_by_id: "",
            counted_by_name: "",
            closed_at: closedAt,
          }));
          if (stockSnapshotPayloads.length) {
            await service.entities.ShiftProductSnapshot.bulkCreate(stockSnapshotPayloads);
          }
          stockSnapshotSucceeded = true;
        } catch (stockError) {
          console.warn("Shift stock snapshot skipped:", stockError);
          await cleanupShiftStockSnapshots(service, closingShift.id);
          stockReport = {
            shift_id: closingShift.id,
            shop_id: closingShift.shop_id,
            opened_at: closingShift.opened_at,
            generated_at: closedAt,
            rows: [],
            warning: "Mahsulot qoldig‘i tarixini avtomatik saqlab bo‘lmadi.",
          };
          stockSnapshotPayloads = [];
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: userName,
            action: "shift_stock_snapshot_skipped",
            details: `${closingShift.shop_name} · smena yopildi, mahsulot qoldig‘i tarixi saqlanmadi`,
          }).catch(() => {});
        }

        for (const deposit of deposits) {
          const balanceChange = await creditBudgetBalance(
            service,
            deposit.account,
            deposit.amount,
            user,
            closedAt,
            `${settlementReference}-${deposit.account}`,
          );
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
          }).catch(async (ledgerError: any) => {
            const saved = await service.entities.BudgetTransaction.filter({
              transaction_number: `${settlementReference}-${deposit.account.toUpperCase()}`,
              shift_id: closingShift.id,
            }, "id", 2);
            if (saved.length === 1 && saved[0].account === deposit.account
              && Number(saved[0].amount) === deposit.amount && saved[0].performed_by_id === user.id) return saved[0];
            throw ledgerError;
          });
          budgetTransactions.push(transaction);
        }

        const finalized = await service.entities.Shift.updateMany(
          { id: closingShift.id, user_id: user.id, status: "closing", closing_operation_token: settlementReference },
          { $set: {
            status: "closed",
            closed_at: closedAt,
            actual_cash: actualCash,
            difference: actualCash - expected,
            stock_count_completed: stockSnapshotSucceeded,
            stock_snapshot_count: stockSnapshotPayloads.length,
            stock_difference_quantity: stockDifferenceQuantity,
            stock_difference_product_count: stockDifferenceProductCount,
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

        const updated = {
          ...closingShift,
          status: "closed",
          closed_at: closedAt,
          actual_cash: actualCash,
          difference: actualCash - expected,
          stock_count_completed: stockSnapshotSucceeded,
          stock_snapshot_count: stockSnapshotPayloads.length,
          stock_difference_quantity: stockDifferenceQuantity,
          stock_difference_product_count: stockDifferenceProductCount,
          budget_settled: true,
          budget_settlement_reference: settlementReference,
          budget_cash_submitted: budgetCashSubmitted,
          cash_left_for_next_shift: cashLeftForNextShift,
          budget_settled_at: closedAt,
          budget_settled_by_id: user.id,
          budget_settled_by_name: userName,
        };
        // A single cashier closing is not the end of a shop-wide service
        // numbering cycle while any other shift remains open or closing.
        await finishServiceTicketCycleIfLastShift(service, closingShift.shop_id)
          .catch((error: any) => console.error("Service-ticket cycle close needs reconciliation:", error));
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userName,
          action: "shift_closed",
          details: `${closingShift.shop_name} · Budgetga ${budgetCashSubmitted} UZS naqd · qoldirildi ${cashLeftForNextShift} UZS · pul farqi ${actualCash - expected} UZS · tizim qoldig‘i ${stockSnapshotSucceeded ? `${stockSnapshotPayloads.length} tur` : "saqlanmadi"} · backend ${COMPLETE_SALE_RUNTIME_VERSION}`,
        }).catch(() => {});
        return Response.json({
          runtime_version: COMPLETE_SALE_RUNTIME_VERSION,
          shift: updated,
          stock_report: {
            ...stockReport,
            rows: stockSnapshotPayloads,
          },
          budget_transactions: budgetTransactions,
          print_report_required: true,
        });
      } catch (error) {
        return reconcileShiftCloseFailure(service, closingShift.id, user.id, settlementReference, COMPLETE_SALE_RUNTIME_VERSION, error);
      }
    }

    if (action === "validate_discount") {
      const code = String(body?.code || "").trim().toUpperCase();
      const matches = code ? await service.entities.DiscountCode.filter({ code, active: true }) : [];
      const discount = matches?.[0];
      if (!discount || (discount.single_use !== false && Number(discount.usage_count || 0) >= 1)) {
        return Response.json({ error: "Kod noto‘g‘ri, nofaol yoki avval ishlatilgan." }, { status: 404 });
      }
      if (isDiscountExpired(discount)) {
        return Response.json({ error: "Chegirma kodining muddati tugagan." }, { status: 409 });
      }
      const percentage = Number(discount.percentage);
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
        return Response.json({ error: "Chegirma foizi noto‘g‘ri." }, { status: 409 });
      }
      const requiresOwnerPin = ["cashier", "manager"].includes(user.role) && percentage === 100;
      if (requiresOwnerPin && !(await verifyOwnerPin(service, body?.owner_pin, user))) {
        return Response.json({
          error: "100% chegirma uchun OWNER PIN noto‘g‘ri yoki kiritilmagan.",
          requires_owner_pin: true,
        }, { status: 403 });
      }
      return Response.json({
        code: discount.code,
        percentage,
        requires_owner_pin: false,
      });
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

      if (!shiftId || !Number.isSafeInteger(amount) || amount <= 0 || !allowedCategories.has(expenseCategory)) {
        return Response.json({ error: "Miqdor va chiqim turi majburiy." }, { status: 400 });
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

      const requestKey = String(body?.idempotency_key || crypto.randomUUID());
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) {
        return Response.json({ error: "Pul operatsiyasi kaliti noto‘g‘ri." }, { status: 400 });
      }
      const claimKey = `cash-out:${requestKey}`;
      const shift = await service.entities.Shift.get(shiftId);
      if (!shift || shift.user_id !== user.id) return Response.json({ error: "Bu smena boshqa xodimga tegishli yoki topilmadi." }, { status: 403 });
      const priorClaim = (shift.sale_request_keys || []).includes(claimKey);
      const findMovement = async () => {
        const rows = await service.entities.CashMovement.filter({ reference_id: requestKey, reference_type: "cash_withdrawal", user_id: user.id, shift_id: shift.id }, "created_date", 2);
        if (rows.length > 1) throw httpError("Pul operatsiyasi tarixi tekshirilishi kerak. Qayta pul bermang.", 409);
        return rows[0] || null;
      };
      if (priorClaim) {
        const recorded = await findMovement();
        if (recorded) {
          if (recorded.amount !== amount || recorded.reason !== reason || recorded.expense_category !== expenseCategory
            || String(recorded.recipient_id || "") !== verifiedRecipientId || String(recorded.recipient_name_snapshot || "") !== recipientName) {
            return Response.json({ error: "Bu pul so‘rovi kaliti boshqa ma’lumotlar uchun ishlatilgan.", operation_pending: true }, { status: 409 });
          }
          return Response.json({ movement: recorded, shift, already_processed: true });
        }
        return Response.json({ error: "Pul operatsiyasi yakunlanmoqda yoki tekshiruv talab qiladi. Qayta pul bermang; shu so‘rovni qayta tekshiring.", operation_pending: true }, { status: 503 });
      }
      if (shift.status !== "open") return Response.json({ error: "Smena ochiq emas." }, { status: 409 });
      // Atomic debit + request claim: another sale or withdrawal cannot overwrite
      // this operation, and the same request cannot debit the drawer twice.
      const debited = await service.entities.Shift.updateMany(
        { id: shift.id, status: "open", user_id: user.id, expected_cash: { $gte: amount }, sale_request_keys: { $ne: claimKey } },
        { $inc: { expected_cash: -amount, cash_removed: amount }, $push: { sale_request_keys: claimKey } },
      );
      if (!debited?.success || Number(debited.updated || 0) !== 1) {
        const latest = await service.entities.Shift.get(shift.id);
        const pending = (latest?.sale_request_keys || []).includes(claimKey);
        return Response.json({ error: "Kassada pul yetarli emas yoki operatsiya boshqa oynada boshlangan. Yangilab tekshiring.", operation_pending: pending }, { status: 409 });
      }
      let movement: any;
      try {
        movement = await service.entities.CashMovement.create({
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
        reference_id: requestKey,
        reference_type: "cash_withdrawal",
        created_at: new Date().toISOString(),
        });
      } catch (recordError) {
        // A timeout can mean the ledger write succeeded but its reply was lost.
        // Re-read before deciding; never blindly reverse or debit a second time.
        let checked = false;
        try { movement = await findMovement(); checked = true; } catch { /* uncertain */ }
        if (!movement) {
          const status = Number((recordError as any)?.response?.status || (recordError as any)?.status || 0);
          if (checked && [400, 401, 403, 404, 422].includes(status)) {
            const reversed = await service.entities.Shift.updateMany(
              { id: shift.id, sale_request_keys: { $in: [claimKey] } },
              { $inc: { expected_cash: amount, cash_removed: -amount }, $pull: { sale_request_keys: claimKey } },
            );
            if (reversed?.success && Number(reversed.updated || 0) === 1) {
              return Response.json({ error: "Pul olish yozilmadi; kassa balansi qaytarildi. Qayta urinib ko‘ring." }, { status: 400 });
            }
          }
          await service.entities.ActionHistory.create({ user_id: user.id, user_name: employeeName,
            action: "cash_withdrawal_needs_review", details: `${requestKey} · ${shift.id} · ${amount} UZS · ${expenseCategory} · ${reason}. Balans band qilindi; qayta pul bermang.` }).catch(() => {});
          return Response.json({ error: "Pul operatsiyasi javobi noaniq. Qayta pul bermang; tarixni tekshiring yoki egasiga xabar bering.", operation_pending: true, reference_id: requestKey }, { status: 503 });
        }
      }
      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: user.full_name || user.email,
        action: "cash_withdrawal",
        details: `${amount} UZS. ${expenseCategory}. ${recipientName || "Qabul qiluvchi yo‘q"}. ${reason}. Xodim: ${employeeName}`,
      }).catch(() => {});
      const updatedShift = await service.entities.Shift.get(shift.id);
      return Response.json({ movement, shift: updatedShift });
    }

    if (action === "check_stock") {
      if (body?.is_delivery !== undefined && typeof body.is_delivery !== "boolean") {
        return Response.json({ error: "Dostavka belgisi noto‘g‘ri." }, { status: 400 });
      }
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
      if (["cashier", "manager"].includes(user.role) && user.shop_id !== shift.shop_id) {
        return Response.json({ error: "Kassir boshqa do‘konga biriktirilgan." }, { status: 403 });
      }
      // Stock precheck must use the same verified, frozen table order as final
      // checkout; otherwise an archived product or price change blocks payment.
      let tableItems: any[] | null = null;
      if (body?.table_number !== undefined || body?.table_order_id !== undefined || body?.takeaway_order_id) {
        const takeaway = Boolean(body?.takeaway_order_id);
        if (takeaway && (body?.table_number !== undefined || body?.table_order_id !== undefined)) {
          return Response.json({ error: "Buyurtma turi noto‘g‘ri." }, { status: 400 });
        }
        const number = body?.table_number;
        if (!takeaway && (String(body?.table_shop_id || "") !== shift.shop_id || !Number.isInteger(number))) {
          return Response.json({ error: "Stol do‘koni yoki raqami noto‘g‘ri." }, { status: 403 });
        }
        const shop = await service.entities.Shop.get(shift.shop_id).catch(() => null);
        const order = takeaway
          ? tableOrders(shop).find((row: any) => row.order_type === "takeaway" && row.id === body.takeaway_order_id)
          : tableOrderForNumber(shop, number);
        if (!shop || shop.active === false || shop.location_type !== "shop"
          || shop.allows_pos === false || (!takeaway && (number < 1 || number > shop.restaurant_table_count))
          || !order || order.id !== (takeaway ? body.takeaway_order_id : body.table_order_id)
          || order.revision !== (takeaway ? body.takeaway_order_revision : body.table_order_revision)
          || order.state !== "occupied") {
          return Response.json({ error: "Stol buyurtmasi eskirgan yoki to‘lovda. Yangilang." }, { status: 409 });
        }
        const requested = new Map<string, number>();
        for (const row of requestedItems) {
          if (!row?.product_id || !Number.isInteger(row.quantity) || row.quantity < 1
            || requested.has(saleLineKey(row))) {
            return Response.json({ error: "Stol mahsulotlarini yangilang." }, { status: 409 });
          }
          requested.set(saleLineKey(row), row.quantity);
        }
        if (requested.size !== order.items?.length
          || order.items.some((row: any) => requested.get(saleLineKey(row)) !== row.quantity)) {
          return Response.json({ error: "Saqlanmagan stol o‘zgarishlari bor. Avval saqlang." }, { status: 409 });
        }
        tableItems = order.items;
      }
      const [normalizedItems, allowNegativeStock] = await Promise.all([
        normalizeSaleItems(service, requestedItems, shift.shop_id, tableItems),
        stockPolicy(service),
      ]);
      const recipeLoader = createCheckoutRecipeLoader(service, normalizedItems.map(item => item.product_id));
      const ingredientPrep = await prepareBranchIngredients(service, shift.shop_id, normalizedItems, recipeLoader,
        body?.is_delivery === true || Boolean(body?.takeaway_order_id));
      if (ingredientPrep.shortages.length && !allowNegativeStock) {
        return Response.json({
          error: "Branch omborida tex-karta masalliqlari yetarli emas: " + ingredientPrep.shortages.map((row: any) => row.ingredient_name).join(", "),
          ingredient_shortages: ingredientPrep.shortages,
          allow_negative_stock: false,
        }, { status: 409 });
      }
      const { shortages } = await planSaleStock(service, shift.shop_id, normalizedItems);
      if (shortages.length && !allowNegativeStock) {
        return Response.json({
          error: "Omborda mahsulot yetarli emas. Qoldiqsiz sotuv bloklangan.",
          shortages,
          allow_negative_stock: false,
        }, { status: 409 });
      }
      return Response.json({ shortages, ingredient_shortages: ingredientPrep.shortages, allow_negative_stock: allowNegativeStock });
    }

    if (action === "refund_sale") {
      if (!["admin", "manager"].includes(user.role)) {
        return Response.json({ error: "Savdoni qaytarishga ruxsat yo‘q." }, { status: 403 });
      }
      if (!(await verifyOwnerPin(service, body?.owner_pin, user))) {
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
      const uzcard = byMethod("uzcard") + byMethod("bank_card");
      const humo = byMethod("humo");
      const online = byMethod("online") + byMethod("click") + byMethod("payme") + byMethod("other");
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
      const ingredientRestocks: any[] = [];
      const refundIngredientMovements: any[] = [];

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

        if (original.shop_id === BRANCH_TECH_CARD_SHOP_ID) {
          await restoreSaleIngredientsOnRefund(service, {
            shopId: original.shop_id, shopName: original.shop_name,
            saleId: original.id, saleNumber: original.sale_number || original.id,
            refundId: refund.id, userId: user.id, userName: user.full_name || user.email,
            now, restocks: ingredientRestocks, movements: refundIngredientMovements,
          });
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
        for (const movement of refundIngredientMovements) {
          try { await service.entities.StockMovement.delete(movement.id); } catch {}
        }
        for (const restock of ingredientRestocks) {
          try {
            await service.entities.IngredientStock.updateMany(
              { id: restock.stockRecord.id }, { $inc: { quantity: -restock.quantity } },
            );
          } catch {}
        }
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
    if (body?.is_delivery !== undefined && typeof body.is_delivery !== "boolean") {
      return Response.json({ error: "Dostavka belgisi noto‘g‘ri." }, { status: 400 });
    }
    const isDelivery = body?.is_delivery === true;
    const shiftId = String(body?.shift_id || "");
    const requestedItems = Array.isArray(body?.items) ? body.items : [];
    const requestedPayments = Array.isArray(body?.payments) ? body.payments : [];
    const requestedDiscountCode = String(body?.discount_code || "").trim().toUpperCase();
    const roundingRequested = body?.rounding_total !== undefined && body?.rounding_total !== null;
    const manualRequested = body?.manual_discount_amount !== undefined && body?.manual_discount_amount !== null;
    idempotencyKey = String(body?.idempotency_key || "").trim();

    if (idempotencyKey && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return Response.json({ error: "Savdo so‘rovining xavfsizlik kaliti noto‘g‘ri." }, { status: 400 });
    }

    const requestFingerprint = idempotencyKey
      ? await saleRequestFingerprint(body)
      : "";

    let requestedShiftRead: PromiseSettledResult<any> | null = null;
    if (idempotencyKey) {
      // Both reads are authoritative and independent after role/scope checks.
      // Defer a failed Shift read until its original validation position: a
      // mismatched/duplicate sale key must still win, and legacy retries still
      // tolerate an unavailable Shift instead of becoming a second checkout.
      const [saleRead, shiftRead] = await Promise.allSettled([
        service.entities.Sale.filter(
          { idempotency_key: idempotencyKey },
          "-created_date",
          2,
        ),
        shiftId ? service.entities.Shift.get(shiftId) : Promise.resolve(null),
      ]);
      requestedShiftRead = shiftRead;
      if (saleRead.status === "rejected") throw saleRead.reason;
      const existingMatches = saleRead.value;
      if ((existingMatches || []).length > 1) {
        return Response.json({
          error: "Bu savdo kaliti bo‘yicha takroriy server yozuvlari topildi. OWNER tekshirishi kerak.",
        }, { status: 409 });
      }
      const existingSale = existingMatches?.[0];
      if (existingSale) {
        if (
          existingSale.user_id !== user.id
          || existingSale.shift_id !== shiftId
          || (existingSale.is_delivery === true) !== isDelivery
          || (existingSale.request_fingerprint && existingSale.request_fingerprint !== requestFingerprint)
        ) {
          return Response.json({
            error: "Bu savdo kaliti boshqa savdo uchun ishlatilgan.",
          }, { status: 409 });
        }
        const existingShift = shiftRead.status === "fulfilled" ? shiftRead.value : null;
        // Queue retries must not discard a sale while its original request is
        // still saving. This marker is added in the EXISTING final shift write;
        // it adds no request or wait to the normal cashier checkout path.
        if (existingSale.financial_records_version >= 3
          && !(existingShift?.sale_request_keys || []).includes(`sale-completed:${idempotencyKey}`)) {
          return Response.json({ error: "Savdo yozuvlari hali yakunlanmagan. Shu kalit bilan qayta tekshiriladi." }, { status: 503 });
        }
        let tableReleased = true;
        if (existingSale.table_order_id_snapshot) {
          try {
            tableReleased = await changeLockedTable(service, existingSale.shop_id,
              existingSale.table_order_id_snapshot, idempotencyKey, true);
          } catch { tableReleased = false; }
        }
        return Response.json({
          sale: existingSale,
          shift: existingShift,
          stock_updates: [],
          table_released: tableReleased,
          already_processed: true,
        });
      }
    }

    if (!shiftId || requestedItems.length === 0) {
      return Response.json({ error: "Smena va mahsulotlar majburiy." }, { status: 400 });
    }

    if (requestedShiftRead?.status === "rejected") throw requestedShiftRead.reason;
    const shift = requestedShiftRead?.status === "fulfilled"
      ? requestedShiftRead.value : await service.entities.Shift.get(shiftId);
    if (!shift || shift.status !== "open") {
      return Response.json({ error: "The shift is not open." }, { status: 409 });
    }
    if (shift.user_id !== user.id) {
      return Response.json({ error: "This shift belongs to another user." }, { status: 403 });
    }
    if (["cashier", "manager"].includes(user.role) && !user.shop_id) {
      return Response.json({ error: "Owner must assign this cashier to a shop first." }, { status: 403 });
    }
    if (["cashier", "manager"].includes(user.role) && user.shop_id !== shift.shop_id) {
      return Response.json({ error: "This cashier is assigned to a different shop." }, { status: 403 });
    }

    // Restaurant table is optional. Never trust URL/body shop or table numbers.
    // Direct table checkout is online-only in POS; inventory remains deducted
    // solely by this completed-sale path, not when a table is selected.
    const hasTable = body?.table_number !== undefined && body?.table_number !== null;
    const hasTakeaway = Boolean(body?.takeaway_order_id);
    if (hasTable && isDelivery) {
      return Response.json({ error: "Stol buyurtmasini dostavka deb belgilab bo‘lmaydi." }, { status: 400 });
    }
    if (hasTakeaway && (hasTable || body?.table_order_id || body?.table_shop_id)) {
      return Response.json({ error: "Buyurtma turi noto‘g‘ri." }, { status: 400 });
    }
    const requestedTableNumber = body?.table_number;
    const requestedTableShopId = String(body?.table_shop_id || "");
    if ((!hasTable && requestedTableShopId)
      || (hasTable && (typeof requestedTableNumber !== "number"
        || !Number.isInteger(requestedTableNumber) || requestedTableNumber < 1
        || !requestedTableShopId || requestedTableShopId !== shift.shop_id))) {
      return Response.json({ error: "Stol yoki do‘kon tanlovi noto‘g‘ri. Stollar xaritasidan qayta tanlang." }, { status: 403 });
    }

    // Receipt contacts come only from the shop assigned to the authenticated shift.
    // Snapshot them at sale time so changing a shop's Instagram/phone/address
    // never rewrites details on an already completed sale.
    const productsAtSale = new Map<string, any>();
    const [receiptShop, ordinaryItems, allowNegativeStock, discountRead] = await Promise.all([
      (async () => {
        if (!service.entities.Shop?.get) return null;
        try { return await service.entities.Shop.get(shift.shop_id); }
        catch (error) { console.warn("Receipt shop details could not be loaded:", error); return null; }
      })(),
      // Ordinary sale prices and shop contacts are independent reads after
      // shift ownership is verified. Saved table prices wait for the shop.
      !hasTable && !hasTakeaway
        ? normalizeSaleItems(service, requestedItems, shift.shop_id, null, productsAtSale)
        : Promise.resolve(null),
      stockPolicy(service),
      // Read coupons alongside other preflight data, but surface lookup errors
      // only after the same stock/ingredient validations as before.
      requestedDiscountCode
        ? Promise.allSettled([service.entities.DiscountCode.filter({
          code: requestedDiscountCode,
          active: true,
        })]).then(([result]) => result)
        : Promise.resolve(null),
    ]);

    if (hasTable && (!receiptShop || receiptShop.active === false
      || receiptShop.location_type !== "shop" || receiptShop.allows_pos === false
      || !Number.isInteger(receiptShop.restaurant_table_count)
      || requestedTableNumber > receiptShop.restaurant_table_count)) {
      return Response.json({ error: "Bu do‘konda ko‘rsatilgan stol mavjud emas. Stollar xaritasini yangilang." }, { status: 409 });
    }

    // A paid table must match the server-stored order, not browser totals.
    const tableOrder: any = hasTakeaway
      ? tableOrders(receiptShop).find((row: any) => row.order_type === "takeaway" && row.id === body.takeaway_order_id)
      : hasTable ? tableOrderForNumber(receiptShop, requestedTableNumber) : null;
    if (hasTable || hasTakeaway) {
      const orderId = hasTakeaway ? body.takeaway_order_id : body?.table_order_id;
      const revision = hasTakeaway ? body.takeaway_order_revision : body?.table_order_revision;
      if (hasTakeaway && (!receiptShop || receiptShop.active === false
        || receiptShop.location_type !== "shop" || receiptShop.allows_pos === false)) {
        return Response.json({ error: "Buyurtma do‘koni faol emas." }, { status: 409 });
      }
      if (!tableOrder || !orderId || orderId !== tableOrder.id
        || !Number.isInteger(revision) || revision !== tableOrder.revision) {
        return Response.json({ error: "Stol buyurtmasi eski yoki saqlanmagan. Stolni yangilang va qayta tekshiring." }, { status: 409 });
      }
      if (hasTakeaway && (tableOrder.is_delivery === true) !== isDelivery) {
        return Response.json({ error: "Dostavka belgisi saqlangan buyurtmadan farq qiladi. Avval buyurtmani saqlang." }, { status: 409 });
      }
      if (tableOrder.state !== "occupied") {
        return Response.json({ error: "Bu stol bo‘yicha to‘lov allaqachon boshlangan. Savdolar tarixini tekshiring." }, { status: 409 });
      }
      const requested = new Map<string, number>();
      for (const row of requestedItems) {
        const id = saleLineKey(row);
        if (!row?.product_id || !Number.isInteger(row?.quantity) || row.quantity < 1 || requested.has(id)) {
          return Response.json({ error: "Stol mahsulotlari noto‘g‘ri. Buyurtmani yangilang." }, { status: 409 });
        }
        requested.set(id, row.quantity);
      }
      if (requested.size !== tableOrder.items?.length
        || tableOrder.items.some((item: any) => requested.get(saleLineKey(item)) !== item.quantity)) {
        return Response.json({ error: "Stol savati saqlangan buyurtmadan farq qiladi. Avval saqlang." }, { status: 409 });
      }
    }
    const normalizedItems = ordinaryItems
      || await normalizeSaleItems(service, requestedItems, shift.shop_id, tableOrder?.items || null, productsAtSale);
    const recipeLoader = createCheckoutRecipeLoader(service, normalizedItems.map(item => item.product_id));
    const ingredientPreparation = prepareBranchIngredients(service, shift.shop_id, normalizedItems, recipeLoader,
        body?.is_delivery === true || Boolean(body?.takeaway_order_id));
    const [{ plans: stockPlans, shortages: stockWarnings }, unitCostByProduct, ingredientPrep] = await Promise.all([
      // Branch recipes can turn off finished-product stock tracking. Wait for
      // that decision while independent cost snapshots read the same raw cards.
      ingredientPreparation.then(() => planSaleStock(service, shift.shop_id, normalizedItems)),
      shift.shop_id === BRANCH_TECH_CARD_SHOP_ID
        ? ingredientPreparation.then(() => loadSaleCostSnapshots(service, normalizedItems, productsAtSale, recipeLoader, isDelivery || hasTakeaway))
        : loadSaleCostSnapshots(service, normalizedItems, productsAtSale, recipeLoader, isDelivery || hasTakeaway),
      ingredientPreparation,
    ]);
    if (ingredientPrep.shortages.length && !allowNegativeStock) {
      throw httpError("Branch omborida tex-karta masalliqlari yetarli emas: "
        + ingredientPrep.shortages.map((row: any) => row.ingredient_name).join(", "), 409);
    }
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
      if (discountRead?.status === "rejected") throw discountRead.reason;
      const matches = discountRead?.status === "fulfilled" ? discountRead.value : [];
      const discount = matches?.[0];
      if (!discount) {
        return Response.json({ error: "Discount code is invalid or inactive." }, { status: 409 });
      }
      if (discount.single_use !== false && Number(discount.usage_count || 0) >= 1) {
        return Response.json({ error: "This discount code has already been used." }, { status: 409 });
      }
      if (isDiscountExpired(discount)) {
        return Response.json({ error: "Chegirma kodining muddati tugagan." }, { status: 409 });
      }
      discountPercentage = Number(discount.percentage);
      if (!Number.isFinite(discountPercentage) || discountPercentage <= 0 || discountPercentage > 100) {
        return Response.json({ error: "Discount percentage is invalid." }, { status: 409 });
      }
      discountCode = discount.code;
      claimedDiscount = discount;
      if (
        ["cashier", "manager"].includes(user.role) &&
        discountPercentage === 100 &&
        !(await verifyOwnerPin(service, body?.owner_pin, user))
      ) {
        return Response.json({
          error: "100% chegirma bilan savdoni yakunlash uchun OWNER PIN kerak.",
          requires_owner_pin: true,
        }, { status: 403 });
      }
    }

    let discountAmount = money(subtotal * discountPercentage / 100);
    if (roundingRequested || manualRequested) {
      // Recalculate against authoritative product prices; never change catalogue prices.
      // A cashier can apply exactly one capped adjustment, never stacked with a coupon.
      const step = subtotal >= 10000 ? 5000 : subtotal >= 1000 ? 1000 : 100;
      const expectedRoundedTotal = Math.floor(subtotal / step) * step;
      const manualAmount = body.manual_discount_amount;
      const target = manualRequested ? subtotal - manualAmount : body.rounding_total;
      const reduction = subtotal - target;
      if (requestedDiscountCode || (roundingRequested && manualRequested)
          || !Number.isSafeInteger(subtotal) || !Number.isSafeInteger(target) || target <= 0
          || (manualRequested && (typeof manualAmount !== "number" || !Number.isSafeInteger(manualAmount)))
          || (roundingRequested && (typeof body.rounding_total !== "number" || target !== expectedRoundedTotal))
          || reduction <= 0) {
        return Response.json({ error: "Chegirma noto‘g‘ri: kupon bilan qo‘shilmaydi; yaxlitlash faqat pastga va yakuniy summa kamida 1 so‘m bo‘lishi kerak." }, { status: 400 });
      }
      discountAmount = reduction;
      discountCode = manualRequested ? "QAYTIB_BERISH" : "YAXLITLASH";
    }
    const total = Math.max(0, subtotal - discountAmount);

    const normalizedPayments = requestedPayments.map((payment) => ({
      method: String(payment?.method || ""),
      amount: money(payment?.amount),
      reference: String(payment?.reference || "").trim(),
    }));

    if (total > 0 && normalizedPayments.length === 0) {
      return Response.json({ error: "Kamida bitta to‘lov usulini kiriting." }, { status: 400 });
    }
    if (normalizedPayments.some((payment) => !PAYMENT_METHODS.has(payment.method) || payment.amount <= 0)) {
      return Response.json({ error: "To‘lov usuli yoki summasi noto‘g‘ri." }, { status: 400 });
    }

    const paidTotal = normalizedPayments.reduce((sum, payment) => sum + payment.amount, 0);
    if (paidTotal !== total) {
      return Response.json({
        error: `To‘lovlar savdo summasiga teng bo‘lishi kerak. Kutilgan: ${total}, kiritilgan: ${paidTotal}.`,
      }, { status: 400 });
    }

    // The one-time table lock must precede any financial or stock mutations.
    if (tableOrder) {
      if (!idempotencyKey) return Response.json({ error: "Stol to‘lovi uchun takrorlanmas kalit kerak." }, { status: 400 });
      const claim = await service.entities.Shop.updateMany(
        { id: receiptShop.id, ...(hasTable ? { restaurant_table_count: receiptShop.restaurant_table_count } : {}),
          ...tableVersionQuery(tableOrdersVersion(receiptShop)) },
        { $set: { restaurant_table_orders: tableOrders(receiptShop).map((row: any) => row.id === tableOrder.id
          ? { ...row, state: "paying", checkout_key: idempotencyKey } : row) },
          $inc: { restaurant_table_orders_version: 1 } },
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ error: "Stol boshqa kassada o‘zgardi yoki to‘lov boshlangan. Xaritani yangilang." }, { status: 409 });
      }
      tablePaymentLock = { shopId: receiptShop.id, orderId: tableOrder.id, checkoutKey: idempotencyKey };
    }

    const receivedAt = new Date().toISOString();
    const soldAt = idempotencyKey
      ? resolveSoldAt(body?.recorded_at, shift, receivedAt)
      : receivedAt;
    const businessDate = tashkentBusinessDate(soldAt);
    const day = businessDate.replaceAll("-", "");
    const saleNumber = saleNumberFor(idempotencyKey, soldAt);
    const paymentSummary = normalizedPayments.length
      ? normalizedPayments.map((payment) => payment.method).join(" + ")
      : "100% chegirma";

    if (idempotencyKey) {
      const claim = await service.entities.Shift.updateMany(
        { id: shift.id, status: "open", sale_request_keys: { $ne: idempotencyKey } },
        { $push: { sale_request_keys: idempotencyKey } },
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        const completedMatches = await service.entities.Sale.filter(
          { idempotency_key: idempotencyKey },
          "-created_date",
          2,
        );
        const completedSale = completedMatches?.[0];
        if (
          completedSale
          && completedSale.user_id === user.id
          && completedSale.shift_id === shift.id
          && (!completedSale.request_fingerprint || completedSale.request_fingerprint === requestFingerprint)
        ) {
          const completedShift = await service.entities.Shift.get(shift.id).catch(() => null);
          if (completedSale.financial_records_version >= 3
            && !(completedShift?.sale_request_keys || []).includes(`sale-completed:${idempotencyKey}`)) {
            return Response.json({ error: "Savdo yozuvlari hali yakunlanmagan. Shu kalit bilan qayta tekshiriladi." }, { status: 503 });
          }
          let tableReleased = true;
          if (completedSale.table_order_id_snapshot) {
            try {
              tableReleased = await changeLockedTable(service, completedSale.shop_id,
                completedSale.table_order_id_snapshot, idempotencyKey, true);
            } catch { tableReleased = false; }
          }
          return Response.json({
            sale: completedSale,
            shift: completedShift,
            stock_updates: [],
            table_released: tableReleased,
            already_processed: true,
          });
        }
        if (tablePaymentLock) {
          await changeLockedTable(service, tablePaymentLock.shopId,
            tablePaymentLock.orderId, tablePaymentLock.checkoutKey, false).catch(() => false);
        }
        return Response.json({
          error: "Savdo serverda yakunlanmoqda. Bir ozdan so‘ng avtomatik qayta yuboriladi.",
        }, { status: 503 });
      }
      idempotencyClaimed = true;
      idempotencyShiftId = shift.id;
    }

    if (claimedDiscount && claimedDiscount.single_use !== false) {
      const discountClaim = await service.entities.DiscountCode.updateMany(
        { id: claimedDiscount.id, active: true },
        {
          $inc: { usage_count: 1 },
          $set: { active: false, used_at: soldAt },
        },
      );
      if (!discountClaim?.success || Number(discountClaim.updated || 0) !== 1) {
        throw httpError("Bu chegirma kodi boshqa kassada ishlatildi.", 409);
      }
      discountChanged = true;
    }

    // Distinct products use independent compare-and-set stock updates.
    // Settle the whole batch before rollback so late writes cannot escape it.
    for (let start = 0; start < stockPlans.length; start += 4) {
      const batch = stockPlans.slice(start, start + 4);
      await settleCheckoutWrites(batch.map((plan) => async () => {
        let stockRecord = plan.stock;
        if (stockRecord) {
          const update = await service.entities.ProductStock.updateMany(
            { id: stockRecord.id, quantity: plan.before },
            { $set: {
              quantity: plan.after,
              location_name: shift.shop_name,
              product_name: plan.item.product_name,
              unit: "piece",
              updated_at: receivedAt,
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
            updated_at: receivedAt,
            updated_by: user.id,
            updated_by_name: user.full_name || user.email,
          });
        }
        stockChanges.push({ ...plan, stockRecord });
      }));
    }
    // Keep response and movement order consistent with the original basket.
    stockChanges.sort((left, right) => stockPlans.findIndex((plan) => plan.item.product_id === left.item.product_id) - stockPlans.findIndex((plan) => plan.item.product_id === right.item.product_id));

    // A table keeps its FIRST saved service number through all edits and
    // payment. An ordinary takeout sale claims one number from the same shop
    // counter. Sale.sale_number remains the original immutable finance ID.
    const serviceTicketNumber = Number.isSafeInteger(tableOrder?.ticket_number) && tableOrder.ticket_number > 0
      ? tableOrder.ticket_number : await allocateServiceTicketNumber(service, shift.shop_id, receiptShop);
    sale = await service.entities.Sale.create({
      sale_number: saleNumber,
      service_ticket_number: serviceTicketNumber,
      is_delivery: isDelivery,
      idempotency_key: idempotencyKey || undefined,
      request_fingerprint: requestFingerprint || undefined,
      sold_at: soldAt,
      business_date: businessDate,
      financial_records_version: 3,
      sale_items_count: normalizedItems.length,
      shift_id: shift.id,
      user_id: user.id,
      user_name: user.full_name || user.email,
      shop_id: shift.shop_id,
      shop_name: shift.shop_name,
      ...(hasTable ? { table_number_snapshot: requestedTableNumber } : {}),
      ...(tableOrder ? { table_order_id_snapshot: tableOrder.id,
        table_order_revision_snapshot: tableOrder.revision } : {}),
      receipt_instagram_snapshot: String(receiptShop?.instagram || "").trim().replace(/^@/, ""),
      receipt_phone_snapshot: String(receiptShop?.phone || "").trim(),
      receipt_address_snapshot: String(receiptShop?.address || "").trim(),
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
      const costInfo = unitCostByProduct.get(saleLineKey(item)) || { costPerPiece: 0, hasPrice: false };
      const snapUnitCost = item.sale_unit !== "gram" && costInfo.hasPrice ? money(costInfo.costPerPiece) : 0;
      const snapTotalCost = snapUnitCost * item.quantity;
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
        ...friesOptionFields(item),
        image_url_snapshot: item.image_url,
        quantity: item.quantity,
        unit_price: item.price,
        sale_unit: item.sale_unit,
        discount_amount: itemDiscount,
        line_total: item.subtotal - itemDiscount,
        unit_cost_at_sale: snapUnitCost,
        total_cost_at_sale: snapTotalCost,
        cost_is_estimate: item.sale_unit === "gram" || !costInfo.hasPrice,
        created_at: soldAt,
      };
    });

    // All rows refer to the already-created sale. Ingredient CAS writes touch
    // different stock records and keep caller-owned partial-write journals, so
    // they can overlap the financial rows. Settle ALL tasks before compensation
    // or the final shift confirmation; never detach a required ledger write.
    await settleCheckoutWrites([
      async () => { saleItems = await service.entities.SaleItem.bulkCreate(itemPayloads); },
      async () => {
        paymentRecords = normalizedPayments.length
          ? await service.entities.Payment.bulkCreate(
            normalizedPayments.map((payment) => ({
              sale_id: sale.id,
              sale_number: saleNumber,
              shop_id: shift.shop_id,
              shift_id: shift.id,
              cashier_id: user.id,
              method: payment.method,
              amount: payment.amount,
              reference: payment.reference || undefined,
              created_at: soldAt,
            })),
          )
          : [];
      },
      async () => {
        for (let start = 0; start < stockChanges.length; start += 4) {
          const batch = stockChanges.slice(start, start + 4);
          await settleCheckoutWrites(batch.map((change) => async () => {
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
              created_at: soldAt,
            });
            stockMovementRecords.push(movement);
          }));
        }
      },
      async () => {
        await applySaleIngredientDeduction(service, {
          shopId: shift.shop_id, shopName: shift.shop_name,
          saleId: sale.id, saleNumber, userId: user.id, userName: user.full_name || user.email,
          now: soldAt, plans: ingredientPrep.plans, lines: ingredientPrep.lines,
          applied: ingredientChanges, movements: ingredientMovementRecords,
        });
      },
    ]);

    if (claimedDiscount) {
      if (claimedDiscount.single_use !== false) {
        await service.entities.DiscountCode.update(claimedDiscount.id, {
          used_by_sale_id: sale.id,
        });
      } else {
        const discountUpdate = await service.entities.DiscountCode.updateMany(
          { id: claimedDiscount.id, active: true },
          {
            $inc: { usage_count: 1 },
            $set: { used_at: soldAt, used_by_sale_id: sale.id },
          },
        );
        if (!discountUpdate?.success || Number(discountUpdate.updated || 0) !== 1) {
          throw httpError("Chegirma kodini ishlatilgan deb belgilab bo‘lmadi.", 409);
        }
        discountChanged = true;
      }
    }

    const cashIncrement = normalizedPayments
      .filter((payment) => payment.method === "cash")
      .reduce((sum, payment) => sum + payment.amount, 0);
    const uzcardIncrement = normalizedPayments
      .filter((payment) => ["bank_card", "uzcard"].includes(payment.method))
      .reduce((sum, payment) => sum + payment.amount, 0);
    const humoIncrement = normalizedPayments
      .filter((payment) => payment.method === "humo")
      .reduce((sum, payment) => sum + payment.amount, 0);
    const onlineIncrement = normalizedPayments
      .filter((payment) => ["online", "click", "payme", "other"].includes(payment.method))
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
        ...(idempotencyKey ? { $push: { sale_request_keys: `sale-completed:${idempotencyKey}` } } : {}),
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

    // A failure to update the floor plan must not roll back already committed
    // money. Keep the table locked and reconcile via the same sale request key.
    let tableReleased = true;
    // These post-commit records are independent. Await both before replying,
    // retaining their existing fail-closed table and best-effort audit behavior.
    await Promise.all([
      (async () => {
        if (tablePaymentLock) {
          try {
            tableReleased = await changeLockedTable(service, tablePaymentLock.shopId,
              tablePaymentLock.orderId, tablePaymentLock.checkoutKey, true);
          } catch { tableReleased = false; }
          if (!tableReleased) console.error("Paid table still locked; retry the SAME sale key to reconcile.");
        }
      })(),
      (async () => {
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
      })(),
    ]);

    return Response.json({
      sale,
      sale_items: saleItems,
      payments: paymentRecords,
      table_released: tableReleased,
      shift: updatedShift,
      stock_warnings: stockWarnings,
      ingredient_warnings: ingredientPrep.shortages,
      allow_negative_stock: allowNegativeStock,
      backend_timing: readTracker.snapshot(),
      stock_updates: stockChanges.map((change) => ({
        product_id: change.item.product_id,
        quantity: change.after,
      })),
    });
  } catch (error) {
    let rollbackSafe = true;
    for (const movement of ingredientMovementRecords) {
      try { await service.entities.StockMovement.delete(movement.id); } catch { rollbackSafe = false; }
    }
    for (const change of ingredientChanges) {
      try {
        const restored = await service.entities.IngredientStock.updateMany(
          { id: change.stockId }, { $inc: { quantity: change.quantity } },
        );
        if (!restored?.success || Number(restored.updated || 0) !== 1) rollbackSafe = false;
      } catch { rollbackSafe = false; }
    }
    for (const movement of stockMovementRecords) {
      try { await base44.asServiceRole.entities.StockMovement.delete(movement.id); } catch { rollbackSafe = false; }
    }
    for (const change of stockChanges) {
      try {
        await base44.asServiceRole.entities.ProductStock.updateMany(
          { id: change.stockRecord.id },
          { $inc: { quantity: change.item.quantity } },
        );
      } catch { rollbackSafe = false; }
    }
    if (claimedDiscount && discountChanged) {
      try {
        await base44.asServiceRole.entities.DiscountCode.update(claimedDiscount.id, {
          usage_count: Number(claimedDiscount.usage_count || 0),
          used_at: claimedDiscount.used_at,
          used_by_sale_id: claimedDiscount.used_by_sale_id,
          active: claimedDiscount.active,
        });
      } catch {
        rollbackSafe = false;
        // Preserve the original failure.
      }
    }
    for (const record of paymentRecords) {
      try { await base44.asServiceRole.entities.Payment.delete(record.id); } catch { rollbackSafe = false; }
    }
    for (const record of saleItems) {
      try { await base44.asServiceRole.entities.SaleItem.delete(record.id); } catch { rollbackSafe = false; }
    }
    if (sale) {
      try { await base44.asServiceRole.entities.Sale.delete(sale.id); } catch { rollbackSafe = false; }
    }

    if (rollbackSafe && idempotencyClaimed && idempotencyShiftId && idempotencyKey) {
      try {
        await base44.asServiceRole.entities.Shift.updateMany(
          { id: idempotencyShiftId },
          { $pull: { sale_request_keys: idempotencyKey } },
        );
      } catch {
        rollbackSafe = false;
        // Preserve the original failure. A retry can be reviewed if the claim remains.
      }
    }

    // An uncertain payment must never reopen the table for a second charge.
    if (tablePaymentLock && rollbackSafe) {
      try {
        const matches = await service.entities.Sale.filter({ idempotency_key: tablePaymentLock.checkoutKey }, '-created_date', 2);
        if (!(matches || []).length) {
          await changeLockedTable(service, tablePaymentLock.shopId,
            tablePaymentLock.orderId, tablePaymentLock.checkoutKey, false);
        }
      } catch { /* Fail closed for owner reconciliation. */ }
    }
    const transient = Boolean(trackedAction) && isTransientCheckoutError(error);
    return Response.json({
      error: transient
        ? "Server ma’lumotlar bazasiga vaqtincha ulanib bo‘lmadi. Savdo holatini tekshiring va shu so‘rov bilan qayta urinib ko‘ring."
        : error instanceof Error ? error.message : "Savdoni yakunlab bo‘lmadi.",
      ...(transient ? { server_recovery_attempted: readTracker.snapshot().read_retries > 0 } : {}),
    }, { status: transient ? 503 : Number((error as any)?.status || 500) });
  } finally {
    if (trackedAction) console.info("[Odina backend timing]", JSON.stringify({
      action: trackedAction, ...readTracker.snapshot(),
    }));
  }
}
