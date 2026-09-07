import { createClientFromRequest } from "npm:@base44/sdk";

const APP_ROLES = new Set(["admin", "manager", "cashier", "accountant", "production", "warehouse"]);
const TRANSFER_VIEW_ROLES = new Set(["admin", "manager", "cashier", "accountant", "production"]);
const TRANSFER_ACTION_ROLES = new Set(["admin", "cashier", "accountant", "production"]);

const cleanNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : NaN;
};

const userLabel = (user: any) => user.full_name || user.email || "Noma’lum xodim";
const userRole = (user: any) => {
  const rootRole = String(user?.role || "");
  const nestedRole = String(user?.data?.role || "");
  if (APP_ROLES.has(rootRole)) return rootRole;
  if (APP_ROLES.has(nestedRole)) return nestedRole;
  return rootRole || nestedRole;
};
const userShopId = (user: any) => String(user?.shop_id || user?.data?.shop_id || "");
const userShopName = (user: any) => String(user?.shop_name || user?.data?.shop_name || "");

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
    full_name: authenticatedUser?.full_name || storedUser?.full_name,
    role: APP_ROLES.has(storedRole) ? storedRole : userRole(authenticatedUser),
    shop_id: userShopId(storedUser) || userShopId(authenticatedUser),
    shop_name: userShopName(storedUser) || userShopName(authenticatedUser),
    active: storedUser?.active ?? authenticatedUser?.active,
  };
};

const findStock = async (service: any, locationId: string, productId: string) => {
  const rows = await service.entities.ProductStock.filter({
    location_id: locationId,
    product_id: productId,
  });
  if ((rows || []).length > 1) {
    throw new Error("Bir mahsulot uchun takroriy ombor qoldig‘i topildi.");
  }
  return rows?.[0] || null;
};

const changeExistingStock = async (
  service: any,
  stock: any,
  before: number,
  after: number,
  location: any,
  product: any,
  user: any,
  now: string,
) => {
  const result = await service.entities.ProductStock.updateMany(
    { id: stock.id, quantity: before },
    { $set: {
      quantity: after,
      location_name: location.name,
      product_name: product.name,
      unit: "piece",
      updated_at: now,
      updated_by: user.id,
      updated_by_name: userLabel(user),
    } },
  );
  if (!result?.success || Number(result.updated || 0) !== 1) {
    throw new Error("Ombor qoldig‘i bir vaqtda o‘zgardi. Yangilang va qayta urinib ko‘ring.");
  }
};

