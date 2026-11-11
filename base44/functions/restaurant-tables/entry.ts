// base44/functions/restaurant-tables/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk";

// base44/shared/user-helpers.ts
var APP_ROLES = /* @__PURE__ */ new Set(["admin", "manager", "cashier", "accountant", "production", "warehouse"]);
var userLabel = (user) => user?.display_name || user?.data?.display_name || user?.full_name || user?.email || "Noma\u2019lum xodim";
var userRole = (user) => {
  const rootRole = String(user?.role || "");
  const nestedRole = String(user?.data?.role || "");
  if (APP_ROLES.has(rootRole)) return rootRole;
  if (APP_ROLES.has(nestedRole)) return nestedRole;
  return rootRole || nestedRole;
};
var userShopId = (user) => String(user?.shop_id || user?.data?.shop_id || "");
var resolveStoredAppUser = async (service, authenticatedUser) => {
  let storedUser = null;
  const authenticatedId = String(authenticatedUser?.id || "");
  const email = String(authenticatedUser?.email || "").trim().toLowerCase();
  if (authenticatedId) {
    storedUser = await service.entities.User.get(authenticatedId).catch(() => null);
  }
  if (!storedUser && email) {
    const matches = await service.entities.User.filter({ email }, "-updated_date", 5);
    storedUser = (matches || []).find(
      (candidate) => String(candidate?.email || "").trim().toLowerCase() === email
    ) || null;
  }
  return storedUser;
};

// base44/shared/service-ticket-cycle.ts
var serviceTicketVersion = (shop) => Number.isSafeInteger(shop?.service_ticket_version) && shop.service_ticket_version >= 0 ? shop.service_ticket_version : 0;
var serviceTicketVersionQuery = (version) => version === 0 ? { $or: [{ service_ticket_version: 0 }, { service_ticket_version: { $exists: false } }] } : { service_ticket_version: version };

// base44/shared/shift-close-helpers.ts
async function allocateServiceTicketNumber(service, shopId, initialShop = null) {
  if (!shopId || !service?.entities?.Shop?.get || !service?.entities?.Shop?.updateMany) {
    throw httpError("Xizmat cheki uchun do\u2018kon aniqlanmadi.", 409);
  }
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const shop = attempt === 0 && initialShop?.id === shopId ? initialShop : await service.entities.Shop.get(shopId);
    if (!shop || shop.active === false || shop.allows_pos === false || shop.location_type === "production") {
      throw httpError("Xizmat cheki do\u2018koni faol emas.", 409);
    }
    const version = serviceTicketVersion(shop);
    const counter = Number.isSafeInteger(shop.service_ticket_counter) && shop.service_ticket_counter >= 0 ? shop.service_ticket_counter : 0;
    if (shop.service_ticket_cycle_active !== true) {
      const opened = await service.entities.Shift.filter({ shop_id: shopId, status: "open" }, "-opened_at", 1e3);
      if (!opened?.length) throw httpError("Xizmat cheki uchun do\u2018konda ochiq smena kerak.", 409);
      const legacyBaseline = counter === 0 ? (opened || []).reduce((sum, shift) => sum + Math.max(0, Number(shift.order_count) || 0), 0) + (Array.isArray(shop.restaurant_table_orders) ? shop.restaurant_table_orders.filter((order) => !Number.isSafeInteger(order?.ticket_number)).length : 0) : 0;
      if (!Number.isSafeInteger(legacyBaseline) || legacyBaseline >= 1e9) {
        throw httpError("Buyurtma raqamlashini tekshirish kerak. Egaga xabar bering.", 409);
      }
      const activated = await service.entities.Shop.updateMany(
        { id: shopId, ...serviceTicketVersionQuery(version) },
        {
          $set: { service_ticket_cycle_active: true, service_ticket_counter: legacyBaseline + 1 },
          $inc: { service_ticket_version: 1 }
        }
      );
      if (activated?.success && Number(activated.updated || 0) === 1) return legacyBaseline + 1;
      continue;
    }
    if (counter >= 1e9) throw httpError("Xizmat cheki raqamlash chegarasiga yetdi.", 409);
    const claimed = await service.entities.Shop.updateMany(
      { id: shopId, service_ticket_cycle_active: true, ...serviceTicketVersionQuery(version) },
      { $inc: { service_ticket_counter: 1, service_ticket_version: 1 } }
    );
    if (claimed?.success && Number(claimed.updated || 0) === 1) return counter + 1;
  }
  throw httpError("Buyurtma raqami boshqa kassada o\u2018zgardi. Qayta urinib ko\u2018ring.", 409);
}
var httpError = (message, status) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// base44/shared/sale-options.js
var CAKE_EXTRA_AMOUNT = 5e3;
var CAKE_CATEGORY_ID = "6ab57e00ab3a0a5019ea99db";
var canChooseCakeExtra = (product, shopId) => product?.sale_unit !== "gram" && (product?.shop_category_ids?.[shopId] || product?.category_id) === CAKE_CATEGORY_ID;
function validateCakeExtra(row) {
  if (row?.cake_extra == null || row.cake_extra === false) return false;
  if (row.cake_extra !== true || row.fries_option || row.tea_option) {
    throw Object.assign(new Error("Tort qo\u2018shimchasi tanlovi noto\u2018g\u2018ri."), { status: 400 });
  }
  return true;
}
var cakeExtraSurcharge = (row) => row?.cake_extra === true ? CAKE_EXTRA_AMOUNT : 0;
var saleLineKey = (row) => String(row?.product_id || "") + (row?.fries_option === "with" ? "::fries" : "") + (row?.tea_option === "cup" ? "::tea-cup" : "") + (row?.cake_extra === true ? "::cake-extra" : "");
var saleOptionFields = (row) => ({
  ...["with", "without"].includes(row?.fries_option) ? { fries_option: row.fries_option } : {},
  ...["cup", "pot"].includes(row?.tea_option) ? { tea_option: row.tea_option } : {},
  ...row?.cake_extra === true ? { cake_extra: true } : {}
});

