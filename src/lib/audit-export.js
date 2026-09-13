import { formatUzbekistanDateTime, uzbekistanDateKey } from './uzbekistan-time.js';

export const AUDIT_CATEGORY_OPTIONS = [
  { value: "all", label: "Barcha bo‘limlar" },
  { value: "sale", label: "Savdo va qaytarish" },
  { value: "payment", label: "To‘lov va pul harakati" },
  { value: "shift", label: "Smenalar" },
  { value: "stock", label: "Ombor harakatlari" },
  { value: "action", label: "Amallar jurnali" },
];

export const AUDIT_CATEGORY_STYLES = {
  sale: "bg-[#FECD7C]/25 text-amber-900 border-[#D0B17F]/35",
  payment: "bg-emerald-50 text-emerald-800 border-emerald-200",
  shift: "bg-[#ACA95D]/15 text-[#66642F] border-[#ACA95D]/30",
  stock: "bg-stone-100 text-stone-700 border-stone-200",
  action: "bg-slate-100 text-slate-700 border-slate-200",
};

export const AUDIT_SOURCE_LABELS = {
  Sale: "Savdo",
  Payment: "Savdo to‘lovi",
  OrderPayment: "Buyurtma to‘lovi",
  Refund: "Qaytarish",
  CashMovement: "Kassa chiqimi",
  Shift: "Smena",
  StockMovement: "Ombor",
  ActionHistory: "Amallar jurnali",
};

export const AUDIT_ROLE_LABELS = {
  admin: "Egasi / Admin",
  manager: "Boshqaruvchi",
  cashier: "Kassir",
  accountant: "Hisobchi",
  production: "Ishlab chiqarish",
  warehouse: "Omborchi",
};

const CSV_HEADERS = [
  "Vaqt",
  "Savdo kuni",
  "Bo‘lim",
  "Amal",
  "Manba",
  "Xodim",
  "Do‘kon",
  "Hujjat",
  "Tafsilot",
  "Summa (UZS)",
  "Miqdor",
  "Birlik",
  "Holat",
];

export function tashkentDateKey(value = Date.now()) {
  return uzbekistanDateKey(value);
}

export function defaultAuditFilters(value = Date.now()) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  const end = Number.isFinite(parsed) ? parsed : Date.now();
  const start = end - 6 * 24 * 60 * 60 * 1000;
  return {
    date_from: tashkentDateKey(start),
    date_to: tashkentDateKey(end),
    category: "all",
    user_id: "all",
    shop_id: "all",
    query: "",
  };
}

export function auditRequestFilters(filters) {
  return {
    date_from: filters.date_from || "",
    date_to: filters.date_to || "",
    category: filters.category === "all" ? "" : filters.category || "",
    user_id: filters.user_id === "all" ? "" : filters.user_id || "",
    shop_id: filters.shop_id === "all" ? "" : filters.shop_id || "",
    query: String(filters.query || "").trim(),
  };
}

export function formatAuditDateTime(value) {
  return formatUzbekistanDateTime(value, { second: "2-digit" });
}

export function auditSourceLabel(source) {
  return AUDIT_SOURCE_LABELS[source] || source || "Tizim";
}

export function auditStatusLabel(status) {
  const labels = {
    completed: "Yakunlangan",
    refunded: "Qaytarilgan",
    open: "Ochiq",
    closing: "Yopilmoqda",
    closed: "Yopilgan",
  };
  return labels[status] || status || "";
}

export function csvCell(value) {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  let text = String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/^[=+\-@\t]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function auditRowsToCsv(rows) {
  const lines = [CSV_HEADERS.map(csvCell).join(";")];
  for (const row of rows || []) {
    const values = [
      formatAuditDateTime(row.event_time),
      row.business_date,
      row.category_label,
      row.action_label,
      auditSourceLabel(row.source),
      row.user_name,
      row.shop_name,
      row.reference,
      row.details,
      row.amount,
      row.quantity,
      row.unit,
      auditStatusLabel(row.status),
    ];
    lines.push(values.map(csvCell).join(";"));
  }
  return "\uFEFF" + lines.join("\r\n");
}

export function downloadAuditCsv(rows, dateFrom, dateTo) {
  const csv = auditRowsToCsv(rows);
  const suffix = dateFrom && dateTo
    ? dateFrom + "_" + dateTo
    : tashkentDateKey();
  const filename = "odina-nazorat-" + suffix + ".csv";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
