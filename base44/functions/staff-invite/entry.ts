import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveStoredAppUser, userRole } from "../../shared/user-helpers.ts";

const STAFF_ROLES = ["manager", "cashier", "accountant", "production", "warehouse"];
// Match the protected owner already used by security-admin and User RLS.
const OWNER_EMAIL = "dota26066@gmail.com";
const isOwner = (email: unknown) => String(email || "").trim().toLowerCase() === OWNER_EMAIL;

const errorMessage = (error: unknown) => {
  if (error && typeof error === "object") {
    const value = error as {
      message?: string;
      response?: { data?: { error?: string; message?: string } };
    };
    return value.response?.data?.error || value.response?.data?.message || value.message || "Noma’lum xato.";
  }
  return String(error || "Noma’lum xato.");
};

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    const currentUser = await base44.auth.me();
    if (!currentUser) {
      return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    if (action === "claim") {
      const email = String(currentUser.email || "").trim().toLowerCase();
      if (!email) return Response.json({ applied: false });

      const matches = await base44.asServiceRole.entities.PendingStaffInvite.filter(
        { email, status: "pending" },
        "-created_date",
        10,
      );
      const invite = matches?.[0];
      if (!invite) return Response.json({ applied: false });

      const desiredRole = String(invite.desired_role || "");
      if (desiredRole === "admin") {
        // An admin invite may only have originated from the protected owner.
        // Never trust the desired_role or invited_by_id in an unverified record.
        const inviter = invite.invited_by_id
          ? await base44.asServiceRole.entities.User.get(invite.invited_by_id).catch(() => null)
          : null;
        if (!inviter || !isOwner(inviter.email) || userRole(inviter) !== "admin"
            || inviter.active === false || inviter.data?.active === false) {
          return Response.json({ error: "Admin taklifini faqat hisob egasi tasdiqlaydi." }, { status: 403 });
        }
      } else if (!STAFF_ROLES.includes(desiredRole)) {
        await base44.asServiceRole.entities.PendingStaffInvite.update(invite.id, {
          status: "failed",
          error_message: "Noto‘g‘ri lavozim saqlangan.",
        });
        return Response.json({ error: "Xodim lavozimi noto‘g‘ri saqlangan." }, { status: 400 });
      }

      const userPatch: Record<string, unknown> = {
        role: desiredRole,
        active: true,
      };

      if (desiredRole === "admin") {
        userPatch.shop_id = "";
        userPatch.shop_name = "";
      } else {
        const shopId = String(invite.shop_id || "");
        if (!shopId) {
          return Response.json({ error: "Xodim uchun do‘kon tanlanmagan." }, { status: 400 });
        }
        const shop = await base44.asServiceRole.entities.Shop.get(shopId);
        if (!shop || shop.active === false) {
          return Response.json({ error: "Biriktirilgan do‘kon topilmadi yoki faol emas." }, { status: 400 });
        }
        userPatch.shop_id = shop.id;
        userPatch.shop_name = shop.name;
      }

      const updatedUser = await base44.asServiceRole.entities.User.update(currentUser.id, userPatch);
      const appliedAt = new Date().toISOString();
      await base44.asServiceRole.entities.PendingStaffInvite.update(invite.id, {
        status: "applied",
        applied_user_id: currentUser.id,
        applied_at: appliedAt,
        error_message: "",
      });

      for (const older of matches.slice(1)) {
        await base44.asServiceRole.entities.PendingStaffInvite.update(older.id, {
          status: "cancelled",
          applied_user_id: currentUser.id,
          applied_at: appliedAt,
        }).catch(() => {});
      }

      await base44.asServiceRole.entities.ActionHistory.create({
        user_id: currentUser.id,
        user_name: currentUser.full_name || currentUser.email,
        action: "staff_invite_applied",
        details: `${currentUser.email}: ${desiredRole}${updatedUser.shop_name ? ` · ${updatedUser.shop_name}` : ""}`,
      }).catch(() => {});

      return Response.json({ applied: true, user: updatedUser });
    }

    if (action === "invite") {
      const admin = await resolveStoredAppUser(base44.asServiceRole, currentUser);
      if (!admin || userRole(admin) !== "admin" || admin.active === false || admin.data?.active === false) {
        return Response.json({ error: "Faqat faol Egasi/Admin xodim taklif qila oladi." }, { status: 403 });
      }

      const email = String(body?.email || "").trim().toLowerCase();
      const desiredRole = String(body?.role || "");
      const shopId = String(body?.shop_id || "");

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return Response.json({ error: "To‘g‘ri email manzilini kiriting." }, { status: 400 });
      }
      const owner = isOwner(currentUser.email) && isOwner(admin.email);
      if (desiredRole === "admin" && !owner) {
        return Response.json({ error: "Admin taklifini faqat hisob egasi yubora oladi." }, { status: 403 });
      }
      if (desiredRole !== "admin" && !STAFF_ROLES.includes(desiredRole)) {
        return Response.json({ error: "Lavozimni tanlang." }, { status: 400 });
      }
      if (isOwner(email)) {
        return Response.json({ error: "Himoyalangan egasi hisobiga xodim taklifi yuborilmaydi." }, { status: 403 });
      }

      let shopName = "";
      if (desiredRole !== "admin") {
        if (!shopId) {
          return Response.json({ error: "Xodim ishlaydigan joyni tanlang." }, { status: 400 });
        }
        const shop = await base44.asServiceRole.entities.Shop.get(shopId);
        if (!shop || shop.active === false) {
          return Response.json({ error: "Tanlangan joy topilmadi yoki faol emas." }, { status: 400 });
        }
        shopName = shop.name;
      }

      const now = new Date().toISOString();
      const previous = await base44.asServiceRole.entities.PendingStaffInvite.filter(
        { email, status: "pending" },
        "-created_date",
        1,
      );

      const inviteData = {
        email,
        desired_role: desiredRole,
        shop_id: desiredRole === "admin" ? "" : shopId,
        shop_name: desiredRole === "admin" ? "" : shopName,
        status: "pending",
        invited_by_id: admin.id,
        invited_by_name: admin.full_name || currentUser.full_name || currentUser.email,
        invited_at: now,
        error_message: "",
      };

      const pending = previous?.[0]
        ? await base44.asServiceRole.entities.PendingStaffInvite.update(previous[0].id, inviteData)
        : await base44.asServiceRole.entities.PendingStaffInvite.create(inviteData);

      try {
        await base44.users.inviteUser(email, "user");
      } catch (error) {
        const message = errorMessage(error);
        await base44.asServiceRole.entities.PendingStaffInvite.update(pending.id, {
          status: "failed",
          error_message: message,
        }).catch(() => {});
        return Response.json({ error: `Taklif yuborilmadi: ${message}` }, { status: 400 });
      }

      await base44.asServiceRole.entities.ActionHistory.create({
        user_id: admin.id,
        user_name: admin.full_name || currentUser.full_name || currentUser.email,
        action: "user_invited",
        details: `${email}: ${desiredRole}${shopName ? ` · ${shopName}` : ""}`,
      }).catch(() => {});

      return Response.json({
        invited: true,
        email,
        role: desiredRole,
        shop_name: shopName,
      });
    }

    return Response.json({ error: "Noto‘g‘ri amal." }, { status: 400 });
  } catch (error) {
    return Response.json(
      { error: errorMessage(error) || "Xodim taklifi bajarilmadi." },
      { status: 500 },
    );
  }
});
