/**
 * 微信 Bot 的小宇宙链接速览（v2.5.132）。
 *
 * 用户发来小宇宙链接时，服务端替她读一次页面的 og 元数据，单集回「标题 + 播客名 + 时长」、
 * 播客页回「播客名 + 简介」（绝不把页面上某个单集的时长按到播客头上），
 * 并把卡片元数据放进「待存位」——她回「记录」才写成随手记（与图片共用同一条确认路径）。
 * 前端 public/js/feeds.js 早就支持结构化 quick_feeds.summary：只要把
 * {title, description, cover, platform, icon} 写进 summary，花园里这条记录就自动渲染成富链接卡片；
 * 封面转存 R2 后写自家 /api/file/... 地址，卡片不依赖第三方防盗链。
 *
 * **可用性事实（2026-10-21 Cloudflare 边缘探测）**：小宇宙按出口 IP/ASN 封了 Cloudflare，
 * www/static 主机一律 403（openresty），api 主机可达但要鉴权（401），图床 xyzcdn 正常（200），
 * 同一 URL 从住宅 IP 实测 200。所以本模块的抓取只当**尽力而为**：拿不到就如实说、绝不假装，
 * 并给出「记录：<标题> <链接>」这条不依赖网络的兜底路径。
 *
 * 出站抓取是本模块唯一的对外动作，边界收得极紧（见 .agents/rules/security.md §3）：
 * 只认小宇宙的页面域名与它的图床、强制 https + 443 端口、手动跟随重定向并逐跳复核域名、
 * 6 秒超时、HTML 512KB / 封面 4MB 上限、IP 字面量与私网主机一律拒绝。
 * 解析失败绝不假装成功：如实说明，并给出「记录：<链接>」的兜底路径。
 */
import { storeClawImage } from './bot-media.js';
import { savePendingMedia, PENDING_CONFIRM_HINT } from './bot-memory.js';
import { moderateText } from './llm.js';

/** 出站超时与体积上限（小宇宙单集页实测 169529 字节、封面实测 184729 字节，留足余量） */
export const LINK_FETCH_TIMEOUT_MS = 6000;
export const LINK_HTML_MAX_BYTES = 512 * 1024;
export const LINK_COVER_MAX_BYTES = 4 * 1024 * 1024;
const LINK_MAX_REDIRECTS = 3;

export const LINK_TITLE_MAX_CHARS = 120;
export const LINK_DESC_MAX_CHARS = 160;
export const LINK_MAX_CHARS = 4000;

/** 出站白名单：页面只认小宇宙，图片只认它的图床 */
const PAGE_HOST_SUFFIXES = ['xiaoyuzhoufm.com'];
const IMAGE_HOST_SUFFIXES = ['xyzcdn.net'];

const LINK_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ChillinBot/1.0';

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'）)】\]]+/i;
const TRAILING_PUNCT_RE = /[.,;:!?，。；：！？、）)】\]]+$/;
const EPISODE_PATH_RE = /^\/episode\/([A-Za-z0-9]{6,40})\/?$/;
const PODCAST_PATH_RE = /^\/podcast\/([A-Za-z0-9]{6,40})\/?$/;
/** 私网 / 链路本地 / 云元数据网段的兜底（白名单之外再上一道锁） */
const PRIVATE_HOST_RE = /(^|\.)(10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\./;

/** 从一段文本里取第一个 http(s) 链接（微信转发过来的正文常常只有链接本身） */
export function extractFirstUrl(text) {
    const m = String(text || '').match(URL_IN_TEXT_RE);
    return m ? m[0].replace(TRAILING_PUNCT_RE, '') : '';
}

/** 只判域名（不看协议与路径）：用来区分「不是小宇宙链接」和「是小宇宙但协议/路径不认」 */
export function xiaoyuzhouHostOf(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl)); } catch { return ''; }
    return hostAllowed(u.hostname, PAGE_HOST_SUFFIXES) ? u.hostname.toLowerCase() : '';
}

