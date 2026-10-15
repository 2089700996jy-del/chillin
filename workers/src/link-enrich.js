/**
 * Link & RSS Enrichment Module
 * 外链元数据解析与增强：RSS/Atom 解析、小宇宙播客单集解析、Microlink 兜底。
 * （从 541 行的 garden-media.js 拆出，保持单文件 500 行以内的架构红线。）
 */
import { fetchWithTimeout, readTextCapped } from './security.js';
/**
 * 服务端外链兜底增强（Microlink）。
 * 此前该兜底写在前端 feeds.js 中，会被 Pages 的 CSP connect-src 直接拦截而失效；
 * 收敛到 Worker 后既恢复了兜底能力，也无需放宽浏览器 CSP 白名单。
 */

export async function fetchMicrolinkPreview(targetUrl) {
    try {
        const res = await fetchWithTimeout(
            `https://api.microlink.io/?url=${encodeURIComponent(targetUrl)}`,
            { headers: { 'Accept': 'application/json' }, timeout: 4000 }
        );
        if (!res || !res.ok) return null;
        const raw = await readTextCapped(res, 128 * 1024);
        const payload = JSON.parse(raw);
        if (!payload || payload.status !== 'success' || !payload.data) return null;
        const data = payload.data;
        return {
            title: typeof data.title === 'string' ? data.title : '',
            description: typeof data.description === 'string' ? data.description : '',
            cover: (data.image && typeof data.image.url === 'string') ? data.image.url : ''
        };
    } catch {
        return null;
    }
}

