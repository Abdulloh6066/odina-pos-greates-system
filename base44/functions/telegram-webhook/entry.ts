import { createClientFromRequest } from "npm:@base44/sdk";
import { TELEGRAM_GROUP_ID } from "../../shared/telegram-alert-logic.ts";
import { preparePrivateIdentityReply, preparePrivateTelegramReply } from "../../shared/private-telegram-webhook-stage.ts";

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
  const privateChat = (cb ? cb.message?.chat : update?.message?.chat)?.type === "private";
  // Keep private reports and ID discovery entirely separate from group birthday actions.
  // Missing/invalid owner ID fails closed for reports; /id only reveals the sender's own ID.
  if (privateChat) {
    try {
      // /id must work on the public Telegram webhook even without a Base44 user
      // session. Do not construct the SDK client or read any business data for /id.
      const identityReply = preparePrivateIdentityReply(update);
      if (identityReply.kind === "message") {
        await telegramPost(token, "sendMessage", { chat_id: identityReply.chatId, text: identityReply.text });
        return ok();
      }
      const ownerId = Deno.env.get("TELEGRAM_OWNER_USER_ID") || "";
      // Fail closed before constructing an authenticated service client or reading DB.
      const sender = cb ? cb.from : update?.message?.from;
      const chat = cb ? cb.message?.chat : update?.message?.chat;
      if (!/^[1-9][0-9]{0,19}$/.test(ownerId) || String(sender?.id || "") !== ownerId
          || String(chat?.id || "") !== ownerId || sender?.is_bot === true) return ok();
      const client = createClientFromRequest(req);
      const reply = await preparePrivateTelegramReply(update, {
        ownerId,
        service: client.asServiceRole,
        now: Date.now(),
      });
      if (reply.kind === "message") {
        // Only the validated private chat returned by the router may receive a response.
        const body: Record<string, unknown> = { chat_id: reply.chatId, text: reply.text };
        if (reply.replyMarkup) body.reply_markup = reply.replyMarkup;
        await telegramPost(token, "sendMessage", body);
        if (reply.callbackId) await answerCallbackQuery(token, reply.callbackId, "Tayyor").catch(() => {});
      } else if (cb?.id) {
        await answerCallbackQuery(token, cb.id, "Ruxsat yo‘q yoki tugma eskirgan.").catch(() => {});
      }
    } catch {
      // Keep provider errors, bot token, user IDs and financial data out of logs.
      console.error("ODINA_TELEGRAM_PRIVATE_HANDLER_FAILED");
      if (cb?.id) await answerCallbackQuery(token, cb.id, "Hisobotni hozir yuklab bo‘lmadi.").catch(() => {});
    }
    return ok();
  }
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
  // Group membership is NOT authorization. Permit the verified owner and only
  // explicitly approved staff Telegram numeric IDs configured in Base44 Secrets.
  // Never authorize usernames, forwarded messages, or the entire group implicitly.
  const senderId = String(cb.from?.id ?? "");
  const ownerId = String(Deno.env.get("TELEGRAM_OWNER_USER_ID") || "").trim();
  const staffIds = String(Deno.env.get("TELEGRAM_BIRTHDAY_STAFF_IDS") || "")
    .split(",").map((id) => id.trim()).filter((id) => /^[1-9][0-9]{0,19}$/.test(id));
  const authorizedIds = new Set([ownerId, ...staffIds].filter((id) => /^[1-9][0-9]{0,19}$/.test(id)));
  if (cb.from?.is_bot === true || !authorizedIds.has(senderId)) {
    await answerCallbackQuery(token, cb.id, "Bu amal uchun ruxsat berilmagan.").catch(() => {});
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

async function telegramPost(token: string, method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("Telegram delivery failed");
}

async function answerCallbackQuery(token: string, id: string, text: string): Promise<void> {
  await fetch("https://api.telegram.org/bot" + token + "/answerCallbackQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
    signal: AbortSignal.timeout(8000),
  });
}