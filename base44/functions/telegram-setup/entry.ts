import { createClientFromRequest } from "npm:@base44/sdk";
import { userRole } from "../../shared/user-helpers.ts";

// Recipient explicitly supplied by the owner. Never accept a recipient or text from the browser.
const GROUP_ID = "-5570444945";
const TEST_TEXT = "✅ Odina POS bilan ulanish ishlayapti.\nBu sinov xabari. Avtomatik ogohlantirishlar hali yoqilmagan.";
Deno.serve(async (req) => {
  let phase = "boshlash";
  try {
    phase = "Base44 mijozini yaratish";
    const client = createClientFromRequest(req);
    phase = "sessiyani o‘qish";
    const auth = await client.auth.me();
    if (!auth?.id) return Response.json({ error: "Avval tizimga kiring." }, { status: 401 });
    const authEmail = String(auth.email || "").trim();
    phase = "User yozuvini qidirish";
    const storedMatches = authEmail
      ? await client.asServiceRole.entities.User.filter({ email: authEmail }, "-updated_date", 5)
      : [];
    phase = "rolni tekshirish";
    const normalizedEmail = authEmail.toLowerCase();
    const stored = (storedMatches || []).find(
      (candidate: any) => String(candidate?.email || "").trim().toLowerCase() === normalizedEmail,
    ) || null;
    if (!stored || stored.active === false || stored.data?.active === false || userRole(stored) !== "admin") {
      return Response.json({ error: "Faqat egasi/admin uchun." }, { status: 403 });
    }
    phase = "so‘rovni o‘qish";
    const body = await req.json().catch(() => ({}));
    const action = body.action || "inspect";
    if (!["inspect", "test"].includes(action)) return Response.json({ error: "Noma’lum amal." }, { status: 400 });
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
          400: "Telegram guruhini tekshiring. Guruh turi yoki ID o‘zgargan bo‘lishi mumkin.",
          403: "Bot guruhga xabar yubora olmayapti. Bot a’zoligi va yozish ruxsatini tekshiring.",
          401: "Telegram tokeni yaroqsiz. Base44 Secrets ichidagi tokenni tekshiring.",
          409: "Bot boshqa ulanishda ishlayapti. Mavjud ulanishni tekshirish kerak.",
          429: "Telegram so‘rovlar chegarasi. Birozdan keyin qayta urinib ko‘ring.",
        };
        throw new Error(messages[data.error_code || response.status] || "Telegram bilan ulanishda xato.");
      }
      return data.result;
    };
    phase = "Telegram botni tekshirish";
    const bot = await call("getMe");
    if (String(bot.username).toLowerCase() !== "odina_nazorat_bot") {
      return Response.json({ error: "Saqlangan token @Odina_nazorat_bot ga tegishli emas." }, { status: 400 });
    }
    phase = "Telegram guruhini tekshirish";
    const group = await call("getChat", { chat_id: GROUP_ID });
    if (String(group.id) !== GROUP_ID || !["group", "supergroup"].includes(group.type)) {
      return Response.json({ error: "Tasdiqlangan Telegram guruhi mos kelmadi." }, { status: 409 });
    }
    let messageId = null;
    if (action === "test") {
      // Exactly one attempt. A timeout may mean Telegram accepted the message;
      // never automatically retry and risk posting a duplicate.
      phase = "sinov xabarini yuborish";
      const sent = await call("sendMessage", { chat_id: GROUP_ID, text: TEST_TEXT });
      messageId = sent.message_id;
    }
    return Response.json({
      bot_username: bot.username,
      groups: [{ id: GROUP_ID, title: String(group.title || "Odina-Ish Jarayoni") }],
      notifications_enabled: false,
      test_sent: action === "test",
      message_id: messageId,
    });
  } catch (error) {
    const known = [
      "Telegram guruhini tekshiring. Guruh turi yoki ID o‘zgargan bo‘lishi mumkin.",
      "Bot guruhga xabar yubora olmayapti. Bot a’zoligi va yozish ruxsatini tekshiring.",
      "Telegram tokeni yaroqsiz. Base44 Secrets ichidagi tokenni tekshiring.",
      "Bot boshqa ulanishda ishlayapti. Mavjud ulanishni tekshirish kerak.",
      "Telegram so‘rovlar chegarasi. Birozdan keyin qayta urinib ko‘ring.",
      "Telegram bilan ulanishda xato.",
    ];
    const message = error instanceof Error && known.includes(error.message)
      ? error.message
      : `Ulanishni ${phase} bosqichida tekshirib bo‘lmadi. Qayta bosishdan oldin Telegram guruhini tekshiring.`;
    return Response.json({ error: message }, { status: 502 });
  }
});