export function parseRssOrAtom(xml) {
    if (!xml || typeof xml !== 'string') return null;
    const isXml = /^\s*<(\?xml|rss|feed)/i.test(xml) || /<channel[\s\S]*?>/i.test(xml);
    if (!isXml) return null;

    const decodeXml = (s) => {
        if (!s) return '';
        return s
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#x27;/g, "'")
            .replace(/&#8230;/g, '…')
            .trim();
    };
    const cleanText = (s) => decodeXml(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    // 1. Channel metadata
    const channelMatch = xml.match(/<channel[\s\S]*?<\/channel>/i);
    const channelXml = channelMatch ? channelMatch[0] : xml;
    const channelTitleMatch = channelXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const channelTitle = decodeXml(channelTitleMatch ? channelTitleMatch[1] : '');

    const channelDescMatch = channelXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
    const channelDesc = cleanText(channelDescMatch ? channelDescMatch[1] : '');

    const channelImageMatch = channelXml.match(/<itunes:image[^>]*href=["']([^"']+)["']/i) ||
                             channelXml.match(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>/i);
    let cover = channelImageMatch ? (channelImageMatch[1] || '').trim() : '';

    // 2. Latest item (Episode / Article)
    const itemMatch = xml.match(/<item[\s\S]*?<\/item>/i) || xml.match(/<entry[\s\S]*?<\/entry>/i);
    let title = channelTitle;
    let description = channelDesc;
    let audioUrl = '';

    if (itemMatch) {
        const itemXml = itemMatch[0];
        const itemTitleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        if (itemTitleMatch) title = decodeXml(itemTitleMatch[1]);

        const itemDescMatch = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) ||
                              itemXml.match(/<itunes:summary>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/itunes:summary>/i) ||
                              itemXml.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i);
        if (itemDescMatch) description = cleanText(itemDescMatch[1]);

        const itemImageMatch = itemXml.match(/<itunes:image[^>]*href=["']([^"']+)["']/i);
        if (itemImageMatch && itemImageMatch[1]) cover = itemImageMatch[1].trim();

        const encMatch = itemXml.match(/<enclosure[^>]*url=["']([^"']+)["']/i) ||
                         itemXml.match(/<link[^>]*rel=["']enclosure["'][^>]*href=["']([^"']+)["']/i);
        if (encMatch && encMatch[1]) audioUrl = encMatch[1].trim();
    }

    if (cover) cover = cover.replace(/^http:\/\//i, 'https://').replace(/^\/\//, 'https://');
    if (audioUrl) audioUrl = audioUrl.replace(/^http:\/\//i, 'https://');

    return {
        title: title || channelTitle || '',
        siteName: channelTitle ? `${channelTitle} · 播客` : '播客 RSS',
        description: description.slice(0, 240),
        cover,
        audioUrl,
        platform: audioUrl ? '播客 (RSS)' : 'RSS 订阅',
        icon: audioUrl ? '🎙️' : '📰'
    };
}

export function matchEpisodeAudioFromRss(xml, episodeTitle) {
    if (!xml || !episodeTitle) return '';
    const clean = (s) => (s || '').toLowerCase().replace(/[\s\-_.,!?:;()（）《》【】]/g, '');
    const cleanZh = (s) => (s || '').replace(/[^\u4e00-\u9fa5]/g, '');
    const cleanTarget = clean(episodeTitle), targetZh = cleanZh(episodeTitle);
    const getEnc = (item) => {
        const m = item.match(/<enclosure[^>]*url=["']([^"']+)["']/i) || item.match(/<link[^>]*rel=["']enclosure["'][^>]*href=["']([^"']+)["']/i);
        return m ? m[1].trim() : '';
    };
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    for (const item of items) {
        const titleM = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        if (!titleM) continue;
        const cleanItem = clean(titleM[1]), itemZh = cleanZh(titleM[1]);
        if (cleanItem && (cleanTarget.includes(cleanItem) || cleanItem.includes(cleanTarget) || (itemZh.length >= 2 && targetZh.length >= 2 && (targetZh.includes(itemZh) || itemZh.includes(targetZh))))) {
            const enc = getEnc(item);
            if (enc) return enc;
        }
    }
    const volM = episodeTitle.match(/(?:vol|ep|no|第)[\s\.]*(\d+)/i);
    if (volM) {
        const numPattern = new RegExp('(?:vol|ep|no|第)[\\s\\.]*' + volM[1] + '(?:[\\s\\._]|$|期|集)', 'i');
        for (const item of items) {
            const titleM = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
            if (titleM && numPattern.test(titleM[1])) {
                const enc = getEnc(item);
                if (enc) return enc;
            }
        }
    }
    return '';
}

/**
 * 从小宇宙页面 HTML 中提取元数据（纯函数，便于用固定 HTML 做回归测试）。
 *
 * 两条独立来源，互为兜底：
 *   1. Next.js SSR 的 __NEXT_DATA__（最完整，含音频 enclosure 与播客名）
 *   2. og: / <title>（结构变化或 SSR 数据缺失时仍能拿到标题与封面）
 */
export function extractXiaoyuzhouMeta(html) {
    const out = { title: '', description: '', cover: '', podcastTitle: '', audioUrl: '' };
    if (!html || typeof html !== 'string') return out;

    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
        try {
            const ep = JSON.parse(nextDataMatch[1])?.props?.pageProps?.episode;
            if (ep) {
                out.title = ep.title || '';
                out.description = ep.description || '';
                out.cover = ep.image?.picUrl || ep.image?.thumbnailUrl || ep.image?.middlePicUrl || ep.podcast?.image?.picUrl || '';
                out.podcastTitle = ep.podcast?.title || '';
                if (ep.media?.source?.url) out.audioUrl = ep.media.source.url;
            }
        } catch {}
    }

    const metaContent = (key) => {
        const pattern = '(?:property|name)=["\']' + key + '["\'][^>]*content=["\']([^"\']*)["\']';
        const m = html.match(new RegExp('<meta[^>]*' + pattern, 'i'))
            || html.match(new RegExp('<meta[^>]*content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + key + '["\']', 'i'));
        return m && m[1] ? m[1].trim() : '';
    };

    if (!out.title) {
        const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        out.title = metaContent('og:title') || (titleTag ? titleTag[1].trim() : '');
    }
    if (!out.description) out.description = metaContent('og:description') || metaContent('description');
    if (!out.cover) out.cover = metaContent('og:image');
    return out;
}

/**
 * 抓取页面文本，失败重试一次。
 * 小宇宙服务在国内、Worker 出口可能绕远，单次 3s 超时是「偶发解析失败」的主因。
 * 4xx 视为确定性失败，不重试。
 */
async function fetchTextWithRetry(url, { headers, timeout = 8000, attempts = 2, cap = 512 * 1024 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetchWithTimeout(url, { headers, timeout });
            if (res && res.ok) return { ok: true, text: await readTextCapped(res, cap) };
            if (res && res.status >= 400 && res.status < 500) return { ok: false, status: res.status };
        } catch {}
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, status: 0 };
}

export async function resolveXiaoyuzhou(rawUrl, titleHint = '', env = null) {
    let title = '', description = '', cover = '', audioUrl = '', podcastTitle = '';

    // 1. 直连页面（Next.js SSR 数据 + og 兜底，8s 超时 + 一次重试）
    const direct = await fetchTextWithRetry(rawUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        timeout: 8000,
        attempts: 2
    });
    if (direct.ok) {
        const meta = extractXiaoyuzhouMeta(direct.text);
        title = meta.title;
        description = meta.description;
        cover = meta.cover;
        podcastTitle = meta.podcastTitle;
        audioUrl = meta.audioUrl;
    }

    // 2. Jina AI Reader fallback when direct fetch fails/is blocked
    if (!title) {
        try {
            const jinaRes = await fetchWithTimeout(`https://r.jina.ai/${rawUrl}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000
            });
            if (jinaRes && jinaRes.ok) {
                const jinaText = await readTextCapped(jinaRes, 128 * 1024);
                const titleMatch = jinaText.match(/Title:\s*([^\n\r]+)/i);
                if (titleMatch && titleMatch[1]) title = titleMatch[1].trim();
                const epImgMatch = jinaText.match(/!\[Image\s*1:[^\]]*\]\((https:\/\/image\.xyzcdn\.net\/[^)@\s]+)/i) ||
                                   jinaText.match(/!\[[^\]]*\]\((https:\/\/image\.xyzcdn\.net\/[^)@\s]+)/i);
                if (epImgMatch && epImgMatch[1]) cover = epImgMatch[1].trim();
                const podImgMatch = jinaText.match(/!\[Image\s*2:\s*([^\]]+)\]/i);
                if (podImgMatch && podImgMatch[1]) podcastTitle = podImgMatch[1].trim();
                const descMatch = jinaText.match(/Markdown Content:[\s\S]*?\n\n([\s\S]*?)(?:展开Show Notes|参与现场录制|$)/i);
                if (descMatch && descMatch[1]) {
                    description = descMatch[1].replace(/!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\)|[·\d]+(?:分钟|年前|小时前)/g, '').replace(/^[\d\s·]+/, '').replace(/\s+/g, ' ').trim();
                }
            }
        } catch {}
    }

    // 3. Title hint fallback (if user entered 【播客名】 or 《播客名》)
    if (!podcastTitle && titleHint) {
        const hintPodMatch = titleHint.match(/[【《]([^】》]+)[】》]/);
        if (hintPodMatch) podcastTitle = hintPodMatch[1].trim();
    }

    // 4. Apple Podcasts Native RSS Discovery (Apple iTunes API -> Native RSS -> Audio enclosure)
    if (podcastTitle && (!audioUrl || !cover)) {
        try {
            const itunesRes = await fetchWithTimeout(
                `https://itunes.apple.com/search?term=${encodeURIComponent(podcastTitle)}&entity=podcast&country=cn&limit=1`,
                { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3500 }
            );
            if (itunesRes && itunesRes.ok) {
                const pod = (await itunesRes.json())?.results?.[0];
                if (pod) {
                    if (!cover && pod.artworkUrl600) cover = pod.artworkUrl600;
                    if (!title && pod.collectionName) title = `${pod.collectionName} 播客单集`;
                    if (pod.feedUrl && isSafeFetchUrl(pod.feedUrl)) {
                        try {
                            const feedRes = await fetchWithTimeout(pod.feedUrl, {
                                headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000
                            });
                            if (feedRes && feedRes.ok) {
                                const feedXml = await readTextCapped(feedRes, 512 * 1024);
                                const matchedAudio = matchEpisodeAudioFromRss(feedXml, title || podcastTitle);
                                if (matchedAudio) audioUrl = matchedAudio;
                            }
                        } catch {}
                    }
                }
            }
        } catch {}
    }

    // 5. 末位兜底：直连与 Jina 都失败时，交给 Microlink（受 LINK_ENRICH_MICROLINK 开关约束）
    const microlinkEnabled = !env || env.LINK_ENRICH_MICROLINK !== 'false';
    if (!title && microlinkEnabled) {
        const enriched = await fetchMicrolinkPreview(rawUrl);
        if (enriched) {
            title = enriched.title || '';
            if (!description) description = enriched.description || '';
            if (!cover) cover = enriched.cover || '';
        }
    }

    if (cover) cover = cover.replace(/^http:\/\//i, 'https://').replace(/^\/\//, 'https://');
    if (audioUrl) audioUrl = audioUrl.replace(/^http:\/\//i, 'https://');

    return {
        title: title || (podcastTitle ? `${podcastTitle} 播客单集` : '小宇宙播客单集'),
        description: (description || '').slice(0, 240),
        cover,
        audioUrl,
        siteName: podcastTitle ? `${podcastTitle} · 小宇宙` : '小宇宙',
        platform: audioUrl ? '小宇宙 (RSS)' : '小宇宙',
        icon: '🎙️',
        // 只有拿到真实标题才算解析成功；占位标题让前端知道"可以稍后重试"
        resolved: !!title
    };
}
