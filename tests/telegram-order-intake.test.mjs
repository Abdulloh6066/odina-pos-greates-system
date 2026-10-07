import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, missing, recoverContactDetails } from '../base44/shared/order-bot/parser.js';
import { OrderBot } from '../base44/shared/order-bot/bot.js';
import { Base44StateStore } from '../base44/shared/order-bot/base44-store.js';

const now = new Date('2026-10-06T23:10:00Z');
const sender = '123456';
const phone = '+998919175070';
const details = `${phone}\nAbdulloh\nOlib ketish`;
const previous = () => ({
    id: 'draft-before-fix', version: 11, sender, staff: 'owner',
    shop: 'central', shop_name: 'Odina Central', status: 'draft',
    owner_shop_choices: [{ id: 'central', name: 'Odina Central' }, { id: 'branch', name: 'Odina Branch' }],
    date: '2026-10-08', time: '16:00', type: 'tugilgan_kun_va_boshqa',
    photo: { file_id: 'reference-cake-photo' }, errors: [],
    notes: '8-okt 16:00\nЯ тебя люблю муж\nYoziladi',
});

// The production state adapter talks only to this in-memory entity in these
// tests. No SDK, provider requests or real business records are involved.
function fixture(draft = null) {
    let row = {
        id: 'binding', sender_id: sender, staff_id: 'owner', enabled: true,
        scope_policy: 'owner_choose_shop', owner_shop_ids: ['central', 'branch'],
        version: 1, phase: draft?.status || 'idle',
        payload_json: JSON.stringify({ draft, receipts: [], floor: 0 }),
    };
    const entity = {
        filter: async query => query.sender_id === row.sender_id ? [structuredClone(row)] : [],
        updateMany: async (query, update) => {
            const matches = Object.entries(query).every(([key, value]) =>
                JSON.stringify(row[key]) === JSON.stringify(value?.$eq ?? value));
            if (matches) row = { ...row, ...structuredClone(update.$set) };
            return { success: true, updated: matches ? 1 : 0, has_more: false };
        },
    };
    const store = new Base44StateStore(entity, { canonicalIds: { [sender]: row.id } });
    const staff = {
        id: 'owner', active: true, role: 'admin', is_owner: true,
        owner_shop_choices: [{ id: 'central', name: 'Odina Central' }, { id: 'branch', name: 'Odina Branch' }],
    };
    let creates = 0, saved = null, updates = 100;
    const bot = new OrderBot({
        store, bindingProvider: s => store.binding(s), now: () => now,
        pos: {
            staff: async () => staff,
            shopActive: async () => true,
            createConfirmed: async ({ draft: d }) => {
                creates++;
                saved = { complete: true, key: d.key, staff: d.staff, shop: d.shop,
                    total: d.tier, paid_amount: 0, remaining_balance: d.tier,
                    payment_status: 'unpaid', order_number: 'BO-OFFLINE-1' };
            },
            reconcile: async () => saved,
        },
        photos: { rehost: async () => 'https://base44.app/offline-reference.png' },
    });
    const message = (text, extra = {}) => bot.handle({ update_id: ++updates,
        message: { from: { id: Number(sender) }, chat: { id: Number(sender), type: 'private' }, text, ...extra } });
    const callback = data => bot.handle({ update_id: ++updates,
        callback_query: { from: { id: Number(sender) }, data,
            message: { chat: { id: Number(sender), type: 'private' } } } });
    return { store, message, callback, creates: () => creates };
}

test('screenshot follow-up recognizes phone, plain customer name and pickup', () => {
    const result = parse(details, now, previous());
    assert.deepEqual(result, { patch: { phone, fulfilment: 'pickup', name: 'Abdulloh' }, errors: [] });
    assert.deepEqual(missing({ ...previous(), ...result.patch }, now), ['Narx:']);
});

test('explicit labels and wedding type keep working', () => {
    const result = parse('Ism: Ali\nTelefon: +998901234567\nSana: 2026-10-08\nVaqt: 16:00\n200 lik\nTo‘y uchun\nOlish: olib ketish', now);
    assert.equal(result.patch.name, 'Ali');
    assert.equal(result.patch.type, 'toy_va_bazmlar');
    assert.equal(result.patch.tier, 200000);
    assert.equal(result.patch.fulfilment, 'pickup');
    assert.deepEqual(result.errors, []);
});

