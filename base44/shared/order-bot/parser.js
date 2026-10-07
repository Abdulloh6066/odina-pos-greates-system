const months = {
    yan: 1, yanv: 1, fev: 2, fevr: 2, mar: 3, mart: 3, apr: 4, apre: 4,
    may: 5, iyn: 6, iyun: 6, iyl: 7, iyul: 7, avg: 8, avgu: 8,
    sen: 9, sent: 9, okt: 10, okta: 10, okty: 10, oqti: 10, okti: 10,
    noy: 11, noya: 11, dek: 12, deka: 12,
};
const monthWords = '(?:(?:yanv|fevr|mart|apre|iyun|iyul|avgu|sent|okta|okty|oqti|okti|noya|deka)[a-z]*|(?:yan|fev|mar|apr|may|iyn|iyl|avg|sen|okt|noy|dek)(?![a-z]))';
const datePattern = '\\b(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[ \\t]*[-.]?[ \\t]*' + monthWords + ')\\b';
const deliveryPattern = /(?<![\p{L}\p{N}_])(?:dastafka|dastavka|dostavka|delivery|доставка|даставка|дастафка|yetkazib\s+berish)(?![\p{L}\p{N}_])/iu;
const pickupPattern = /^(?:olish\s*:\s*)?olib\s+(?:ketish|ketadi|ketaman|ketamiz)[.!]?$/iu;
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
    take(new RegExp('(' + datePattern + ')', 'gi'), 'date', m => {
        if (/^\d{4}/.test(m[1])) return m[1];
        const parts = m[1].match(/^(\d{1,2})[ \t]*[-.]?[ \t]*([a-z]+)$/i);
        const word = parts[2].toLowerCase(), month = months[word.slice(0, 4)] ?? months[word];
        return `${new Date(+now + 18000000).getUTCFullYear()}-${String(month).padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    });
    take(/\b(\d{1,2}:\d{2})\b/g, 'time', m => m[1].padStart(5, '0'));
    // "lik" is thousands; explicit currency amounts are already full UZS.
    const prices = [...text.matchAll(/(?<![\d.,+-])\b(\d+)\s*lik\b/gi)].map(m => Number(m[1]) * 1000);
    const amount = '(?:\\d{1,3}(?:[ \\u00a0\\u202f.,]\\d{3})+|\\d+)';
    const currency = "(?:so['‘’ʻʼ]?m|sum|uzs|usz|сум)";
    for (const m of text.matchAll(new RegExp('(?<![\\d.,+-])\\b(' + amount + ')[ \\t]*' + currency + '(?![\\p{L}\\p{N}_])', 'giu')))
        if (!/[-+\d][\d \t\u00a0\u202f.,]*$/.test(text.slice(0, m.index)))
            prices.push(Number(m[1].replace(/\D/g, '')));
    // Explicit Narx labels remain valid; unlabelled numbers need a currency.
    const labelled = new RegExp('(?:^|[;\\n])[ \\t]*narx[ \\t]*:[ \\t]*(' + amount + ')[ \\t]*(?=$|[;\\n])', 'gi');
    for (const m of text.matchAll(labelled)) prices.push(Number(m[1].replace(/\D/g, '')));
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
    const delivery = text.split(/[,;\n]/).some(line => deliveryPattern.test(line)
        && !/(?:emas|kerak\s+emas|shart\s+emas|yo['‘’ʻʼ]?q)\b/iu.test(line));
    const pickup = text.split(/[,;\n]/).some(line => pickupPattern.test(line.trim()));
    if (delivery && pickup) { patch.fulfilment = null; errors.push('fulfilment'); }
    else if (delivery) patch.fulfilment = 'delivery';
    else if (pickup) patch.fulfilment = 'pickup';
    // A plain name is accepted in the contact/pickup reply, or as the sole
    // answer to a missing-name prompt. Cake inscriptions stay in notes.
    if (!draft.name && !Object.hasOwn(patch, 'name')) {
        const lines = text.split(/[,;\n]/).map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean);
        const names = lines.filter(line => line.length <= 80
            && !deliveryPattern.test(line) && !pickupPattern.test(line)
            && /^(?:[\p{L}‘’ʻʼ'-]+|\p{Lu}[\p{L}‘’ʻʼ'-]*(?: \p{Lu}[\p{L}‘’ʻʼ'-]*){1,2})$/u.test(line)
            && !/(?:^| )(?:buyurtma|tort|rasm|yoziladi|yozilad|olib|ketish|yetkazib|avans|to‘lov|narx|sana|vaqt|telefon|rahmat|salom|aniq|deb|uchun|oq|qora|pushti|qizil|rang|gullar|bezak|bento|dastafka|dastavka|dostavka)(?:$| )/iu.test(line));
        const contactReply = Boolean(patch.phone || draft.phone);
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
    if (!draft.fulfilment && !parsed.errors.includes('fulfilment') && !draft.errors?.includes('fulfilment')) {
        draft.fulfilment = 'pickup';
        changed = true;
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
    let orphanMarker = false;
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
            } else if (!before || (!inscriptionLabel.test(before) && !inlineWriting.test(before))) orphanMarker = true;
        } else {
            const inline = lines[i].match(inlineWriting);
            if (inline) { candidates.push(inline[1].replace(/^[«“"]|[»”"]$/g, '').trim()); protectedLines.add(i); }
        }
    }
    return { lines, protectedLines, explicit, candidates: [...new Set(candidates)], additional, orphanMarker };
}
// Dates/numbers inside explicit notes or proposed inscriptions are not order fields.
export function orderInput(text) {
    const { lines, protectedLines } = decorationLines(text);
    return lines.filter((_, i) => !protectedLines.has(i)).join('\n');
}
function removeOrderFields(line, draft) {
    if (/[,;](?!\d)/.test(line) && /(?:^|[,;])\s*(?:ism|telefon|sana|vaqt|narx|tur|olish)\s*:/iu.test(line))
        return line.split(/[,;](?!\d)/).map(part => removeOrderFields(part.trim(), draft)).filter(Boolean).join('; ');
    if (line === draft.name) return '';
    if (/^(?:ism|telefon|sana|vaqt|narx|tur|olish)\s*:/iu.test(line)) {
        const value = line.replace(/^[^:]+:\s*/, '');
        if (/^ism\s*:/iu.test(line) && value === draft.name) return '';
        line = value; // Preserve an unrecognized value for review.
    }
    return line
        .replace(/(?<!\d)(\+?998[\s-]*\d{2}[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})(?!\d)/g, '')
        .replace(new RegExp(datePattern, 'gi'), '')
        .replace(/\b\d{1,2}:\d{2}\b/g, '')
        .replace(/(?<![\d.,+-])\b\d+\s*lik\b/gi, '')
        .replace(/(?<![\d.,+-])\b(?:\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+|\d+)[ \t]*(?:so['‘’ʻʼ]?m|sum|uzs|usz|сум)(?![\p{L}\p{N}_])/giu, '')
        .replace(pickupPattern, '')
        .replace(/^(?:to['‘’ʻʼ]?y\s+uchun|tugilgan_kun_va_boshqa|toy_va_bazmlar)$/iu, '')
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
        inscription_unclear: !inscription && (parts.candidates.length > 1 || parts.orphanMarker),
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

export function dateProblem(d, now) {
    if (!d.date || !d.time) return '';
    const t = new Date(d.date + 'T' + d.time + ':00+05:00');
    if (!Number.isFinite(+t) || new Date(+t + 18000000).toISOString().slice(0, 16) !== d.date + 'T' + d.time)
        return 'Sana yoki vaqt noto‘g‘ri. To‘g‘ri sana va vaqt yuboring.';
    if (t < now)
        return d.date + ' ' + d.time + ' (Toshkent) o‘tib ketgan. Yangi sana va vaqt yuboring.';
    return '';
}
export function missing(d, now) {
    const labels = { date: 'Sana:', time: 'Vaqt:', tier: 'Narx:', phone: 'Telefon raqami:', name: 'Mijoz ismi:', type: 'Buyurtma turi:', fulfilment: 'Olish usuli:', photo: 'Tort rasmi:' };
    const needed = Object.keys(labels).filter(k => !d[k] && !(k === 'type' && d.type === undefined));
    if (d.date && d.time) {
        const t = new Date(`${d.date}T${d.time}:00+05:00`);
        if (!Number.isFinite(+t) || new Date(+t + 18000000).toISOString().slice(0, 16) !== `${d.date}T${d.time}` || t < now)
            needed.push('date', 'time');
    }
    if (d.fulfilment && d.fulfilment !== 'pickup') needed.push('fulfilment');
    if (d.tier && !Number.isSafeInteger(d.tier))
        needed.push('tier');
    return [...new Set(needed)].map(k => labels[k]);
}