// base44/shared/burger-fries.js
var BURGER_FRIES_SHOP_ID = "6a96f0a4ecc85c2fc57f3174";
var BURGER_PRODUCT_IDS = ["6ab747c5c1c33517e6eea448", "6ab747c5c1c33517e6eea449"];
var FRIES_SURCHARGE = 5e3;
var canChooseBurgerFries = (productId, shopId) => shopId === BURGER_FRIES_SHOP_ID && BURGER_PRODUCT_IDS.includes(String(productId));
function validateFriesOption(row, shopId) {
  const option = row?.fries_option;
  if (option === void 0 || option === null || option === "") return "";
  if (!["with", "without"].includes(option) || !canChooseBurgerFries(row?.product_id, shopId)) {
    const error = new Error("Fri tanlovi ushbu mahsulot yoki do\u2018kon uchun noto\u2018g\u2018ri.");
    error.status = 400;
    throw error;
  }
  return option;
}
var friesSurcharge = (row) => row?.fries_option === "with" ? FRIES_SURCHARGE : 0;
var burgerOptionName = (name, option) => option === "with" ? name + " \u2014 Fri bilan" : option === "without" ? name + " \u2014 Frisiz" : name;

// base44/shared/tea-options.js
var TEA_PRODUCT_IDS = [
  "6ab66ca8ae6223ce0f93e60c",
  // Legacy combined green / black tea
  "6ace05d7ea4cdff9020d4a8d",
  // Ko‘k choy
  "6ace05d7ea4cdff9020d4a8c",
  // Qora choy
  "6ab6b03dfa815d9efa74363e",
  // Limon choy
  "6ab66ca8ae6223ce0f93e611",
  // Marokash
  "6ab66ca8ae6223ce0f93e610",
  // Oblepixa
  "6ab66ca8ae6223ce0f93e60f",
  // Imbir
  "6ab66ca8ae6223ce0f93e60e",
  // Mango marakuya
  "6ab66ca8ae6223ce0f93e60d"
  // Yagodniy
];
var canChooseTeaServing = (productId) => TEA_PRODUCT_IDS.includes(String(productId));
function validateTeaOption(row) {
  const option = row?.tea_option;
  if (option === void 0 || option === null || option === "") return "";
  if (!["cup", "pot"].includes(option) || !canChooseTeaServing(row?.product_id)) {
    const error = new Error("Choy tanlovi ushbu mahsulot uchun noto\u2018g\u2018ri.");
    error.status = 400;
    throw error;
  }
  return option;
}
var teaServingPrice = (basePrice, option) => Number(basePrice) / (option === "cup" ? 2 : 1);
var teaOptionName = (name, option) => option === "cup" ? name + " \u2014 Stakan" : option === "pot" ? name + " \u2014 Choynik" : name;

