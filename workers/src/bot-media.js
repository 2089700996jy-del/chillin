/**
 * 微信 ClawBot 图片接入层（v2.5.121）
 *
 * iLink 的图片消息形状（2026-10-20 线上实测，日志只记字段名不记正文）：
 *   item_list[i] = { type: 2, msg_id, image_item: { aeskey, media, thumb_size, mid_size, hd_size, thumb_width, thumb_height } }
 *   （外层 message_type 仍是 1，所以「非文本消息」不是靠 message_type 判断，而是靠 item.type）。
 *
 * `aeskey` 是 base64 的 16 字节密钥：微信 CDN 的图片可能是 AES-128-CBC 密文（IV 即密钥本身、PKCS7 填充），
 * 与官方客户端一致。所以下载链路是「取地址 → 下载 → 先按明文嗅探魔数 → 不行再用 aeskey 解密嗅探 →
 * 只有识出真实图片才认账」，绝不把密文写进 R2。任何一步失败都只记状态与字段形状，绝不记正文。
 */
import { handleUpload } from './garden-media.js';
import { saveFeed } from './bot-commands.js';

const IMAGE_ITEM_TYPE = 2;
/** 与 garden-media 的上限保持一致：5MB */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CAPTION_CHARS = 2000;
const DEFAULT_CONTENT = '来自微信的图片';

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

export async function decryptClawImage(bytes, aeskey, cryptoImpl = crypto, ivMode = 'key') {
    const key = decodeAesKey(aeskey);
    if (!key || !cryptoImpl || !cryptoImpl.subtle) return null;
    try {
        const imported = await cryptoImpl.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
        // 微信通例：IV 取 aeskey 的前 16 字节（AES-128 时就是密钥本身）；少数实现用全零 IV，作为兜底再试一次
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
        if (isHttpUrl(url) && !out.some(v => v.url === url) && out.length < 3) out.push({ url, tag });
    };
    push(resolveClawImageUrl(item), 'direct');
    if (media) {
        const base = NESTED_URL_FIELDS.map(f => media[f]).find(isHttpUrl) || '';
        for (const field of ['encrypt_query_param', 'encrypted_query_param']) {
            const value = media[field];
            if (!base || typeof value !== 'string' || !value || base.includes(field)) continue;
            push(base + (base.includes('?') ? '&' : '?') + field + '=' + encodeURIComponent(value), field);
        }
    }
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
    let lastBytes = null;
    for (const candidate of urls) {
        let res;
        try {
            res = await fetchImpl(candidate.url, { method: 'GET' });
        } catch (err) {
            tried.push(candidate.tag + ':fetch-error');
            continue;
        }
        if (!res || !res.ok) {
            tried.push(candidate.tag + ':http-' + ((res && res.status) || 0));
            continue;
        }
        let bytes;
        try {
            bytes = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            tried.push(candidate.tag + ':body-error');
            continue;
        }
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
            for (const ivMode of ['key', 'zero']) {
                const suffix = (ivMode === 'zero' ? ':iv0' : '') + ':fail';
                const decrypted = await decryptClawImage(bytes, key.value, options.cryptoImpl, ivMode);
                if (!decrypted) {
                    tried.push(candidate.tag + '+' + key.tag + ':' + kind + suffix);
                    continue;
                }
                const mime = sniffImageMagic(decrypted);
                if (mime) return { ok: true, bytes: decrypted, mime, note: 'aes-' + kind + (ivMode === 'zero' ? ':iv0' : '') + '/' + candidate.tag + '+' + key.tag };
                tried.push(candidate.tag + '+' + key.tag + ':' + kind + (ivMode === 'zero' ? ':iv0' : '') + ':after');
            }
        }
    }
    const size = lastBytes ? lastBytes.byteLength : 0;
    const head = headHex(lastBytes);
    const wxgf = head.startsWith('77786766');
    return {
        ok: false,
        note: 'not-an-image:' + size + (wxgf ? ' wxgf' : '') + ' head=' + head + ' tried=' + tried.slice(0, 6).join(','),
        head
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
 * 图片消息 → 随手记（带图）。返回给用户的回复；没有图片 item 时返回空串（调用方按普通消息继续）。
 * 存图不经过模型：秒回，也不占用对话限流桶。
 */
export async function handleClawImageMessage(env, db, userId, msg, caption, fetchImpl = fetch) {
    const imageItems = extractClawImageItems(msg);
    if (!imageItems.length) return '';
    const download = await downloadClawImage(imageItems[0], fetchImpl);
    if (!download.ok) {
        console.warn('[bot-media] 图片下载失败 note=' + download.note + ' shape=' + JSON.stringify(describeClawImage(imageItems[0])));
        return '这张图我暂时拿不到原图，你换个方式再发一次试试？';
    }
    const src = await storeClawImage(env, db, userId, download.bytes, download.mime);
    if (!src) return '图片收到了，但没存住，稍后再发一次试试？';
    const text = String(caption || '').trim().slice(0, MAX_CAPTION_CHARS);
    const content = text || DEFAULT_CONTENT;
    const saved = await saveFeed(db, userId, content, src);
    if (!saved) return '图片收到了，但没存进随手记，稍后再发一次试试？';
    console.log('[bot-media] 图片已入随手记 userId=' + userId + ' bytes=' + download.bytes.byteLength + ' note=' + download.note);
    const preview = content.length > 60 ? content.slice(0, 60) + '…' : content;
    return '收到图片，已存入**随手记** ✅' + (text ? '' : '（没配文字，我按「' + DEFAULT_CONTENT + '」记的）') + '\n\n> ' + preview;
}
