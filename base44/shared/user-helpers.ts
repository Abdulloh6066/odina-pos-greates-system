// Shared user/role helpers used across warehouse backend functions.
// Keep here to avoid duplicating logic between stock-transfer, stock-count, etc.

export const APP_ROLES = new Set(["admin", "manager", "cashier", "accountant", "production", "warehouse"]);

export const userLabel = (user: any) => user?.full_name || user?.email || "Noma’lum xodim";

export const userRole = (user: any) => {
  const rootRole = String(user?.role || "");
  const nestedRole = String(user?.data?.role || "");
  if (APP_ROLES.has(rootRole)) return rootRole;
  if (APP_ROLES.has(nestedRole)) return nestedRole;
  return rootRole || nestedRole;
};

export const userShopId = (user: any) => String(user?.shop_id || user?.data?.shop_id || "");

export const userShopName = (user: any) => String(user?.shop_name || user?.data?.shop_name || "");

// Resolve the stored app User record from the authenticated identity. Auth and
// entity IDs may differ, so fall back to an exact normalized email match.
export const resolveStoredAppUser = async (service: any, authenticatedUser: any) => {
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
  return storedUser;
};

// Resolve the full app user (with role + shop_id) from the authenticated token by
// reading the stored User record. Used by backend functions that need the user's
// assigned shop and reliable role. `service` is base44.asServiceRole.
export const resolveAppUser = async (service: any, authenticatedUser: any) => {
  const storedUser = await resolveStoredAppUser(service, authenticatedUser);

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