// base44/functions/restaurant-tables/entry.ts
var ALLOWED_ROLES = /* @__PURE__ */ new Set(["admin", "cashier", "manager"]);
var MAX_TABLES = 30;
var MAX_ORDER_ITEMS = 100;
var ordersOf = (shop) => Array.isArray(shop?.restaurant_table_orders) ? shop.restaurant_table_orders : [];
var groupsOf = (shop) => Array.isArray(shop?.restaurant_table_groups) ? shop.restaurant_table_groups : [];
var groupForNumber = (shop, number) => groupsOf(shop).find((group) => Array.isArray(group?.numbers) && group.numbers.includes(number)) || null;
var canonicalNumber = (shop, number) => groupForNumber(shop, number)?.numbers?.[0] || number;
var orderForNumber = (shop, number) => {
  const primary = canonicalNumber(shop, number);
  return ordersOf(shop).find((order) => order.number === primary) || null;
};
var cleanGroups = (shop, count) => {
  const used = /* @__PURE__ */ new Set();
  return groupsOf(shop).filter((group) => {
    if (!group?.id || !Array.isArray(group.numbers) || group.numbers.length < 2 || group.numbers.length > 8) return false;
    const numbers = group.numbers;
    if (new Set(numbers).size !== numbers.length || numbers.some((number) => !Number.isInteger(number) || number < 1 || number > count || used.has(number))) return false;
    numbers.forEach((number) => used.add(number));
    return true;
  }).map((group) => ({ ...group, numbers: [...group.numbers] }));
};
var ordersVersion = (shop) => Number.isInteger(shop?.restaurant_table_orders_version) && shop.restaurant_table_orders_version >= 0 ? shop.restaurant_table_orders_version : 0;
var ordersVersionCondition = (version) => version === 0 ? { $or: [{ restaurant_table_orders_version: 0 }, { restaurant_table_orders_version: { $exists: false } }] } : { restaurant_table_orders_version: version };
var orderSummary = (order) => ({
  number: order.number,
  ticket_number: order.ticket_number,
  state: order.state,
  revision: order.revision,
  total: order.total,
  item_count: (order.items || []).reduce((sum, item) => sum + (item.sale_unit === "gram" ? 1 : item.quantity), 0),
  started_at: order.started_at,
  updated_at: order.updated_at
});
var DEFAULT_ENTRANCE = { side: "top", offset: 500 };
var validEntrance = (entry) => entry && ["top", "right", "bottom", "left"].includes(entry.side) && Number.isInteger(entry.offset) && entry.offset >= 150 && entry.offset <= 850;
var cleanEntrance = (entry) => validEntrance(entry) ? { side: entry.side, offset: entry.offset } : { ...DEFAULT_ENTRANCE };
var sizeOf = (entry) => entry?.size === void 0 ? 100 : entry?.size;
var validSize = (size) => Number.isInteger(size) && size >= 80 && size <= 140 && size % 10 === 0;
var hasValidPosition = (entry, count) => {
  const size = sizeOf(entry);
  return entry && Number.isInteger(entry.number) && entry.number >= 1 && entry.number <= count && validSize(size) && Number.isInteger(entry.x) && entry.x >= Math.max(60, 60 * size / 100) && entry.x <= Math.min(940, 1e3 - 60 * size / 100) && Number.isInteger(entry.y) && entry.y >= Math.max(70, (size > 100 ? 90 : 70) * size / 100) && entry.y <= Math.min(930, 1e3 - (size > 100 ? 90 : 70) * size / 100);
};
var overlaps = (a, b) => {
  const factor = (sizeOf(a) + sizeOf(b)) / 200;
  const verticalSpacing = sizeOf(a) === 100 && sizeOf(b) === 100 ? 125 : 175 * factor;
  return Math.abs(a.x - b.x) < 115 * factor && Math.abs(a.y - b.y) < verticalSpacing;
};
var validateLayout = (layout, count) => {
  if (!Array.isArray(layout) || layout.length !== count || count <= 0 || count > MAX_TABLES) return false;
  const numbers = /* @__PURE__ */ new Set();
  for (const point of layout) {
    if (!hasValidPosition(point, count) || numbers.has(point.number)) return false;
    numbers.add(point.number);
  }
  return !layout.some((point, i) => layout.some((other, j) => i < j && overlaps(point, other)));
};
var cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
var onSegment = (a, b, p) => cross(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
var segmentsCross = (a, b, c, d) => {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC === 0 && onSegment(a, b, c) || abD === 0 && onSegment(a, b, d) || cdA === 0 && onSegment(c, d, a) || cdB === 0 && onSegment(c, d, b) || abC > 0 !== abD > 0 && cdA > 0 !== cdB > 0;
};
var validOutdoorPolygon = (polygon) => {
  if (!Array.isArray(polygon)) return false;
  if (polygon.length === 0) return true;
  if (polygon.length < 3 || polygon.length > 12) return false;
  const seen = /* @__PURE__ */ new Set();
  for (const point of polygon) {
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.x > 1e3 || point.y < 0 || point.y > 1e3) return false;
    const key = `${point.x}:${point.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const doubleArea = Math.abs(polygon.reduce((sum, p, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0));
  if (doubleArea < 2e4) return false;
  for (let i = 0; i < polygon.length; i += 1) {
    const previous = polygon[(i + polygon.length - 1) % polygon.length];
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const incomingX = current.x - previous.x;
    const incomingY = current.y - previous.y;
    const outgoingX = next.x - current.x;
    const outgoingY = next.y - current.y;
    if (cross(previous, current, next) === 0 && incomingX * outgoingX + incomingY * outgoingY < 0) return false;
  }
  for (let i = 0; i < polygon.length; i += 1) {
    for (let j = i + 1; j < polygon.length; j += 1) {
      if (j === i + 1 || i === 0 && j === polygon.length - 1) continue;
      if (segmentsCross(
        polygon[i],
        polygon[(i + 1) % polygon.length],
        polygon[j],
        polygon[(j + 1) % polygon.length]
      )) return false;
    }
  }
  return true;
};
var cleanOutdoorPolygon = (polygon) => validOutdoorPolygon(polygon) ? polygon.map(({ x, y }) => ({ x, y })) : [];
var isShop = (shop) => Boolean(shop && shop.active !== false && shop.location_type === "shop" && shop.allows_pos !== false);
var safeShop = (shop) => {
  const tableCount = Number.isInteger(shop.restaurant_table_count) && shop.restaurant_table_count >= 0 && shop.restaurant_table_count <= MAX_TABLES ? shop.restaurant_table_count : 0;
  const groups = cleanGroups(shop, tableCount);
  const orders = ordersOf(shop).filter((order) => Number.isInteger(order.number));
  const expandedOrders = orders.flatMap((order) => {
    const group = groups.find((row) => row.numbers.includes(order.number));
    const numbers = group?.numbers || [order.number];
    return numbers.map((number) => ({
      ...orderSummary(order),
      number,
      primary_number: order.number,
      group_id: group?.id || "",
      group_numbers: numbers
    }));
  }).sort((a, b) => a.number - b.number);
  return {
    id: String(shop.id),
    name: String(shop.name || "Do\u2018kon"),
    is_main: Boolean(shop.is_main),
    table_count: tableCount,
    entrance: cleanEntrance(shop.restaurant_entrance),
    outdoor_polygon: cleanOutdoorPolygon(shop.restaurant_outdoor_polygon),
    groups,
    orders: expandedOrders,
    layout_version: Number.isInteger(shop.restaurant_table_layout_version) && shop.restaurant_table_layout_version >= 0 ? shop.restaurant_table_layout_version : 0,
    layout: (Array.isArray(shop.restaurant_table_layout) ? shop.restaurant_table_layout : []).filter((row) => hasValidPosition(row, tableCount)).map((row) => ({ number: row.number, x: row.x, y: row.y, size: sizeOf(row) }))
  };
};
Deno.serve(async (req) => {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth?.id) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const service = client.asServiceRole;
    const actor = await resolveStoredAppUser(service, auth);
    const role = userRole(actor);
    if (!actor || actor.active === false || actor.data?.active === false || !ALLOWED_ROLES.has(role)) {
      return Response.json({ error: "Stollar bo\u2018limiga kirishga ruxsat yo\u2018q." }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "status");
    if (action === "status") {
      if (role === "cashier" || role !== "admin") {
        const assignedId = userShopId(actor);
        if (!assignedId) return Response.json({ error: "Kassirga do\u2018kon biriktirilmagan." }, { status: 403 });
        const assignedShop = await service.entities.Shop.get(assignedId).catch(() => null);
        if (!isShop(assignedShop)) {
          return Response.json({ error: "Biriktirilgan do\u2018kon faol emas yoki topilmadi." }, { status: 403 });
        }
        return Response.json({ can_manage: role === "manager", shops: [safeShop(assignedShop)], invalid_records: [] });
      }
      const allShops = await service.entities.Shop.list("name", 100);
      const activeShops = (allShops || []).filter(isShop);
      const invalidRecords = (allShops || []).filter((s) => !s?.id || typeof s.id !== "string" || !s.id.trim()).map((s) => ({
        issue: "missing_shop_id",
        name: s?.name || "Nomsiz do\u2018kon",
        table_count: s?.restaurant_table_count || 0
      }));
      const requestedShopId = String(body?.shop_id || "").trim();
      if (requestedShopId) {
        const targetShop = activeShops.find((s) => s.id === requestedShopId);
        if (!targetShop) {
          return Response.json({ error: "So\u2018ralgan do\u2018kon topilmadi yoki faol emas." }, { status: 404 });
        }
        return Response.json({
          can_manage: true,
          shops: [safeShop(targetShop)],
          available_shops: activeShops.map((s) => ({
            id: String(s.id),
            name: String(s.name || "Do\u2018kon"),
            is_main: Boolean(s.is_main),
            table_count: Number(s.restaurant_table_count || 0)
          })),
          invalid_records: invalidRecords
        });
      }
      return Response.json({
        can_manage: true,
        shops: activeShops.map(safeShop),
        available_shops: activeShops.map((s) => ({
          id: String(s.id),
          name: String(s.name || "Do\u2018kon"),
          is_main: Boolean(s.is_main),
          table_count: Number(s.restaurant_table_count || 0)
        })),
        invalid_records: invalidRecords
      });
    }
    const shopId = String(body?.shop_id || "");
    if (action === "group_tables" || action === "ungroup_tables") {
      const shop2 = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
      if (!isShop(shop2)) return Response.json({ error: "Faol do\u2018kon topilmadi." }, { status: 404 });
      if (role !== "admin" && userShopId(actor) !== shop2.id) {
        return Response.json({ error: "Boshqa do\u2018kon stollariga ruxsat yo\u2018q." }, { status: 403 });
      }
      const count2 = safeShop(shop2).table_count;
      const primaryNumber = body?.primary_table_number;
      if (!Number.isInteger(primaryNumber) || primaryNumber < 1 || primaryNumber > count2) {
        return Response.json({ error: "Asosiy stol topilmadi." }, { status: 400 });
      }
      const groups = cleanGroups(shop2, count2);
      const stored = ordersOf(shop2);
      const version = ordersVersion(shop2);
      if (action === "ungroup_tables") {
        const group2 = groups.find((row) => row.numbers.includes(primaryNumber));
        if (!group2) return Response.json({ ok: true, unchanged: true, shop: safeShop(shop2) });
        if (stored.some((order) => group2.numbers.includes(order.number))) {
          return Response.json({ error: "Buyurtmasi ochiq birlashtirilgan stollar hisob yopilganda avtomatik ajraladi." }, { status: 409 });
        }
        const updated3 = await service.entities.Shop.updateMany(
          { id: shop2.id, ...ordersVersionCondition(version) },
          {
            $set: { restaurant_table_groups: groups.filter((row) => row.id !== group2.id) },
            $inc: { restaurant_table_orders_version: 1 }
          }
        );
        if (!updated3?.success || Number(updated3.updated || 0) !== 1) {
          return Response.json({ error: "Stollar boshqa qurilmada o\u2018zgardi. Yangilang." }, { status: 409 });
        }
        const saved2 = await service.entities.Shop.get(shop2.id);
        await service.entities.ActionHistory.create({
          user_id: actor.id,
          user_name: userLabel(actor),
          action: "restaurant_tables_ungrouped",
          details: `${shop2.name} \xB7 ${group2.numbers.join(" + ")}-stollar ajratildi`
        }).catch(() => {
        });
        return Response.json({ ok: true, shop: safeShop(saved2) });
      }
      const secondaryNumber = body?.secondary_table_number;
      if (!Number.isInteger(secondaryNumber) || secondaryNumber < 1 || secondaryNumber > count2 || secondaryNumber === primaryNumber) {
        return Response.json({ error: "Qo\u2018shiladigan stol noto\u2018g\u2018ri." }, { status: 400 });
      }
      const primaryGroup = groups.find((row) => row.numbers.includes(primaryNumber)) || null;
      const secondaryGroup = groups.find((row) => row.numbers.includes(secondaryNumber)) || null;
      if (secondaryGroup && secondaryGroup.id !== primaryGroup?.id) {
        return Response.json({ error: "Tanlangan stol boshqa guruhga ulangan." }, { status: 409 });
      }
      const numbers = primaryGroup ? [...primaryGroup.numbers] : [primaryNumber];
      if (numbers.includes(secondaryNumber)) {
        return Response.json({ ok: true, unchanged: true, group: primaryGroup, shop: safeShop(shop2) });
      }
      if (numbers.length >= 8) {
        return Response.json({ error: "Bitta guruhga ko\u2018pi bilan 8 ta stol ulanadi." }, { status: 400 });
      }
      numbers.push(secondaryNumber);
      const relatedOrders = stored.filter((order) => numbers.includes(order.number));
      if (relatedOrders.length > 1) {
        return Response.json({ error: "Ikkala stolda ham buyurtma bor. Birlashtirishdan oldin bittasining hisobini yakunlang." }, { status: 409 });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const group = primaryGroup ? { ...primaryGroup, numbers } : {
        id: crypto.randomUUID(),
        numbers,
        created_at: now,
        created_by: actor.id,
        created_by_name: userLabel(actor)
      };
      const canonical = numbers[0];
      const nextOrders = relatedOrders.length === 1 && relatedOrders[0].number !== canonical ? stored.map((order) => order.id === relatedOrders[0].id ? {
        ...order,
        number: canonical,
        revision: Number(order.revision || 0) + 1,
        updated_by: actor.id,
        updated_at: now
      } : order) : stored;
      const nextGroups = primaryGroup ? groups.map((row) => row.id === primaryGroup.id ? group : row) : [...groups, group];
      const updated2 = await service.entities.Shop.updateMany(
        { id: shop2.id, ...ordersVersionCondition(version) },
        {
          $set: { restaurant_table_groups: nextGroups, restaurant_table_orders: nextOrders },
          $inc: { restaurant_table_orders_version: 1 }
        }
      );
      if (!updated2?.success || Number(updated2.updated || 0) !== 1) {
        return Response.json({ error: "Stollar boshqa qurilmada o\u2018zgardi. Yangilang." }, { status: 409 });
      }
      const saved = await service.entities.Shop.get(shop2.id);
      await service.entities.ActionHistory.create({
        user_id: actor.id,
        user_name: userLabel(actor),
        action: "restaurant_tables_grouped",
        details: `${shop2.name} \xB7 ${numbers.join(" + ")}-stollar birlashtirildi`
      }).catch(() => {
      });
      return Response.json({ ok: true, group, shop: safeShop(saved) });
    }
    if ([
      "get_table_order",
      "save_table_order",
      "reconcile_table_payment",
      "cancel_table_order",
      "list_takeaway_orders",
      "get_takeaway_order",
      "save_takeaway_order",
      "reconcile_takeaway_payment",
      "cancel_takeaway_order"
    ].includes(action)) {
      const takeaway = action.includes("takeaway");
      const shop2 = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
      if (!isShop(shop2)) return Response.json({ error: "Faol do\u2018kon topilmadi." }, { status: 404 });
      if (role !== "admin" && userShopId(actor) !== shop2.id) {
        return Response.json({ error: "Boshqa do\u2018kon stoliga ruxsat yo\u2018q." }, { status: 403 });
      }
      const number = body?.table_number;
      const orderId = String(body?.order_id || "");
      if (takeaway && action === "list_takeaway_orders") {
        return Response.json({ ok: true, orders: ordersOf(shop2).filter((row) => row.order_type === "takeaway") });
      }
      if (takeaway && !/^[a-zA-Z0-9_-]{8,128}$/.test(orderId)) {
        return Response.json({ error: "Buyurtma identifikatori noto\u2018g\u2018ri." }, { status: 400 });
      }
      if (!takeaway && (!Number.isInteger(number) || number < 1 || number > safeShop(shop2).table_count)) {
        return Response.json({ error: "Bu do\u2018konda stol topilmadi." }, { status: 400 });
      }
      const stored = ordersOf(shop2);
      const group = takeaway ? null : groupForNumber(shop2, number);
      const primaryNumber = takeaway ? void 0 : canonicalNumber(shop2, number);
      const existing = takeaway ? stored.find((row) => row.order_type === "takeaway" && row.id === orderId) : orderForNumber(shop2, number);
      if (action === "get_table_order" || action === "get_takeaway_order") {
        return Response.json({
          ok: true,
          order: existing,
          group,
          shop: { id: shop2.id, name: shop2.name, restaurant_table_count: safeShop(shop2).table_count },
          primary_table_number: primaryNumber
        });
      }
      if (action === "reconcile_table_payment" || action === "reconcile_takeaway_payment") {
        if (!existing || existing.state !== "paying" || !existing.checkout_key) {
          return Response.json({ error: "To\u2018lov tekshiriladigan stol topilmadi." }, { status: 409 });
        }
        const matches = await service.entities.Sale.filter({
          table_order_id_snapshot: existing.id,
          idempotency_key: existing.checkout_key
        }, "-created_date", 2);
        if ((matches || []).length !== 1 || matches[0].status !== "completed" || matches[0].shop_id !== shop2.id || (takeaway ? Boolean(matches[0].table_number_snapshot) : !(group?.numbers || [number]).includes(matches[0].table_number_snapshot))) {
          return Response.json({ error: "To\u2018lov tasdiqlanmadi. Qayta to\u2018lov olmang \u2014 egasi Savdolar tarixini tekshirsin." }, { status: 409 });
        }
        const version2 = ordersVersion(shop2);
        const cleared = await service.entities.Shop.updateMany(
          { id: shop2.id, ...ordersVersionCondition(version2) },
          {
            $set: {
              restaurant_table_orders: stored.filter((row) => row.id !== existing.id),
              restaurant_table_groups: group ? cleanGroups(shop2, safeShop(shop2).table_count).filter((row) => row.id !== group.id) : cleanGroups(shop2, safeShop(shop2).table_count)
            },
            $inc: { restaurant_table_orders_version: 1 }
          }
        );
        if (!cleared?.success || Number(cleared.updated || 0) !== 1) {
          return Response.json({ error: "Stol holati o\u2018zgardi. Yangilang va qayta tekshiring." }, { status: 409 });
        }
        return Response.json({ ok: true, sale_id: matches[0].id, released: true });
      }
      const shiftId = String(body?.shift_id || "");
      const shift = shiftId ? await service.entities.Shift.get(shiftId).catch(() => null) : null;
      if (!shift || shift.status !== "open" || shift.user_id !== actor.id || shift.shop_id !== shop2.id) {
        return Response.json({ error: "Stol buyurtmasini faqat shu do\u2018kondagi ochiq smenangizda saqlang." }, { status: 403 });
      }
      if (action === "cancel_table_order" || action === "cancel_takeaway_order") {
        const expectedId = takeaway ? orderId : String(body?.table_order_id || "");
        if (!expectedId || !Number.isInteger(body?.expected_revision) || body.expected_revision < 1 || body?.confirm_cancel !== true) {
          return Response.json({ error: "Bekor qilish uchun buyurtma va tasdiq kerak." }, { status: 400 });
        }
        if (!existing) return Response.json({ ok: true, already_closed: true });
        if (existing.id !== expectedId || existing.revision !== body.expected_revision) {
          return Response.json({ error: "Buyurtma boshqa qurilmada o\u2018zgardi. Yangilang va qayta tekshiring." }, { status: 409 });
        }
        if (existing.state !== "occupied" || existing.checkout_key) {
          return Response.json({ error: "To\u2018lovi boshlangan buyurtmani bekor qilib bo\u2018lmaydi. Avval to\u2018lovni tekshiring." }, { status: 409 });
        }
        const cancelledAt = (/* @__PURE__ */ new Date()).toISOString();
        const details = JSON.stringify({
          shop_id: shop2.id,
          shop_name: shop2.name,
          order_type: takeaway ? "takeaway" : "table",
          table_numbers: takeaway ? [] : group?.numbers || [number],
          order_id: existing.id,
          ticket_number: existing.ticket_number,
          revision: existing.revision,
          cancelled_at: cancelledAt,
          reason: takeaway ? "Ochiq buyurtma bekor qilindi" : "Oxirgi mahsulot olib tashlandi",
          order_snapshot: existing
        });
        await service.entities.ActionHistory.create({
          user_id: actor.id,
          user_name: userLabel(actor),
          action: takeaway ? "restaurant_takeaway_order_cancel_requested" : "restaurant_table_order_cancel_requested",
          details
        });
        const cleared = await service.entities.Shop.updateMany(
          { id: shop2.id, ...ordersVersionCondition(ordersVersion(shop2)) },
          { $set: {
            restaurant_table_orders: stored.filter((row) => row.id !== existing.id),
            ...takeaway ? {} : { restaurant_table_groups: group ? cleanGroups(shop2, safeShop(shop2).table_count).filter((row) => row.id !== group.id) : cleanGroups(shop2, safeShop(shop2).table_count) }
          }, $inc: { restaurant_table_orders_version: 1 } }
        );
        if (!cleared?.success || Number(cleared.updated || 0) !== 1) {
          return Response.json({ error: "Buyurtmalar boshqa kassada o\u2018zgardi. Buyurtma bekor qilinmadi; yangilang." }, { status: 409 });
        }
        let auditWarning = false;
        await service.entities.ActionHistory.create({
          user_id: actor.id,
          user_name: userLabel(actor),
          action: takeaway ? "restaurant_takeaway_order_cancelled" : "restaurant_table_order_cancelled",
          details
        }).catch(() => {
          auditWarning = true;
        });
        return Response.json({ ok: true, cancelled: true, order_id: existing.id, audit_warning: auditWarning });
      }
      if (body?.is_delivery !== void 0 && typeof body.is_delivery !== "boolean") {
        return Response.json({ error: "Dostavka belgisi noto\u2018g\u2018ri." }, { status: 400 });
      }
      if (!takeaway && body?.is_delivery === true) {
        return Response.json({ error: "Stol buyurtmasini dostavka deb belgilab bo\u2018lmaydi." }, { status: 400 });
      }
      const isDelivery = takeaway && (body?.is_delivery === void 0 ? existing?.is_delivery === true : body.is_delivery);
      if (takeaway && existing && body?.expected_revision === 0 && existing.revision === 1 && existing.opened_by === actor.id && existing.state === "occupied" && existing.is_delivery === true === isDelivery && Array.isArray(body?.items) && body.items.length === existing.items.length && new Set(body.items.map((row) => saleLineKey(row))).size === body.items.length && body.items.every((row) => existing.items.some((item) => saleLineKey(item) === saleLineKey(row) && item.quantity === row.quantity && item.notes === String(row.notes || "").trim() && item.variant_name === String(row.variant_name || "").trim()))) {
        return Response.json({ ok: true, order: existing, unchanged: true });
      }
      if (takeaway && !existing && (body?.expected_revision !== 0 || stored.filter((row) => row.order_type === "takeaway").length >= 200)) {
        return Response.json({ error: "Buyurtma yopilgan yoki ochiq buyurtmalar chegarasi to\u2018lgan. Ro\u2018yxatni yangilang." }, { status: 409 });
      }
      if (takeaway && !existing) {
        const paid = await service.entities.Sale.filter({ shop_id: shop2.id, table_order_id_snapshot: orderId }, "-created_date", 1);
        if (paid?.length) return Response.json({ error: "Bu buyurtma allaqachon to\u2018langan. Ochiq buyurtmalarni yangilang." }, { status: 409 });
      }
      const revision = body?.expected_revision;
      if (!Number.isInteger(revision) || revision < 0 || revision !== (existing?.revision || 0)) {
        return Response.json({ error: "Buyurtma boshqa qurilmada o\u2018zgardi. Yangilang; sizning savatingiz o\u2018chirilmaydi." }, { status: 409 });
      }
      if (existing?.state !== void 0 && existing.state !== "occupied") {
        return Response.json({ error: "Bu stolning to\u2018lovi boshlangan. Buyurtmani o\u2018zgartirib bo\u2018lmaydi." }, { status: 409 });
      }
      const requested = body?.items;
      if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_ORDER_ITEMS) {
        return Response.json({ error: "Buyurtmada 1\u2013100 turdagi mahsulot bo\u2018lishi kerak." }, { status: 400 });
      }
      const previousItems = new Map((existing?.items || []).map((item) => [saleLineKey(item), item]));
      const seen = /* @__PURE__ */ new Set();
      const items = [];
      for (const row of requested) {
        const productId = String(row?.product_id || "");
        const quantity = row?.quantity;
        const option = validateFriesOption(row, shop2.id);
        const teaOption = validateTeaOption(row);
        const cakeExtra = validateCakeExtra(row);
        const key = saleLineKey(row);
        if (!productId || seen.has(key) || !Number.isInteger(quantity) || quantity < 1 || quantity > 1e6) {
          return Response.json({ error: "Takroriy mahsulot yoki dona soni noto\u2018g\u2018ri." }, { status: 400 });
        }
        seen.add(key);
        const previous2 = previousItems.get(key);
        const product = await service.entities.Product.get(productId).catch(() => null);
        if (!previous2 && (!product || product.active === false || product.archived === true)) {
          return Response.json({ error: "Yangi qo\u2018shilgan mahsulot sotuvda mavjud emas." }, { status: 409 });
        }
        if (!previous2 && product?.available_shop_ids?.length && !product.available_shop_ids.includes(shop2.id)) {
          return Response.json({ error: "Bu mahsulot ushbu do\u2018konda sotilmaydi." }, { status: 403 });
        }
        if (!previous2 && cakeExtra && !canChooseCakeExtra(product, shop2.id)) {
          return Response.json({ error: "Tort qo\u2018shimchasi faqat dona bilan sotiladigan tortga qo\u2018shiladi." }, { status: 400 });
        }
        const price = previous2 ? previous2.price : teaServingPrice(product?.shop_prices?.[shop2.id] ?? product.price, teaOption) + friesSurcharge(row) + cakeExtraSurcharge(row);
        if (!Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(price * quantity)) {
          return Response.json({ error: "Mahsulot narxi yoki miqdori noto\u2018g\u2018ri." }, { status: 400 });
        }
        const saleUnit = (previous2 || product).sale_unit === "gram" ? "gram" : "piece";
        if (saleUnit !== "gram" && quantity > 1e3) return Response.json({ error: "Dona soni chegaradan oshdi." }, { status: 400 });
        items.push({
          product_id: productId,
          product_name: previous2?.product_name || teaOptionName(burgerOptionName(String(product.name || "Mahsulot"), option), teaOption),
          ...saleOptionFields(previous2 || row),
          image_url: previous2?.image_url || String(product.image_url || ""),
          price,
          quantity,
          sale_unit: saleUnit,
          subtotal: Math.round(price * quantity / (saleUnit === "gram" ? 1e3 : 1)),
          stock_tracked: saleUnit !== "gram" && (previous2 ? previous2.stock_tracked !== false : product.track_stock !== false),
          source_type: previous2?.source_type || product.source_type || "central_produced",
          variant_name: String(row?.variant_name || row?.variant || previous2?.variant_name || "").trim(),
          notes: String(row?.notes || previous2?.notes || "").trim()
        });
      }
      const total = items.reduce((sum, item) => sum + item.subtotal, 0);
      if (!Number.isSafeInteger(total) || total > 1e12) {
        return Response.json({ error: "Buyurtma summasi chegaradan oshdi." }, { status: 400 });
      }
      const ticketNumber = Number.isSafeInteger(existing?.ticket_number) && existing.ticket_number > 0 ? existing.ticket_number : await allocateServiceTicketNumber(service, shop2.id);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const order = {
        id: existing?.id || (takeaway ? orderId : crypto.randomUUID()),
        ...takeaway ? { order_type: "takeaway", is_delivery: isDelivery } : { number: primaryNumber },
        ticket_number: ticketNumber,
        revision: revision + 1,
        state: "occupied",
        items,
        total,
        started_at: existing?.started_at || now,
        opened_by: existing?.opened_by || actor.id,
        opened_by_name: existing?.opened_by_name || userLabel(actor),
        customer_name: String(body?.customer_name || existing?.customer_name || "").trim(),
        notes: String(body?.notes || existing?.notes || "").trim(),
        updated_by: actor.id,
        updated_at: now
      };
      const version = ordersVersion(shop2);
      const updated2 = await service.entities.Shop.updateMany(
        { id: shop2.id, ...!takeaway ? { restaurant_table_count: safeShop(shop2).table_count } : {}, ...ordersVersionCondition(version) },
        {
          $set: { restaurant_table_orders: [...stored.filter((row) => takeaway ? row.id !== orderId : row.number !== primaryNumber), order] },
          $inc: { restaurant_table_orders_version: 1 }
        }
      );
      if (!updated2?.success || Number(updated2.updated || 0) !== 1) {
        return Response.json({ error: "Xarita boshqa qurilmada o\u2018zgardi. Savatni saqlagan holda yangilang." }, { status: 409 });
      }
      await service.entities.ActionHistory.create({
        user_id: actor.id,
        user_name: userLabel(actor),
        action: takeaway ? "takeaway_order_saved" : "restaurant_table_order_saved",
        details: `${shop2.name} \xB7 ${takeaway ? "Olib ketish #" + ticketNumber : (group?.numbers || [number]).join(" + ") + "-stol"} \xB7 ${revision + 1}-tahrir \xB7 ${total} UZS (to\u2018lanmagan)`
      }).catch(() => {
      });
      return Response.json({ ok: true, order, summary: orderSummary(order) });
    }
    if (action !== "set_table_count" && action !== "set_table_layout") {
      return Response.json({ error: "Noma\u2019lum amal." }, { status: 400 });
    }
    if (role !== "admin" && !(role === "manager" && userShopId(actor) && userShopId(actor) === shopId)) {
      return Response.json({ error: "Faqat o\u2018z do\u2018koningiz stollarini o\u2018zgartira olasiz." }, { status: 403 });
    }
    if (action === "set_table_layout") {
      const shop2 = shopId ? await service.entities.Shop.get(shopId).catch(() => null) : null;
      if (!isShop(shop2)) return Response.json({ error: "Faol do\u2018kon topilmadi." }, { status: 404 });
      const current = safeShop(shop2);
      const version = body?.layout_version;
      if (!Number.isInteger(version) || version !== current.layout_version) {
        return Response.json({ error: "Xarita boshqa oynada o\u2018zgardi. Yangilab qayta joylashtiring." }, { status: 409 });
      }
      const entrance = body?.entrance === void 0 ? current.entrance : body.entrance;
      if (!validEntrance(entrance)) {
        return Response.json({ error: "Eshik joylashuvi noto\u2018g\u2018ri. Devorni va joyini qayta tanlang." }, { status: 400 });
      }
      const outdoorPolygon = body?.outdoor_polygon === void 0 ? current.outdoor_polygon : body.outdoor_polygon;
      if (!validOutdoorPolygon(outdoorPolygon)) {
        return Response.json({ error: "Ko\u2018cha hududi noto\u2018g\u2018ri. Kamida uchta nuqta tanlang, chiziqlar kesishmasin." }, { status: 400 });
      }
      const layout = body?.layout;
      const existingSizes = new Map((current.layout || []).map((row) => [row.number, row.size]));
      const clean = Array.isArray(layout) ? layout.map((row) => ({
        number: row?.number,
        x: row?.x,
        y: row?.y,
        size: row?.size === void 0 ? existingSizes.get(row?.number) || 100 : row.size
      })).sort((a, b) => a.number - b.number) : null;
      if (!validateLayout(clean, current.table_count)) {
        return Response.json({ error: "Stol soni, o\u2018lchami yoki joylashuvi noto\u2018g\u2018ri. Stollar ustma-ust tushmasligi va xaritadan chiqmasligi kerak." }, { status: 400 });
      }
      const expectedVersion = version === 0 ? { $or: [{ restaurant_table_layout_version: 0 }, { restaurant_table_layout_version: { $exists: false } }] } : { restaurant_table_layout_version: version };
      const updated2 = await service.entities.Shop.updateMany(
        { id: shop2.id, ...expectedVersion, restaurant_table_count: current.table_count },
        {
          $set: {
            restaurant_table_layout: clean,
            restaurant_entrance: cleanEntrance(entrance),
            restaurant_outdoor_polygon: cleanOutdoorPolygon(outdoorPolygon)
          },
          $inc: { restaurant_table_layout_version: 1 }
        }
      );
      if (!updated2?.success || Number(updated2.updated || 0) !== 1) {
        return Response.json({ error: "Stollar soni yoki xarita o\u2018zgardi. Yangilang va qayta urinib ko\u2018ring." }, { status: 409 });
      }
      const saved = await service.entities.Shop.get(shop2.id);
      await service.entities.ActionHistory.create({
        user_id: String(actor.id || auth.id),
        user_name: userLabel(actor),
        action: "restaurant_table_layout_changed",
        details: `${String(shop2.name || shop2.id)} \xB7 ${current.table_count} stol joylashuvi yangilandi`
      });
      return Response.json({ ok: true, shop: safeShop(saved) });
    }
    const count = body?.table_count;
    if (!shopId || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_TABLES) {
      return Response.json({ error: `Stollar sonini 0 dan ${MAX_TABLES} gacha butun son bilan kiriting.` }, { status: 400 });
    }
    const shop = await service.entities.Shop.get(shopId).catch(() => null);
    if (!isShop(shop)) {
      return Response.json({ error: "Faqat faol savdo do\u2018koni uchun stol sozlanadi." }, { status: 404 });
    }
    const previous = safeShop(shop).table_count;
    if (previous === count) return Response.json({ ok: true, shop: safeShop(shop), unchanged: true });
    if (ordersOf(shop).some((order) => order.number > count)) {
      return Response.json({ error: "Buyurtmasi ochiq stolni olib tashlab bo\u2018lmaydi. Avval hisobni yakunlang." }, { status: 409 });
    }
    if (cleanGroups(shop, previous).some((group) => group.numbers.some((number) => number > count))) {
      return Response.json({ error: "Birlashtirilgan stolni olib tashlab bo\u2018lmaydi. Avval stollarni ajrating." }, { status: 409 });
    }
    const existingLayout = Array.isArray(shop.restaurant_table_layout) ? shop.restaurant_table_layout : [];
    const countUpdate = await service.entities.Shop.updateMany(
      {
        id: shop.id,
        restaurant_table_count: previous === 0 ? { $in: [0, null] } : previous,
        restaurant_table_layout_version: safeShop(shop).layout_version === 0 ? { $in: [0, null] } : safeShop(shop).layout_version,
        ...ordersVersionCondition(ordersVersion(shop))
      },
      { $set: {
        restaurant_table_count: count,
        restaurant_table_layout: existingLayout.filter((row) => Number.isInteger(row?.number) && row.number <= count),
        restaurant_table_layout_version: safeShop(shop).layout_version + 1
      } }
    );
    if (!countUpdate?.success || Number(countUpdate.updated || 0) !== 1) {
      return Response.json({ error: "Stol buyurtmasi yoki stollar soni o\u2018zgardi. Yangilang." }, { status: 409 });
    }
    const updated = await service.entities.Shop.get(shop.id);
    await service.entities.ActionHistory.create({
      user_id: String(actor.id || auth.id),
      user_name: userLabel(actor),
      action: "restaurant_table_count_changed",
      details: `${String(shop.name || shop.id)} \xB7 stollar: ${previous} \u2192 ${count}`
    });
    return Response.json({ ok: true, shop: safeShop(updated) });
  } catch (error) {
    if (error?.status === 400) return Response.json({ error: error.message }, { status: 400 });
    console.error("restaurant-tables failed", error);
    return Response.json({ error: "Stollar ma\u2019lumotini xavfsiz yuklash yoki saqlash amalga oshmadi." }, { status: 500 });
  }
});
