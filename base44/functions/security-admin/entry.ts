import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole, userShopId } from "../../shared/user-helpers.ts";

const STAFF_ROLES = new Set(["manager", "cashier", "accountant", "production", "warehouse"]);
// A shop manager may manage only these roles, and only inside his own shop.
const MANAGER_MANAGEABLE_ROLES = new Set(["cashier", "warehouse"]);

// Hisob egasi — boshqa adminlar tomonidan o'chirilishi yoki o'zgartirilishi mumkin emas.
const isOwner = (user: any) => user?.is_owner === true || user?.data?.is_owner === true;

const displayName = (user: any) => String(user?.display_name || user?.data?.display_name || user?.full_name || "");

const safeUser = (user: any) => ({
  id: String(user?.id || ""),
  full_name: displayName(user),
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
    const actorRole = admin ? userRole(admin) : "";
    if (!admin || !["admin", "manager"].includes(actorRole) || admin.active === false || admin.data?.active === false) {
      return Response.json({ error: "Faqat Egasi/Admin yoki do‘kon boshqaruvchisi uchun." }, { status: 403 });
    }
    const isManager = actorRole === "manager";
    const managerShopId = isManager ? userShopId(admin) : "";
    if (isManager) {
      const managerShop = managerShopId ? await service.entities.Shop.get(managerShopId).catch(() => null) : null;
      if (!managerShop || managerShop.active === false || managerShop.location_type === "production") {
        return Response.json({ error: "Boshqaruvchiga faol do‘kon biriktirilmagan." }, { status: 403 });
      }
    }

    // The existing protected owner identity is checked against both the
    // authenticated session and stored profile; a regular admin cannot claim it.
    const canManageAdmins = String(auth.id) === String(admin.id) && isOwner(admin);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    if (action === "status") {
      if (isManager) {
        // The staff view must not read owner PIN material or the global audit feed.
        const users = await service.entities.User.list("-created_date", 500);
        const own = (users || []).map(safeUser).filter((row: any) => row.id === String(admin.id) || (row.shop_id === managerShopId && row.role !== "admin" && !row.is_owner));
        return Response.json({ pin_set: false, can_manage_admins: false, manager_scope: { shop_id: managerShopId, roles: [...MANAGER_MANAGEABLE_ROLES] }, users: own, audit: [] });
      }
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

    if (action !== "update_user_access" && action !== "update_user_name") {
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
    if (isManager) {
      // Never trust browser shop/role values: the target must already be this shop's cashier/warehouse staff,
      // and the result must stay inside this shop with a manageable role.
      const nextRoleForManager = Object.prototype.hasOwnProperty.call(body, "role") ? String(body.role || "") : userRole(target);
      const shopChange = Object.prototype.hasOwnProperty.call(body, "shop_id") && String(body.shop_id || "") !== managerShopId;
      if (userShopId(target) !== managerShopId || !MANAGER_MANAGEABLE_ROLES.has(userRole(target))
        || !MANAGER_MANAGEABLE_ROLES.has(nextRoleForManager) || shopChange) {
        return Response.json({ error: "Boshqaruvchi faqat o‘z do‘konidagi kassir va omborchilarni boshqaradi." }, { status: 403 });
      }
    }

    if (action === "update_user_name") {
      // Display-name editing never changes authentication or access fields.
      const allowedFields = new Set(["action", "target_user_id", "full_name"]);
      if (Object.keys(body).some((key) => !allowedFields.has(key))) {
        return Response.json({ error: "Bu amal orqali faqat xodim ismini o‘zgartirish mumkin." }, { status: 400 });
      }
      if (typeof body.full_name !== "string") {
        return Response.json({ error: "Xodim ismini kiriting." }, { status: 400 });
      }
      const fullName = body.full_name.trim();
      const hasControlCharacter = [...fullName].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      });
      if (!fullName || fullName.length > 120 || hasControlCharacter) {
        return Response.json({ error: "Ism 1–120 belgidan iborat bo‘lsin; yangi qator va boshqaruv belgilari mumkin emas." }, { status: 400 });
      }
      if (fullName === displayName(target)) {
        return Response.json({ ok: true, user: safeUser(target) });
      }
      // full_name belongs to the sign-in account and can be ignored by the
      // platform. Store the app-specific name in its declared custom field.
      await service.entities.User.update(target.id, { display_name: fullName });
      const updated = await service.entities.User.get(target.id);
      if (displayName(updated) !== fullName) {
        return Response.json({ error: "Yangi ism saqlanganligi tasdiqlanmadi. Sahifani yangilab, qayta urinib ko‘ring." }, { status: 502 });
      }
      await service.entities.ActionHistory.create({
        user_id: String(admin.id || auth.id),
        user_name: displayName(admin) || String(auth.full_name || auth.email || "Egasi"),
        action: "user_name_updated",
        details: String(target.id) + " · ism: " + String(displayName(target) || target.email || "Nomsiz xodim") + " → " + fullName,
      });
      return Response.json({ ok: true, user: safeUser(updated) });
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
    } else if (hasRole || hasShop || (nextRole === "manager" && hasActive && body.active === true)) {
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