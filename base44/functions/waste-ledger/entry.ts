import { createClientFromRequest } from "npm:@base44/sdk";

const APP_ROLES = new Set(["admin", "manager", "cashier", "accountant", "production", "warehouse"]);
const VIEW_ROLES = new Set(["admin", "manager", "cashier"]);
const WRITE_ROLES = new Set(["admin", "manager", "cashier"]);
const CANCEL_ROLES = new Set(["admin", "manager"]);
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const REASON_LABELS: Record<string, string> = {
  expired: "3 kundan oshgan",
  damaged: "Shikastlangan",
  quality: "Sifati buzilgan",
  other: "Boshqa sabab",
};

const cleanNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : NaN;
};

const money = (value: unknown) => Math.round(Number(value) || 0);

const userRole = (value: any) => {
  const rootRole = String(value?.role || "");
  const nestedRole = String(value?.data?.role || "");
  if (APP_ROLES.has(rootRole)) return rootRole;
  if (APP_ROLES.has(nestedRole)) return nestedRole;
  return rootRole || nestedRole;
};

const userShopId = (value: any) => String(value?.shop_id || value?.data?.shop_id || "");
const userShopName = (value: any) => String(value?.shop_name || value?.data?.shop_name || "");
const userLabel = (value: any) => value?.full_name || value?.email || "Noma’lum xodim";

const httpError = (message: string, status: number) => {
  const error: any = new Error(message);
  error.status = status;
  return error;
};

const resolveAppUser = async (service: any, authenticatedUser: any) => {
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
    shop_name: userShopName(storedUser) || userShopName(authenticatedUser),
    active: storedUser?.active ?? authenticatedUser?.active,
  };
};

const stockKey = (locationId: string, productId: string) => `${locationId}:${productId}`;

const ageSummary = (stock: any, transfers: any[], nowMs: number) => {
  let unallocated = Math.max(0, cleanNumber(stock?.quantity || 0));
  let expiredQuantity = 0;
  let trackedQuantity = 0;
  let oldestReceivedAt = "";
  let oldestExpiredAt = "";
  let oldestTime = Number.POSITIVE_INFINITY;
  let oldestExpiredTime = Number.POSITIVE_INFINITY;

  const ordered = (transfers || [])
    .filter((transfer: any) =>
      transfer.status === "received"
      && transfer.destination_location_id === stock.location_id
      && transfer.product_id === stock.product_id
      && Number.isFinite(Date.parse(transfer.received_at || ""))
      && cleanNumber(transfer.received_quantity ?? transfer.quantity) > 0
    )
    .sort((a: any, b: any) => Date.parse(b.received_at) - Date.parse(a.received_at));

  for (const transfer of ordered) {
    if (unallocated <= 0) break;
    const allocated = Math.min(unallocated, cleanNumber(transfer.received_quantity ?? transfer.quantity));
    if (allocated <= 0) continue;
    const receivedTime = Date.parse(transfer.received_at);
    trackedQuantity += allocated;
    unallocated = Math.max(0, cleanNumber(unallocated - allocated));

    if (receivedTime < oldestTime) {
      oldestTime = receivedTime;
      oldestReceivedAt = new Date(receivedTime).toISOString();
    }
    if (receivedTime + THREE_DAYS_MS <= nowMs) {
      expiredQuantity += allocated;
      if (receivedTime < oldestExpiredTime) {
        oldestExpiredTime = receivedTime;
        oldestExpiredAt = new Date(receivedTime).toISOString();
      }
    }
  }

  const referenceTime = Number.isFinite(oldestExpiredTime) ? oldestExpiredTime : oldestTime;
  return {
    expired_quantity: cleanNumber(expiredQuantity),
    tracked_quantity: cleanNumber(trackedQuantity),
    untracked_quantity: cleanNumber(unallocated),
    oldest_received_at: oldestReceivedAt || null,
    oldest_expired_at: oldestExpiredAt || null,
    age_days: Number.isFinite(referenceTime)
      ? Math.max(0, Math.floor((nowMs - referenceTime) / (24 * 60 * 60 * 1000)))
      : null,
    expires_at: Number.isFinite(oldestTime)
      ? new Date(oldestTime + THREE_DAYS_MS).toISOString()
      : null,
  };
};

const getRetailShops = async (service: any) => {
  const shops = await service.entities.Shop.list("name", 100);
  return (shops || []).filter((shop: any) =>
    shop.active !== false && shop.allows_pos !== false && shop.location_type !== "production"
  );
};

const permittedShops = async (service: any, user: any) => {
  const role = userRole(user);
  const shops = await getRetailShops(service);
  if (role === "cashier") {
    const assignedId = userShopId(user);
    if (!assignedId) throw httpError("Kassirga do‘kon biriktirilmagan.", 400);
    const assigned = shops.find((shop: any) => shop.id === assignedId);
    if (!assigned) throw httpError("Biriktirilgan do‘kon topilmadi yoki Kassa uchun faol emas.", 400);
    return [assigned];
  }
  return shops;
};