test('a plain name can answer the missing-name prompt separately', () => {
    assert.equal(parse('Abdulloh', now, previous()).patch.name, 'Abdulloh');
    assert.equal(parse('Abdulloh', now).patch.name, undefined);
    assert.equal(parse('Olib ketish', now, previous()).patch.fulfilment, 'pickup');
});

test('instructions and inscriptions are kept as notes, not customer names', () => {
    for (const text of ['Yoziladi', 'Я тебя люблю муж', 'To‘y uchun', 'Olib ketish', 'Ha aniq'])
        assert.equal(parse(text, now, previous()).patch.name, undefined);
    assert.equal(parse(details, now, { ...previous(), name: 'Ali' }).patch.name, undefined);
    const ambiguous = parse(`${phone}\nAbdulloh\nAli\nOlib ketish`, now, previous());
    assert.equal(ambiguous.patch.name, null);
    assert.ok(ambiguous.errors.includes('name'));
});

test('recovery from old notes only fills missing name and pickup', () => {
    const draft = { ...previous(), phone, notes: `${previous().notes}\n${previous().notes}\n${details}` };
    assert.equal(recoverContactDetails(draft, now), true);
    assert.equal(draft.name, 'Abdulloh');
    assert.equal(draft.fulfilment, 'pickup');
    assert.equal(draft.date, '2026-10-08');
    assert.equal(draft.tier, undefined);
    assert.deepEqual(draft.errors, []);
});

