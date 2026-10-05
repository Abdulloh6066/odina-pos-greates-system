const months = { yan: 1, fev: 2, mar: 3, apr: 4, may: 5, iyn: 6, iyl: 7, avg: 8, sen: 9, okt: 10, noy: 11, dek: 12 };
export function parse(text, now) {
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
    take(/(?:^|[,;\n])\s*olish\s*:\s*(olib ketish)\b/gi, 'fulfilment', () => 'pickup');
    if (/avans|oldindan|to['‘’]?landi/i.test(text))
        errors.push('payment');
    return { patch, errors };
}
export function missing(d, now) {
    const labels = { date: 'sana (2026-10-06)', time: 'vaqt (10:00)', tier: 'narx (200 lik)', phone: 'telefon (+998901234567)', name: 'mijoz ismi (ism: Ali)', type: 'tur (tur: tugilgan_kun_va_boshqa yoki toy_va_bazmlar)', fulfilment: 'olish usuli (olish: olib ketish)', photo: 'tort rasmi' };
    const needed = Object.keys(labels).filter(k => !d[k]);
    if (d.date && d.time) {
        const t = new Date(`${d.date}T${d.time}:00+05:00`);
        if (!Number.isFinite(+t) || new Date(+t + 18000000).toISOString().slice(0, 16) !== `${d.date}T${d.time}` || t < now)
            needed.push('date', 'time');
    }
    if (d.tier && !Number.isSafeInteger(d.tier))
        needed.push('tier');
    return [...new Set(needed)].map(k => labels[k]);
}
