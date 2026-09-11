import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser, userLabel, userRole, userShopId, userShopName } from "../../shared/user-helpers.ts";
import {
  computeTotals,
  findExistingByKey,
  hasSendKey,
  isFullyReceived,
  normalizeRequestItems,
  receivedPiecesFromTransfers,
  remainingForItem,
  sortRequests,
  VALID_STATUS,
} from "../../shared/shop-demand-logic.ts";

const VIEW_ALL_ROLES = new Set(["admin", "accountant", "production"]);
const CREATE_ROLES = new Set(["admin", "manager", "cashier"]);
const ACCEPT_ROLES = new Set(["admin", "production"]);
const PROGRESS_ROLES = new Set(["admin", "production"]);
const SEND_ROLES = new Set(["admin"]);

const cleanNumber = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
};

function tashkentParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const o = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour === "24" ? "0" : o.hour),
    minute: Number(o.minute),
  };
}

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;
  try {
    const authUser = await base44.auth.me();
    if (!authUser) return Response.json({ error: "Tizimga kirish kerak." }, { status: 401 });
    const user = await resolveAppUser(service, authUser);
    if (user.active === false) return Response.json({ error: "Xodim akkaunti faol emas." }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");
    const role = userRole(user);
    const shopId = userShopId(user);
    const shopName = userShopName(user);

    // ---------------- list_requests ----------------
    if (action === "list_requests") {
      const canViewAll = VIEW_ALL_ROLES.has(role);
      const allRequests = await service.entities.ShopRequest.list("-created_date", 500);
      let requests = allRequests || [];
      if (!canViewAll) {
        if (!shopId) return Response.json({ error: "Xodimga do'kon biriktirilmagan." }, { status: 400 });
        requests = requests.filter((r: any) => r.shop_id === shopId);
      }
      const allItems = await service.entities.ShopRequestItem.list("-created_date", 1000);
      const itemsByRequest: Record<string, any[]> = {};
      (allItems || []).forEach((it: any) => {
        (itemsByRequest[it.request_id] = itemsByRequest[it.request_id] || []).push(it);
      });
      requests = requests.map((r: any) => ({
        ...r,
        items: itemsByRequest[r.id] || [],
        ...computeTotals(itemsByRequest[r.id] || []),
      }));
      const fDate = body?.date ? String(body.date) : "";
      const fShop = body?.shop_id ? String(body.shop_id) : "";
      const fProduct = body?.product_id ? String(body.product_id) : "";
      const fStatus = body?.status && VALID_STATUS(String(body.status)) ? String(body.status) : "";
      if (fDate) requests = requests.filter((r: any) => r.required_date === fDate);
      if (fShop) requests = requests.filter((r: any) => r.shop_id === fShop);
      if (fStatus) requests = requests.filter((r: any) => r.status === fStatus);
      if (fProduct) {
        requests = requests.filter((r: any) => (r.items || []).some((it: any) => it.product_id === fProduct));
      }
      requests = sortRequests(requests, tashkentParts());
      return Response.json({
        requests,
        items: allItems || [],
        viewer: { role, shop_id: shopId || null, shop_name: shopName || null, can_view_all: canViewAll },
      });
    }

    // ---------------- create_request ----------------
    if (action === "create_request") {
      if (!CREATE_ROLES.has(role)) {
        return Response.json({ error: "Talab yuborish huquqi yo'q." }, { status: 403 });
      }
      if (!shopId) return Response.json({ error: "Xodimga do'kon biriktirilmagan." }, { status: 400 });
      const idempotencyKey = String(body?.idempotency_key || "").trim();
      if (!idempotencyKey) return Response.json({ error: "Idempotency kaliti kerak." }, { status: 400 });
      const existing = await service.entities.ShopRequest.filter({ idempotency_key: idempotencyKey }, "-created_date", 5);
      const prior = findExistingByKey(existing || [], idempotencyKey);
      if (prior) {
        const items = await service.entities.ShopRequestItem.filter({ request_id: prior.id }, "created_date", 100);
        return Response.json({ request: prior, items: items || [], duplicate: true });
      }

      const requiredDate = String(body?.required_date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredDate)) {
        return Response.json({ error: "Talab sanasi noto'g'ri (YYYY-MM-DD)." }, { status: 400 });
      }
      const notes = String(body?.notes || "").trim().slice(0, 2000);
      const products = await service.entities.Product.list("name", 500);
      const productsById: Record<string, any> = {};
      (products || []).forEach((p: any) => { productsById[p.id] = p; });
      const { items, error } = normalizeRequestItems(body?.items, productsById);
      if (error) return Response.json({ error }, { status: 400 });

      const shop = await service.entities.Shop.get(shopId).catch(() => null);
      if (!shop || shop.active === false || shop.location_type !== "shop") {
        return Response.json({ error: "Biriktirilgan do'kon topilmadi yoki faol emas." }, { status: 400 });
      }

      const now = new Date().toISOString();
      const requestNumber = `DT-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const totals = computeTotals(items);
      const created = await service.entities.ShopRequest.create({
        request_number: requestNumber,
        shop_id: shop.id,
        shop_name_snapshot: shop.name,
        required_date: requiredDate,
        notes,
        status: "yangi",
        transfer_batch_ids: [],
        send_log: [],
        total_requested: totals.total_requested,
        total_sent: 0,
        total_remaining: totals.total_requested,
        creator_id: user.id,
        creator_name: userLabel(user),
        idempotency_key: idempotencyKey,
        created_at: now,
      });
      const itemRows = await service.entities.ShopRequestItem.bulkCreate(
        items.map((it: any) => ({
          request_id: created.id,
          request_number: requestNumber,
          shop_id: shop.id,
          product_id: it.product_id,
          product_name_snapshot: it.product_name_snapshot,
          category_name_snapshot: it.category_name_snapshot,
          unit: it.unit,
          pieces_per_sheet_snapshot: it.pieces_per_sheet_snapshot,
          requested_quantity: it.requested_quantity,
          sent_quantity: 0,
          received_quantity: 0,
          created_at: now,
        })),
      );
      try {
        await service.entities.ActionHistory.create({
          user_id: user.id,
          user_name: userLabel(user),
          action: "shop_request_created",
          details: `${shop.name} · ${requestNumber} · ${items.length} tur.`,
        });
      } catch {}
      // Creating a request must not touch warehouse stock — no ProductStock / StockMovement calls here.
      return Response.json({ request: created, items: itemRows || [] });
    }

    // ---------------- update_request (edit while new, or cancel) ----------------
    if (action === "update_request") {
      const requestId = String(body?.request_id || "");
      if (!requestId) return Response.json({ error: "Talab tanlanmagan." }, { status: 400 });
      const request = await service.entities.ShopRequest.get(requestId).catch(() => null);
      if (!request) return Response.json({ error: "Talab topilmadi." }, { status: 404 });
      if (request.status !== "yangi") {
        return Response.json({ error: "Faqat yangi (qabul qilinmagan) talabni o'zgartirish mumkin." }, { status: 409 });
      }
      if (role !== "admin" && request.shop_id !== shopId) {
        return Response.json({ error: "Faqat o'z do'koningiz talabini o'zgartira olasiz." }, { status: 403 });
      }

      if (body?.cancel) {
        const updated = await service.entities.ShopRequest.update(requestId, { status: "bekor_qilindi" });
        try {
          await service.entities.ActionHistory.create({
            user_id: user.id, user_name: userLabel(user), action: "shop_request_cancelled",
            details: `${request.shop_name_snapshot} · ${request.request_number}.`,
          });
        } catch {}
        return Response.json({ request: updated });
      }

      const requiredDate = String(body?.required_date || request.required_date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredDate)) {
        return Response.json({ error: "Talab sanasi noto'g'ri (YYYY-MM-DD)." }, { status: 400 });
      }
      const notes = String(body?.notes ?? request.notes ?? "").trim().slice(0, 2000);
      let newItems = null;
      if (Array.isArray(body?.items)) {
        const products = await service.entities.Product.list("name", 500);
        const productsById: Record<string, any> = {};
        (products || []).forEach((p: any) => { productsById[p.id] = p; });
        const norm = normalizeRequestItems(body.items, productsById);
        if (norm.error) return Response.json({ error: norm.error }, { status: 400 });
        newItems = norm.items;
      }
      const now = new Date().toISOString();
      if (newItems) {
        await service.entities.ShopRequestItem.deleteMany({ request_id: requestId });
        await service.entities.ShopRequestItem.bulkCreate(
          newItems.map((it: any) => ({
            request_id: requestId,
            request_number: request.request_number,
            shop_id: request.shop_id,
            product_id: it.product_id,
            product_name_snapshot: it.product_name_snapshot,
            category_name_snapshot: it.category_name_snapshot,
            unit: it.unit,
            pieces_per_sheet_snapshot: it.pieces_per_sheet_snapshot,
            requested_quantity: it.requested_quantity,
            sent_quantity: 0,
            received_quantity: 0,
            created_at: now,
          })),
        );
        const totals = computeTotals(newItems);
        const updated = await service.entities.ShopRequest.update(requestId, {
          required_date: requiredDate, notes, total_requested: totals.total_requested, total_remaining: totals.total_requested,
        });
        return Response.json({ request: updated, items: newItems });
      }
      const updated = await service.entities.ShopRequest.update(requestId, { required_date: requiredDate, notes });
      return Response.json({ request: updated });
    }

    // ---------------- accept_request ----------------
    if (action === "accept_request") {
      if (!ACCEPT_ROLES.has(role)) return Response.json({ error: "Qabul qilish huquqi yo'q." }, { status: 403 });
      const requestId = String(body?.request_id || "");
      const request = await service.entities.ShopRequest.get(requestId).catch(() => null);
      if (!request) return Response.json({ error: "Talab topilmadi." }, { status: 404 });
      if (request.status !== "yangi") return Response.json({ error: "Faqat yangi talabni qabul qilish mumkin." }, { status: 409 });
      const now = new Date().toISOString();
      const updated = await service.entities.ShopRequest.update(requestId, {
        status: "qabul_qilindi",
        accepted_at: now, accepted_by_id: user.id, accepted_by_name: userLabel(user),
      });
      try {
        await service.entities.ActionHistory.create({
          user_id: user.id, user_name: userLabel(user), action: "shop_request_accepted",
          details: `${request.shop_name_snapshot} · ${request.request_number}.`,
        });
      } catch {}
      // Accepting does not change stock — no ProductStock / StockMovement calls here.
      return Response.json({ request: updated });
    }

    // ---------------- set_progress ----------------
    if (action === "set_progress") {
      if (!PROGRESS_ROLES.has(role)) return Response.json({ error: "Holatni o'zgartirish huquqi yo'q." }, { status: 403 });
      const requestId = String(body?.request_id || "");
      const status = String(body?.status || "");
      if (!["tayyorlanmoqda", "tayyor"].includes(status)) {
        return Response.json({ error: "Noto'g'ri holat." }, { status: 400 });
      }
      const request = await service.entities.ShopRequest.get(requestId).catch(() => null);
      if (!request) return Response.json({ error: "Talab topilmadi." }, { status: 404 });
      if (!["qabul_qilindi", "tayyorlanmoqda"].includes(request.status)) {
        return Response.json({ error: "Holatni o'zgartirib bo'lmaydi." }, { status: 409 });
      }
      const updated = await service.entities.ShopRequest.update(requestId, { status });
      try {
        await service.entities.ActionHistory.create({
          user_id: user.id, user_name: userLabel(user), action: "shop_request_progress",
          details: `${request.shop_name_snapshot} · ${request.request_number} → ${status}.`,
        });
      } catch {}
      return Response.json({ request: updated });
    }

    // ---------------- send_request (admin: reuse existing stock-transfer flow) ----------------
    if (action === "send_request") {
      if (!SEND_ROLES.has(role)) return Response.json({ error: "Yuborish huquqi yo'q." }, { status: 403 });
      const requestId = String(body?.request_id || "");
      const sendKey = String(body?.send_idempotency_key || "").trim();
      if (!sendKey) return Response.json({ error: "Yuborish kaliti kerak." }, { status: 400 });
      const request = await service.entities.ShopRequest.get(requestId).catch(() => null);
      if (!request) return Response.json({ error: "Talab topilmadi." }, { status: 404 });
      if (!["qabul_qilindi", "tayyorlanmoqda", "tayyor"].includes(request.status)) {
        return Response.json({ error: "Talabni hali yuborib bo'lmaydi." }, { status: 409 });
      }
      if (hasSendKey(request, sendKey)) {
        return Response.json({ request, duplicate: true });
      }
      const items = await service.entities.ShopRequestItem.filter({ request_id: requestId }, "created_date", 200);
      const itemById: Record<string, any> = {};
      (items || []).forEach((it: any) => { itemById[it.id] = it; });
      const rawSend = Array.isArray(body?.items) ? body.items : [];
      const sendLines: any[] = [];
      for (const row of rawSend) {
        const itemId = String(row?.request_item_id || row?.item_id || "");
        const it = itemById[itemId];
        if (!it) return Response.json({ error: "Talab qatori topilmadi." }, { status: 400 });
        const q = Number(row?.quantity);
        const rem = remainingForItem(it);
        if (!Number.isInteger(q) || q <= 0) return Response.json({ error: "Miqdor noto'g'ri." }, { status: 400 });
        if (q > rem) return Response.json({ error: `${it.product_name_snapshot}: qoldi ${rem}, yuborilmoqda ${q}.` }, { status: 409 });
        sendLines.push({ item: it, quantity: q });
      }
      if (sendLines.length === 0) return Response.json({ error: "Yuborish uchun mahsulot tanlang." }, { status: 400 });

      const shops = await service.entities.Shop.list("name", 100);
      const productionShop =
        (shops || []).find((s: any) => s.active !== false && s.location_type === "production")
        || (shops || []).find((s: any) => s.active !== false)
        || null;
      if (!productionShop) return Response.json({ error: "Markaziy ishlab chiqarish ombori topilmadi." }, { status: 400 });
      if (productionShop.id === request.shop_id) {
        return Response.json({ error: "Manzil markaziy ombor bilan bir xil." }, { status: 400 });
      }

      // Claim the send key atomically — prevents duplicate sends from repeated clicks / retries.
      const claim = await service.entities.ShopRequest.updateMany(
        { id: requestId, send_log: { $ne: sendKey } },
        { $push: { send_log: sendKey } },
      );
      if (!claim?.success || Number(claim.updated || 0) !== 1) {
        return Response.json({ request, duplicate: true });
      }

      let batchId = "";
      try {
        const transferRes = await base44.functions.invoke("stock-transfer", {
          action: "create_transfer",
          source_location_id: productionShop.id,
          destination_location_id: request.shop_id,
          items: sendLines.map((s) => ({ product_id: s.item.product_id, quantity: s.quantity })),
          notes: `Do'kon talabi ${request.request_number}`,
        });
        const tp = transferRes?.data || transferRes;
        if (!tp?.transfers?.length) throw new Error(tp?.error || "Transfer yaratib bo'lmadi.");
        batchId = String(tp.batch_id || tp.transfers[0].batch_id || "");
        if (!batchId) throw new Error("Transfer batch topilmadi.");
      } catch (error) {
        try {
          await service.entities.ShopRequest.updateMany({ id: requestId }, { $pull: { send_log: sendKey } });
        } catch {}
        return Response.json({ error: error instanceof Error ? error.message : "Transfer yaratib bo'lmadi." }, { status: 500 });
      }

      const now = new Date().toISOString();
      for (const s of sendLines) {
        await service.entities.ShopRequestItem.update(s.item.id, { $inc: { sent_quantity: s.quantity } });
      }
      const freshItems = await service.entities.ShopRequestItem.filter({ request_id: requestId }, "created_date", 200);
      const totals = computeTotals(freshItems || []);
      const allSent = (freshItems || []).every((it: any) => remainingForItem(it) === 0);
      const updated = await service.entities.ShopRequest.update(requestId, {
        $push: { transfer_batch_ids: batchId },
        $set: {
          status: "yuborildi",
          sent_at: now,
          total_sent: totals.total_sent,
          total_remaining: totals.total_remaining,
        },
      });
      try {
        await service.entities.ActionHistory.create({
          user_id: user.id, user_name: userLabel(user), action: "shop_request_sent",
          details: `${request.shop_name_snapshot} · ${request.request_number} · ${sendLines.length} tur, batch ${batchId}.${allSent ? " To'liq yuborildi." : ""}`,
        });
      } catch {}
      // Stock was decreased by the existing stock-transfer flow — not duplicated here.
      return Response.json({ request: updated, batch_id: batchId });
    }

    // ---------------- sync_receipt / reconcile (recompute received after a transfer is received) ----------------
    if (action === "sync_receipt" || action === "reconcile" || action === "reconcile_all") {
      let targets: any[] = [];
      if (action === "sync_receipt" || action === "reconcile") {
        const batchId = String(body?.batch_id || "");
        const requestId = String(body?.request_id || "");
        if (batchId) {
          const all = await service.entities.ShopRequest.list("-created_date", 500);
          targets = (all || []).filter((r: any) => Array.isArray(r.transfer_batch_ids) && r.transfer_batch_ids.includes(batchId));
        } else if (requestId) {
          const r = await service.entities.ShopRequest.get(requestId).catch(() => null);
          if (r) targets = [r];
        }
      } else {
        const all = await service.entities.ShopRequest.list("-created_date", 500);
        targets = (all || []).filter((r: any) => Array.isArray(r.transfer_batch_ids) && r.transfer_batch_ids.length > 0);
      }
      let updatedCount = 0;
      for (const request of targets) {
        const items = await service.entities.ShopRequestItem.filter({ request_id: request.id }, "created_date", 200);
        if (!items || items.length === 0) continue;
        const transfers: any[] = [];
        for (const bid of request.transfer_batch_ids || []) {
          const rows = await service.entities.StockTransfer.filter({ batch_id: bid }, "line_number", 50);
          (rows || []).forEach((t: any) => transfers.push(t));
        }
        let changed = false;
        for (const it of items) {
          const received = receivedPiecesFromTransfers(it, transfers);
          if (cleanNumber(received) !== cleanNumber(it.received_quantity)) {
            await service.entities.ShopRequestItem.update(it.id, { received_quantity: received });
            it.received_quantity = received;
            changed = true;
          }
        }
        const fully = isFullyReceived(items, transfers);
        if (fully && request.status !== "qabul_qilingan") {
          const now = new Date().toISOString();
          await service.entities.ShopRequest.update(request.id, { status: "qabul_qilingan", received_at: now });
          request.status = "qabul_qilingan";
          changed = true;
          try {
            await service.entities.ActionHistory.create({
              user_id: user.id, user_name: userLabel(user), action: "shop_request_received",
              details: `${request.shop_name_snapshot} · ${request.request_number}.`,
            });
          } catch {}
        }
        if (changed) updatedCount += 1;
      }
      return Response.json({ updated: updatedCount });
    }

    return Response.json({ error: "Noma'lum talab amali." }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Talab amalini bajarib bo'lmadi." },
      { status: 500 },
    );
  }
}