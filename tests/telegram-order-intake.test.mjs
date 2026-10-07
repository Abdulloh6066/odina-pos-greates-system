import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, missing, recoverContactDetails, updateCustomization, orderNotes, dateProblem } from '../base44/shared/order-bot/parser.js';
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
    notes: '8-okt 16:00',
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
    for (const text of ['200000 som', '200 000 so‘m', "200000 so'm", '200000 so’m', '200.000 sum', '200,000 UZS', '200\u00a0000 soʻm', 'Narx: 200000', '200 lik']) {
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


const ready = (notes = '') => ({ ...previous(), phone, name: 'Abdulloh',
    fulfilment: 'pickup', tier: 200000, notes });
const writing = 'Я тебя люблю муж';

test('redundant writing marker after an explicit inscription does not become a note', () => {
    const draft = ready('Tortdagi yozuv: ' + writing + '\nYozilad');
    updateCustomization(draft);
    assert.equal(orderNotes(draft), 'Tortdagi yozuv: ' + writing);
    assert.equal(draft.inscription_unclear, false);
});

test('an orphan writing instruction asks for clarification; text with numbers stays intact', async () => {
    const f = fixture(ready('Ali 20 yosh\nYoziladi'));
    const response = await f.message('/holat');
    assert.match(response.text, /Tortdagi yozuvni aniqlashtiring/);
    assert.ok(response.text.includes('Ali 20 yosh'));
    assert.equal(response.buttons, undefined);
});

test('comma-separated labelled fields stay out of additional notes', () => {
    const draft = ready('Ism: Abdulloh, Telefon: ' + phone + ', Sana: 2026-10-08, Vaqt: 16:00, Narx: 200,000 UZS, Olish: olib ketish\nIzoh: Oq, pushti gullar');
    updateCustomization(draft);
    assert.equal(orderNotes(draft), 'Izoh: Oq, pushti gullar');
});

test('explicit inscription and notes stay separate; order fields do not repeat in notes', () => {
    const draft = ready('8-okt 16:00\n200 lik razmerda\n' + details +
        '\nTortdagi yozuv: ' + writing + '\nIzoh: oq rangda bezatilsin');
    updateCustomization(draft);
    assert.equal(draft.inscription, writing);
    assert.equal(draft.additional_notes, 'oq rangda bezatilsin');
    assert.equal(orderNotes(draft), 'Tortdagi yozuv: ' + writing + '\nIzoh: oq rangda bezatilsin');
    assert.equal(draft.inscription_pending, false);
});

test('inscriptions and explicit notes cannot overwrite dates, prices or names', () => {
    const result = parse('Tortdagi yozuv: Ali 20 yosh 9-okt 10:00 250 lik\nIzoh: 200000 som yozilmasin', now, previous());
    assert.deepEqual(result, { patch: {}, errors: [] });
    assert.deepEqual(parse('Ali\nYozilad', now, previous()), { patch: {}, errors: [] });
});

test('the screenshot writing marker requires a decision before order confirmation', async () => {
    for (const marker of ['Yozilad', 'Yoziladi']) {
        const f = fixture(ready('8-okt 16:00\n' + writing + '\n' + marker +
            '\n200000 som\n' + details));
        const question = await f.message('/holat');
        assert.equal(question.text, 'Tortga «' + writing + '» deb yozilsinmi?');
        assert.deepEqual(question.buttons.map(b => b[0]), ['Ha, yozilsin', 'Yo‘q, izoh sifatida']);
        const draft = await f.store.get(sender);
        const forgedConfirm = await f.callback('ok:' + draft.id + ':' + draft.version);
        assert.equal(forgedConfirm.text, question.text);
        assert.equal(f.creates(), 0);
        const confirmation = await f.callback(question.buttons[0][1]);
        assert.match(confirmation.text, /^Shu buyurtma to‘g‘rimi\?/);
        assert.match(confirmation.text, /Tortdagi yozuv: Я тебя люблю муж/);
        assert.doesNotMatch(confirmation.text, /Yozilad/);
        assert.equal(orderNotes(await f.store.get(sender)), 'Tortdagi yozuv: ' + writing);
        assert.equal(f.creates(), 0);
        await f.callback(confirmation.buttons[0][1]);
        assert.equal(f.creates(), 1);
    }
});

test('declining inscription keeps the text as an additional note', async () => {
    const f = fixture(ready(writing + '\nYozilad\nIzoh: oq rangda'));
    const question = await f.message('/holat');
    const confirmation = await f.callback(question.buttons[1][1]);
    assert.match(confirmation.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.doesNotMatch(confirmation.text, /Tortdagi yozuv:/);
    const notes = orderNotes(await f.store.get(sender));
    assert.ok(notes.includes(writing));
    assert.ok(notes.includes('oq rangda'));
    assert.equal(f.creates(), 0);
    assert.match((await f.callback(question.buttons[0][1])).text, /eskirgan/);
});

test('unknown design text is preserved, repeated notes are deduplicated', () => {
    const draft = ready('Oq gullar\nOq gullar\n200000 som\nOlganda beradi pulini');
    updateCustomization(draft);
    assert.equal(orderNotes(draft), 'Izoh: Oq gullar\nOlganda beradi pulini');
    assert.equal(draft.inscription_pending, false);
});

test('multiple proposed writings ask for an explicit inscription, retaining all text', async () => {
    const f = fixture(ready('Birinchi matn\nYoziladi\nIkkinchi matn\nYoziladi'));
    const response = await f.message('/holat');
    assert.match(response.text, /Tortdagi yozuvni aniqlashtiring/);
    assert.equal(response.buttons, undefined);
    assert.ok(response.text.includes('Birinchi matn'));
    assert.ok(response.text.includes('Ikkinchi matn'));
    const clarified = await f.message('Tortdagi yozuv: Yakuniy matn');
    assert.match(clarified.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.equal((await f.store.get(sender)).inscription, 'Yakuniy matn');
});

test('editing resets inscription decisions, retains the photo and asks again for new writing', async () => {
    const f = fixture(ready(writing + '\nYoziladi'));
    const first = await f.message('/holat');
    await f.callback(first.buttons[0][1]);
    await f.message('/tahrir');
    const response = await f.message('8-okt 16:00\n200000 som\n' + details + '\nBoshqa matn\nYozilad');
    assert.equal(response.text, 'Tortga «Boshqa matn» deb yozilsinmi?');
    assert.equal((await f.store.get(sender)).photo.file_id, previous().photo.file_id);
    assert.equal(f.creates(), 0);
});

test('old order confirmation buttons cannot bypass a newly required inscription decision', async () => {
    const old = ready(writing + '\nYoziladi');
    const f = fixture(old);
    const response = await f.callback('ok:' + old.id + ':' + old.version);
    assert.match(response.text, /Tortga «Я тебя люблю муж»/);
    assert.equal(f.creates(), 0);
});

test('historical notes keep their original value until an unsubmitted draft is migrated', () => {
    const old = ready('8-okt 16:00\n' + writing + '\nYoziladi');
    assert.equal(orderNotes(old), old.notes);
    updateCustomization(old);
    assert.equal(old.inscription_pending, true);
    assert.equal(old.notes, '8-okt 16:00\n' + writing + '\nYoziladi');
});


test('all twelve months accept their first four letters and remaining spelling variants', () => {
    const names = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
    for (const [index, month] of names.entries()) {
        for (const word of [month, month.slice(0, 4), month.length >= 4 ? month.slice(0, 4) + 'xyz' : month]) {
            const result = parse('7- ' + word + ' 17:00', now);
            assert.equal(result.patch.date, '2026-' + String(index + 1).padStart(2, '0') + '-07', word);
        }
    }
    for (const text of ['7 oktabr', '7-oqtiyabr', '7- oqtiyabr', '7 OKTYABR', '7.oktabr', '7-okt'])
        assert.equal(parse(text, now).patch.date, '2026-10-07', text);
    assert.equal(parse('7 iyu', now).patch.date, undefined);
    assert.equal(parse('7 Unknownmonth', now).patch.date, undefined);
});

test('explicit som, UZS and USZ prices are exact, without guessing or multiplying', () => {
    for (const text of ['8500 som', '8500 UZS', '8500 usz', '8500som', "8500 so'm", 'Narx: 8500 UZS'])
        assert.equal(parse(text, now, previous()).patch.tier, 8500, text);
    assert.equal(parse('85 som', now).patch.tier, 85);
    assert.equal(parse('8500', now, previous()).patch.tier, undefined);
    assert.equal(parse('8500\n' + details, now, previous()).patch.tier, undefined);
    assert.equal(parse('85 lik', now).patch.tier, 85000);
});

test('lowercase customer names are recognized with contact context or a missing-name reply', () => {
    for (const name of ['abdurahim', 'ali', 'vali', 'Олег'])
        assert.equal(parse(phone + '\n' + name, now, previous()).patch.name, name);
    assert.equal(parse('abdurahim', now, previous()).patch.name, 'abdurahim');
    assert.equal(parse('abdurahim', now).patch.name, undefined);
    assert.equal(parse(phone + '\nAbdurahim\nAli', now, previous()).patch.name, null);
    assert.equal(parse(phone + '\nIzoh: Oq gullar', now, previous()).patch.name, undefined);
});

test('the latest screenshot wording accepts corrected date, lowercase name and pickup variant', async () => {
    const f = fixture({ ...previous(), date: '2026-10-06' });
    const response = await f.message('85000 som\n' + phone + '\nabdurahim\nolib ketadi\n7- oqtiyabr 17:00');
    assert.match(response.text, /^Shu buyurtma to‘g‘rimi\?/);
    const d = await f.store.get(sender);
    assert.equal(d.date, '2026-10-07');
    assert.equal(d.time, '17:00');
    assert.equal(d.tier, 85000);
    assert.equal(d.name, 'abdurahim');
    assert.equal(d.fulfilment, 'pickup');
    assert.equal(orderNotes(d), '');
    assert.equal(f.creates(), 0);
});

test('pickup defaults when omitted, and all pickup variants are recognized', async () => {
    for (const wording of ['', '\nolib ketish', '\nolib ketadi', '\nolib ketaman', '\nolib ketamiz', '\nDastafka kerak emas']) {
        const f = fixture(previous());
        const response = await f.message('85000 UZS\n' + phone + '\nabdurahim' + wording);
        assert.match(response.text, /^Shu buyurtma to‘g‘rimi\?/, wording);
        assert.equal((await f.store.get(sender)).fulfilment, 'pickup');
        assert.equal(f.creates(), 0);
    }
});

test('delivery requests and conflicting methods cannot silently become pickup orders', async () => {
    for (const wording of ['dastafka', 'dostavka', 'yetkazib berish', 'delivery']) {
        const f = fixture(ready());
        const response = await f.message(wording);
        assert.equal((await f.store.get(sender)).fulfilment, 'delivery');
        assert.equal(response.buttons, undefined);
        assert.match(response.text, /Yetkazib berish bu botda hali yoqilmagan/);
        assert.equal(f.creates(), 0);
        const correction = await f.message('olib ketish');
        assert.match(correction.text, /^Shu buyurtma to‘g‘rimi\?/);
    }
    const f = fixture(ready());
    const response = await f.message('dastafka\nolib ketish');
    assert.equal(response.buttons, undefined);
    assert.equal(f.creates(), 0);
});

test('past dates explain the reason, and impossible dates remain blocked', async () => {
    const past = ready();
    past.date = '2026-10-06';
    past.time = '17:00';
    const f = fixture(past);
    assert.match((await f.message('/holat')).text, /2026-10-06 17:00 \(Toshkent\) o‘tib ketgan/);
    const future = await f.message('7- oqtiyabr 17:00');
    assert.match(future.text, /^Shu buyurtma to‘g‘rimi\?/);
    assert.equal(f.creates(), 0);
    assert.match(dateProblem({ date: '2026-02-30', time: '17:00' }, now), /noto‘g‘ri/);
    assert.match(dateProblem({ date: '2026-10-07', time: '25:00' }, now), /noto‘g‘ri/);
});

test('month and currency aliases do not leak into cleaned notes or parse inscriptions', () => {
    const draft = ready('7- oqtiyabr 17:00\n85000 USZ\n' + phone + '\nAbdulloh\nolib ketadi\nIzoh: oq rangda');
    updateCustomization(draft);
    assert.equal(orderNotes(draft), 'Izoh: oq rangda');
    const result = parse('Tortdagi yozuv: 7- oqtiyabr 8500 USZ\nIzoh: dastafka', now, previous());
    assert.deepEqual(result.patch, {});
});

