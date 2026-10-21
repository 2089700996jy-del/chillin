/**
 * 微信 ClawBot 图片接入层（v2.5.121）
 *
 * iLink 的图片消息形状（2026-10-20 线上实测，日志只记字段名不记正文）：
 *   item_list[i] = { type: 2, msg_id, image_item: { aeskey, media, thumb_size, mid_size, hd_size, thumb_width, thumb_height } }
 *   （外层 message_type 仍是 1，所以「非文本消息」不是靠 message_type 判断，而是靠 item.type）。
 *
 * `aeskey` 是 **32 位十六进制**（= 16 字节）密钥，图片是 **AES-128-ECB + PKCS7** 密文（v2.5.126 用真实
 * 报文离线枚举确证：CBC 的几种 IV 全部失败，ECB 直接解出 JPEG）。WebCrypto 不提供 ECB，所以解密由本
 * 文件的纯 JS 实现承担。链路是「取地址 → 下载 → 先按明文嗅探魔数 → 不行再用 aeskey 解密嗅探 → 只有识出
 * 真实图片才认账」，绝不把密文写进 R2。任何一步失败都只记状态与字段形状，绝不记正文。
 */
import { handleUpload } from './garden-media.js';
import { describeClawImageContent } from './bot-vision.js';
import { saveChatTurn, savePendingMedia, PENDING_CONFIRM_HINT } from './bot-memory.js';

const IMAGE_ITEM_TYPE = 2;
/** 与 garden-media 的上限保持一致：5MB */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CAPTION_CHARS = 2000;
const DEFAULT_CONTENT = '来自微信的图片';
/** 图片只暂存：回一句「记录」才落进随手记（默认无副作用；提示语与链接速览共用同一句） */
const CONFIRM_HINT = PENDING_CONFIRM_HINT;
const URL_FIELDS = ['media', 'url', 'hd_url', 'mid_url', 'thumb_url', 'download_url'];
const NESTED_URL_FIELDS = ['url', 'download_url', 'full_url', 'cdn_url', 'src'];

function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** 取出消息里所有图片 item 的 image_item（可能多张，当前只处理第一张） */
export function extractClawImageItems(msg) {
    if (!msg || !Array.isArray(msg.item_list)) return [];
    return msg.item_list
        .filter(item => item && Number(item.type) === IMAGE_ITEM_TYPE && item.image_item)
        .map(item => item.image_item);
}

/** 从 image_item 里找可下载地址：字段形态没有文档，逐层兜底，认不出就返回空串 */
export function resolveClawImageUrl(imageItem) {
    if (!imageItem || typeof imageItem !== 'object') return '';
    for (const field of URL_FIELDS) {
        const value = imageItem[field];
        if (isHttpUrl(value)) return value;
        if (value && typeof value === 'object') {
            for (const nested of NESTED_URL_FIELDS) if (isHttpUrl(value[nested])) return value[nested];
        }
    }
    return '';
}

/** 图片魔数嗅探：只认 JPEG / PNG / GIF / WEBP，其余（含密文）一律拒绝 */
export function sniffImageMagic(bytes) {
    const b = bytes || new Uint8Array(0);
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return '';
}

/**
 * aeskey → 密钥字节。微信实测给的是 **32 位十六进制**（= 16 字节，AES-128），
 * 也兼容 base64 与 32 字节（AES-256）的写法；长度不是 16/24/32 字节就当作没有密钥。
 */
export function decodeAesKey(aeskey) {
    const text = String(aeskey || '').trim();
    if (!text) return null;
    if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0 && text.length >= 32 && text.length <= 64) {
        const key = new Uint8Array(text.length / 2);
        for (let i = 0; i < key.length; i++) key[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
        return [16, 24, 32].includes(key.length) ? key : null;
    }
    try {
        const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
        if (![16, 24, 32].includes(raw.length)) return null;
        return Uint8Array.from(raw, ch => ch.charCodeAt(0));
    } catch (err) {
        return null;
    }
}

/** 诊断用：说明 aeskey 是怎么被解读的（只报种类与长度，不报内容） */
export function aesKeyKind(aeskey) {
    const key = decodeAesKey(aeskey);
    if (!key) return 'none:' + String(aeskey || '').length;
    const hex = /^[0-9a-fA-F]+$/.test(String(aeskey || '').trim());
    return (hex ? 'hex-' : 'base64-') + key.length;
}

