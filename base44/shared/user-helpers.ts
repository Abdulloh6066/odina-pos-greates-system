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