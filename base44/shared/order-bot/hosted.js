import { OrderBot } from './bot.js';
import { Base44StateStore } from './base44-store.js';
import { InternalOrderBridge } from './bridge.js';
import { ReferencePhotos } from './photos.js';
import { TelegramAdapter, base44PhotoUpload } from './telegram.js';
import { localWebhook } from './transport.js';
// Factory only. No listener, Deno.env, SDK client construction, or invocation on import.
// It remains outside base44/functions until source placement is separately authorized.
export function prepareHostedOrderBot({ service, canonicalIds = {}, approvedPhotoHosts = [], token = '', webhookSecret = '', fetchImpl, acceptUpdates = false, deliveryEnabled = false, submissionEnabled = false, atomicVerified = false }) {
    const store = new Base44StateStore(service.entities.TelegramOrderBotState, { canonicalIds });
    const bindingProvider = s => store.binding(s);
    const pos = new InternalOrderBridge({ ...service, approvedPhotoHosts }, { bindingForSender: bindingProvider });
    const telegram = new TelegramAdapter({ token, fetchImpl, enabled: deliveryEnabled });
    const photos = new ReferencePhotos({ downloadBytes: id => telegram.downloadBytes(id), uploadBytes: base44PhotoUpload(service), approvedHosts: approvedPhotoHosts });
    const bot = new OrderBot({ store, pos, photos, bindingProvider, submissionEnabled: submissionEnabled && atomicVerified });
    const boundary = localWebhook({ handle: async (update) => {
            const message = update?.callback_query?.message ?? update?.message;
            const from = update?.callback_query?.from ?? update?.message?.from;
            if (!Number.isSafeInteger(update?.update_id) || !Number.isSafeInteger(from?.id) || from.id <= 0 || from?.is_bot || message?.chat?.type !== 'private' || String(message.chat.id) !== String(from.id)) return { ok: true };
            const sender = String(from.id);
            if (!await bot.auth(sender)) {
                // A fixed /start refusal grants no access and creates no binding or draft.
                // Only Telegram-authenticated private messages may receive this response.
                if (deliveryEnabled && !update.callback_query && message.text === '/start' &&
                    !message.forward_origin && !message.forward_from && !message.forward_date) {
                    try {
                        await telegram.sendReply(sender, { text: 'Siz ro‘yxatda yo‘qsiz. Mas’ul xodimga murojaat qiling.' });
                    }
                    catch { /* Unknown send outcome: acknowledge, never blindly retry. */ }
                }
                return { ok: true };
            }
            const response = await bot.handle(update);
            if (deliveryEnabled && await bot.auth(sender)) {
                // Durable send claim. Sending/unknown is not automatically retried: Telegram
                // sendMessage has no idempotency key. A new /holat can request a fresh reply.
                const pending = await store.claimReply(sender, String(update.update_id));
                if (pending) {
                    const current = await store.get(sender), staff = await bot.auth(sender);
                    if (!staff || (current && !bot.scopeMatches(current, staff)))
                        throw Error('scope');
                    let id;
                    try {
                        id = await telegram.sendReply(sender, pending);
                    }
                    catch { /* unknown */ }
                    await store.finishReply(sender, String(update.update_id), id);
                }
                if (update.callback_query?.id)
                    try {
                        await telegram.acknowledge(update.callback_query.id);
                    }
                    catch { /* Cosmetic acknowledgment only. */ }
            }
            return { ok: true, response };
        } }, { secret: webhookSecret });
    return { bot, store, handler: async (req) => {
            if (!acceptUpdates || !atomicVerified)
                return new Response('Bot hali yoqilmagan.', { status: 503 });
            const result = await boundary(req);
            if (!result.ok)
                return result;
            // Responses are sent via Telegram, never returned as raw customer data to webhook callers.
            return Response.json({ ok: true });
        } };
}