function hostAllowed(host, suffixes) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');       // FQDN 尾点归一化
    if (!h) return false;
    if (h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h)) return false;  // IP 字面量
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return false;
    if (PRIVATE_HOST_RE.test(h)) return false;
    return suffixes.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

/** 出站抓取准入：https、443 端口、无 userinfo、域名命中白名单 */
export function isAllowedOutboundUrl(rawUrl, options = {}) {
    let u;
    try { u = new URL(String(rawUrl)); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (u.port && u.port !== '443') return false;
    return hostAllowed(u.hostname, options && options.image ? IMAGE_HOST_SUFFIXES : PAGE_HOST_SUFFIXES);
}

/** 只认小宇宙的网页链接；短链 / App 分享链接暂不支持（解析不了就交回普通聊天） */
export function parseXiaoyuzhouUrl(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl)); } catch { return null; }
    if (u.protocol !== 'https:' || !hostAllowed(u.hostname, PAGE_HOST_SUFFIXES)) return null;
    const episode = u.pathname.match(EPISODE_PATH_RE);
    if (episode) return { kind: 'episode', id: episode[1], url: u.toString() };
    const podcast = u.pathname.match(PODCAST_PATH_RE);
    if (podcast) return { kind: 'podcast', id: podcast[1], url: u.toString() };
    return null;
}

/**
 * 手写兜底（纯字符串处理、零出站）：用户自己带标题的「记录：<标题> <链接>」也配拿到一张真卡片。
 * Cloudflare 出口被小宇宙 403 封（见文件头），抓不到元数据时这是唯一能出卡片的路径；
 * 只有链接、没有标题时返回 null，交回默认的「域名当标题」卡片。
 */
export function buildManualLinkCard(text) {
    const raw = String(text || '');
    const url = extractFirstUrl(raw);
    if (!url) return null;
    const leftover = raw.replace(url, ' ').replace(/\s+/g, ' ').trim();
    if (!leftover) return null;
    const meta = { title: leftover.slice(0, LINK_TITLE_MAX_CHARS), description: '', cover: '' };
    if (xiaoyuzhouHostOf(url)) { meta.platform = '小宇宙'; meta.icon = '🎧'; }
    return { url, meta };
}

/** 秒 → 1:49:52；超出合理区间（0 < s ≤ 4 天）返回空串 */
export function formatDuration(seconds) {
    const total = Math.floor(Number(seconds));
    if (!Number.isFinite(total) || total <= 0 || total > 4 * 86400) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s);
}

function decodeEntities(value) {
    return String(value)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'");
}

/** 逐个 <meta> 标签找属性值：property/name 与 content 的先后顺序都不挑 */
function metaContent(html, prop) {
    const tags = String(html || '').match(/<meta\s[^>]*>/gi) || [];
    for (const tag of tags) {
        const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (!key || key.toLowerCase() !== prop.toLowerCase()) continue;
        const value = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
        if (value) return decodeEntities(value.trim());
    }
    return '';
}

function tagTitle(html) {
    const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) : '';
}

/**
 * 解析小宇宙页面：og:title 是标题，<title> 里的第二段是播客名，
 * 单集时长从页面内联 JSON 的 "duration" 抠（线上实测单集页第 104275 字节附近）。
 *
 * 播客页（kind: 'podcast'）不一样：页面上混着 33 个单集各自的 "duration"，抠第一个必然张冠李戴，
 * 所以它只取 og:description 当简介、绝不给时长（2026-10-21 线上实测：播客页会回
 * 「基本无害 Mostly Harmless」+「听播客，上小宇宙 · 1:13:16」，那个 1:13:16 其实是某一集的）。
 */
/** 页面自带的 `__NEXT_DATA__` SSR 数据块（Next.js）：拿不到或 JSON 坏了都返回 null，绝不抛 */
function parseNextData(html) {
    const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    try {
        const data = JSON.parse(m[1]);
        return (data && data.props && data.props.pageProps) || null;
    } catch { return null; }
}

