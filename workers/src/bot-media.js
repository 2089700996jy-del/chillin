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

export async function decryptClawImage(bytes, aeskey, cryptoImpl = crypto) {
    const key = decodeAesKey(aeskey);
    if (!key || !cryptoImpl || !cryptoImpl.subtle) return null;
    try {
        const imported = await cryptoImpl.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
        // 微信通例：IV 取 aeskey 的前 16 字节（AES-128 时就是密钥本身）
        const plain = await cryptoImpl.subtle.decrypt({ name: 'AES-CBC', iv: key.slice(0, 16) }, imported, bytes);
        return new Uint8Array(plain);
    } catch (err) {
        return null;
    }
}

/**
 * 下载 → 必要时解密 → 魔数嗅探。返回 { ok, bytes, mime, note }；任何异常都折叠成 ok:false，绝不抛。
 * note 是给日志看的原因码（plain / aes / http-403 / no-url / not-an-image…），不会直接给用户看。
 */
export async function downloadClawImage(imageItem, fetchImpl = fetch, options = {}) {
    const url = resolveClawImageUrl(imageItem);
    if (!url) return { ok: false, note: 'no-url' };
    let res;
    try {
        res = await fetchImpl(url, { method: 'GET' });
    } catch (err) {
        return { ok: false, note: 'fetch-error' };
    }
    if (!res || !res.ok) return { ok: false, note: 'http-' + ((res && res.status) || 0) };
    let bytes;
    try {
        bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
        return { ok: false, note: 'body-error' };
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, note: 'too-large:' + bytes.byteLength };
    const plainMime = sniffImageMagic(bytes);
    if (plainMime) return { ok: true, bytes, mime: plainMime, note: 'plain' };
    const kind = aesKeyKind(imageItem && imageItem.aeskey);
    const decrypted = await decryptClawImage(bytes, imageItem && imageItem.aeskey, options.cryptoImpl);
    if (decrypted) {
        const mime = sniffImageMagic(decrypted);
        if (mime) return { ok: true, bytes: decrypted, mime, note: 'aes-' + kind };
        return { ok: false, note: 'not-an-image:' + bytes.byteLength + '/after-' + kind };
    }
    return { ok: false, note: 'not-an-image:' + bytes.byteLength + '/' + kind };
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