test('screenshot draft asks only for price, then displays confirmation without creating an order', async () => {
    const f = fixture(previous());
    const incomplete = await f.message(details);
    assert.match(incomplete.text, /Mijoz ismi: Abdulloh/);
    assert.match(incomplete.text, /Olish: olib ketish/);
    const requested = incomplete.text.split('Quyidagilarni yuboring:')[1];
    assert.match(requested, /Narx:/);
    assert.doesNotMatch(requested, /Mijoz ismi:|Olish usuli:|Telefon raqami:/);
    assert.equal(incomplete.buttons, undefined);
    const complete = await f.message('200 lik');
    assert.match(complete.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.match(complete.text, /Ism: Abdulloh/);
    assert.match(complete.text, /Narx: 200000 UZS/);
    assert.deepEqual(complete.buttons.map(b => b[0]), ['Tasdiqlash', 'Tahrirlash', 'Bekor qilish']);
    assert.equal(f.creates(), 0);
    const draft = await f.store.get(sender);
    assert.equal(draft.photo.file_id, previous().photo.file_id);
    assert.equal(draft.date, '2026-10-08');
    const saved = await f.callback(complete.buttons[0][1]);
    assert.match(saved.text, /Buyurtma saqlandi/);
    assert.equal(f.creates(), 1);
});

test('existing ignored follow-up is recovered when the next message is only the price', async () => {
    const f = fixture({ ...previous(), phone, notes: `${previous().notes}\n${details}` });
    const response = await f.message('200 lik');
    assert.match(response.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.equal(f.creates(), 0);
});

test('/holat recovers old details and only requests the still missing price', async () => {
    const draft = { ...previous(), phone, notes: `${previous().notes}\n${details}` };
    const f = fixture(draft);
    const response = await f.message('/holat');
    assert.match(response.text, /Mijoz ismi: Abdulloh/);
    assert.deepEqual(missing(await f.store.get(sender), now), ['Narx:']);
    assert.equal(f.creates(), 0);
});

test('owner must still choose the shop before confirmation', async () => {
    const f = fixture();
    const response = await f.message(`8-okt 16:00\n200 lik\n${details}`, {
        photo: [{ file_id: 'cake-photo', file_size: 1024 }],
    });
    assert.match(response.text, /qaysi do‘konda/);
    assert.deepEqual(response.buttons.map(b => b[0]), ['Odina Central', 'Odina Branch']);
    const confirmation = await f.callback(response.buttons[1][1]);
    assert.match(confirmation.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.match(confirmation.text, /Do‘kon: Odina Branch/);
    assert.equal(f.creates(), 0);
});

test('editing preserves photo and requires fresh full text before confirmation', async () => {
    const f = fixture({ ...previous(), tier: 200000, name: 'Ali', phone, fulfilment: 'pickup' });
    await f.message('/tahrir');
    const response = await f.message(`9-okt 12:00\n250 lik\n${details}`);
    assert.match(response.text, /^Shu buyurtma to‘g‘rimi\?/);
    const draft = await f.store.get(sender);
    assert.equal(draft.name, 'Abdulloh');
    assert.equal(draft.tier, 250000);
    assert.equal(draft.photo.file_id, previous().photo.file_id);
    assert.equal(f.creates(), 0);
});

test('conflicting prices and past dates never expose confirmation buttons', async () => {
    const price = fixture({ ...previous(), name: 'Ali', phone, fulfilment: 'pickup' });
    assert.equal((await price.message('200 lik yoki 250 lik')).buttons, undefined);
    const past = fixture({ ...previous(), date: '2026-10-01', tier: 200000, name: 'Ali', phone, fulfilment: 'pickup' });
    assert.equal((await past.message('/holat')).buttons, undefined);
    assert.equal(price.creates(), 0);
    assert.equal(past.creates(), 0);
});

test('full UZS amounts recognize the screenshot and common money formats', () => {
    for (const text of ['200000 som', '200 000 so‘m', "200000 so'm", '200000 so’m', '200.000 sum', '200,000 UZS', '200\u00a0000 soʻm', 'Narx: 200000', '200 lik', '200000']) {
        const result = parse(text, now, previous());
        assert.equal(result.patch.tier, 200000, text);
        assert.deepEqual(result.errors, [], text);
    }
    assert.equal(parse('200000', now).patch.tier, undefined);
    assert.equal(parse('200 som', now).patch.tier, 200);
});

test('dates, phone numbers, malformed decimals and invalid prices never become a price', () => {
    for (const text of ['8-okt 16:00', '+998919175070', '998919175070', '200000.50 som', '-200000 som', '-200 100 som', '200 5000 som', 'abc200000 som', '200000 something'])
        assert.equal(parse(text, now, previous()).patch.tier, undefined, text);
    for (const text of ['0 som', '9999999999999999999 som'])
        assert.ok(parse(text, now, previous()).errors.includes('tier'), text);
});

test('conflicting currency and lik prices stay ambiguous; equivalent prices agree', () => {
    for (const text of ['200000 som yoki 250000 som', '200 lik yoki 250000 som']) {
        const result = parse(text, now, previous());
        assert.equal(result.patch.tier, null);
        assert.ok(result.errors.includes('tier'));
    }
    assert.equal(parse('200 lik — 200000 som', now, previous()).patch.tier, 200000);
});

test('the exact screenshot price reply reaches confirmation and creates only on confirmation', async () => {
    const f = fixture({ ...previous(), phone, name: 'Abdulloh', fulfilment: 'pickup',
        notes: previous().notes + '\n' + details });
    const response = await f.message('200000 som');
    assert.match(response.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.match(response.text, /Narx: 200000 UZS/);
    assert.deepEqual(response.buttons.map(b => b[0]), ['Tasdiqlash', 'Tahrirlash', 'Bekor qilish']);
    assert.equal(f.creates(), 0);
    const draft = await f.store.get(sender);
    assert.equal(draft.date, '2026-10-08');
    assert.equal(draft.photo.file_id, previous().photo.file_id);
    assert.equal(draft.name, 'Abdulloh');
    await f.callback(response.buttons[0][1]);
    assert.equal(f.creates(), 1);
});

test('/holat recovers an already ignored 200000 som reply without resending it', async () => {
    const f = fixture({ ...previous(), phone, name: 'Abdulloh', fulfilment: 'pickup',
        notes: previous().notes + '\n' + details + '\n200000 som' });
    const response = await f.message('/holat');
    assert.match(response.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.equal((await f.store.get(sender)).tier, 200000);
    assert.equal(f.creates(), 0);
});

test('price recovery preserves existing prices and refuses conflicting old notes', async () => {
    const current = fixture({ ...previous(), phone, name: 'Abdulloh', fulfilment: 'pickup', tier: 250000, notes: '200000 som' });
    assert.match((await current.message('/holat')).text, /Narx: 250000 UZS/);
    const conflict = fixture({ ...previous(), phone, name: 'Abdulloh', fulfilment: 'pickup', notes: '200000 som\n250000 som' });
    assert.equal((await conflict.message('/holat')).buttons, undefined);
    assert.equal((await conflict.store.get(sender)).tier, undefined);
});

test('full currency prices still require owner shop selection', async () => {
    const f = fixture();
    const response = await f.message('8-okt 16:00\n200000 som\n' + details, {
        photo: [{ file_id: 'cake-photo', file_size: 1024 }],
    });
    assert.match(response.text, /qaysi do‘konda/);
    const confirmation = await f.callback(response.buttons[1][1]);
    assert.match(confirmation.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.equal(f.creates(), 0);
});