export function parseXiaoyuzhouPage(html, options = {}) {
    const text = String(html || '');
    const kind = options && options.kind === 'podcast' ? 'podcast' : 'episode';
    // 页面自带的 SSR 数据块优先：结构化字段比 og / 正则稳（2026-10-21 实测单集页与播客页都有）
    const pageProps = parseNextData(text);
    const nextEpisode = (kind === 'episode' && pageProps && pageProps.episode) ? pageProps.episode : null;
    const nextPodcast = (kind === 'podcast' && pageProps && pageProps.podcast) ? pageProps.podcast : null;

    const segments = tagTitle(text).split(' - ');
    const rawName = segments.length > 1 ? segments[1].split('|')[0].trim() : '';
    // 站点模板尾巴（"听播客，上小宇宙"）不是播客名，别拿它冒充
    const titlePodcast = (/听播客|上小宇宙/.test(rawName) || rawName === '小宇宙') ? '' : rawName;
    const podcast = (nextEpisode && nextEpisode.podcast && nextEpisode.podcast.title) || titlePodcast;
    const title = String(
        (nextEpisode && nextEpisode.title)
        || (nextPodcast && nextPodcast.title)
        || metaContent(text, 'og:title')
        || metaContent(text, 'twitter:title')
        || segments[0] || ''
    ).trim().slice(0, LINK_TITLE_MAX_CHARS);
    if (!title) return { ok: false, reason: '页面上没有标题' };
    let description = '';
    if (kind === 'podcast') {
        description = (nextPodcast && nextPodcast.description)
            || metaContent(text, 'og:description') || metaContent(text, 'description');
    } else {
        const duration = nextEpisode
            ? formatDuration(nextEpisode.duration)
            : formatDuration((text.match(/"duration"\s*:\s*(\d{1,7})/) || [])[1]);
        description = [podcast, duration].filter(Boolean).join(' · ');
    }
    const nextCover = (nextEpisode && nextEpisode.image && (nextEpisode.image.picUrl || nextEpisode.image.largePicUrl))
        || (nextPodcast && nextPodcast.image && (nextPodcast.image.picUrl || nextPodcast.image.largePicUrl))
        || '';
    return {
        ok: true,
        title,
        description: description.replace(/\s+/g, ' ').trim().slice(0, LINK_DESC_MAX_CHARS),
        cover: nextCover || metaContent(text, 'og:image') || metaContent(text, 'twitter:image')
    };
}

/** 读 body 并按上限截断（超限直接放弃，绝不无界读进内存） */
async function readBodyCapped(res, maxBytes) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const buf = await res.arrayBuffer();
        return buf.byteLength > maxBytes ? null : new Uint8Array(buf);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        size += value.length;
        if (size > maxBytes) {
            if (typeof reader.cancel === 'function') { try { await reader.cancel(); } catch { /* 已断开则忽略 */ } }
            return null;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
}

/** 受限 GET：手动跟重定向，每一跳都重新过一遍准入判定 */
async function fetchBounded(rawUrl, maxBytes, fetchImpl, options = {}) {
    let current = String(rawUrl);
    for (let hop = 0; hop <= LINK_MAX_REDIRECTS; hop++) {
        if (!isAllowedOutboundUrl(current, options)) return { ok: false, reason: '域名不在白名单' };
        let res;
        try {
            res = await fetchImpl(current, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': LINK_USER_AGENT,
                    Accept: options.image ? 'image/*' : 'text/html,application/xhtml+xml'
                },
                signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(LINK_FETCH_TIMEOUT_MS) : undefined
            });
        } catch (err) {
            return { ok: false, reason: '请求失败' };
        }
        if (res.status >= 300 && res.status < 400) {
            const location = (res.headers && typeof res.headers.get === 'function') ? res.headers.get('location') : '';
            if (!location) return { ok: false, reason: '重定向缺少目标' };
            try { current = new URL(location, current).toString(); } catch { return { ok: false, reason: '重定向目标非法' }; }
            continue;
        }
        if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
        let bytes;
        try { bytes = await readBodyCapped(res, maxBytes); } catch (err) { return { ok: false, reason: '读取失败' }; }
        if (!bytes) return { ok: false, reason: '内容过大' };
        return { ok: true, bytes, finalUrl: current };
    }
    return { ok: false, reason: '重定向过多' };
}

