// Display helpers for the "Do'kon talabi" workflow (frontend only).
import { tashkentNowParts } from '@/lib/orders';

export const DEMAND_STATUSES = [
  { key: 'yangi', label: 'Yangi', tone: 'bg-amber-100 text-amber-700 border-amber-200' },
  { key: 'qabul_qilindi', label: 'Qabul qilindi', subtitle: 'Ishlab chiqarish tomonidan', tone: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'tayyorlanmoqda', label: 'Tayyorlanmoqda', tone: 'bg-amber-100 text-amber-700 border-amber-200' },
  { key: 'tayyor', label: 'Tayyor', tone: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { key: 'yuborildi', label: 'Yuborildi', tone: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'qabul_qilingan', label: 'Qabul qilindi', subtitle: "Do'konda qabul qilingan", tone: 'bg-brand-olive/20 text-brand-ink border-brand-olive/30' },
  { key: 'bekor_qilindi', label: 'Bekor qilindi', tone: 'bg-rose-100 text-rose-700 border-rose-200' },
];

export const demandStatus = (k) => DEMAND_STATUSES.find((s) => s.key === k) || { key: k, label: k, tone: 'bg-muted text-muted-foreground border-border' };

export const unitLabel = (u) => (u === 'sheet' ? 'list' : 'dona');

export const remainingForItem = (it) =>
  Math.max(0, (Number(it.requested_quantity) || 0) - (Number(it.sent_quantity) || 0));

export const sentPieces = (it) => (it.unit === 'sheet'
  ? (Number(it.sent_quantity) || 0) * (Number(it.pieces_per_sheet_snapshot) || 0)
  : Number(it.sent_quantity) || 0);

function urgency(request) {
  if (!request?.required_date) return '';
  const req = String(request.required_date).replace(/-/g, '');
  const p = tashkentNowParts();
  const pad2 = (n) => String(n).padStart(2, '0');
  const now = `${p.year}${pad2(p.month)}${pad2(p.day)}`;
  if (req < now) return 'overdue';
  const reqMs = new Date(`${request.required_date}T00:00:00+05:00`).getTime();
  if (!Number.isFinite(reqMs)) return '';
  const diffH = (reqMs - Date.now()) / 3600000;
  return diffH <= 24 ? 'urgent' : '';
}

export function sortRequests(requests) {
  const rank = (r) => { const u = urgency(r); return u === 'overdue' ? 0 : u === 'urgent' ? 1 : 2; };
  return [...requests].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return String(a.required_date || '').localeCompare(String(b.required_date || ''))
      || String(a.request_number || '').localeCompare(String(b.request_number || ''));
  });
}

export function groupByDateAndShop(requests, itemsByRequest) {
  const map = new Map();
  for (const r of requests) {
    const key = `${r.required_date || '__'}|${r.shop_id || '__'}`;
    if (!map.has(key)) {
      map.set(key, { date: r.required_date || '', shop_id: r.shop_id || '', shop_name: r.shop_name_snapshot || '', requests: [] });
    }
    map.get(key).requests.push({ ...r, items: itemsByRequest[r.id] || [] });
  }
  return Array.from(map.values()).sort(
    (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.shop_name).localeCompare(String(b.shop_name)),
  );
}

export function aggregateByProduct(requests, itemsByRequest) {
  const map = new Map();
  for (const r of requests) {
    const items = itemsByRequest[r.id] || [];
    for (const it of items) {
      const key = it.product_id || it.product_name_snapshot || '?';
      if (!map.has(key)) {
        map.set(key, { product_id: key, name: it.product_name_snapshot || '?', unit: it.unit === 'sheet' ? 'list' : 'dona', total: 0, byShop: {} });
      }
      const g = map.get(key);
      g.total += Number(it.requested_quantity) || 0;
      const shopKey = r.shop_id || '?';
      if (!g.byShop[shopKey]) g.byShop[shopKey] = { shop_name: r.shop_name_snapshot || '?', requested: 0, sent: 0, remaining: 0 };
      g.byShop[shopKey].requested += Number(it.requested_quantity) || 0;
      g.byShop[shopKey].sent += Number(it.sent_quantity) || 0;
      g.byShop[shopKey].remaining += remainingForItem(it);
    }
  }
  return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function displayDate(value) {
  const [y, m, d] = (value || '').split('-');
  return y && m && d ? `${d}.${m}.${y}` : (value || '—');
}