/**
 * ── AES-128-ECB 解密（纯 JS，仅解密侧）────────────────────────────────────────
 * WebCrypto 只提供 CBC / CTR / GCM，没有 ECB；而线上报文确证微信 CDN 用的是 AES-128-ECB + PKCS7，
 * 所以这里自带一份标准实现（只用查表，解密 200KB 量级的图片在边缘约几十毫秒）。
 */
const AES_SBOX = Uint8Array.from(
    ('637c777bf26b6fc53001672bfed7ab76' + 'ca82c97dfa5947f0add4a2af9ca472c0'
        + 'b7fd9326363ff7cc34a5e5f171d83115' + '04c723c31896059a071280e2eb27b275'
        + '09832c1a1b6e5aa0523bd6b329e32f84' + '53d100ed20fcb15b6acbbe394a4c58cf'
        + 'd0efaafb434d338545f9027f503c9fa8' + '51a3408f929d38f5bcb6da2110fff3d2'
        + 'cd0c13ec5f974417c4a77e3d645d1973' + '60814fdc222a908846eeb814de5e0bdb'
        + 'e0323a0a4906245cc2d3ac629195e479' + 'e7c8376d8dd54ea96c56f4ea657aae08'
        + 'ba78252e1ca6b4c6e8dd741f4bbd8b8a' + '703eb5664803f60e613557b986c11d9e'
        + 'e1f8981169d98e949b1e87e9ce5528df' + '8ca1890dbfe6426841992d0fb054bb16'
    ).match(/../g).map(h => parseInt(h, 16))
);
const AES_INV_SBOX = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) t[AES_SBOX[i]] = i;
    return t;
})();

/** GF(2^8) 乘法，只用于建表；查表用 MUL* 常量 */
function gmul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hi = a & 0x80;
        a = (a << 1) & 0xff;
        if (hi) a ^= 0x1b;
        b >>= 1;
    }
    return p;
}
function mulTable(n) {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) t[i] = gmul(i, n);
    return t;
}
const MUL9 = mulTable(9), MUL11 = mulTable(11), MUL13 = mulTable(13), MUL14 = mulTable(14);

/** AES-128 密钥扩展：11 组轮密钥共 176 字节 */
function aesExpandKey(key) {
    const w = new Uint8Array(176);
    w.set(key, 0);
    let rcon = 1;
    for (let i = 4; i < 44; i++) {
        const off = i * 4;
        let t0 = w[off - 4], t1 = w[off - 3], t2 = w[off - 2], t3 = w[off - 1];
        if (i % 4 === 0) {
            const first = t0;
            t0 = AES_SBOX[t1] ^ rcon;
            t1 = AES_SBOX[t2];
            t2 = AES_SBOX[t3];
            t3 = AES_SBOX[first];
            rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x1b : 0)) & 0xff;
        }
        w[off] = w[off - 16] ^ t0;
        w[off + 1] = w[off - 15] ^ t1;
        w[off + 2] = w[off - 14] ^ t2;
        w[off + 3] = w[off - 13] ^ t3;
    }
    return w;
}

/** 单块解密到位（state 与 key schedule 都是列优先，索引 i = 4*列 + 行） */
function aesDecryptBlock(s, w, scratch) {
    const keyAdd = round => { for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i]; };
    const invShiftRows = () => {
        for (let r = 1; r < 4; r++) {
            for (let i = 0; i < 4; i++) scratch[i] = s[r + 4 * ((i + 4 - r) % 4)];
            for (let i = 0; i < 4; i++) s[r + 4 * i] = scratch[i];
        }
    };
    keyAdd(10);
    for (let round = 9; round >= 1; round--) {
        invShiftRows();
        for (let i = 0; i < 16; i++) s[i] = AES_INV_SBOX[s[i]];
        keyAdd(round);
        for (let c = 0; c < 4; c++) {
            const o = 4 * c;
            const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
            s[o] = MUL14[a0] ^ MUL11[a1] ^ MUL13[a2] ^ MUL9[a3];
            s[o + 1] = MUL9[a0] ^ MUL14[a1] ^ MUL11[a2] ^ MUL13[a3];
            s[o + 2] = MUL13[a0] ^ MUL9[a1] ^ MUL14[a2] ^ MUL11[a3];
            s[o + 3] = MUL11[a0] ^ MUL13[a1] ^ MUL9[a2] ^ MUL14[a3];
        }
    }
    invShiftRows();
    for (let i = 0; i < 16; i++) s[i] = AES_INV_SBOX[s[i]];
    keyAdd(0);
}

