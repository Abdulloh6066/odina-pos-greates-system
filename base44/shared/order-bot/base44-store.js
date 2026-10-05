const clone = value => structuredClone(value);
const waiting = { text: 'So‘rov tekshirilmoqda. /holat yuboring.' };
// No SQLite, filesystem, create(), delete() or auto-provisioning in this adapter.
// Conditional update correctness is a platform activation gate, not assumed evidence.
export class Base44StateStore {
    constructor(entity, { canonicalIds = {}, maxAttempts = 8, maxReceipts = 32 } = {}) {
        Object.assign(this, { entity, canonicalIds, maxAttempts, maxReceipts });
    }
    async row(sender) {
        const id = Object.hasOwn(this.canonicalIds, sender) ? this.canonicalIds[sender] : null;
        if (!id)
            throw Error('Xodim biriktirilmagan.');
        const rows = await this.entity.filter({ sender_id: sender }, '-created_date', 2);
        if (rows.length !== 1 || rows[0].id !== id || rows[0].enabled !== true || !Number.isSafeInteger(rows[0].version) || rows[0].version < 0)
            throw Error('Xodim biriktirilishi tekshirilsin.');
        return rows[0];
    }
    async binding(sender) { try {
        const r = await this.row(sender);
        return { enabled: r.enabled, staff_id: r.staff_id, scope_policy: r.scope_policy, owner_shop_ids: r.owner_shop_ids || [] };
    }
    catch {
        return null;
    } }
    state(row) {
        const s = JSON.parse(row.payload_json);
        if (!s || !Array.isArray(s.receipts) || !Number.isSafeInteger(s.floor) || s.receipts.length > this.maxReceipts || JSON.stringify(s).length > 240000)
            throw Error('Saqlangan holat tekshirilsin.');
        return s;
    }
    async get(sender) { const r = await this.row(sender); return clone(this.state(r).draft); }
    async transaction(sender, reducer) {
        for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
            const r = await this.row(sender), s = this.state(r);
            let dirty = false;
            const tx = {
                get: key => { if (key !== sender)
                    throw Error('scope'); return clone(s.draft); },
                put: (key, d) => { if (key !== sender)
                    throw Error('scope'); s.draft = clone(d); dirty = true; },
                delivery: (id, key) => {
                    if (key !== sender || !/^\d+$/.test(id))
                        throw Error('scope');
                    const old = s.receipts.find(x => x.id === id);
                    if (old)
                        return { duplicate: true, response: clone(old.response || waiting) };
                    if (Number(id) <= s.floor)
                        return { duplicate: true, response: { text: 'Bu xabar eskirgan. /holat yuboring.' } };
                    if (s.receipts.length >= this.maxReceipts) {
                        const done = s.receipts.filter(x => x.response && (!x.outbox || ['sent', 'unknown'].includes(x.outbox.status))).sort((a, b) => Number(a.id) - Number(b.id))[0];
                        if (!done)
                            throw Error('Javoblar navbati to‘lgan.');
                        s.floor = Math.max(s.floor, Number(done.id));
                        s.receipts = s.receipts.filter(x => x.id !== done.id);
                    }
                    s.receipts.push({ id, response: null });
                    dirty = true;
                    return { duplicate: false };
                },
                reply: (id, response) => { const receipt = s.receipts.find(x => x.id === id); if (!receipt)
                    throw Error('receipt'); if (!receipt.response) {
                    receipt.response = clone(response);
                    receipt.outbox = { status: 'pending' };
                    dirty = true;
                } return clone(receipt.response); },
                receipt: id => clone(s.receipts.find(x => x.id === id)),
                setOutbox: (id, outbox) => { const receipt = s.receipts.find(x => x.id === id); if (!receipt)
                    throw Error('receipt'); receipt.outbox = clone(outbox); dirty = true; },
            };
            const result = reducer(tx);
            if (result?.then)
                throw Error('Reducer must not perform asynchronous side effects');
            if (!dirty)
                return result;
            const payload = JSON.stringify(s);
            if (payload.length > 240000)
                throw Error('Holat hajmi oshgan.');
            // Include binding fields so revocation/rebinding without a version bump still blocks.
            const query = { id: r.id, sender_id: sender, enabled: true, version: r.version, phase: r.phase, staff_id: r.staff_id, scope_policy: r.scope_policy, owner_shop_ids: { $eq: r.owner_shop_ids || [] } };
            const updated = await this.entity.updateMany(query, { $set: { payload_json: payload, phase: s.draft?.status || 'idle', version: r.version + 1 } });
            // An exception is an UNKNOWN outcome: never retry this invocation's reducer.
            if (updated?.success === true && updated.has_more !== true && updated.updated === 1)
                return result;
            if (updated?.success === true && updated.has_more !== true && updated.updated === 0)
                continue;
            throw Error('Holat yozilishi tasdiqlanmadi.');
        }
        throw Error('Holat band. /holat yuboring.');
    }
    async claimReply(sender, id) { return this.transaction(sender, tx => { const r = tx.receipt(id); if (r?.outbox?.status !== 'pending')
        return null; tx.setOutbox(id, { status: 'sending' }); return r.response; }); }
    async finishReply(sender, id, messageId) { return this.transaction(sender, tx => { const r = tx.receipt(id); if (r?.outbox?.status === 'sending')
        tx.setOutbox(id, messageId ? { status: 'sent', message_id: messageId } : { status: 'unknown' }); }); }
}
