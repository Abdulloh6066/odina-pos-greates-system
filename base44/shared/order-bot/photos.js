// Adapter contract deliberately accepts file IDs and byte buffers, never token URLs.
export class ReferencePhotos {
    constructor({ downloadBytes, uploadBytes, approvedHosts = [] }) { Object.assign(this, { downloadBytes, uploadBytes, approvedHosts }); }
    async rehost({ file_id }) {
        try {
            if (typeof file_id !== 'string' || file_id.length > 512 || /[/:?]/.test(file_id))
                throw Error();
            const bytes = await this.downloadBytes(file_id);
            if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 10485760)
                throw Error();
            const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
            const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
            if (!jpeg && !png)
                throw Error();
            const url = new URL(await this.uploadBytes(bytes, jpeg ? 'image/jpeg' : 'image/png'));
            if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !this.approvedHosts.includes(url.hostname))
                throw Error();
            return url.href;
        }
        catch {
            throw Error('Rasmni saqlab bo‘lmadi.');
        }
    }
}