/** AES-128-ECB 解密 + PKCS7 去填充；长度或填充不合法返回 null */
export function aes128EcbDecrypt(bytes, key) {
    if (!bytes || !key || key.length !== 16) return null;
    if (!bytes.length || bytes.length % 16 !== 0) return null;
    const w = aesExpandKey(key);
    const out = new Uint8Array(bytes.length);
    const s = new Uint8Array(16);
    const scratch = new Uint8Array(4);
    for (let off = 0; off < bytes.length; off += 16) {
        s.set(bytes.subarray(off, off + 16));
        aesDecryptBlock(s, w, scratch);
        out.set(s, off);
    }
    const pad = out[out.length - 1];
    if (pad < 1 || pad > 16 || pad > out.length) return null;
    for (let i = out.length - pad; i < out.length; i++) if (out[i] !== pad) return null;
    return out.subarray(0, out.length - pad);
}

export async function decryptClawImage(bytes, aeskey, cryptoImpl = crypto, ivMode = 'key') {
    const key = decodeAesKey(aeskey);
    if (!key) return null;
    // 实测证实的主力方式：AES-128-ECB + PKCS7（WebCrypto 无 ECB，走本地实现）
    if (ivMode === 'ecb') return key.length === 16 ? aes128EcbDecrypt(bytes, key) : null;
    if (!cryptoImpl || !cryptoImpl.subtle) return null;
    try {
        const imported = await cryptoImpl.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
        // 兜底：CBC 时 IV 取 aeskey 的前 16 字节；少数实现用全零 IV，再试一次
        const iv = ivMode === 'zero' ? new Uint8Array(16) : key.slice(0, 16);
        const plain = await cryptoImpl.subtle.decrypt({ name: 'AES-CBC', iv }, imported, bytes);
        return new Uint8Array(plain);
    } catch (err) {
        return null;
    }
}

/**
 * 有些实现会把 16 字节密钥先写成 32 位 hex，再对这一整串做 base64；
 * 线上 `media.aes_key` 解出来正好是 32 字节（很可能就是这个中间层），所以把它还原成真正的 hex 密钥串。
 * 认不出就返回空串。
 */
export function unwrapHexAsciiKey(value) {
    const text = String(value || '').trim();
    if (!text || /^[0-9a-fA-F]+$/.test(text)) return '';
    try {
        const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
        if (raw.length % 2 === 0 && raw.length >= 32 && raw.length <= 64 && /^[0-9a-fA-F]+$/.test(raw)) return raw;
        return '';
    } catch (err) {
        return '';
    }
}