const loadContext = async (service: any, user: any) => {
  const shops = await permittedShops(service, user);
  const allowedIds = new Set(shops.map((shop: any) => shop.id));
  const [allStocks, allTransfers, allRecords, allProducts] = await Promise.all([
    service.entities.ProductStock.list("-updated_at", 1000),
    service.entities.StockTransfer.filter({ status: "received" }, "-received_at", 1000),
    service.entities.WasteRecord.list("-recorded_at", 500),
    service.entities.Product.list("name", 500),
  ]);

  const nowMs = Date.now();
  const productById = new Map((allProducts || []).map((product: any) => [product.id, product]));
  const stocks = (allStocks || []).filter((stock: any) =>
    allowedIds.has(stock.location_id) && cleanNumber(stock.quantity) > 0
      && productById.has(stock.product_id)
      && (productById.get(stock.product_id) as any)?.archived !== true
  );
  const transfers = (allTransfers || []).filter((transfer: any) =>
    allowedIds.has(transfer.destination_location_id)
  );

  const stockItems = stocks.map((stock: any) => {
    const product: any = productById.get(stock.product_id) || {};
    const age = ageSummary(stock, transfers, nowMs);
    return {
      id: stock.id,
      location_id: stock.location_id,
      location_name: stock.location_name,
      product_id: stock.product_id,
      product_name: stock.product_name || product.name,
      quantity: cleanNumber(stock.quantity),
      image_url: product.image_url || "",
      price: money(product.price),
      ...age,
    };
  });

  const expiredItems = stockItems
    .filter((item: any) => item.expired_quantity > 0)
    .sort((a: any, b: any) =>
      (b.age_days || 0) - (a.age_days || 0)
      || String(a.product_name).localeCompare(String(b.product_name))
    );
  const records = (allRecords || []).filter((record: any) => allowedIds.has(record.location_id));

  return {
    shops,
    stock_items: stockItems,
    expired_items: expiredItems,
    waste_records: records,
    expiry_days: 3,
    generated_at: new Date(nowMs).toISOString(),
    summary: {
      expired_product_types: expiredItems.length,
      expired_quantity: expiredItems.reduce(
        (sum: number, item: any) => sum + cleanNumber(item.expired_quantity), 0,
      ),
      active_waste_quantity: records
        .filter((record: any) => record.status === "recorded")
        .reduce((sum: number, record: any) => sum + cleanNumber(record.quantity), 0),
      active_waste_value: records
        .filter((record: any) => record.status === "recorded")
        .reduce((sum: number, record: any) => sum + money(record.total_retail_value), 0),
    },
  };
};

const findSingleStock = async (service: any, locationId: string, productId: string) => {
  const rows = await service.entities.ProductStock.filter({
    location_id: locationId,
    product_id: productId,
  });
  if ((rows || []).length > 1) {
    throw httpError("Bu mahsulot uchun takroriy qoldiq topildi. Egasi tekshirishi kerak.", 409);
  }
  return rows?.[0] || null;
};

