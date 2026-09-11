// Pure logic for the "Do'kon talabi" (shop demand) workflow.
// No SDK / no IO — safe to unit-test offline. Imported by the shop-demand backend function.

export const DEMAND_STATUS_KEYS = [
  "yangi",
  "qabul_qilindi",
  "tayyorlanmoqda",
  "tayyor",
  "yuborildi",
  "qabul_qilingan",
  "bekor_qilindi",
];

export const STATUS_LABELS: Record<string, string> = {
  yangi: "Yangi",
  qabul_qilindi: "Qabul qilindi",
  tayyorlanmoqda: "Tayyorlanmoqda",
  tayyor: "Tayyor",
  yuborildi: "Yuborildi",
  qabul_qilingan: "Qabul qilindi",
  bekor_qilindi: "Bekor qilindi",
};

export const STATUS_SUBTITLE: Record<string, string> = {
  qabul_qilindi: "Ishlab chiqarish tomonidan",
  qabul_qilingan: "Do'konda qabul qilingan",
};

export const VALID_STATUS = (key: string) => DEMAND_STATUS_KEYS.includes(key);

export const statusLabel = (key: string) => STATUS_LABELS[key] || key;
export const statusSubtitle = (key: string) => STATUS_SUBTITLE[key] || "";

export const pad2 = (n: number) => String(n).padStart(2, "0");

export const cleanQty = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : NaN;
};

export const unitLabel = (u: string) => (u === "sheet" ? "list" : "dona");

// Build validated request items from raw input + a product lookup map.
export const normalizeRequestItems = (input: any, productsById: any) => {
  if (!Array.isArray(input) || input.length === 0) {
    return { items: null, error: "Kamida bitta mahsulot tanlang." };
  }
  if (input.length > 50) {
    return { items: null, error: "Bir talabda 50 tagacha mahsulot bo'lishi mumkin." };
  }
  const seen = new Set<string>();
  const items: any[] = [];
  for (const raw of input) {
    const productId = String(raw?.product_id || "");
    const product = productsById[productId];
    if (!product || product.active === false || product.archived === true || product.track_stock === false) {
      return { items: null, error: `Mahsulot topilmadi yoki faol emas: ${productId}` };
    }
    if (seen.has(productId)) {
      return { items: null, error: `Mahsulot takror tanlandi: ${product.name}` };
    }
    seen.add(productId);
    const q = cleanQty(raw?.quantity);
    if (!Number.isInteger(q) || q <= 0) {
      return { items: null, error: `${product.name} miqdori musbat butun son bo'lishi kerak.` };
    }
    items.push({
      product_id: productId,
      product_name_snapshot: product.name,
      category_name_snapshot: product.category_name || "",
      unit: product.production_unit || "piece",
      pieces_per_sheet_snapshot: Number(product.pieces_per_sheet || 20),
      requested_quantity: q,
    });
  }
  return { items, error: null };
};

export const remainingForItem = (it: any) =>
  Math.max(0, (Number(it.requested_quantity) || 0) - (Number(it.sent_quantity) || 0));

export const sentPiecesForItem = (it: any) => {
  const sent = Number(it.sent_quantity) || 0;
  return it.unit === "sheet" ? sent * (Number(it.pieces_per_sheet_snapshot) || 0) : sent;
};

export const receivedPiecesFromTransfers = (it: any, transfers: any[]) => {
  let sum = 0;
  for (const t of transfers) {
    if (!t || t.product_id !== it.product_id) continue;
    if (t.status !== "received") continue;
    // StockTransfer stores received_quantity = quantity * conversion_factor at send time;
    // for piece products that equals the sent quantity. Use the stored received value.
    sum += t.unit === "sheet"
      ? Number(t.received_quantity || 0)
      : Number(t.received_quantity || t.quantity || 0);
  }
  return sum;
};

// Fully received = everything requested was sent AND all sent goods were received.
export const isFullyReceived = (items: any[], transfers: any[]) => {
  if (!items || items.length === 0) return false;
  for (const it of items) {
    if (remainingForItem(it) > 0) return false;
    if (receivedPiecesFromTransfers(it, transfers) < sentPiecesForItem(it)) return false;
  }
  return true;
};

export const computeTotals = (items: any[]) => {
  let total_requested = 0;
  let total_sent = 0;
  for (const it of items || []) {
    total_requested += Number(it.requested_quantity) || 0;
    total_sent += Number(it.sent_quantity) || 0;
  }
  return { total_requested, total_sent, total_remaining: Math.max(0, total_requested - total_sent) };
};