/** 封面转存 R2（复用既有上传通道：魔数嗅探 + 5MB 上限），失败返回空串由调用方回落远程地址 */
async function storeClawCover(env, db, userId, coverUrl, fetchImpl) {
    if (!coverUrl || !isAllowedOutboundUrl(coverUrl, { image: true })) return '';
    const got = await fetchBounded(coverUrl, LINK_COVER_MAX_BYTES, fetchImpl, { image: true });
    if (!got.ok) return '';
    return await storeClawImage(env, db, userId, got.bytes, '');
}

/**
 * 抓一次小宇宙页面，返回卡片元数据（封面已转存时写自家地址，否则回落远程地址）。
 * 任何一步失败都返回 { ok: false, reason }，绝不抛给调用方。
 */
export async function previewXiaoyuzhouLink(env, db, userId, target, fetchImpl = fetch) {
    const got = await fetchBounded(target && target.url, LINK_HTML_MAX_BYTES, fetchImpl, { image: false });
    if (!got.ok) return { ok: false, reason: got.reason };
    const parsed = parseXiaoyuzhouPage(new TextDecoder().decode(got.bytes), { kind: target && target.kind });
    if (!parsed.ok) return parsed;

    const titleVerdict = moderateText(parsed.title, env);
    if (!titleVerdict.ok) return { ok: false, reason: '标题未通过内容安全检查' };
    const descVerdict = parsed.description ? moderateText(parsed.description, env) : { ok: true, text: '' };
    if (!descVerdict.ok) return { ok: false, reason: '简介未通过内容安全检查' };

    const stored = await storeClawCover(env, db, userId, parsed.cover, fetchImpl);
    return {
        ok: true,
        meta: {
            title: titleVerdict.text,
            description: descVerdict.text,
            cover: stored || parsed.cover || '',
            platform: '小宇宙',
            icon: '🎧'
        }
    };
}

/**
 * 链接消息的统一入口：不是白名单链接返回空串（交回普通聊天，绝不出站抓取）。
 * 抓到的卡片进「待存位」，她回「记录」才落库；正文里保留原始链接，前端就能渲染卡片。
 */
export async function handleClawLinkMessage(env, db, userId, text, fetchImpl = fetch) {
    const url = extractFirstUrl(text);
    if (!url) return '';
    const target = parseXiaoyuzhouUrl(url);
    if (!target) {
        // 是小宇宙的域名但协议不是 https：沉默会让人以为 Bot 没看懂，如实说一句更省事
        if (xiaoyuzhouHostOf(url) && !/^https:/i.test(url)) {
            return '这个链接是 http 的，我只会读 https 的页面。改成 https 再发我一次？想原样存就发「记录：' + url + '」。';
        }
        return '';
    }

    const card = await previewXiaoyuzhouLink(env, db, userId, target, fetchImpl);
    if (!card.ok) {
        return '这个链接我读不到内容（' + card.reason + '）。'
            + '想原样存进随手记，就发「记录：' + url + '」；'
            + '想带上标题，把标题写在前面：记录：<标题> ' + url + '，我照样给你做成带标题的卡片。';
    }
    const caption = String(text || '').replace(url, ' ').replace(/\s+/g, ' ').trim();
    const content = [caption, url].filter(Boolean).join('\n').slice(0, LINK_MAX_CHARS);
    await savePendingMedia(db, userId, card.meta.cover || '', content, JSON.stringify(card.meta));
    const head = card.meta.icon + ' ' + card.meta.title;
    return (card.meta.description ? head + '\n' + card.meta.description : head) + PENDING_CONFIRM_HINT;
}