const createMovement = async (
  service: any,
  data: {
    location: any;
    product: any;
    type: "transfer_out" | "transfer_in";
    change: number;
    before: number;
    after: number;
    transfer: any;
    user: any;
    now: string;
  },
) => service.entities.StockMovement.create({
  movement_number: `ST-${data.now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  location_id: data.location.id,
  location_name: data.location.name,
  item_kind: "product",
  item_id: data.product.id,
  item_name: data.transfer.product_name_snapshot || data.product.name,
  unit: "piece",
  movement_type: data.type,
  quantity_change: data.change,
  balance_before: data.before,
  balance_after: data.after,
  reason: data.type === "transfer_out"
    ? `${data.transfer.destination_location_name} do‘koniga transfer`
    : `${data.transfer.source_location_name} omboridan transfer qabul qilindi`,
  reference_id: data.transfer.id,
  reference_type: "stock_transfer",
  user_id: data.user.id,
  user_name: userLabel(data.user),
  created_at: data.now,
});

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) return Response.json({ error: "Tizimga kirish kerak." }, { status: 401 });

    const user = await resolveAppUser(service, authenticatedUser);
    if (user.active === false) {
      return Response.json({ error: "Xodim akkaunti faol emas." }, { status: 403 });
    }

    const body = await req.json();
    const action = String(body?.action || "");
    const role = userRole(user);
    const allowedRoles = action === "list_transfers" ? TRANSFER_VIEW_ROLES : TRANSFER_ACTION_ROLES;
    if (!allowedRoles.has(role)) {
      return Response.json({ error: "Sizda transfer bilan ishlash huquqi yo‘q." }, { status: 403 });
    }

    if (action === "list_transfers") {
      const canViewAllLocations = role === "admin" || role === "manager";
      const effectiveLocationId = canViewAllLocations ? "" : userShopId(user);

      if (!canViewAllLocations && !effectiveLocationId) {
        return Response.json({ error: "Xodimga do‘kon biriktirilmagan." }, { status: 400 });
      }

      const allTransfers = await service.entities.StockTransfer.list("-sent_at", 500);
      const transfers = effectiveLocationId
        ? (allTransfers || []).filter((transfer: any) =>
          transfer.source_location_id === effectiveLocationId
          || transfer.destination_location_id === effectiveLocationId
        )
        : (allTransfers || []);

      return Response.json({
        transfers,
        effective_location_id: effectiveLocationId || null,
        effective_location_name: canViewAllLocations ? null : (userShopName(user) || null),
        viewer: {
          role,
          shop_id: userShopId(user) || null,
          shop_name: userShopName(user) || null,
        },
      });
    }

    if (action === "create_transfer") {
      if (role !== "admin") {
        return Response.json({ error: "Transferni faqat egasi jo‘nata oladi." }, { status: 403 });
      }

      const sourceId = String(body?.source_location_id || "");
      const destinationId = String(body?.destination_location_id || "");
      const notes = String(body?.notes || "").trim().slice(0, 2000);
      const rawItems = Array.isArray(body?.items) && body.items.length > 0
        ? body.items
        : [{ product_id: body?.product_id, quantity: body?.quantity }];
      const items = rawItems.map((item: any) => ({
        product_id: String(item?.product_id || ""),
        quantity: cleanNumber(item?.quantity),
      }));

      if (!sourceId || !destinationId || sourceId === destinationId) {
        return Response.json({ error: "Markaz va qabul qiluvchi do‘konni to‘g‘ri tanlang." }, { status: 400 });
      }
      if (items.length < 1 || items.length > 50) {
        return Response.json({ error: "Bitta transferda 1 tadan 50 tagacha mahsulot turi bo‘lishi mumkin." }, { status: 400 });
      }
      if (items.some((item: any) =>
        !item.product_id || !Number.isInteger(item.quantity) || item.quantity <= 0
      )) {
        return Response.json({ error: "Har bir mahsulot miqdori musbat butun dona bo‘lishi kerak." }, { status: 400 });
      }
      if (new Set(items.map((item: any) => item.product_id)).size !== items.length) {
        return Response.json({ error: "Bir mahsulotni transferga ikki marta qo‘shib bo‘lmaydi." }, { status: 400 });
      }

      const [source, destination] = await Promise.all([
        service.entities.Shop.get(sourceId),
        service.entities.Shop.get(destinationId),
      ]);
      if (!source || source.active === false || source.location_type !== "production") {
        return Response.json({ error: "Jo‘natuvchi joy markaziy ishlab chiqarish ombori bo‘lishi kerak." }, { status: 400 });
      }
      if (!destination || destination.active === false || destination.location_type !== "shop") {
        return Response.json({ error: "Qabul qiluvchi faol do‘kon bo‘lishi kerak." }, { status: 400 });
      }

      const products = await Promise.all(
        items.map((item: any) => service.entities.Product.get(item.product_id)),
      );
      const sourceStocks = await Promise.all(
        items.map((item: any) => findStock(service, sourceId, item.product_id)),
      );
      const prepared: any[] = [];

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const product = products[index];
        const sourceStock = sourceStocks[index];
        if (!product || product.active === false || product.archived === true || product.track_stock === false) {
          return Response.json({ error: "Transfer ro‘yxatidagi faol ombor mahsulotlaridan biri topilmadi." }, { status: 404 });
        }
        const before = cleanNumber(sourceStock?.quantity || 0);
        const after = cleanNumber(before - item.quantity);
        if (!sourceStock || after < 0) {
          return Response.json({
            error: `${product.name} uchun markaziy omborda qoldiq yetarli emas. Mavjud: ${before} dona.`,
          }, { status: 409 });
        }
        prepared.push({ item, product, sourceStock, before, after });
      }

      const now = new Date().toISOString();
      const batchId = crypto.randomUUID();
      const batchNumber = `TR-${now.slice(0, 10).replaceAll("-", "")}-${batchId.slice(0, 6).toUpperCase()}`;
      const changedStocks: any[] = [];
      const createdTransfers: any[] = [];
      const createdMovements: any[] = [];

      try {
        for (const row of prepared) {
          await changeExistingStock(
            service, row.sourceStock, row.before, row.after, source, row.product, user, now,
          );
          changedStocks.push(row);
        }

        for (let index = 0; index < prepared.length; index += 1) {
          const row = prepared[index];
          const transfer = await service.entities.StockTransfer.create({
            transfer_number: `${batchNumber}-${String(index + 1).padStart(2, "0")}`,
            batch_id: batchId,
            batch_number: batchNumber,
            line_number: index + 1,
            batch_item_count: prepared.length,
            source_location_id: source.id,
            source_location_name: source.name,
            destination_location_id: destination.id,
            destination_location_name: destination.name,
            product_id: row.product.id,
            product_name_snapshot: row.product.name,
            quantity: row.item.quantity,
            unit: "piece",
            status: "pending",
            notes,
            created_by: user.id,
            created_by_name: userLabel(user),
            sent_at: now,
          });
          createdTransfers.push(transfer);
          const movement = await createMovement(service, {
            location: source,
            product: row.product,
            type: "transfer_out",
            change: -row.item.quantity,
            before: row.before,
            after: row.after,
            transfer,
            user,
            now,
          });
          createdMovements.push(movement);
        }
      } catch (error) {
        for (const movement of [...createdMovements].reverse()) {
          try {
            if (movement?.id) await service.entities.StockMovement.delete(movement.id);
          } catch {}
        }
        for (const transfer of [...createdTransfers].reverse()) {
          try {
            if (transfer?.id) await service.entities.StockTransfer.delete(transfer.id);
          } catch {}
        }
        for (const row of [...changedStocks].reverse()) {
          try {
            await service.entities.ProductStock.updateMany(
              { id: row.sourceStock.id, quantity: row.after },
              { $set: { quantity: row.before } },
            );
          } catch {}
        }
        throw error;
      }

      try {
        const totalQuantity = prepared.reduce((sum, row) => sum + row.item.quantity, 0);
        const productSummary = prepared
          .slice(0, 5)
          .map((row) => `${row.product.name}: ${row.item.quantity}`)
          .join(", ");
        const more = prepared.length > 5 ? ` va yana ${prepared.length - 5} tur` : "";
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userLabel(user),
          action: "stock_transfer_sent",
          details: `${source.name} → ${destination.name}. ${prepared.length} tur, ${totalQuantity} dona: ${productSummary}${more}.`,
        });
      } catch {}

      return Response.json({
        transfer: createdTransfers[0],
        transfers: createdTransfers,
        batch_id: batchId,
        batch_number: batchNumber,
      });
    }

    if (action === "receive_transfer" || action === "receive_transfer_batch") {
      const transferId = String(body?.transfer_id || "");
      const requestedBatchId = String(body?.batch_id || "");
      let transferRows: any[] = [];

      if (action === "receive_transfer_batch") {
        if (!requestedBatchId) {
          return Response.json({ error: "Transfer guruhi tanlanmagan." }, { status: 400 });
        }
        transferRows = await service.entities.StockTransfer.filter(
          { batch_id: requestedBatchId },
          "line_number",
          50,
        );
      } else {
        if (!transferId) {
          return Response.json({ error: "Transfer tanlanmagan." }, { status: 400 });
        }
        const selected = await service.entities.StockTransfer.get(transferId);
        if (selected?.batch_id) {
          transferRows = await service.entities.StockTransfer.filter(
            { batch_id: selected.batch_id },
            "line_number",
            50,
          );
        } else if (selected) {
          transferRows = [selected];
        }
      }

      transferRows = (transferRows || []).sort(
        (a: any, b: any) => cleanNumber(a.line_number || 0) - cleanNumber(b.line_number || 0),
      );
      if (transferRows.length === 0) {
        return Response.json({ error: "Transfer topilmadi." }, { status: 404 });
      }
      if (transferRows.length > 50) {
        return Response.json({ error: "Transferda ruxsat etilgandan ko‘p mahsulot bor." }, { status: 409 });
      }

      const first = transferRows[0];
      const batchId = String(first.batch_id || "");
      const declaredCount = cleanNumber(first.batch_item_count || transferRows.length);
      if (batchId && declaredCount !== transferRows.length) {
        return Response.json({
          error: "Transfer hujjati to‘liq yuklanmadi. Yangilang va qayta urinib ko‘ring.",
        }, { status: 409 });
      }
      if (transferRows.some((transfer: any) =>
        transfer.source_location_id !== first.source_location_id
        || transfer.destination_location_id !== first.destination_location_id
        || String(transfer.batch_id || "") !== batchId
      )) {
        return Response.json({ error: "Transfer guruhi ma’lumotlari bir-biriga mos emas." }, { status: 409 });
      }
      if (new Set(transferRows.map((transfer: any) => transfer.product_id)).size !== transferRows.length) {
        return Response.json({ error: "Transfer guruhida takroriy mahsulot topildi." }, { status: 409 });
      }
      if (transferRows.some((transfer: any) => transfer.status !== "pending")) {
        return Response.json({
          error: "Bu transfer allaqachon qabul qilingan yoki qayta ishlanmoqda.",
        }, { status: 409 });
      }
      if (role !== "admin" && userShopId(user) !== first.destination_location_id) {
        return Response.json({
          error: "Faqat qabul qiluvchi do‘kon xodimi tasdiqlashi mumkin.",
        }, { status: 403 });
      }

      const [destination, products] = await Promise.all([
        service.entities.Shop.get(first.destination_location_id),
        Promise.all(
          transferRows.map((transfer: any) => service.entities.Product.get(transfer.product_id)),
        ),
      ]);
      if (!destination || destination.active === false || products.some((product: any) => !product)) {
        return Response.json({ error: "Do‘kon yoki mahsulotlardan biri topilmadi." }, { status: 404 });
      }

      const destinationStocks = await Promise.all(
        transferRows.map((transfer: any) =>
          findStock(service, destination.id, transfer.product_id)
        ),
      );
      const prepared = transferRows.map((transfer: any, index: number) => {
        const existing = destinationStocks[index];
        const before = cleanNumber(existing?.quantity || 0);
        return {
          transfer,
          product: products[index],
          existing,
          before,
          after: cleanNumber(before + cleanNumber(transfer.quantity)),
        };
      });

      const claimFilter = batchId
        ? { batch_id: batchId, status: "pending" }
        : { id: first.id, status: "pending" };
      const claim = await service.entities.StockTransfer.updateMany(
        claimFilter,
        { $set: { status: "receiving" } },
      );
      const claimedCount = Number(claim?.updated || 0);
      if (!claim?.success || claimedCount !== transferRows.length) {
        if (claimedCount > 0) {
          try {
            await service.entities.StockTransfer.updateMany(
              batchId ? { batch_id: batchId, status: "receiving" } : { id: first.id, status: "receiving" },
              { $set: { status: "pending" } },
            );
          } catch {}
        }
        return Response.json({
          error: "Transfer boshqa qurilmada qayta ishlanmoqda.",
        }, { status: 409 });
      }

      const now = new Date().toISOString();
      const changedStocks: any[] = [];
      const createdStocks: any[] = [];
      const createdMovements: any[] = [];

      try {
        for (const row of prepared) {
          if (row.existing) {
            await changeExistingStock(
              service, row.existing, row.before, row.after, destination, row.product, user, now,
            );
            changedStocks.push(row);
          } else {
            const createdStock = await service.entities.ProductStock.create({
              location_id: destination.id,
              location_name: destination.name,
              product_id: row.product.id,
              product_name: row.transfer.product_name_snapshot || row.product.name,
              unit: "piece",
              quantity: row.after,
              low_stock_level: 0,
              updated_at: now,
              updated_by: user.id,
              updated_by_name: userLabel(user),
            });
            createdStocks.push({ ...row, createdStock });
          }

          const movement = await createMovement(service, {
            location: destination,
            product: row.product,
            type: "transfer_in",
            change: cleanNumber(row.transfer.quantity),
            before: row.before,
            after: row.after,
            transfer: row.transfer,
            user,
            now,
          });
          createdMovements.push(movement);
        }

        const completionFilter = batchId
          ? { batch_id: batchId, status: "receiving" }
          : { id: first.id, status: "receiving" };
        const completion = await service.entities.StockTransfer.updateMany(
          completionFilter,
          { $set: {
            status: "received",
            received_by: user.id,
            received_by_name: userLabel(user),
            received_at: now,
          } },
        );
        if (!completion?.success || Number(completion.updated || 0) !== transferRows.length) {
          throw new Error("Transfer holatini yakunlab bo‘lmadi.");
        }

        try {
          const totalQuantity = prepared.reduce(
            (sum: number, row: any) => sum + cleanNumber(row.transfer.quantity),
            0,
          );
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: userLabel(user),
            action: "stock_transfer_received",
            details: `${destination.name}. ${prepared.length} tur, ${totalQuantity} dona qabul qilindi (${first.batch_number || first.transfer_number}).`,
          });
        } catch {}

        const completedTransfers = transferRows.map((transfer: any) => ({
          ...transfer,
          status: "received",
          received_by: user.id,
          received_by_name: userLabel(user),
          received_at: now,
        }));
        return Response.json({
          transfer: completedTransfers[0],
          transfers: completedTransfers,
          batch_id: batchId || null,
        });
      } catch (error) {
        for (const movement of [...createdMovements].reverse()) {
          try {
            if (movement?.id) await service.entities.StockMovement.delete(movement.id);
          } catch {}
        }
        for (const row of [...changedStocks].reverse()) {
          try {
            await service.entities.ProductStock.updateMany(
              { id: row.existing.id, quantity: row.after },
              { $set: { quantity: row.before } },
            );
          } catch {}
        }
        for (const row of [...createdStocks].reverse()) {
          try {
            if (row.createdStock?.id) await service.entities.ProductStock.delete(row.createdStock.id);
          } catch {}
        }
        for (const transfer of transferRows) {
          try {
            await service.entities.StockTransfer.update(transfer.id, { status: "pending" });
          } catch {}
        }
        throw error;
      }
    }

    return Response.json({ error: "Noma’lum transfer amali." }, { status: 400 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Transfer amalini bajarib bo‘lmadi.",
    }, { status: 500 });
  }
}
