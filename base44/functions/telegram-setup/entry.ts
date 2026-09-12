import { createClientFromRequest } from "npm:@base44/sdk";
import { userRole } from "../../shared/user-helpers.ts";

// Read-only setup: no messages sent, updates acknowledged, or business records changed.
Deno.serve(async (req) => {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth?.id) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const stored = await client.asServiceRole.entities.User.get(auth.id);
    if (!stored || stored.active === false || stored.data?.active === false || userRole(stored) !== "admin") {
      return Response.json({ error: "Faqat egasi/admin uchun." }, { status: 403 });
    }
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    if (!token) return Response.json({ error: "Base44 Secrets ichida TELEGRAM_BOT_TOKEN topilmadi." }, { status: 400 });
    const call = async (method: string, body = {}) => {
      const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        // Never propagate provider errors or request URLs containing the token.
        const messages: Record<number, string> = {
          401: "Telegram tokeni yaroqsiz. Base44 Secrets ichidagi tokenni tekshiring.",
          409: "Bot boshqa ulanishda ishlayapti. Mavjud ulanishni tekshirish kerak.",
          429: "Telegram so‘rovlar chegarasi. Birozdan keyin qayta urinib ko‘ring.",
        };
        throw new Error(messages[data.error_code || response.status] || "Telegram bilan ulanishda xato.");
      }
      return data.result;
    };
    const bot = await call("getMe");
    if (String(bot.username).toLowerCase() !== "odina_nazorat_bot") {
      return Response.json({ error: "Saqlangan token @Odina_nazorat_bot ga tegishli emas." }, { status: 400 });
    }
    const webhook = await call("getWebhookInfo");
    if (webhook.url) return Response.json({ error: "Botda webhook mavjud. Guruhni aniqlashdan oldin mavjud ulanishni tekshirish kerak." }, { status: 409 });
    // No offset or allowed_updates: don't consume the queue or alter its subscription.
    const updates = await call("getUpdates", { timeout: 0, limit: 100 });
    const groups = new Map();
    for (const update of updates || []) {
      const msg = update.message;
      if (!msg || !["group", "supergroup"].includes(msg.chat?.type)) continue;
      if (!/^\/start@odina_nazorat_bot(?:\s|$)/i.test(msg.text || "")) continue;
      if (!Number.isSafeInteger(msg.chat.id) || msg.chat.id >= 0) continue;
      groups.set(String(msg.chat.id), {
        id: String(msg.chat.id), title: String(msg.chat.title || ""),
        command_at: new Date(msg.date * 1000).toISOString(),
      });
    }
    return Response.json({ bot_username: bot.username, groups: [...groups.values()], notifications_enabled: false });
  } catch (error) {
    const known = [
      "Telegram tokeni yaroqsiz. Base44 Secrets ichidagi tokenni tekshiring.",
      "Bot boshqa ulanishda ishlayapti. Mavjud ulanishni tekshirish kerak.",
      "Telegram so‘rovlar chegarasi. Birozdan keyin qayta urinib ko‘ring.",
      "Telegram bilan ulanishda xato.",
    ];
    const message = error instanceof Error && known.includes(error.message) ? error.message : "Tekshirish amalga oshmadi. Qayta kirib, yana urinib ko‘ring.";
    return Response.json({ error: message }, { status: 502 });
  }
});
