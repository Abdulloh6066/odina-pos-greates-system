// Pure offline-testable logic for the birthday follow-up / Telegram reminder.
// No SDK access — all data is passed in. Tested in tests/birthday-logic.test.mjs.

export type BirthdayStatus =
  | "hali_aloqa_qilinmadi"
  | "qongiroq_javob_bolmadi"
  | "aloqa_chiqildi";

export const BIRTHDAY_STATUS_LABELS: Record<string, string> = {
  hali_aloqa_qilinmadi: "Hali aloqa qilinmadi",
  qongiroq_javob_bolmadi: "Qo'ng'iroq qilindi, javob bo'lmadi",
  aloqa_chiqildi: "Aloqaga chiqildi",
};

export const MONTHS_UZ = [
  "Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun",
  "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr",
];

// Shift a YYYY-MM-DD key by N days using UTC math (year-end / leap-year safe).
export function addDaysToDateKey(dateKey: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!m) return "";
  const shifted = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(days || 0)));
  return shifted.toISOString().slice(0, 10);
}

export function birthdayDisplay(month: number, day: number): string {
  if (!month || !day) return "";
  return `${day} ${MONTHS_UZ[month - 1] || ""}`.trim();
}

export function cleanBirthdayLabel(value: unknown, max = 80): string {
  return String(value ?? "").replace(/[\r\n\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
}

export type BirthdayMatch = {
  customer_id: string;
  customer_name: string;
  phone: string;
  birth_date: string;
  birthday_month: number;
  birthday_day: number;
  birth_year: number;
  campaign_year: number;
  birthday_date: string;
  days_remaining: number;
  label: string;
};

const WINDOW_LABELS = [
  "Bugun tug'ilgan kuni",
  "Ertaga tug'ilgan kuni",
  "2 kun qoldi",
  "3 kun qoldi",
];

// Find customers whose birthday (month/day only) falls on today, tomorrow, +2 or +3 days.
// Birth year is ignored. Year-end and leap-year dates are handled by computing real
// calendar dates for each offset — Feb 29 birthdays simply don't match in non-leap years.
export function birthdayWindowMatches(customers: any[], todayKey: string): BirthdayMatch[] {
  const matches: BirthdayMatch[] = [];
  if (!todayKey) return matches;
  for (const c of customers || []) {
    const bd = String(c?.birth_date || "");
    const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bd);
    if (!parsed) continue;
    const birthYear = Number(parsed[1]);
    const bm = Number(parsed[2]);
    const bdDay = Number(parsed[3]);
    if (!bm || !bdDay) continue;
    for (let offset = 0; offset <= 3; offset++) {
      const target = addDaysToDateKey(todayKey, offset);
      const tp = /^(\d{4})-(\d{2})-(\d{2})$/.exec(target);
      if (!tp) continue;
      const ty = Number(tp[1]);
      const tm = Number(tp[2]);
      const td = Number(tp[3]);
      if (tm === bm && td === bdDay) {
        matches.push({
          customer_id: String(c.id),
          customer_name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.first_name || c.phone || "",
          phone: String(c.phone || ""),
          birth_date: bd,
          birthday_month: bm,
          birthday_day: bdDay,
          birth_year: birthYear,
          campaign_year: ty,
          birthday_date: target,
          days_remaining: offset,
          label: WINDOW_LABELS[offset],
        });
        break;
      }
    }
  }
  return matches;
}

const GROUP_HEADERS: Record<number, string> = {
  0: "🎂 Bugun tug'ilgan kuni",
  1: "🟡 Ertaga tug'ilgan kuni",
  2: "🟠 2 kun qoldi",
  3: "🔴 3 kun qoldi",
};

// Eligible matches (excludes "aloqa_chiqildi"), ordered by days remaining so the
// message and the inline keyboard share the same numbering.
function orderedEligible(matches: BirthdayMatch[], followupByCustomer: Map<string, any>): BirthdayMatch[] {
  const eligible = matches.filter((m) => {
    const f = followupByCustomer.get(m.customer_id);
    const status = f?.contact_status || "hali_aloqa_qilinmadi";
    return status !== "aloqa_chiqildi";
  });
  const byOffset: Record<number, BirthdayMatch[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const m of eligible) byOffset[m.days_remaining].push(m);
  const ordered: BirthdayMatch[] = [];
  for (let offset = 0; offset <= 3; offset++) ordered.push(...byOffset[offset]);
  return ordered;
}

// Build a consolidated Telegram message from eligible matches, grouped by days remaining.
// followupByCustomer: Map<customer_id, {contact_status}>. "aloqa_chiqildi" is excluded.
export function buildBirthdayMessage(
  matches: BirthdayMatch[],
  followupByCustomer: Map<string, any>,
): string {
  const ordered = orderedEligible(matches, followupByCustomer);
  if (!ordered.length) return "";

  const byOffset: Record<number, BirthdayMatch[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const m of ordered) byOffset[m.days_remaining].push(m);

  const sections: string[] = ["🎂 YAQINLASHAYOTGAN TUG'ILGAN KUNLAR", ""];
  let idx = 0;
  for (let offset = 0; offset <= 3; offset++) {
    const group = byOffset[offset];
    if (!group.length) continue;
    sections.push(GROUP_HEADERS[offset]);
    for (const m of group) {
      idx++;
      const f = followupByCustomer.get(m.customer_id);
      const status = f?.contact_status || "hali_aloqa_qilinmadi";
      const statusLabel = BIRTHDAY_STATUS_LABELS[status] || status;
      sections.push(
        idx + ". Mijoz: " + cleanBirthdayLabel(m.customer_name),
        "   Telefon: " + cleanBirthdayLabel(m.phone || "—"),
        "   Tug'ilgan kuni: " + birthdayDisplay(m.birthday_month, m.birthday_day),
        "   Holati: " + statusLabel,
        "",
      );
    }
  }
  sections.push("Jami bog'lanish kerak: " + ordered.length);
  return sections.join("\n").trim();
}

// Inline keyboard for the birthday message: one row per customer with two callback
// buttons ("Javob yo'q" / "Aloqa"). callback_data = "bd:<followup_id>:no|ok".
// Numbering matches the message so the recipient can tell rows apart.
export function buildBirthdayKeyboard(
  matches: BirthdayMatch[],
  followupByCustomer: Map<string, any>,
): { inline_keyboard: any[][] } | null {
  const ordered = orderedEligible(matches, followupByCustomer);
  const rows: any[][] = [];
  ordered.forEach((m, i) => {
    const f = followupByCustomer.get(m.customer_id);
    if (!f?.id) return;
    const n = i + 1 + ".";
    rows.push([
      { text: n + " ❌ Javob yo'q", callback_data: "bd:" + f.id + ":no" },
      { text: n + " ✅ Aloqa", callback_data: "bd:" + f.id + ":ok" },
    ]);
  });
  return rows.length ? { inline_keyboard: rows } : null;
}

// Daily dedup key for a customer's birthday occurrence.
export function birthdayDedupKey(customerId: string, birthdayDate: string): string {
  return "birthday:" + customerId + ":" + birthdayDate;
}