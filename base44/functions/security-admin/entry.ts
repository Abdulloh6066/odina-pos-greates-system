import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole, userShopId } from "../../shared/user-helpers.ts";

const STAFF_ROLES = new Set(["manager", "cashier", "accountant", "production", "warehouse"]);

// Hisob egasi — boshqa adminlar tomonidan o'chirilishi yoki o'zgartirilishi mumkin emas.
const isOwner = (user: any) => user?.is_owner === true || user?.data?.is_owner === true;

const safeUser = (user: any) => ({
  id: String(user?.id || ""),
  full_name: String(user?.full_name || ""),
  email: String(user?.email || ""),
  is_owner: isOwner(user),
  role: userRole(user),
  shop_id: userShopId(user),
  shop_name: String(user?.shop_name || user?.data?.shop_name || ""),
  active: user?.active !== false && user?.data?.active !== false,
});

const safeAudit = (entry: any) => ({
  id: String(entry?.id || ""),
  user_id: String(entry?.user_id || ""),
  user_name: String(entry?.user_name || ""),
  action: String(entry?.action || ""),
  details: String(entry?.details || ""),
  created_date: entry?.created_date || entry?.created_at || "",
});

Deno.serve(async (req) => {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth?.id) {
      return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    }

    const service = client.asServiceRole;
    const admin = await resolveStoredAppUser(service, auth);
    if (!admin || userRole(admin) !== "admin" || admin.active === false || admin.data?.active === false) {
      return Response.json({ error: "Faqat Egasi/Admin uchun." }, { status: 403 });
    }

    // The existing protected owner identity is checked against both the
    // authenticated session and stored profile; a regular admin cannot claim it.
    const canManageAdmins = String(auth.id) === String(admin.id) && isOwner(admin);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    if (action === "status") {
      const [users, securityRows, auditRows] = await Promise.all([
        service.entities.User.list("-created_date", 500),
        service.entities.SecuritySettings.filter({ key: "owner_approval_pin" }, "-updated_date", 2),
        service.entities.ActionHistory.list("-created_date", 30),
      ]);
      return Response.json({
        pin_set: Boolean(securityRows?.[0]?.pin_hash && securityRows?.[0]?.pin_salt),
        can_manage_admins: canManageAdmins,
        users: (users || []).map(safeUser),
        audit: (auditRows || []).map(safeAudit),
      });
    }

    if (action !== "update_user_access") {
      return Response.json({ error: "Noma’lum xavfsizlik amali." }, { status: 400 });
    }

    const targetId = String(body?.target_user_id || "");
    if (!targetId) {
      return Response.json({ error: "Xodim tanlanmagan." }, { status: 400 });
    }
    if (targetId === String(admin.id || "")) {
      return Response.json({ error: "O‘z Egasi/Admin hisobingizni bu yerdan o‘zgartira olmaysiz." }, { status: 400 });
    }

    const target = await service.entities.User.get(targetId).catch(() => null);
    if (!target) {
      return Response.json({ error: "Xodim topilmadi." }, { status: 404 });
    }
    if (isOwner(target)) {
      return Response.json({ error: "Hisob egasi himoyalangan — uni o‘zgartirish yoki o‘chirish mumkin emas." }, { status: 403 });
    }
    // Owner alone may promote, demote, disable or re-enable another admin.
    // Other admins retain their existing staff-management privileges.
    if (userRole(target) === "admin" && !canManageAdmins) {
      return Response.json({ error: "Boshqa Admin hisobini faqat hisob egasi boshqaradi." }, { status: 403 });
    }

    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    const hasRole = Object.prototype.hasOwnProperty.call(body, "role");
    const hasShop = Object.prototype.hasOwnProperty.call(body, "shop_id");
    const hasActive = Object.prototype.hasOwnProperty.call(body, "active");
    const nextRole = hasRole ? String(body.role || "") : userRole(target);

    if (nextRole === "admin" && !canManageAdmins) {
      return Response.json({ error: "Admin huquqini faqat hisob egasi berishi mumkin." }, { status: 403 });
    }
    if (nextRole !== "admin" && !STAFF_ROLES.has(nextRole)) {
      return Response.json({ error: "Xodim lavozimi noto‘g‘ri." }, { status: 400 });
    }
    if (hasRole) {
      patch.role = nextRole;
      changes.push("lavozim: " + nextRole);
    }

    if (hasActive) {
      if (typeof body.active !== "boolean") {
        return Response.json({ error: "Faollik holati noto‘g‘ri." }, { status: 400 });
      }
      patch.active = body.active;
      changes.push(body.active ? "kirish yoqildi" : "kirish o‘chirildi");
    }

    if (nextRole === "admin") {
      if (hasShop && body.shop_id) {
        return Response.json({ error: "Admin uchun do‘kon biriktirilmaydi." }, { status: 400 });
      }
      if (hasRole) {
        patch.shop_id = "";
        patch.shop_name = "";
      }
    } else if (hasRole || hasShop) {
      // A former admin must receive a real location before losing admin rights.
      const requestedShopId = hasShop ? String(body.shop_id || "") : userShopId(target);
      if (!requestedShopId) {
        return Response.json({ error: "Xodim uchun ish joyini tanlang." }, { status: 400 });
      }
      const shop = await service.entities.Shop.get(requestedShopId).catch(() => null);
      if (!shop || shop.active === false) {
        return Response.json({ error: "Tanlangan ish joyi topilmadi yoki faol emas." }, { status: 400 });
      }
      patch.shop_id = String(shop.id);
      patch.shop_name = String(shop.name || "");
      if (hasShop) changes.push("ish joyi: " + String(shop.name || ""));
    }

    if (!Object.keys(patch).length) {
      return Response.json({ error: "O‘zgartirish topilmadi." }, { status: 400 });
    }

    const updated = await service.entities.User.update(target.id, patch);

    // When an admin disables a user, also cancel any pending invite for the
    // same email. Otherwise the pre-login staff-email-check would still see a
    // pending invite and let a deactivated account straight back in.
    if (hasActive && body.active === false) {
      const targetEmail = String(target.email || "").trim().toLowerCase();
      if (targetEmail) {
        const invites = await service.entities.PendingStaffInvite.filter(
          { email: targetEmail, status: "pending" },
          "-created_date",
          20,
        ).catch(() => []);
        for (const inv of invites || []) {
          await service.entities.PendingStaffInvite.update(inv.id, {
            status: "cancelled",
            error_message: "Hisob o‘chirilgan (admin).",
          }).catch(() => {});
        }
      }
    }

    const adminName = String(admin.full_name || auth.full_name || auth.email || "Egasi");
    await service.entities.ActionHistory.create({
      user_id: String(admin.id || auth.id),
      user_name: adminName,
      action: "user_access_updated",
      details: String(target.full_name || target.email || target.id) + " · " + changes.join(" · "),
    });

    return Response.json({ ok: true, user: safeUser(updated) });
  } catch {
    return Response.json({ error: "Xavfsizlik amalini bajarib bo‘lmadi." }, { status: 500 });
  }
});