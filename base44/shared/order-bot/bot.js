import { randomUUID } from 'node:crypto';
import { parse, missing } from './parser.js';
const reply = text => ({ text });
export class OrderBot {
    constructor({ store, allowlist = {}, pos, photos, now = () => new Date(), bindingProvider = null, submissionEnabled = true }) { Object.assign(this, { store, allowlist, pos, photos, now, bindingProvider, submissionEnabled }); }
    async auth(s) {
        const binding = this.bindingProvider ? await this.bindingProvider(s) : null;
        const id = this.bindingProvider ? binding?.staff_id : (Object.hasOwn(this.allowlist, s) ? this.allowlist[s] : null);
        if (!id)
            return null;
        const u = await this.pos.staff(id, binding);
        return u?.id === id && u.active === true && u.data?.active !== false && ['admin', 'manager', 'cashier'].includes(u.role) && (u.owner_shop_choices?.length || (u.shop_id && await this.pos.shopActive(u.shop_id))) ? u : null;
    }
    scopeMatches(d, staff) { return d.staff === staff.id && (staff.owner_shop_choices ? (!d.shop || staff.owner_shop_choices.some(s => s.id === d.shop)) : d.shop === staff.shop_id); }
    async handle(u) {
        const cb = u?.callback_query, m = cb?.message ?? u?.message, s = String((cb?.from ?? m?.from)?.id ?? '');
        if (!Number.isSafeInteger((cb?.from ?? m?.from)?.id) || !Number.isSafeInteger(u?.update_id) || !/^[1-9]\d*$/.test(s) || m?.chat?.type !== 'private' || String(m.chat.id) !== s || m?.forward_origin || m?.forward_from || m?.forward_date || (cb?.from ?? m?.from)?.is_bot)
            return reply('Faqat shaxsiy chatda foydalaning.');
        const staff = await this.auth(s);
        if (!staff)
            return reply('Sizga ruxsat berilmagan. Mas’ul xodimga murojaat qiling.');
        const existing = await this.store.get(s);
        if (existing && !this.scopeMatches(existing, staff))
            return reply('Xodim yoki do‘kon biriktirilishi o‘zgargan. Mas’ul xodim tekshirsin.');
        const uid = String(u.update_id), delivery = await this.store.transaction(s, tx => tx.delivery(uid, s));
        if (delivery.duplicate)
            return delivery.response;
        let r;
        try {
            r = await this.process(s, staff, m, cb);
        }
        catch {
            r = reply('So‘rov yakunlanmadi. /holat yuboring; qayta buyurtma yaratmang.');
        }
        return this.store.transaction(s, tx => tx.reply(uid, r));
    }
    summary(d) {
        if (!d.shop && d.owner_shop_choices?.length)
            return { text: 'Buyurtma qaysi do‘konda saqlansin?', buttons: d.owner_shop_choices.map(s => [s.name, `shop:${d.id}:${d.version}:${s.id}`]) };
        const fields = missing(d, this.now());
        if (fields.length || d.errors?.length)
            return reply(`Aniqlashtiring: ${fields.join(', ')}${d.errors?.length ? ' Noto‘g‘ri yoki bir nechta qiymat bor; /tahrir bilan to‘liq matnni qayta yuboring.' : ''}`);
        return { text: `Buyurtma: ${d.name}, ${d.phone}\n${d.date} ${d.time} (Toshkent)\n${d.tier} UZS · 1 dona · ${d.type}\nDo‘kon: ${d.shop_name || d.shop}\nOlib ketish. To‘lanmagan, qoldiq: ${d.tier} UZS\nIzoh: ${d.notes}`, buttons: [['Tasdiqlash', `ok:${d.id}:${d.version}`], ['Tahrirlash', `edit:${d.id}:${d.version}`], ['Bekor qilish', `cancel:${d.id}:${d.version}`]] };
    }
    async process(s, staff, m, cb) {
        let d = await this.store.get(s);
        if (d && !this.scopeMatches(d, staff))
            return reply('Xodim yoki do‘kon biriktirilishi o‘zgargan. Mas’ul xodim tekshirsin.');
        if (cb) {
            const [action, id, v, shopId] = String(cb.data).split(':');
            if (!d || d.id !== id || String(d.version) !== v)
                return reply('Bu tasdiq eskirgan. /holat yuboring.');
            if (action === 'shop') {
                if (!staff.owner_shop_choices?.some(s => s.id === shopId))
                    return reply('Do‘kon tanlashga ruxsat yo‘q.');
                return this.store.transaction(s, tx => {
                    const c = tx.get(s);
                    if (c.status !== 'draft' || c.version !== d.version)
                        return reply('Bu tanlov eskirgan. /holat yuboring.');
                    c.shop = shopId;
                    c.shop_name = staff.owner_shop_choices.find(s => s.id === shopId).name;
                    c.version++;
                    tx.put(s, c);
                    return this.summary(c);
                });
            }
            if (action === 'ok')
                return this.confirm(s, d);
            if (!['edit', 'cancel'].includes(action))
                return reply('Amal noto‘g‘ri.');
            return this.store.transaction(s, tx => {
                const c = tx.get(s);
                if (c.status !== 'draft' || c.version !== d.version)
                    return reply('Buyurtma tekshirilmoqda. /holat yuboring.');
                c.version++;
                c.status = action === 'cancel' ? 'cancelled' : 'draft';
                if (action === 'edit')
                    c.editing = true;
                tx.put(s, c);
                return reply(action === 'cancel' ? 'Buyurtma bekor qilindi.' : 'To‘liq yangi matnni yuboring. Rasm saqlanadi.');
            });
        }
        const text = String(m.text ?? m.caption ?? '');
        if (/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/.test(text))
            return reply('Maxfiy kalitni chatga yubormang. Mas’ul xodimga murojaat qiling.');
        if (['/start', '/yordam'].includes(text)) return reply('Assalomu alaykum! Tort rasmi va buyurtma matnini yuboring.\nMasalan: 2026-10-10 10:00, 200 lik, +998901234567, ism: Ali, tur: tugilgan_kun_va_boshqa, olish: olib ketish.\n200 lik — 200 000 so‘m. Avans qabul qilinmaydi. Yakuniy ma’lumotlarni ko‘rib, Tasdiqlash tugmasini bosing.\n/holat — holat, /tahrir — tahrirlash, /bekor — bekor qilish.');
        if (text === '/holat') {
            if (!d)
                return reply('Rasm va buyurtma matnini yuboring.');
            if (['submitting', 'uncertain', 'complete'].includes(d.status))
                return this.reconcile(s, d);
            if (d.status === 'cancelled')
                return reply('Buyurtma bekor qilingan.');
            return this.summary(d);
        }
        return this.store.transaction(s, tx => {
            d = tx.get(s);
            if (d && ['submitting', 'uncertain'].includes(d.status))
                return reply('Buyurtma tekshirilmoqda. /holat yuboring.');
            if (!d || ['cancelled', 'complete'].includes(d.status))
                d = { id: randomUUID().slice(0, 16), version: 0, sender: s, staff: staff.id, shop: staff.owner_shop_choices ? '' : staff.shop_id, shop_name: staff.shop_name, owner_shop_choices: staff.owner_shop_choices, status: 'draft', notes: '', errors: [] };
            if (text === '/bekor') {
                d.status = 'cancelled';
                d.version++;
                tx.put(s, d);
                return reply('Buyurtma bekor qilindi.');
            }
            if (text === '/tahrir') {
                d.editing = true;
                d.version++;
                tx.put(s, d);
                return reply('To‘liq yangi matnni yuboring.');
            }
            if (text.length > 2000 || d.notes.length + text.length > 3500)
                return reply('Matn juda uzun. /tahrir bilan qisqaroq yuboring.');
            if (d.editing && text) {
                for (const k of ['date', 'time', 'tier', 'phone', 'name', 'type', 'fulfilment'])
                    delete d[k];
                d.notes = '';
                d.errors = [];
                d.editing = false;
            }
            const p = parse(text, this.now());
            Object.assign(d, p.patch);
            d.errors.push(...p.errors);
            if (text)
                d.notes = (d.notes + '\n' + text).trim();
            const photo = m.photo?.at(-1);
            if (photo?.file_id && photo.file_size <= 10485760)
                d.photo = { file_id: photo.file_id };
            d.version++;
            tx.put(s, d);
            return this.summary(d);
        });
    }
    async confirm(s, snapshot) {
        if (!this.submissionEnabled)
            return reply('Buyurtma yuborish hozircha yoqilmagan. Mas’ul xodimga murojaat qiling.');
        if (!snapshot.shop)
            return this.summary(snapshot);
        if (snapshot.editing)
            return reply('Avval yangi matnni yuboring.');
        if (missing(snapshot, this.now()).length || snapshot.errors.length)
            return this.summary(snapshot);
        const d = await this.store.transaction(s, tx => {
            const c = tx.get(s);
            if (c.status !== 'draft' || c.version !== snapshot.version)
                return null;
            c.status = 'submitting';
            c.key = `odina-order-bot:${c.id}:${c.version}`;
            tx.put(s, c);
            return c;
        });
        if (!d)
            return this.reconcile(s, await this.store.get(s));
        try {
            const image = await this.photos.rehost(d.photo);
            d.reference_image = image;
            await this.store.transaction(s, tx => {
                const c = tx.get(s);
                if (c.key !== d.key || !['submitting', 'uncertain'].includes(c.status))
                    throw Error('claim');
                c.reference_image = image;
                tx.put(s, c);
            });
            const staff = await this.auth(s);
            if (!staff || !this.scopeMatches(d, staff))
                throw Error('scope');
            await this.pos.createConfirmed({ draft: d, image, staffId: staff.id });
        }
        catch { /* Any failure may hide a completed write: reconcile, never blindly resubmit. */ }
        return this.reconcile(s, d);
    }
    async reconcile(s, d) {
        const staff = await this.auth(s);
        if (!staff || !this.scopeMatches(d, staff))
            return reply('Ruxsat o‘zgargan. Mas’ul xodim tekshirsin.');
        let r;
        try {
            r = await this.pos.reconcile(d);
        }
        catch {
            r = null;
        }
        const valid = r?.complete === true && r.key === d.key && r.staff === d.staff && r.shop === d.shop && r.total === d.tier && r.paid_amount === 0 && r.remaining_balance === d.tier && r.payment_status === 'unpaid' && /^BO-[A-Z0-9-]+$/.test(r.order_number);
        await this.store.transaction(s, tx => {
            const c = tx.get(s);
            if (c?.key === d.key) {
                c.status = valid ? 'complete' : 'uncertain';
                tx.put(s, c);
            }
        });
        return reply(valid ? `Buyurtma saqlandi: ${r.order_number}. To‘lanmagan, qoldiq: ${r.remaining_balance} UZS.` : 'Natija tekshirilmoqda. /holat yuboring. Yangi buyurtma yaratmang.');
    }
}
