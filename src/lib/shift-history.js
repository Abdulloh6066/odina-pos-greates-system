import { uzbekistanDateKey } from "./uzbekistan-time.js";

const normalized = (value) => String(value || "").trim().toLocaleLowerCase("uz-UZ");

export function shiftHistoryDateKey(shift) {
  return uzbekistanDateKey(shift?.opened_at || shift?.created_date || shift?.closed_at);
}

export function shiftHistoryStatusGroup(shift) {
  return shift?.status === "closed" ? "closed" : "open";
}

export function filterShiftHistory(shifts, filters = {}) {
  const query = normalized(filters.query);
  const date = String(filters.date || "").trim();
  const shopId = String(filters.shop_id || "all");
  const status = String(filters.status || "all");

  return (shifts || []).filter((shift) => {
    if (date && shiftHistoryDateKey(shift) !== date) return false;
    if (shopId !== "all" && String(shift?.shop_id || "") !== shopId) return false;
    if (status !== "all" && shiftHistoryStatusGroup(shift) !== status) return false;
    if (!query) return true;

    return [
      shift?.user_name,
      shift?.shop_name,
    ].some((value) => normalized(value).includes(query));
  });
}

export function listShiftHistoryShops(shifts) {
  const shops = new Map();

  for (const shift of shifts || []) {
    const id = String(shift?.shop_id || "").trim();
    if (!id || shops.has(id)) continue;
    shops.set(id, {
      id,
      name: String(shift?.shop_name || "Noma’lum do‘kon"),
    });
  }

  return Array.from(shops.values()).sort((left, right) => left.name.localeCompare(right.name, "uz"));
}