// Asia/Tashkent "now" parts for urgency sorting.
export const urgency = (request: any, nowParts: any) => {
  if (!request?.required_date) return "";
  const req = String(request.required_date).replace(/-/g, "");
  const now = `${nowParts.year}${pad2(nowParts.month)}${pad2(nowParts.day)}`;
  if (req < now) return "overdue";
  const reqMs = new Date(`${request.required_date}T00:00:00+05:00`).getTime();
  if (!Number.isFinite(reqMs)) return "";
  const diffH = (reqMs - Date.now()) / 3600000;
  return diffH <= 24 ? "urgent" : "";
};

export const sortRequests = (requests: any[], nowParts: any) => {
  const rank = (r: any) => {
    const u = urgency(r, nowParts);
    return u === "overdue" ? 0 : u === "urgent" ? 1 : 2;
  };
  return [...requests].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (
      String(a.required_date || "").localeCompare(String(b.required_date || "")) ||
      String(a.request_number || "").localeCompare(String(b.request_number || ""))
    );
  });
};

export const groupByDateAndShop = (requests: any[], itemsByRequest: any) => {
  const map = new Map();
  for (const r of requests) {
    const key = `${r.required_date || "__"}|${r.shop_id || "__"}`;
    if (!map.has(key)) {
      map.set(key, {
        date: r.required_date || "",
        shop_id: r.shop_id || "",
        shop_name: r.shop_name_snapshot || "",
        requests: [],
      });
    }
    map.get(key).requests.push({ ...r, items: itemsByRequest[r.id] || [] });
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      String(a.date).localeCompare(String(b.date)) || String(a.shop_name).localeCompare(String(b.shop_name)),
  );
};

// Aggregated product summary across requests: per product total + per-shop breakdown.
export const aggregateByProduct = (requests: any[], itemsByRequest: any) => {
  const map = new Map();
  for (const r of requests) {
    const items = itemsByRequest[r.id] || [];
    for (const it of items) {
      const key = it.product_id || it.product_name_snapshot || "?";
      if (!map.has(key)) {
        map.set(key, {
          product_id: key,
          name: it.product_name_snapshot || "?",
          unit: it.unit === "sheet" ? "list" : "dona",
          total: 0,
          byShop: {} as Record<string, any>,
        });
      }
      const g = map.get(key);
      g.total += Number(it.requested_quantity) || 0;
      const shopKey = r.shop_id || "?";
      if (!g.byShop[shopKey]) {
        g.byShop[shopKey] = { shop_name: r.shop_name_snapshot || "?", requested: 0, sent: 0, remaining: 0 };
      }
      g.byShop[shopKey].requested += Number(it.requested_quantity) || 0;
      g.byShop[shopKey].sent += Number(it.sent_quantity) || 0;
      g.byShop[shopKey].remaining += remainingForItem(it);
    }
  }
  return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
};

export const canEdit = (request: any, role: string, shopId: string) => {
  if (request.status !== "yangi") return false;
  if (role === "admin") return true;
  return Boolean(shopId) && request.shop_id === shopId;
};

export const canCancel = canEdit;

export const canAccept = (request: any, role: string) =>
  (role === "admin" || role === "production") && request.status === "yangi";

export const canProgress = (request: any, role: string) => {
  if (role !== "admin" && role !== "production") return false;
  return ["qabul_qilindi", "tayyorlanmoqda"].includes(request.status);
};

export const canSend = (request: any, role: string) => {
  if (role !== "admin") return false;
  return ["qabul_qilindi", "tayyorlanmoqda", "tayyor"].includes(request.status);
};

export const allowedProgressTargets = (request: any, role: string) => {
  if (role !== "admin" && role !== "production") return [] as string[];
  if (request.status === "qabul_qilindi") return ["tayyorlanmoqda", "tayyor"];
  if (request.status === "tayyorlanmoqda") return ["tayyor"];
  return [] as string[];
};

// Dedup guard for the create action: returns the existing request if the key was already used.
export const findExistingByKey = (rows: any[], key: string) =>
  (rows || []).find((r) => r && r.idempotency_key && r.idempotency_key === key) || null;

// Dedup guard for the send action: has this send key already been recorded?
export const hasSendKey = (request: any, key: string) =>
  Array.isArray(request?.send_log) && request.send_log.includes(key);