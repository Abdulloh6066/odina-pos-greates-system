import { resolveAppUser } from '../user-helpers.ts';
import { boundedBytes } from './response-bytes.js';
export const ORDER_BOT_SECRET_NAMES = Object.freeze([
    'ODINA_ORDER_BOT_TOKEN', 'ODINA_ORDER_BOT_OWNER_TELEGRAM_ID', 'ODINA_ORDER_BOT_WEBHOOK_SECRET',
]);
// Only getMe/getWebhookInfo. No order, upload, state-write or webhook mutation capability.
// The injected secrets reader is called only inside an approved, owner-authenticated request.
export function prepareOrderBotReadiness({ clientForRequest, readSecret, fetchImpl, verificationApproved = false, ownerStaffId = '', expectedWebhookUrl = '' }) {
    return async req => {
        const answer = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
        if (req.method !== 'POST') return answer({ error: 'Amal noto‘g‘ri.' }, 405);
        try {
            const client = await clientForRequest(req);
            const auth = await client.auth.me();
            if (!auth?.id) return answer({ error: 'Avval tizimga kiring.' }, 401);
            const user = await resolveAppUser(client.asServiceRole, auth);
            if (!ownerStaffId || user.id !== ownerStaffId || !user.is_owner || user.disabled === true || user.data?.disabled === true)
                return answer({ error: 'Faqat egasi uchun.' }, 403);
            // No arbitrary payload/action/URL/token accepted from the caller.
            if (!verificationApproved) return answer({ error: 'Ulanishni tekshirish hali yoqilmagan.' }, 503);
            const values = ORDER_BOT_SECRET_NAMES.map(name => readSecret(name));
            const present = Object.fromEntries(ORDER_BOT_SECRET_NAMES.map((name, i) => [name, typeof values[i] === 'string' && values[i].length > 0]));
            const [token, ownerId, webhookSecret] = values;
            const configured = Object.values(present).every(Boolean) && /^[1-9]\d*$/.test(ownerId) && Number.isSafeInteger(Number(ownerId)) && /^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) && /^\d+:[A-Za-z0-9_-]+$/.test(token);
            if (!configured) return answer({ present, configured: false, identityVerified: false, activationReady: false });
            const call = async method => {
                const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
                    redirect: 'error', signal: AbortSignal.timeout(10000),
                });
                const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536)));
                if (body.ok !== true) throw Error();
                return body.result;
            };
            const identity = await call('getMe');
            if (identity?.is_bot !== true || identity.username !== 'odina_buyurtmalar_bot' || !Number.isSafeInteger(identity.id) || String(identity.id) !== token.split(':')[0])
                return answer({ present, configured: true, identityVerified: false, activationReady: false });
            const webhook = await call('getWebhookInfo');
            if (typeof webhook?.url !== 'string' || !Number.isSafeInteger(webhook.pending_update_count) || webhook.pending_update_count < 0) throw Error();
            // Do not return raw provider descriptions, webhook URLs/IPs, token or owner ID.
            return answer({ present, configured: true, identityVerified: true, bot: { id: identity.id, username: identity.username },
                webhook: webhook.url === '' ? 'absent' : expectedWebhookUrl && webhook.url === expectedWebhookUrl ? 'expected' : 'other',
                pendingUpdates: webhook.pending_update_count, activationReady: false });
        } catch {
            return answer({ error: 'Ulanishni tekshirish yakunlanmadi.', activationReady: false }, 503);
        }
    };
}
