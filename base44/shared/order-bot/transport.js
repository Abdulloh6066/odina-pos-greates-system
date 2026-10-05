import { timingSafeEqual } from 'node:crypto';
// No server is started. Only an in-process Request/Response boundary for offline tests.
export function localWebhook(bot, { secret = '' } = {}) {
    return async (req) => {
        const supplied = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
        const a = Buffer.from(secret), b = Buffer.from(supplied);
        if (!a.length || a.length !== b.length || !timingSafeEqual(a, b))
            return new Response('Ruxsat yo‘q.', { status: 403 });
        if (req.method !== 'POST')
            return new Response('Amal noto‘g‘ri.', { status: 405 });
        const reader = req.body?.getReader();
        let length = 0;
        const chunks = [];
        if (!reader)
            return new Response('Ma’lumot yo‘q.', { status: 400 });
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            length += value.length;
            if (length > 32768) {
                await reader.cancel();
                return new Response('Ma’lumot juda katta.', { status: 413 });
            }
            chunks.push(value);
        }
        try {
            return Response.json(await bot.handle(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        }
        catch {
            return new Response('So‘rov yakunlanmadi.', { status: 503 });
        }
    };
}
