/**
 * 测试用 R2 适配器：用内存 Map 复刻 Workers R2Bucket 的最小语义
 * （put / get / delete / list，以及 handleFileView 依赖的 Range 分片读取）。
 */
export class FakeR2 {
    constructor(options = {}) {
        this.store = new Map();
        // 真实 R2 list 单次最多 1000 个 key 并回传 cursor；pageLimit 让测试能逼出分页分支
        this.pageLimit = Number.isInteger(options.pageLimit) && options.pageLimit > 0 ? options.pageLimit : 1000;
    }

    _bytes(value) {
        if (value == null) return new Uint8Array(0);
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (typeof value === 'string') return new TextEncoder().encode(value);
        throw new TypeError('FakeR2: unsupported value type');
    }

    async put(key, value, options = {}) {
        const bytes = this._bytes(value);
        this.store.set(key, {
            bytes,
            httpMetadata: options.httpMetadata || {},
            uploaded: new Date()
        });
        return { key, size: bytes.length, httpEtag: `"${bytes.length}"` };
    }

    async get(key, options = {}) {
        const entry = this.store.get(key);
        if (!entry) return null;
        const base = {
            key,
            size: entry.bytes.length,
            httpEtag: `"${entry.bytes.length}"`,
            httpMetadata: entry.httpMetadata,
            uploaded: entry.uploaded
        };
        // 与真实 R2 一致：带 Range 头时只回片段，并附 range 元信息
        const rangeHeader = options && options.range ? options.range.get('range') : null;
        const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim()) : null;
        if (match) {
            const total = entry.bytes.length;
            const start = match[1] === '' ? Math.max(0, total - Number(match[2])) : Number(match[1]);
            const end = (match[1] === '' || match[2] === '') ? total - 1 : Math.min(Number(match[2]), total - 1);
            const slice = entry.bytes.slice(start, end + 1);
            return { ...base, body: slice, range: { offset: start, length: slice.length } };
        }
        // 与线上 R2 行为一致：整对象读取也会带上 range 元信息，
        // 调用方必须靠「客户端是否发了 Range 头」来判断 200 / 206。
        return { ...base, body: entry.bytes, range: { offset: 0, length: entry.bytes.length } };
    }

    async delete(key) {
        this.store.delete(key);
    }

    async head(key) {
        const entry = this.store.get(key);
        return entry ? { key, size: entry.bytes.length } : null;
    }

    async list(options = {}) {
        const prefix = options.prefix || '';
        const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : this.pageLimit;
        // 与真实 R2 一致：按 key 字典序升序返回
        const all = [...this.store.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, size: value.bytes.length, uploaded: value.uploaded, httpEtag: `"${value.bytes.length}"` }))
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const start = Number.isInteger(Number(options.cursor)) ? Number(options.cursor) : 0;
        const page = all.slice(start, start + limit);
        return start + page.length < all.length
            ? { objects: page, truncated: true, cursor: String(start + page.length) }
            : { objects: page, truncated: false };
    }
}
