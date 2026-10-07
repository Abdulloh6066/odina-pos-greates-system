import { timingSafeEqual } from "node:crypto";
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import { INTAKE_CONFIG, controlRow } from "../../shared/order-bot/setup.js";
import { prepareHostedOrderBot } from "../../shared/order-bot/hosted.js";
// Bot bundle revision: order-intake-v8 (permanent sequential order numbers; unmatched cake prices save as ordinary orders).
export default async function (req: Request): Promise<Response> {
    try {
        const secret = secrets.get("ODINA_ORDER_BOT_WEBHOOK_SECRET") || "";
        const supplied = req.headers.get("x-telegram-bot-api-secret-token") || "";
        const a = new TextEncoder().encode(secret), b = new TextEncoder().encode(supplied);
        if (!a.length || a.length !== b.length || !timingSafeEqual(a, b)) return new Response("Ruxsat yo‘q. (order-intake-v8)", { status: 403, headers: { "x-odina-order-revision": "order-intake-v8" } });
        if (req.method !== "POST") return new Response("Amal noto‘g‘ri.", { status: 405 });
        const ownerId = secrets.get("ODINA_ORDER_BOT_OWNER_TELEGRAM_ID") || "";
        const token = secrets.get("ODINA_ORDER_BOT_TOKEN") || "";
        if (!/^[1-9]\d*$/.test(ownerId) || !Number.isSafeInteger(Number(ownerId)) || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) return new Response("Sozlamalar tekshirilsin.", { status: 503 });
        const client = createClientFromRequest(req), service = client.asServiceRole;
        const control = await controlRow(service.entities.TelegramOrderBotState);
        const state = JSON.parse(control.payload_json);
        if (control.phase !== 'complete' || state.probe?.passed !== true || !state.ownerStateId || state.activation !== 'active') return new Response("Bot hali yoqilmagan.", { status: 503 });
        return await prepareHostedOrderBot({
            service, canonicalIds: { [ownerId]: state.ownerStateId }, approvedPhotoHosts: INTAKE_CONFIG.approvedPhotoHosts,
            token, webhookSecret: secret, fetchImpl: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
            acceptUpdates: true, deliveryEnabled: true, submissionEnabled: true, atomicVerified: true,
        }).handler(req);
    } catch { return new Response("So‘rov yakunlanmadi.", { status: 503 }); }
}
