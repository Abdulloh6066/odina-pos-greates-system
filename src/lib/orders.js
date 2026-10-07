// Keep historical technical numbers intact; display the permanent sequence.
export const displayOrderNumber = (order) => Number.isSafeInteger(order?.order_sequence) && order.order_sequence > 0
  ? String(order.order_sequence) : (order?.order_number || '—');

export const ORDER_STATUSES = [
  { key: "qabul_qilindi", label: "Qabul qilindi", tone: "bg-blue-100 text-blue-700 border-blue-200" },
  { key: "tayyorlanmoqda", label: "Tayyorlanmoqda", tone: "bg-amber-100 text-amber-700 border-amber-200" },
  { key: "tayyor", label: "Tayyor", tone: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  { key: "yuborildi_olib_ketildi", label: "Yuborildi / olib ketildi", tone: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  { key: "yakunlandi", label: "Yakunlandi", tone: "bg-brand-olive/20 text-brand-ink border-brand-olive/30" },
  { key: "bekor_qilindi", label: "Bekor qilindi", tone: "bg-rose-100 text-rose-700 border-rose-200" },
];

export const ORDER_TYPES = [
  { key: "toy_va_bazmlar", label: "Toy va bazmlar" },
  { key: "tugilgan_kun_va_boshqa", label: "Tug‘ilgan kun va boshqa" },
];

export const PAYMENT_STATUSES = [
  { key: "unpaid", label: "To‘lanmagan", tone: "bg-rose-100 text-rose-700 border-rose-200" },
  { key: "partial", label: "Qisman", tone: "bg-amber-100 text-amber-700 border-amber-200" },
  { key: "paid", label: "To‘langan", tone: "bg-emerald-100 text-emerald-700 border-emerald-200" },
];

export const FULFILMENT_TYPES = [
  { key: "pickup", label: "Olib ketish" },
  { key: "delivery", label: "Yetkazib berish" },
];

export const CAKE_SHAPES = [
  { key: "round", label: "Doira" },
  { key: "rectangular", label: "To‘rtburchak" },
  { key: "other", label: "Boshqa" },
];

export const statusLabel = (key) => ORDER_STATUSES.find((s) => s.key === key)?.label || key;
export const statusTone = (key) => ORDER_STATUSES.find((s) => s.key === key)?.tone || "bg-muted text-muted-foreground border-border";
export const typeLabel = (key) => ORDER_TYPES.find((t) => t.key === key)?.label || key;
export const payStatusLabel = (key) => PAYMENT_STATUSES.find((s) => s.key === key)?.label || key;
export const payStatusTone = (key) => PAYMENT_STATUSES.find((s) => s.key === key)?.tone || "bg-muted text-muted-foreground border-border";
export const fulfilmentLabel = (key) => FULFILMENT_TYPES.find((f) => f.key === key)?.label || key;

export const buildIdempotencyKey = (prefix = "order") =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const TZ = "Asia/Tashkent";

export const MONTHS_UZ = [
  "Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun",
  "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr",
];

export const pad2 = (n) => String(n).padStart(2, "0");

export function tashkentNowParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
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

export function tashkentNowStamp() {
  const p = tashkentNowParts();
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function composeRequiredDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!y || !m || !d) return "";
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return "";
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function isFutureDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const req = dateStr.replace(/-/g, "") + timeStr.replace(":", "");
  const p = tashkentNowParts();
  const now = `${p.year}${pad2(p.month)}${pad2(p.day)}${pad2(p.hour)}${pad2(p.minute)}`;
  return req >= now;
}