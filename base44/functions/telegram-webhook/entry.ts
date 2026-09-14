import { createClientFromRequest } from "npm:@base44/sdk";
import { TELEGRAM_GROUP_ID } from "../../shared/telegram-alert-logic.ts";

// Receives Telegram callback_query updates fired when a staff member taps an inline
// button under the birthday reminder. callback_data format: "bd:<followup_id>:no|ok".
// The webhook URL + secret_token are configured via the telegram-setup "setWebhook" action.

const STATUS_CODE: Record<string, string> = {
  no: "qongiroq_javob_bolmadi",
  ok: "aloqa_chiqildi",
};
const STATUS_LABEL: Record<string, string> = {
  qongiroq_javob_bolmadi: "Qo'ng'iroq qilindi, javob bo'lmadi",
  aloqa_chiqildi: "Aloqaga chiqildi",
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  // Always answer 200 fast so Telegram does not retry; real work is best-effort.
  const ok = () => new Response("ok", { status: 200 });

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return ok();

  // Validate the secret_token Telegram echoes back (derived from the bot token so no
  // extra secret store is needed). Unknown callers are ignored silently.
  const expected = (await sha256Hex(token)).slice(0, 32);
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) return ok();

  const update = await req.json().catch(() => ({}));
  const cb = update?.callback_query;
  if (!cb?.id || !cb?.data) return ok();

  if (String(cb.message?.chat?.id || "") !== String(TELEGRAM_GROUP_ID)) {
    await answerCallbackQuery(token, cb.id, "Bu tugma faqat Odina ish guruhida ishlaydi.").catch(() => {});
    return ok();
  }

  const m = /^bd:([A-Za-z0-9_-]{1,128}):(no|ok)$/.exec(String(cb.data));
  if (!m) {
    await answerCallbackQuery(token, cb.id, "Noma’lum tugma.").catch(() => {});
    return ok();
  }
  const followupId = m[1];
  const status = STATUS_CODE[m[2]];

  try {
    const client = createClientFromRequest(req);
    const service = client.asServiceRole;
    const f = await service.entities.BirthdayFollowup.get(followupId).catch(() => null);
    if (!f) {
      await answerCallbackQuery(token, cb.id, "Yozuv topilmadi.").catch(() => {});
      return ok();
    }
    if (f.contact_status === "aloqa_chiqildi") {
      await answerCallbackQuery(token, cb.id, "Bu mijoz bilan allaqachon aloqa qilingan.").catch(() => {});
      return ok();
    }
    if (f.contact_status === status) {
      await answerCallbackQuery(token, cb.id, "Bu holat avval saqlangan.").catch(() => {});
      return ok();
    }

    const telegramUserId = String(cb.from?.id || "telegram");
    const telegramUserName = [
      String(cb.from?.first_name || ""),
      String(cb.from?.last_name || ""),
    ].filter(Boolean).join(" ").trim() || String(cb.from?.username || "Telegram");
    const contactedAt = new Date().toISOString();

    await service.entities.BirthdayFollowup.update(f.id, {
      contact_status: status,
      contacted_at: contactedAt,
      contacted_by_id: telegramUserId,
      contacted_by_name: telegramUserName,
    });
    await service.entities.ActionHistory.create({
      user_id: telegramUserId,
      user_name: telegramUserName,
      action: "birthday_contact_updated",
      details: String(f.customer_name_snapshot || f.customer_id || "Mijoz") + " · " + STATUS_LABEL[status],
    }).catch(() => {});
    await answerCallbackQuery(token, cb.id, "✅ " + STATUS_LABEL[status]).catch(() => {});
    // Refresh the message text so the team sees the updated status inline.
    if (cb.message?.chat?.id && cb.message?.message_id) {
      const updated = (cb.message.text || "") + "\n\n✅ Holat yangilandi: " + STATUS_LABEL[status];
      await fetch("https://api.telegram.org/bot" + token + "/editMessageText", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text: updated,
          reply_markup: cb.message.reply_markup,
        }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    }
  } catch {
    await answerCallbackQuery(token, cb.id, "Xato. Iltimos CRMda qiling.").catch(() => {});
  }
  return ok();
});

async function answerCallbackQuery(token: string, id: string, text: string): Promise<void> {
  await fetch("https://api.telegram.org/bot" + token + "/answerCallbackQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
    signal: AbortSignal.timeout(8000),
  });
}