const months = { yan: 1, fev: 2, mar: 3, apr: 4, may: 5, iyn: 6, iyl: 7, avg: 8, sen: 9, okt: 10, noy: 11, dek: 12 };
export function parse(text, now, draft = {}) {
    text = orderInput(text);
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
    // "lik" is thousands; explicit currency amounts are already full UZS.
    const prices = [...text.matchAll(/(?<![\d.,+-])\b(\d+)\s*lik\b/gi)].map(m => Number(m[1]) * 1000);
    const amount = '(?:\\d{1,3}(?:[ \\u00a0\\u202f.,]\\d{3})+|\\d+)';
    const currency = "(?:so['‘’ʻʼ]?m|sum|uzs|сум)";
    for (const m of text.matchAll(new RegExp('(?<![\\d.,+-])\\b(' + amount + ')[ \\t]*' + currency + '(?![\\p{L}\\p{N}_])', 'giu')))
        if (!/[-+\d][\d \t\u00a0\u202f.,]*$/.test(text.slice(0, m.index)))
            prices.push(Number(m[1].replace(/\D/g, '')));
    // A labelled full amount, or a number-only reply while awaiting a price.
    const labelled = new RegExp('(?:^|[;\\n])[ \\t]*narx[ \\t]*:[ \\t]*(' + amount + ')[ \\t]*(?=$|[;\\n])', 'gi');
    for (const m of text.matchAll(labelled)) prices.push(Number(m[1].replace(/\D/g, '')));
    if (!draft.tier && !/^998\d{9}$/.test(text.trim()) && (draft.date || draft.time || draft.photo) && new RegExp('^[ \\t]*(' + amount + ')[ \\t]*$').test(text))
        prices.push(Number(text.replace(/\D/g, '')));
    const distinctPrices = [...new Set(prices)];
    if (distinctPrices.length === 1 && Number.isSafeInteger(distinctPrices[0]) && distinctPrices[0] > 0)
        patch.tier = distinctPrices[0];
    else if (distinctPrices.length) { patch.tier = null; errors.push('tier'); }
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
// Recover an explicit, unambiguous price that the older parser ignored.
// Existing prices and drafts with a price conflict are never overwritten.
export function recoverMissingPrice(draft, now) {
    if (draft.tier || draft.errors?.includes('tier')) return false;
    const parsed = parse(draft.notes || '', now, draft);
    if (!parsed.patch.tier || parsed.errors.includes('tier')) return false;
    draft.tier = parsed.patch.tier;
    return true;
}

const inscriptionLabel = /^(?:tort(?:dagi|ga)?\s+yozuv|yozuv)\s*:\s*(.+)$/iu;
const noteLabel = /^(?:izoh|qo['‘’ʻʼ]?shimcha\s+izoh)\s*:\s*(.+)$/iu;
const writingMarker = /^(?:yoziladi|yozilad|yozilsin)[.!]?$/iu;
const inlineWriting = /^(.+?)\s+(?:deb\s+)?(?:yoziladi|yozilad|yozilsin)[.!]?$/iu;
function decorationLines(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const protectedLines = new Set(), explicit = [], candidates = [], additional = [];
    for (let i = 0; i < lines.length; i++) {
        const label = lines[i].match(inscriptionLabel), note = lines[i].match(noteLabel);
        if (label) { explicit.push(label[1].trim()); protectedLines.add(i); }
        else if (note) { additional.push(note[1].trim()); protectedLines.add(i); }
        else if (writingMarker.test(lines[i])) {
            protectedLines.add(i);
            // A marker applies to the preceding unlabelled text, not a data field.
            const before = lines[i - 1];
            if (before && !protectedLines.has(i - 1) && !/[:\d]/u.test(before) && !/^(?:olib\s+ketish|to['‘’ʻʼ]?y\s+uchun)$/iu.test(before)) {
                candidates.push(before); protectedLines.add(i - 1);
            } else additional.push(lines[i]);
        } else {
            const inline = lines[i].match(inlineWriting);
            if (inline) { candidates.push(inline[1].replace(/^[«“"]|[»”"]$/g, '').trim()); protectedLines.add(i); }
        }
    }
    return { lines, protectedLines, explicit, candidates: [...new Set(candidates)], additional };
}
// Dates/numbers inside explicit notes or proposed inscriptions are not order fields.
export function orderInput(text) {
    const { lines, protectedLines } = decorationLines(text);
    return lines.filter((_, i) => !protectedLines.has(i)).join('\n');
}
function removeOrderFields(line, draft) {
    if (line === draft.name) return '';
    if (/^(?:ism|telefon|sana|vaqt|narx|tur|olish)\s*:/iu.test(line)) {
        const value = line.replace(/^[^:]+:\s*/, '');
        const parsed = parse(line, new Date(), draft);
        if (Object.keys(parsed.patch).length && !parsed.errors.length) return '';
        line = value; // Preserve an unrecognized value for review.
    }
    return line
        .replace(/(?<!\d)(\+?998[\s-]*\d{2}[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})(?!\d)/g, '')
        .replace(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}-(?:yan|fev|mar|apr|may|iyn|iyl|avg|sen|okt|noy|dek))\b/gi, '')
        .replace(/\b\d{1,2}:\d{2}\b/g, '')
        .replace(/(?<![\d.,+-])\b\d+\s*lik\b/gi, '')
        .replace(/(?<![\d.,+-])\b(?:\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+|\d+)[ \t]*(?:so['‘’ʻʼ]?m|sum|uzs|сум)(?![\p{L}\p{N}_])/giu, '')
        .replace(/^(?:olib\s+ketish|to['‘’ʻʼ]?y\s+uchun|tugilgan_kun_va_boshqa|toy_va_bazmlar)$/iu, '')
        .replace(new RegExp('^' + String(draft.tier || 'NO_PRICE') + '$'), '')
        .replace(/^[\s,;—-]*(?:razmerda)?[\s,;—-]*$/iu, '')
        .trim();
}
export function updateCustomization(draft) {
    const parts = decorationLines(draft.notes || '');
    const additional = [...parts.additional];
    for (let i = 0; i < parts.lines.length; i++) {
        if (!parts.protectedLines.has(i)) {
            const rest = removeOrderFields(parts.lines[i], draft);
            if (rest) additional.push(rest);
        }
    }
    const candidate = parts.candidates.length === 1 ? parts.candidates[0] : '';
    const decision = draft.inscription_decision?.text === candidate ? draft.inscription_decision : null;
    let inscription = parts.explicit.at(-1) || '';
    let pending = false;
    if (!inscription && candidate) {
        if (decision?.accepted === true) inscription = candidate;
        else if (decision?.accepted === false) additional.push(candidate);
        else pending = true;
    }
    if (parts.candidates.length > 1) additional.push(...parts.candidates);
    const values = {
        notes_format_version: 1, inscription, inscription_candidate: candidate,
        inscription_pending: pending,
        additional_notes: [...new Set(additional)].join('\n'),
    };
    const changed = Object.entries(values).some(([k, v]) => draft[k] !== v);
    Object.assign(draft, values);
    return changed;
}
// New drafts use reviewed customization; old saved drafts retain their original
// text so reconciliation never rewrites or reinterprets historical orders.
export function orderNotes(draft) {
    if (draft.notes_format_version !== 1) return draft.notes;
    return [
        draft.inscription ? 'Tortdagi yozuv: ' + draft.inscription : '',
        draft.additional_notes ? 'Izoh: ' + draft.additional_notes : '',
    ].filter(Boolean).join('\n');
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
