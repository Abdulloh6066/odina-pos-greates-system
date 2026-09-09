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