export async function boundedBytes(response, limit) {
    if (!response.ok)
        throw Error('http');
    const stated = Number(response.headers.get('content-length'));
    if (stated > limit)
        throw Error('size');
    const reader = response.body?.getReader();
    if (!reader)
        throw Error('body');
    const parts = [];
    let size = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            throw Error('size');
        }
        parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}
