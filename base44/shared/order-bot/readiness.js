import { resolveAppUser } from '../user-helpers.ts';
import { boundedBytes } from './response-bytes.js';
export const ORDER_BOT_SECRET_NAMES = Object.freeze([
    'ODINA_ORDER_BOT_TOKEN', 'ODINA_ORDER_BOT_OWNER_TELEGRAM_ID', 'ODINA_ORDER_BOT_WEBHOOK_SECRET',
]);
// Only getMe/getWebhookInfo. No order, upload, state-write or webhook mutation capability.
// The injected secrets reader is called only inside an approved, owner-authenticated request.
export function prepareOrderBotReadiness({ clientForRequest, readSecret, fetchImpl, verificationApproved = false, ownerStaffId = '', expectedWebhookUrl = '' }) {
    return async req => {
        const answer = (body, status = 200) => Response.json({ revision: 'readiness-v2', ...body }, { status, headers: { 'cache-control': 'no-store' } });
        if (req.method !== 'POST') return answer({ error: 'Amal noto‘g‘ri.' }, 405);
        let ownerVerified = false, stage = 'auth', code = 'AUTH_UNVERIFIED';
        let present;
        try {
            const client = await clientForRequest(req);
            const auth = await client.auth.me();
            if (!auth?.id) return answer({ error: 'Avval tizimga kiring.', stage: 'auth', code: 'AUTH_UNVERIFIED', activationReady: false }, 401);
            const user = await resolveAppUser(client.asServiceRole, auth);
            if (!ownerStaffId || user.id !== ownerStaffId || !user.is_owner || user.disabled === true || user.data?.disabled === true)
                return answer({ error: 'Faqat egasi uchun.', stage: 'auth', code: 'OWNER_REQUIRED', activationReady: false }, 403);
            ownerVerified = true;
            stage = 'config';
            code = 'SECRET_ACCESS_FAILED';
            // No arbitrary payload/action/URL/token accepted from the caller.
            if (!verificationApproved) return answer({ error: 'Ulanishni tekshirish hali yoqilmagan.' }, 503);
            const values = ORDER_BOT_SECRET_NAMES.map(name => readSecret(name));
            present = Object.fromEntries(ORDER_BOT_SECRET_NAMES.map((name, i) => [name, typeof values[i] === 'string' && values[i].length > 0]));
            const [token, ownerId, webhookSecret] = values;
            const configured = Object.values(present).every(Boolean) && /^[1-9]\d*$/.test(ownerId) && Number.isSafeInteger(Number(ownerId)) && /^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) && /^\d+:[A-Za-z0-9_-]+$/.test(token);
            if (!configured) return answer({ stage, code: 'CONFIG_INVALID_OR_MISSING', present, configured: false, identityVerified: false, activationReady: false });
            const call = async method => {
                stage = method;
                code = 'TELEGRAM_TRANSPORT_FAILED';
                const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
                    redirect: 'error', signal: AbortSignal.timeout(10000),
                });
                if (!response.ok) {
                    code = response.status === 401 ? 'TELEGRAM_AUTH_REJECTED' : response.status === 429 ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_HTTP_ERROR';
                    throw Error();
                }
                code = 'TELEGRAM_RESPONSE_INVALID';
                const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536)));
                if (body.ok !== true) throw Error();
                return body.result;
            };
            const identity = await call('getMe');
            if (identity?.is_bot !== true || identity.username !== 'odina_buyurtmalar_bot' || !Number.isSafeInteger(identity.id) || String(identity.id) !== token.split(':')[0])
                return answer({ stage, code: 'BOT_IDENTITY_MISMATCH', present, configured: true, identityVerified: false, activationReady: false });
            const webhook = await call('getWebhookInfo');
            if (typeof webhook?.url !== 'string' || !Number.isSafeInteger(webhook.pending_update_count) || webhook.pending_update_count < 0) throw Error();
            // Do not return raw provider descriptions, webhook URLs/IPs, token or owner ID.
            return answer({ present, configured: true, identityVerified: true, bot: { id: identity.id, username: identity.username },
                webhook: webhook.url === '' ? 'absent' : expectedWebhookUrl && webhook.url === expectedWebhookUrl ? 'expected' : 'other',
                pendingUpdates: webhook.pending_update_count, activationReady: false });
        } catch {
            // Before owner verification disclose no configuration or internal auth details.
            if (!ownerVerified) return answer({ error: 'Egasi sifatida tizimga kiring.', stage: 'auth', code: 'AUTH_UNVERIFIED', activationReady: false }, 401);
            return answer({ error: 'Ulanishni tekshirish yakunlanmadi.', stage, code, ...(present ? { present } : {}), activationReady: false }, 503);
        }
    };
}

