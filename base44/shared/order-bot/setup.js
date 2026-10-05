import { resolveAppUser } from '../user-helpers.ts';
import { boundedBytes } from './response-bytes.js';
export const INTAKE_CONFIG = Object.freeze({
    ownerStaffId: '6a96eb22a9fd2b34081eb2de',
    ownerShopIds: ['6a96f0a4ecc85c2fc57f3173', '6a96f0a4ecc85c2fc57f3174'],
    controlId: '6ac3ffe963d876f807aef8bf', runId: 'order-bot-cas-20261005-01',
    webhookUrl: 'https://base44.app/api/apps/6a96eb22a9fd2b34081eb2dd/functions/telegram-order-webhook',
    approvedPhotoHosts: ['base44.app'],
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const initial = () => ({ draft: null, receipts: [], floor: 0 });
export async function controlRow(entity, config = INTAKE_CONFIG) {
    const row = await entity.get(config.controlId);
    if (row?.id !== config.controlId || row.enabled !== false || row.test_run_id !== config.runId || !Number.isSafeInteger(row.version)) throw Error('control');
    return row;
}
async function changeControl(entity, row, config, data) {
    const result = await entity.updateMany({ id: config.controlId, enabled: false, test_run_id: config.runId, version: row.version, phase: row.phase }, { $set: { ...data, version: row.version + 1 } });
    if (result?.success !== true || result.updated !== 1 || result.has_more === true) throw Error('control');
    return controlRow(entity, config);
}
export async function runStateProbe(entity, config = INTAKE_CONFIG) {
    let row = await controlRow(entity, config);
    if (row.phase !== 'idle') throw Error('probe busy');
    row = await changeControl(entity, row, config, { phase: 'submitting' });
    const rounds = [];
    for (let round = 0; round < 10; round++) {
        const version = row.version;
        const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => entity.updateMany({
            id: config.controlId, enabled: false, test_run_id: config.runId, version, phase: 'submitting', owner_shop_ids: { $eq: [] },
        }, { $set: { version: version + 1, payload_json: JSON.stringify({ ...initial(), probeMarker: `${round}:${i}` }) } })));
        const winners = results.flatMap((r, i) => r.status === 'fulfilled' && r.value?.success === true && r.value.updated === 1 && r.value.has_more !== true ? [i] : []);
        if (winners.length !== 1 || results.some(r => r.status !== 'fulfilled' || r.value?.success !== true || ![0, 1].includes(r.value.updated) || r.value.has_more === true)) throw Error('probe');
        row = await controlRow(entity, config);
        if (row.version !== version + 1 || JSON.parse(row.payload_json).probeMarker !== `${round}:${winners[0]}`) throw Error('probe');
        const stale = await entity.updateMany({ id: row.id, version, enabled: false, test_run_id: config.runId }, { $set: { version: version + 1000 } });
        if (stale?.success !== true || stale.updated !== 0) throw Error('stale');
        rounds.push({ winners: 1, staleRejected: true });
    }
    // Exact-array and disabled-binding predicates must reject mismatches.
    for (const mismatch of [{ owner_shop_ids: { $eq: ['wrong-shop'] } }, { enabled: true }]) {
        const result = await entity.updateMany({ id: row.id, version: row.version, test_run_id: config.runId, ...mismatch }, { $set: { version: row.version + 1000 } });
        if (result?.success !== true || result.updated !== 0) throw Error('predicate');
    }
    const evidence = { passed: true, rounds: rounds.length, contendersPerRound: 16, staleRejected: rounds.length, checkedAt: new Date().toISOString() };
    return changeControl(entity, row, config, { phase: 'complete', payload_json: JSON.stringify({ ...initial(), probe: evidence, activation: 'off' }) });
}
export function prepareOrderBotSetup({ clientForRequest, readSecret, fetchImpl, config = INTAKE_CONFIG }) {
    return async req => {
        const answer = (body, status = 200) => Response.json({ revision: 'order-setup-v1', ...body }, { status, headers: { 'cache-control': 'no-store' } });
        let stage = 'auth', ownerVerified = false;
        if (req.method !== 'POST') return answer({ error: 'Amal noto‘g‘ri.' }, 405);
        try {
            const client = await clientForRequest(req), auth = await client.auth.me();
            if (!auth?.id) return answer({ code: 'AUTH_REQUIRED' }, 401);
            const user = await resolveAppUser(client.asServiceRole, auth);
            if (user.id !== config.ownerStaffId || !user.is_owner || user.disabled === true || user.data?.disabled === true) return answer({ code: 'OWNER_REQUIRED' }, 403);
            ownerVerified = true;
            const input = await req.text(); if (input.length > 256) return answer({ code: 'BAD_INPUT' }, 400);
            const action = JSON.parse(input || '{}').action || 'status';
            if (!['status', 'prepare', 'activate'].includes(action)) return answer({ code: 'BAD_ACTION' }, 400);
            stage = 'config';
            const token = readSecret('ODINA_ORDER_BOT_TOKEN'), sender = readSecret('ODINA_ORDER_BOT_OWNER_TELEGRAM_ID'), secret = readSecret('ODINA_ORDER_BOT_WEBHOOK_SECRET');
            if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '') || !/^[1-9]\d*$/.test(sender || '') || !Number.isSafeInteger(Number(sender)) || !/^[A-Za-z0-9_-]{32,256}$/.test(secret || '')) throw Error();
            const call = async (method, payload = {}) => {
                stage = method;
                const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(15000) });
                const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536)));
                if (body.ok !== true) throw Error();
                return body.result;
            };
            const me = await call('getMe');
            if (me?.is_bot !== true || me.username !== 'odina_buyurtmalar_bot' || !Number.isSafeInteger(me.id) || String(me.id) !== token.split(':')[0]) return answer({ code: 'WRONG_BOT' }, 409);
            let webhook = await call('getWebhookInfo');
            if (typeof webhook?.url !== 'string') throw Error();
            if (webhook.url && webhook.url !== config.webhookUrl) return answer({ code: 'OTHER_WEBHOOK', bot: me.username }, 409);
            stage = 'state';
            const entity = client.asServiceRole.entities.TelegramOrderBotState;
            let control = await controlRow(entity, config), state = JSON.parse(control.payload_json);
            if (action === 'status') return answer({ bot: me.username, webhook: webhook.url ? 'expected' : 'absent', pendingUpdates: webhook.pending_update_count, probe: state.probe || null, bindingPrepared: Boolean(state.ownerStateId), activation: state.activation || 'off' });
            // Recheck current real POS permissions and shop metadata before provisioning/activation.
            for (const id of config.ownerShopIds) {
                const shop = await client.asServiceRole.entities.Shop.get(id);
                if (!shop || shop.active === false || shop.allows_pos === false || shop.location_type === 'production') throw Error();
            }
            if (action === 'prepare') {
                if (!state.probe?.passed) { stage = 'atomic_probe'; control = await runStateProbe(entity, config); state = JSON.parse(control.payload_json); }
                if (state.activation !== 'off') return answer({ code: 'ALREADY_ACTIVATING' }, 409);
                stage = 'binding';
                let rows = await entity.filter({ sender_id: sender }, '-created_date', 2);
                if (rows.length === 0) {
                    if (state.provisioning) return answer({ code: 'BINDING_CREATE_UNCERTAIN' }, 409);
                    // Durable attempt marker before create; a lost result is looked up, never blindly repeated.
                    control = await changeControl(entity, control, config, { payload_json: JSON.stringify({ ...state, provisioning: true }) }); state = JSON.parse(control.payload_json);
                    await entity.create({ sender_id: sender, staff_id: config.ownerStaffId, enabled: false, scope_policy: 'owner_choose_shop', owner_shop_ids: config.ownerShopIds, version: 0, phase: 'idle', payload_json: JSON.stringify(initial()) });
                    rows = await entity.filter({ sender_id: sender }, '-created_date', 2);
                }
                if (rows.length !== 1 || rows[0].staff_id !== config.ownerStaffId || rows[0].scope_policy !== 'owner_choose_shop' || !equal(rows[0].owner_shop_ids, config.ownerShopIds) || rows[0].enabled !== false) throw Error();
                control = await changeControl(entity, control, config, { payload_json: JSON.stringify({ ...state, ownerStateId: rows[0].id, provisioning: false }) });
                return answer({ bot: me.username, prepared: true, bindingRecordId: rows[0].id, probe: JSON.parse(control.payload_json).probe, webhook: webhook.url ? 'expected' : 'absent', activation: 'off' });
            }
            if (!state.probe?.passed || !state.ownerStateId || !['off', 'activating', 'active'].includes(state.activation)) return answer({ code: 'PREPARE_REQUIRED' }, 409);
            const rows = await entity.filter({ sender_id: sender }, '-created_date', 2), binding = rows[0];
            if (rows.length !== 1 || binding.id !== state.ownerStateId || binding.staff_id !== config.ownerStaffId || binding.scope_policy !== 'owner_choose_shop' || !equal(binding.owner_shop_ids, config.ownerShopIds)) throw Error();
            stage = 'endpoint';
            // Wrong secret must reach our handler and fail 403; no configured credential transmitted.
            const check = await fetchImpl(config.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual', signal: AbortSignal.timeout(15000) });
            if (check.status !== 403) throw Error();
            stage = 'binding';
            if (!binding.enabled) {
                const r = await entity.updateMany({ id: binding.id, version: binding.version, enabled: false, sender_id: sender, staff_id: config.ownerStaffId, scope_policy: 'owner_choose_shop', owner_shop_ids: { $eq: config.ownerShopIds } }, { $set: { enabled: true, version: binding.version + 1 } });
                if (r?.success !== true || r.updated !== 1 || r.has_more === true) throw Error();
            }
            if (state.activation === 'off') { control = await changeControl(entity, control, config, { payload_json: JSON.stringify({ ...state, activation: 'activating' }) }); state = JSON.parse(control.payload_json); }
            if (!webhook.url) {
                // Only this new bot, fixed endpoint and existing secret; never touches report bot.
                await call('setWebhook', { url: config.webhookUrl, secret_token: secret, allowed_updates: ['message', 'callback_query'], max_connections: 1, drop_pending_updates: false });
            }
            webhook = await call('getWebhookInfo');
            if (webhook.url !== config.webhookUrl || webhook.max_connections !== 1) throw Error();
            stage = 'state';
            if (state.activation !== 'active') await changeControl(entity, control, config, { payload_json: JSON.stringify({ ...state, activation: 'active', activatedAt: new Date().toISOString() }) });
            return answer({ bot: me.username, activated: true, webhook: 'expected', maxConnections: webhook.max_connections, pendingUpdates: webhook.pending_update_count, bindingRecordId: binding.id, probe: state.probe });
        } catch {
            return answer({ code: ownerVerified ? 'SETUP_INCOMPLETE' : 'AUTH_REQUIRED', ...(ownerVerified ? { stage } : {}) }, ownerVerified ? 503 : 401);
        }
    };
}
