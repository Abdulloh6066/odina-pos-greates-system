import { createClientFromRequest } from "npm:@base44/sdk";

const ALLOWED_ROLES = new Set(["admin", "cashier", "accountant", "production"]);

const cleanNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : NaN;
};

const userLabel = (user: any) => user.full_name || user.email || "Noma’lum xodim";

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
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Tizimga kirish kerak." }, { status: 401 });
    if (!ALLOWED_ROLES.has(user.role)) {
      return Response.json({ error: "Sizda transfer bilan ishlash huquqi yo‘q." }, { status: 403 });
    }

    const body = await req.json();
    const action = String(body?.action || "");

    if (action === "create_transfer") {
      if (user.role !== "admin") {
        return Response.json({ error: "Transferni faqat egasi jo‘nata oladi." }, { status: 403 });
      }

      const sourceId = String(body?.source_location_id || "");
      const destinationId = String(body?.destination_location_id || "");
      const productId = String(body?.product_id || "");
      const quantity = cleanNumber(body?.quantity);
      const notes = String(body?.notes || "").trim();

      if (!sourceId || !destinationId || sourceId === destinationId || !productId) {
        return Response.json({ error: "Markaz, do‘kon va mahsulotni to‘g‘ri tanlang." }, { status: 400 });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return Response.json({ error: "Transfer miqdori musbat butun dona bo‘lishi kerak." }, { status: 400 });
      }
      const [source, destination, product] = await Promise.all([
        service.entities.Shop.get(sourceId),
        service.entities.Shop.get(destinationId),
        service.entities.Product.get(productId),
      ]);
      if (!source || source.active === false || source.location_type !== "production") {
        return Response.json({ error: "Jo‘natuvchi joy markaziy ishlab chiqarish ombori bo‘lishi kerak." }, { status: 400 });
      }
      if (!destination || destination.active === false || destination.location_type !== "shop") {
        return Response.json({ error: "Qabul qiluvchi faol do‘kon bo‘lishi kerak." }, { status: 400 });
      }
      if (!product || product.active === false || product.archived === true || product.track_stock === false) {
        return Response.json({ error: "Transfer uchun faol ombor mahsuloti topilmadi." }, { status: 404 });
      }

      const sourceStock = await findStock(service, sourceId, productId);
      const before = cleanNumber(sourceStock?.quantity || 0);
      const after = cleanNumber(before - quantity);
      if (!sourceStock || after < 0) {
        return Response.json({ error: `Markaziy omborda yetarli qoldiq yo‘q. Mavjud: ${before} dona.` }, { status: 409 });
      }

      const now = new Date().toISOString();
      await changeExistingStock(service, sourceStock, before, after, source, product, user, now);
      let transfer: any = null;
      try {
        transfer = await service.entities.StockTransfer.create({
          transfer_number: `TR-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
          source_location_id: source.id,
          source_location_name: source.name,
          destination_location_id: destination.id,
          destination_location_name: destination.name,
          product_id: product.id,
          product_name_snapshot: product.name,
          quantity,
          unit: "piece",
          status: "pending",
          notes,
          created_by: user.id,
          created_by_name: userLabel(user),
          sent_at: now,
        });
        await createMovement(service, {
          location: source, product, type: "transfer_out", change: -quantity,
          before, after, transfer, user, now,
        });
      } catch (error) {
        try {
          await service.entities.ProductStock.update(sourceStock.id, { quantity: before });
          if (transfer?.id) await service.entities.StockTransfer.delete(transfer.id);
        } catch {}
        throw error;
      }

      try {
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userLabel(user),
          action: "stock_transfer_sent",
          details: `${source.name} → ${destination.name}. ${product.name}: ${quantity} dona.`,
        });
      } catch {}

      return Response.json({ transfer });
    }

    if (action === "receive_transfer") {
      const transferId = String(body?.transfer_id || "");
      if (!transferId) return Response.json({ error: "Transfer tanlanmagan." }, { status: 400 });

      const transfer = await service.entities.StockTransfer.get(transferId);
      if (!transfer) return Response.json({ error: "Transfer topilmadi." }, { status: 404 });
      if (transfer.status !== "pending") {
        return Response.json({ error: "Bu transfer allaqachon qabul qilingan yoki qayta ishlanmoqda." }, { status: 409 });
      }
      if (user.role !== "admin" && user.shop_id !== transfer.destination_location_id) {
        return Response.json({ error: "Faqat qabul qiluvchi do‘kon xodimi tasdiqlashi mumkin." }, { status: 403 });
      }

      const claim = await service.entities.StockTransfer.updateMany(
        { id: transfer.id, status: "pending" },
        { $set: { status: "receiving" } },
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ error: "Transfer boshqa qurilmada qayta ishlanmoqda." }, { status: 409 });
      }

      const now = new Date().toISOString();
      const [destination, product] = await Promise.all([
        service.entities.Shop.get(transfer.destination_location_id),
        service.entities.Product.get(transfer.product_id),
      ]);
      if (!destination || destination.active === false || !product) {
        await service.entities.StockTransfer.update(transfer.id, { status: "pending" });
        return Response.json({ error: "Do‘kon yoki mahsulot topilmadi." }, { status: 404 });
      }

      const existing = await findStock(service, destination.id, product.id);
      const before = cleanNumber(existing?.quantity || 0);
      const after = cleanNumber(before + cleanNumber(transfer.quantity));
      let createdStock: any = null;

      try {
        if (existing) {
          await changeExistingStock(service, existing, before, after, destination, product, user, now);
        } else {
          createdStock = await service.entities.ProductStock.create({
            location_id: destination.id,
            location_name: destination.name,
            product_id: product.id,
            product_name: transfer.product_name_snapshot || product.name,
            unit: "piece",
            quantity: after,
            low_stock_level: 0,
            updated_at: now,
            updated_by: user.id,
            updated_by_name: userLabel(user),
          });
        }

        await createMovement(service, {
          location: destination, product, type: "transfer_in",
          change: cleanNumber(transfer.quantity), before, after, transfer, user, now,
        });

        const completed = await service.entities.StockTransfer.update(transfer.id, {
          status: "received",
          received_by: user.id,
          received_by_name: userLabel(user),
          received_at: now,
        });

        try {
          await service.entities.ActionHistory.create({
            user_id: user.id,
            user_name: userLabel(user),
            action: "stock_transfer_received",
            details: `${destination.name}. ${transfer.product_name_snapshot}: ${transfer.quantity} dona qabul qilindi.`,
          });
        } catch {}

        return Response.json({ transfer: completed });
      } catch (error) {
        try {
          if (existing) await service.entities.ProductStock.update(existing.id, { quantity: before });
          else if (createdStock?.id) await service.entities.ProductStock.delete(createdStock.id);
          await service.entities.StockTransfer.update(transfer.id, { status: "pending" });
        } catch {}
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
