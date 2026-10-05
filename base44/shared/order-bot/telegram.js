import { boundedBytes } from './response-bytes.js';
export class TelegramAdapter {
    #token;
    constructor({ token = '', fetchImpl, enabled = false, timeoutMs = 10000 }) {
        if (typeof fetchImpl !== 'function')
            throw Error('Transport talab qilinadi.');
        this.#token = token;
        Object.assign(this, { fetchImpl, enabled, timeoutMs });
    }
    async request(method, payload) {
        try {
            if (!this.enabled || !this.#token || !['getFile', 'sendMessage', 'answerCallbackQuery'].includes(method))
                throw Error('disabled');
            const response = await this.fetchImpl(`https://api.telegram.org/bot${this.#token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
            const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536)));
            if (body.ok !== true)
                throw Error('api');
            return body.result;
        }
        catch {
            throw Error('Telegram amali tasdiqlanmadi.');
        }
    }
    async downloadBytes(fileId) {
        try {
            if (typeof fileId !== 'string' || fileId.length > 512 || /[/:?]/.test(fileId))
                throw Error('file');
            const file = await this.request('getFile', { file_id: fileId });
            if (file?.file_id !== fileId || file.file_size > 10485760 || typeof file.file_path !== 'string' || !/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(file.file_path) || file.file_path.includes('..'))
                throw Error('file');
            const response = await this.fetchImpl(`https://api.telegram.org/file/bot${this.#token}/${file.file_path}`, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
            return await boundedBytes(response, 10485760);
        }
        catch {
            throw Error('Rasmni yuklab bo‘lmadi.');
        }
    }
    async sendReply(sender, response) {
        if (!/^[1-9]\d*$/.test(String(sender)) || typeof response?.text !== 'string' || response.text.length > 4096)
            throw Error('Javob noto‘g‘ri.');
        const keyboard = response.buttons?.map(([text, data]) => {
            if (typeof text !== 'string' || typeof data !== 'string' || new TextEncoder().encode(data).length > 64)
                throw Error('Tugma noto‘g‘ri.');
            return [{ text, callback_data: data }];
        });
        const result = await this.request('sendMessage', { chat_id: sender, text: response.text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
        if (!Number.isSafeInteger(result?.message_id) || String(result.chat?.id) !== String(sender))
            throw Error('Telegram javobi tasdiqlanmadi.');
        return result.message_id;
    }
    async acknowledge(callbackId) { if (typeof callbackId !== 'string' || callbackId.length > 200)
        return; await this.request('answerCallbackQuery', { callback_query_id: callbackId, text: 'So‘rov tekshirildi.' }); }
}
export function base44PhotoUpload(service) {
    return async (bytes, mime) => {
        try {
            const result = await service.integrations.Core.UploadFile({ file: new File([bytes], mime === 'image/png' ? 'order-reference.png' : 'order-reference.jpg', { type: mime }) });
            if (typeof result?.file_url !== 'string')
                throw Error();
            return result.file_url;
        }
        catch {
            throw Error('Rasmni saqlab bo‘lmadi.');
        }
    };
}
