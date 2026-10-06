const months = { yan: 1, fev: 2, mar: 3, apr: 4, may: 5, iyn: 6, iyl: 7, avg: 8, sen: 9, okt: 10, noy: 11, dek: 12 };
export function parse(text, now, draft = {}) {
    const patch = {}, errors = [];
    function take(regex, key, convert = m => m[1]) {
        const a = [...text.matchAll(regex)];
        if (a.length === 1)
            patch[key] = convert(a[0]);
        if (a.length > 1) {
            patch[key] = null;
            errors.push(key);
        }
    }
    take(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}-(?:yan|fev|mar|apr|may|iyn|iyl|avg|sen|okt|noy|dek))\b/gi, 'date', m => {
        if (/^\d{4}/.test(m[1]))
            return m[1];
        const [d, month] = m[1].toLowerCase().split('-');
        return `${new Date(+now + 18000000).getUTCFullYear()}-${String(months[month]).padStart(2, '0')}-${d.padStart(2, '0')}`;
    });
    take(/\b(\d{1,2}:\d{2})\b/g, 'time', m => m[1].padStart(5, '0'));
    take(/(?<![\d.,])\b(\d+)\s*lik\b/gi, 'tier', m => Number(m[1]) * 1000);
    take(/(?<!\d)(\+?998[\s-]*\d{2}[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})(?!\d)/g, 'phone', m => '+' + m[1].replace(/\D/g, ''));
    take(/(?:^|[,;\n])\s*ism\s*:\s*([^,;\n]+)/gi, 'name', m => m[1].trim());
    take(/(?:^|[,;\n])\s*tur\s*:\s*(tugilgan_kun_va_boshqa|toy_va_bazmlar)\b/gi, 'type');
    if (/\bto['‘’ʻʼ]?y\s+uchun\b/i.test(text)) {
        if (Object.hasOwn(patch, 'type') && patch.type !== 'toy_va_bazmlar') {
            patch.type = null;
            if (!errors.includes('type')) errors.push('type');
        } else patch.type = 'toy_va_bazmlar';
    }
    take(/(?:^|[,;\n])\s*olish\s*:\s*(olib ketish)\b/gi, 'fulfilment', () => 'pickup');
    if (!Object.hasOwn(patch, 'fulfilment') && /(?:^|[,;\n])\s*olib\s+ketish[.!]?\s*(?=$|[,;\n])/i.test(text))
        patch.fulfilment = 'pickup';
    // A plain name is accepted in the contact/pickup reply, or as the sole
    // answer to a missing-name prompt. Cake inscriptions stay in notes.
    if (!draft.name && !Object.hasOwn(patch, 'name')) {
        const lines = text.split(/[,;\n]/).map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean);
        const names = lines.filter(line => line.length <= 80
            && /^\p{Lu}[\p{L}‘’ʻʼ'-]*(?: \p{Lu}[\p{L}‘’ʻʼ'-]*){0,2}$/u.test(line)
            && !/(?:^| )(?:buyurtma|tort|rasm|yoziladi|yozilad|olib|ketish|yetkazib|avans|to‘lov|narx|sana|vaqt|telefon|rahmat|salom|aniq)(?:$| )/iu.test(line));
        const contactReply = Boolean((patch.phone || draft.phone) && (patch.fulfilment || draft.fulfilment));
        const nameReply = !draft.name && lines.length === 1 && Boolean(draft.date || draft.time || draft.photo || draft.phone);
        if (contactReply || nameReply) {
            if (names.length === 1) patch.name = names[0];
            if (names.length > 1) { patch.name = null; errors.push('name'); }
        }
    }
    if (/avans|oldindan|to['‘’]?landi/i.test(text))
        errors.push('payment');
    return { patch, errors };
}
// Recover only previously unrecognized contact details on the next normal
// interaction. Do not replay prices/dates from accumulated notes.
export function recoverContactDetails(draft, now) {
    const parsed = parse(draft.notes || '', now, draft);
    let changed = false;
    for (const key of ['name', 'fulfilment']) {
        if (!draft[key] && parsed.patch[key] && !parsed.errors.includes(key)) {
            draft[key] = parsed.patch[key];
            changed = true;
        }
    }
    return changed;
}
export function missing(d, now) {
    const labels = { date: 'Sana:', time: 'Vaqt:', tier: 'Narx:', phone: 'Telefon raqami:', name: 'Mijoz ismi:', type: 'Buyurtma turi:', fulfilment: 'Olish usuli:', photo: 'Tort rasmi:' };
    const needed = Object.keys(labels).filter(k => !d[k] && !(k === 'type' && d.type === undefined));
    if (d.date && d.time) {
        const t = new Date(`${d.date}T${d.time}:00+05:00`);
        if (!Number.isFinite(+t) || new Date(+t + 18000000).toISOString().slice(0, 16) !== `${d.date}T${d.time}` || t < now)
            needed.push('date', 'time');
    }
    if (d.tier && !Number.isSafeInteger(d.tier))
        needed.push('tier');
    return [...new Set(needed)].map(k => labels[k]);
}