const createMovement = async (service: any, data: any) => service.entities.StockMovement.create({
  movement_number: `ST-${data.now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  location_id: data.location.id,
  location_name: data.location.name,
  item_kind: "product",
  item_id: data.product.id,
  item_name: data.product.name,
  unit: "piece",
  movement_type: data.type,
  quantity_change: data.change,
  balance_before: data.before,
  balance_after: data.after,
  reason: data.reason,
  reference_id: data.waste.id,
  reference_type: "waste_record",
  user_id: data.user.id,
  user_name: userLabel(data.user),
  created_at: data.now,
});

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) {
      return Response.json({ error: "Tizimga kirish kerak." }, { status: 401 });
    }
    const user = await resolveAppUser(service, authenticatedUser);
    const role = userRole(user);
    if (user.active === false) {
      return Response.json({ error: "Xodim akkaunti faol emas." }, { status: 403 });
    }
    if (!VIEW_ROLES.has(role)) {
      return Response.json({ error: "Sizda chiqitlar bo‘limini ko‘rish huquqi yo‘q." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "get_context");

    if (action === "get_context" || action === "get_alerts") {
      const context = await loadContext(service, user);
      if (action === "get_alerts") {
        return Response.json({
          expired_items: context.expired_items,
          summary: context.summary,
          expiry_days: context.expiry_days,
          generated_at: context.generated_at,
        });
      }
      return Response.json(context);
    }

    if (action === "create_waste") {
      if (!WRITE_ROLES.has(role)) {
        return Response.json({ error: "Siz chiqit kirita olmaysiz." }, { status: 403 });
      }
      const shops = await permittedShops(service, user);
      const requestedLocationId = String(body?.location_id || "");
      const locationId = role === "cashier" ? userShopId(user) : requestedLocationId;
      const location = shops.find((shop: any) => shop.id === locationId);
      if (!location) {
        return Response.json({ error: "Chiqit uchun faol do‘konni tanlang." }, { status: 400 });
      }

      const productId = String(body?.product_id || "");
      const quantity = cleanNumber(body?.quantity);
      const reasonCode = String(body?.reason_code || "");
      const notes = String(body?.notes || "").trim().slice(0, 2000);
      const photoUrl = String(body?.photo_url || "").trim().slice(0, 3000);
      if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
        return Response.json({ error: "Mahsulot va musbat butun dona sonini kiriting." }, { status: 400 });
      }
      if (!REASON_LABELS[reasonCode]) {
        return Response.json({ error: "Chiqit sababini tanlang." }, { status: 400 });
      }
      if (photoUrl && !/^https:\/\//i.test(photoUrl)) {
        return Response.json({ error: "Rasm manzili xavfsiz HTTPS havola bo‘lishi kerak." }, { status: 400 });
      }

      const [product, stock, transfers] = await Promise.all([
        service.entities.Product.get(productId),
        findSingleStock(service, location.id, productId),
        service.entities.StockTransfer.filter({
          status: "received",
          destination_location_id: location.id,
          product_id: productId,
        }, "-received_at", 500),
      ]);
      if (!product || product.active === false || product.archived === true || product.track_stock === false) {
        return Response.json({ error: "Faol ombor mahsuloti topilmadi." }, { status: 404 });
      }
      if (!stock) {
        return Response.json({ error: "Do‘konda bu mahsulot qoldig‘i topilmadi." }, { status: 404 });
      }
      const before = cleanNumber(stock.quantity);
      if (quantity > before) {
        return Response.json({ error: `Chiqit miqdori qoldiqdan oshmasligi kerak. Mavjud: ${before} dona.` }, { status: 409 });
      }

      const age = ageSummary(stock, transfers || [], Date.now());
      if (reasonCode === "expired" && quantity > age.expired_quantity) {
        return Response.json({
          error: `3 kundan oshgan qoldiq ${age.expired_quantity} dona. Ko‘proq miqdor uchun boshqa sababni tanlang.`,
        }, { status: 409 });
      }

      const now = new Date().toISOString();
      const after = cleanNumber(before - quantity);
      const stockUpdate = await service.entities.ProductStock.updateMany(
        { id: stock.id, quantity: before },
        { $set: {
          quantity: after,
          updated_at: now,
          updated_by: user.id,
          updated_by_name: userLabel(user),
        } },
      );
      if (!stockUpdate?.success || Number(stockUpdate.updated || 0) !== 1) {
        return Response.json({
          error: "Qoldiq boshqa qurilmada o‘zgardi. Sahifani yangilab qayta urinib ko‘ring.",
        }, { status: 409 });
      }

      let waste: any = null;
      let movement: any = null;
      try {
        const wasteNumber = `CH-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        waste = await service.entities.WasteRecord.create({
          waste_number: wasteNumber,
          location_id: location.id,
          location_name: location.name,
          product_id: product.id,
          product_name_snapshot: product.name,
          quantity,
          unit: "piece",
          reason_code: reasonCode,
          reason_label: REASON_LABELS[reasonCode],
          notes: notes || undefined,
          photo_url: photoUrl || undefined,
          unit_price_snapshot: money(product.price),
          total_retail_value: money(product.price) * quantity,
          status: "recorded",
          source_received_at: age.oldest_expired_at || age.oldest_received_at || undefined,
          age_days: age.age_days ?? undefined,
          expired_quantity_at_record: age.expired_quantity,
          recorded_by_id: user.id,
          recorded_by_name: userLabel(user),
          recorded_at: now,
        });
        movement = await createMovement(service, {
          location,
          product,
          type: "waste",
          change: -quantity,
          before,
          after,
          waste,
          user,
          now,
          reason: `Chiqit: ${REASON_LABELS[reasonCode]}${notes ? `. ${notes}` : ""}`,
        });
        waste = await service.entities.WasteRecord.update(waste.id, {
          stock_movement_id: movement.id,
        });
      } catch (error) {
        if (movement?.id) await service.entities.StockMovement.delete(movement.id).catch(() => {});
        if (waste?.id) await service.entities.WasteRecord.delete(waste.id).catch(() => {});
        await service.entities.ProductStock.updateMany(
          { id: stock.id, quantity: after },
          { $set: {
            quantity: before,
            updated_at: new Date().toISOString(),
            updated_by: user.id,
            updated_by_name: userLabel(user),
          } },
        ).catch(() => {});
        throw error;
      }

      await service.entities.ActionHistory.create({
        user_id: user.id,
        user_name: userLabel(user),
        action: "waste_recorded",
        details: `${waste.waste_number}. ${location.name}. ${product.name}: ${quantity} dona. ${REASON_LABELS[reasonCode]}.`,
      }).catch(() => {});

      return Response.json({
        waste,
        stock: { ...stock, quantity: after, updated_at: now },
      });
    }

    if (action === "cancel_waste") {
      if (!CANCEL_ROLES.has(role)) {
        return Response.json({ error: "Xato chiqitni faqat egasi yoki boshqaruvchi bekor qila oladi." }, { status: 403 });
      }
      const wasteId = String(body?.waste_id || "");
      if (!wasteId) return Response.json({ error: "Chiqit yozuvi tanlanmagan." }, { status: 400 });
      const waste = await service.entities.WasteRecord.get(wasteId);
      if (!waste) return Response.json({ error: "Chiqit yozuvi topilmadi." }, { status: 404 });
      if (waste.status !== "recorded") {
        return Response.json({ error: "Bu chiqit allaqachon bekor qilingan yoki qayta ishlanmoqda." }, { status: 409 });
      }

      const claim = await service.entities.WasteRecord.updateMany(
        { id: waste.id, status: "recorded" },
        { $set: { status: "cancelling" } },
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ error: "Chiqit boshqa qurilmada o‘zgartirilmoqda." }, { status: 409 });
      }

      let stockChanged = false;
      let createdStock: any = null;
      let movement: any = null;
      let before = 0;
      let after = 0;
      try {
        const [location, product, stock] = await Promise.all([
          service.entities.Shop.get(waste.location_id),
          service.entities.Product.get(waste.product_id),
          findSingleStock(service, waste.location_id, waste.product_id),
        ]);
        if (!location || !product) throw httpError("Do‘kon yoki mahsulot topilmadi.", 404);
        const quantity = cleanNumber(waste.quantity);
        before = cleanNumber(stock?.quantity || 0);
        after = cleanNumber(before + quantity);
        const now = new Date().toISOString();

        if (stock) {
          const update = await service.entities.ProductStock.updateMany(
            { id: stock.id, quantity: before },
            { $set: {
              quantity: after,
              location_name: location.name,
              product_name: product.name,
              updated_at: now,
              updated_by: user.id,
              updated_by_name: userLabel(user),
            } },
          );
          if (!update?.success || Number(update.updated || 0) !== 1) {
            throw httpError("Qoldiq boshqa qurilmada o‘zgardi. Qayta urinib ko‘ring.", 409);
          }
          stockChanged = true;
        } else {
          createdStock = await service.entities.ProductStock.create({
            location_id: location.id,
            location_name: location.name,
            product_id: product.id,
            product_name: product.name,
            unit: "piece",
            quantity: after,
            low_stock_level: 0,
            updated_at: now,
            updated_by: user.id,
            updated_by_name: userLabel(user),
          });
        }

        movement = await createMovement(service, {
          location,
          product,
          type: "waste_cancel",
          change: quantity,
          before,
          after,
          waste,
          user,
          now,
          reason: `Xato chiqit bekor qilindi: ${waste.waste_number}`,
        });
        const cancelled = await service.entities.WasteRecord.update(waste.id, {
          status: "cancelled",
          cancelled_by_id: user.id,
          cancelled_by_name: userLabel(user),
          cancelled_at: now,
          cancel_reason: "Xato chiqit yozuvi",
          cancel_movement_id: movement.id,
        });

        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userLabel(user),
          action: "waste_cancelled",
          details: `${waste.waste_number}. ${waste.location_name}. ${waste.product_name_snapshot}: ${quantity} dona qoldiqqa qaytarildi.`,
        }).catch(() => {});
        return Response.json({ waste: cancelled, restored_quantity: quantity });
      } catch (error) {
        if (movement?.id) await service.entities.StockMovement.delete(movement.id).catch(() => {});
        if (createdStock?.id) {
          await service.entities.ProductStock.delete(createdStock.id).catch(() => {});
        } else if (stockChanged) {
          await service.entities.ProductStock.updateMany(
            { location_id: waste.location_id, product_id: waste.product_id, quantity: after },
            { $set: { quantity: before } },
          ).catch(() => {});
        }
        await service.entities.WasteRecord.updateMany(
          { id: waste.id, status: "cancelling" },
          { $set: { status: "recorded" } },
        ).catch(() => {});
        throw error;
      }
    }

    return Response.json({ error: "Noma’lum chiqit amali." }, { status: 400 });
  } catch (error) {
    const status = Number((error as any)?.status) || 500;
    return Response.json({
      error: error instanceof Error ? error.message : "Chiqit amalini bajarib bo‘lmadi.",
    }, { status });
  }
}