/** 日志用：只报前几个字节的十六进制，够看出是不是 HTML/JSON 错误页，却不含正文 */
function headHex(bytes, n = 8) {
    const b = bytes || new Uint8Array(0);
    return Array.from(b.slice(0, n)).map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * 候选下载地址：直链之外，微信 CDN 常常还需要把授权参数拼回查询串。
 * 只产出 http(s) 地址、去重、最多 3 条，避免为一个 item 无限重试。
 */
export function clawImageUrlCandidates(imageItem) {
    const item = imageItem || {};
    const media = item.media && typeof item.media === 'object' ? item.media : null;
    const out = [];
    const push = (url, tag) => {
        if (isHttpUrl(url) && !out.some(v => v.url === url) && out.length < 8) out.push({ url, tag });
    };
    push(resolveClawImageUrl(item), 'direct');
    if (media) {
        const base = NESTED_URL_FIELDS.map(f => media[f]).find(isHttpUrl) || '';
        const sep = base.includes('?') ? '&' : '?';
        for (const field of ['encrypt_query_param', 'encrypted_query_param']) {
            const value = media[field];
            if (!base || typeof value !== 'string' || !value || base.includes(field)) continue;
            // 参数名有 encrypt / encrypted 两种拼法，值也可能已经编码过，四种组合都试（去重后仍有限）
            const other = field === 'encrypt_query_param' ? 'encrypted_query_param' : 'encrypt_query_param';
            push(base + sep + field + '=' + value, field);
            push(base + sep + field + '=' + encodeURIComponent(value), field + ':enc');
            push(base + sep + other + '=' + value, other);
        }
    }
    out.length = Math.min(out.length, 6);
    return out;
}

/** 候选密钥：item.aeskey 与 media.aes_key 都可能存在，谁对用谁（去重，保留来源标签） */
export function clawImageKeys(imageItem) {
    const item = imageItem || {};
    const media = item.media && typeof item.media === 'object' ? item.media : null;
    const out = [];
    const push = (value, tag) => {
        if (typeof value === 'string' && value && !out.some(v => v.value === value)) out.push({ value, tag });
    };
    push(item.aeskey, 'item');
    if (media) {
        for (const field of ['aes_key', 'aeskey', 'key']) {
            push(media[field], 'media.' + field);
            const inner = unwrapHexAsciiKey(media[field]);
            if (inner) push(inner, 'media.' + field + '>hex');
        }
    }
    return out;
}

/**
 * 下载 → 必要时解密 → 魔数嗅探。返回 { ok, bytes, mime, note }；任何异常都折叠成 ok:false，绝不抛。
 * note 是给日志看的原因码（plain / aes-<密钥种类>/<地址来源>+<密钥来源> / not-an-image…），不会给用户看。
 * 地址与密钥都可能有多份形态（线上实测：item.aeskey 是 16 字节 hex，而真正的图要 media.aes_key 才解得开），
 * 所以逐对尝试，任一对解出真实魔数就认账；全部失败也只记「形状」，不记正文与密钥内容。
 */
export async function downloadClawImage(imageItem, fetchImpl = fetch, options = {}) {
    const urls = clawImageUrlCandidates(imageItem);
    if (!urls.length) return { ok: false, note: 'no-url' };
    const keys = clawImageKeys(imageItem);
    const tried = [];
    const probes = [];
    let lastBytes = null;
    for (const candidate of urls) {
        let res;
        try {
            res = await fetchImpl(candidate.url, { method: 'GET' });
        } catch (err) {
            tried.push(candidate.tag + ':fetch-error');
            probes.push({ tag: candidate.tag, err: 'fetch' });
            continue;
        }
        if (!res || !res.ok) {
            tried.push(candidate.tag + ':http-' + ((res && res.status) || 0));
            probes.push({ tag: candidate.tag, status: (res && res.status) || 0 });
            continue;
        }
        let bytes;
        try {
            bytes = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            tried.push(candidate.tag + ':body-error');
            continue;
        }
        probes.push({
            tag: candidate.tag,
            status: res.status,
            ctype: String((res.headers && res.headers.get && res.headers.get('content-type')) || '').slice(0, 40),
            len: bytes.byteLength,
            head: headHex(bytes),
            final: String(res.url || '').replace(/^https?:\/\//, '').split('?')[0].slice(0, 60)
        });
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
            tried.push(candidate.tag + ':too-large:' + bytes.byteLength);
            continue;
        }
        const plainMime = sniffImageMagic(bytes);
        if (plainMime) return { ok: true, bytes, mime: plainMime, note: 'plain/' + candidate.tag };
        lastBytes = bytes;
        if (!keys.length) {
            tried.push(candidate.tag + ':no-key');
            continue;
        }
        for (const key of keys) {
            const kind = aesKeyKind(key.value);
            // ECB 先试（实测主力），CBC 两种 IV 作为兜底
            for (const [ivMode, modeTag] of [['ecb', ':ecb'], ['key', ''], ['zero', ':iv0']]) {
                const decrypted = await decryptClawImage(bytes, key.value, options.cryptoImpl, ivMode);
                if (!decrypted) {
                    tried.push(candidate.tag + '+' + key.tag + ':' + kind + modeTag + ':fail');
                    continue;
                }
                const mime = sniffImageMagic(decrypted);
                if (mime) return { ok: true, bytes: decrypted, mime, note: 'aes-' + kind + modeTag + '/' + candidate.tag + '+' + key.tag };
                tried.push(candidate.tag + '+' + key.tag + ':' + kind + modeTag + ':after');
            }
        }
    }
    const size = lastBytes ? lastBytes.byteLength : 0;
    const head = headHex(lastBytes);
    const wxgf = head.startsWith('77786766');
    return {
        ok: false,
        note: 'not-an-image:' + size + (wxgf ? ' wxgf' : '') + ' head=' + head + ' tried=' + tried.slice(0, 6).join(','),
        head,
        bytes: lastBytes,
        probes
    };
}

/** 诊断用：只输出字段形状（键名、长度、URL 主机），供日志确认协议，不含正文与密钥内容 */
export function describeClawImage(imageItem) {
    const item = imageItem || {};
    const media = item.media;
    const url = resolveClawImageUrl(item);
    return {
        keys: Object.keys(item),
        mediaType: typeof media,
        mediaKeys: media && typeof media === 'object' ? Object.keys(media) : [],
        mediaLen: typeof media === 'string' ? media.length : 0,
        mediaHost: url ? new URL(url).host : '',
        mediaPath: url ? new URL(url).pathname.slice(0, 60) : '',
        mediaQueryKeys: url ? Array.from(new URL(url).searchParams.keys()).slice(0, 6) : [],
        aeskeyLen: String(item.aeskey || '').length,
        keyKinds: clawImageKeys(item).map(k => k.tag + ':' + aesKeyKind(k.value)),
        urlVariants: clawImageUrlCandidates(item).map(u => u.tag),
        sizes: [item.thumb_size, item.mid_size, item.hd_size].map(v => Number(v) || 0)
    };
}

/** 走既有上传通道（魔数嗅探 + 5MB 上限 + 写 R2），返回可直接当 media_url 的 /api/file/... 地址 */
export async function storeClawImage(env, db, userId, bytes, mime) {
    try {
        const form = new FormData();
        form.append('file', new File([bytes], 'wechat-image', { type: mime }));
        const request = new Request('https://chillin.internal/api/media/upload', { method: 'POST', body: form });
        const res = await handleUpload(request, env, db, userId);
        if (!res.ok) {
            console.error('[bot-media] 图片入库失败 status=' + res.status);
            return '';
        }
        const payload = await res.json();
        const first = Array.isArray(payload) ? payload[0] : null;
        const src = first && typeof first.src === 'string' ? first.src : '';
        if (!src) console.error('[bot-media] 上传响应缺少 src');
        return src;
    } catch (err) {
        console.error('[bot-media] 图片入库异常: ' + (err && err.message));
        return '';
    }
}

/**
 * 图片消息 → 暂存待确认（不落库）。返回给用户的回复；没有图片 item 时返回空串（调用方按普通消息继续）。
 * 默认无副作用：图只进 R2 与待存位，用户回一句「记录」才写成随手记（见 bot-commands.js）。
 * 存图不经过模型：秒回，也不占用对话限流桶。
 */
export async function handleClawImageMessage(env, db, userId, msg, caption, fetchImpl = fetch) {
    const imageItems = extractClawImageItems(msg);
    if (!imageItems.length) return '';
    const download = await downloadClawImage(imageItems[0], fetchImpl);
    if (!download.ok) {
        console.warn('[bot-media] 图片下载失败 note=' + download.note + ' probes=' + JSON.stringify(download.probes || []) + ' shape=' + JSON.stringify(describeClawImage(imageItems[0])));
        return '这张图我暂时拿不到原图，你换个方式再发一次试试？';
    }
    const text = String(caption || '').trim().slice(0, MAX_CAPTION_CHARS);
    // 存图与看一眼图片并行：回信只等较慢的那个，省掉一段串行等待（看图失败只是没有描述，绝不阻塞暂存）
    const [src, desc] = await Promise.all([
        storeClawImage(env, db, userId, download.bytes, download.mime),
        describeClawImageContent(env, download.bytes, download.mime, fetchImpl)
    ]);
    if (!src) return '图片收到了，但没存住，稍后再发一次试试？';
    const content = [text, desc].filter(Boolean).join('\n\n') || DEFAULT_CONTENT;
    const pending = await savePendingMedia(db, userId, src, content);
    if (!pending) return '图片收到了，但没能暂存，稍后再发一次试试？';
    console.log('[bot-media] 图片已暂存 userId=' + userId + ' bytes=' + download.bytes.byteLength + ' descLen=' + desc.length + ' note=' + download.note);
    const reply = desc
        ? desc + CONFIRM_HINT
        : '图片我收好了，这次没能看清里面是什么。' + CONFIRM_HINT;
    // 图片消息也进对话上下文：用户接着说「这张图不错」这类话才有指代可继承
    await saveChatTurn(db, userId, 'user', text ? '[图片] ' + text : '[图片]');
    await saveChatTurn(db, userId, 'assistant', reply);
    return reply;
}
