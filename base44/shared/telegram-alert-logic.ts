export const TELEGRAM_GROUP_ID = "-5570444945";
export const cleanLabel = (value: unknown, max = 80) => String(value ?? "").replace(/[\r\n\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
export function localClock(now: number) {
  const local = new Date(now + 5 * 3600000);
  return { today: local.toISOString().slice(0, 10), tomorrow: new Date(local.getTime() + 86400000).toISOString().slice(0, 10), hour: local.getUTCHours() };
}
export function orderCandidates(orders: any[], now: number) {
  const candidates: any[] = [];
  for (const order of orders) {
    if (!["qabul_qilindi", "tayyorlanmoqda", "tayyor"].includes(order.order_status)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(order.required_date || "") || !/^\d{1,2}:\d{2}$/.test(order.required_time || "")) continue;
    const [h, m] = order.required_time.split(":").map(Number);
    if (h > 23 || m > 59) continue;
    const due = Date.parse(order.required_date + "T" + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":00+05:00");
    if (!Number.isFinite(due) || localClock(due).today !== order.required_date || due - now > 3 * 3600000) continue;
    const kind = due < now ? "overdue" : due - now <= 3600000 ? "due_soon" : "due_3h";
    candidates.push({
      key: ["order", order.id, due, kind].join(":"),
      kind, due,
      text: (kind === "overdue" ? "🔴 Buyurtma kechikdi!" : kind === "due_soon" ? "🟠 Shoshiling — topshirishga 1 soat yoki kam qoldi!" : "🟡 Vaqt oz qoldi — topshirishga 3 soat yoki kam qoldi. Buyurtmani tayyorlashni rejalashtiring.") + " · " + cleanLabel(order.order_number) +
        "\n" + cleanLabel(order.shop_name_snapshot) + " · " + order.required_date + " " + cleanLabel(order.required_time),
    });
  }
  const rank: Record<string, number> = { overdue: 0, due_soon: 1, due_3h: 2 };
  return candidates.sort((a, b) => rank[a.kind] - rank[b.kind] || a.due - b.due);
}
export function forecastCandidate(forecast: any, location: any, date: string) {
  const shortages = forecast.shortages || [];
  const issues = forecast.issues || [];
  if (!shortages.length && !issues.length) return null;
  const units: Record<string, string> = { g: "g", ml: "ml", piece: "dona", sheet: "list" };
  const lines = shortages.slice(0, 8).map((s: any) => cleanLabel(s.ingredient_name, 50) +
    ": " + Number(s.missing).toLocaleString("en-US", { maximumFractionDigits: 3 }) + " " + (units[s.unit] || "") + " yetishmaydi");
  if (shortages.length > 8) lines.push("Yana " + (shortages.length - 8) + " ta masalliq — Ishlab chiqarish ekranida.");
  if (issues.length) lines.push("⚠️ " + issues.length + " ta tex-karta/ma’lumot muammosi. Hisob to‘liq emas — Ishlab chiqarish ekranini tekshiring.");
  return {
    key: "forecast:" + location.id + ":" + date,
    text: "📦 Ertangi ish uchun masalliqlar · " + date + "\n" + cleanLabel(location.name, 50) +
      "\nBugungi tayyorlanmagan ishlar ham hisobga olingan.\n" + lines.join("\n"),
  };
}
