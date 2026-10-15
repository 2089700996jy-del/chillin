/**
 * Garden Media & Link Module
 * Image upload, authenticated file delivery and outbound link parsing.
 */
import {
    jsonResponse,
    applySecurityHeaders,
    checkRateLimitShared,
    rateLimitedResponse,
    timingSafeEqualStr,
    sniffImageMime,
    isSafeFetchUrl,
    fetchWithTimeout,
    readTextCapped,
    isBlockedLinkUrl
} from './security.js';

export async function handleUpload(request, db, userId) {
    const uploadLimit = await checkRateLimitShared(db, `upload:${userId}`, 60, 10 * 60 * 1000);
    if (!uploadLimit.ok) return rateLimitedResponse(uploadLimit.retryAfter);

    const MAX_SIZE = 5 * 1024 * 1024;
    // 快速拒绝：先看声明的 Content-Length（multipart 额外留 64KB 边界开销），
    // 避免把超大请求整体读入内存后再判长度。
    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength && declaredLength > MAX_SIZE + 64 * 1024) {
        return jsonResponse({ error: '文件过大，最大支持 5MB' }, 413);
    }

    try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return jsonResponse({ error: 'No file uploaded' }, 400);

        // File.size 在读取内容前即可用：超限文件不再复制进内存
        if (typeof file.size === 'number' && file.size > MAX_SIZE) {
            return jsonResponse({ error: '文件过大，最大支持 5MB' }, 413);
        }

        const arrayBuffer = await file.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_SIZE) {
            return jsonResponse({ error: '文件过大，最大支持 5MB' }, 413);
        }
        const bytes = new Uint8Array(arrayBuffer);
        const sniffed = sniffImageMime(bytes);
        const claimed = (file.type || '').toLowerCase();
        const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
        if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
            return jsonResponse({ error: '仅支持 JPEG / PNG / GIF / WEBP 图片' }, 400);
        }
        if (claimed && claimed !== 'application/octet-stream' && claimed !== sniffed) {
            return jsonResponse({ error: '文件类型与内容不匹配' }, 400);
        }
        const id = crypto.randomUUID();
        const accessToken = crypto.randomUUID();
        await db.prepare('INSERT INTO files (id, mime_type, data, access_token, user_id) VALUES (?1, ?2, ?3, ?4, ?5)')
            .bind(id, sniffed, arrayBuffer, accessToken, userId).run();

        return jsonResponse([{ src: `/api/file/${id}?t=${accessToken}` }], 201);
    } catch (err) {
        console.error('[upload] error:', err);
        return jsonResponse({ error: '上传失败' }, 500);
    }
}

export async function handleFileView(fileId, request, db, authenticate) {
    if (!fileId) return new Response('Not Found', { status: 404 });
    const row = await db.prepare('SELECT mime_type, data, access_token, user_id FROM files WHERE id = ?1').bind(fileId).first();
    if (!row) return new Response('Not Found', { status: 404 });

    const fileToken = new URL(request.url).searchParams.get('t') || '';
    if (row.access_token != null && row.access_token !== '') {
        if (!timingSafeEqualStr(row.access_token, fileToken)) {
            return new Response('Forbidden', { status: 403, headers: applySecurityHeaders(new Headers()) });
        }
    } else {
        const viewerId = await authenticate(request, db);
        if (!viewerId || row.user_id == null || Number(row.user_id) !== Number(viewerId)) {
            return new Response('Forbidden', { status: 403, headers: applySecurityHeaders(new Headers()) });
        }
        if (!fileToken) {
            const newToken = crypto.randomUUID().replace(/-/g, '');
            await db.prepare('UPDATE files SET access_token = ?1 WHERE id = ?2 AND access_token IS NULL')
                .bind(newToken, fileId).run();
        }
    }

    let responseData = row.data;
    if (Array.isArray(responseData)) responseData = new Uint8Array(responseData);
    else if (responseData instanceof ArrayBuffer) responseData = new Uint8Array(responseData);

    return new Response(responseData, {
        status: 200,
        headers: applySecurityHeaders(new Headers({
            'Content-Type': row.mime_type || 'application/octet-stream',
            'Cache-Control': 'private, max-age=86400',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
            'Content-Disposition': 'inline'
        }))
    });
}

// ── Link Parse (OpenGraph) ──
/**
 * 服务端外链兜底增强（Microlink）。
 * 此前该兜底写在前端 feeds.js 中，会被 Pages 的 CSP connect-src 直接拦截而失效；
 * 收敛到 Worker 后既恢复了兜底能力，也无需放宽浏览器 CSP 白名单。
 */

async function fetchMicrolinkPreview(targetUrl) {
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

export async function resolveXiaoyuzhou(rawUrl, titleHint = '') {
    let title = '', description = '', cover = '', audioUrl = '', podcastTitle = '';

    // 1. Direct fetch attempt (Next.js SSR data)
    try {
        const directRes = await fetchWithTimeout(rawUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            },
            timeout: 3000
        });
        if (directRes && directRes.ok) {
            const html = await readTextCapped(directRes, 512 * 1024);
            const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (nextDataMatch) {
                const ep = JSON.parse(nextDataMatch[1])?.props?.pageProps?.episode;
                if (ep) {
                    title = ep.title || '';
                    description = ep.description || '';
                    cover = ep.image?.picUrl || ep.image?.thumbnailUrl || ep.image?.middlePicUrl || ep.podcast?.image?.picUrl || '';
                    podcastTitle = ep.podcast?.title || '';
                    if (ep.media?.source?.url) audioUrl = ep.media.source.url;
                }
            }
        }
    } catch {}

    // 2. Jina AI Reader fallback when direct fetch fails/is blocked
    if (!title) {
        try {
            const jinaRes = await fetchWithTimeout(`https://r.jina.ai/${rawUrl}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000
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

    if (cover) cover = cover.replace(/^http:\/\//i, 'https://').replace(/^\/\//, 'https://');
    if (audioUrl) audioUrl = audioUrl.replace(/^http:\/\//i, 'https://');

    return {
        title: title || (podcastTitle ? `${podcastTitle} 播客单集` : '小宇宙播客单集'),
        description: (description || '').slice(0, 240),
        cover,
        audioUrl,
        siteName: podcastTitle ? `${podcastTitle} · 小宇宙` : '小宇宙',
        platform: audioUrl ? '小宇宙 (RSS)' : '小宇宙',
        icon: '🎙️'
    };
}

export async function handleLinkParse(request, env, db, userId) {
    const linkLimit = await checkRateLimitShared(db, `link:${userId}`, 40, 10 * 60 * 1000);
    if (!linkLimit.ok) return rateLimitedResponse(linkLimit.retryAfter);

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: '请求格式错误' }, 400);
    }
    const rawUrl = (body && typeof body.url === 'string') ? body.url.trim() : '';
    const titleHint = (body && typeof body.hint === 'string') ? body.hint.trim() : '';
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
        return jsonResponse({ error: '仅支持 http/https 链接' }, 400);
    }
    if (!isSafeFetchUrl(rawUrl)) {
        return jsonResponse({ error: '禁止访问该地址' }, 403);
    }
    if (isBlockedLinkUrl(rawUrl)) {
        return jsonResponse({ error: '该链接属于合规黑名单，禁止解析' }, 403);
    }

    let currentUrl = rawUrl, title = '', description = '', cover = '', audioUrl = '', platformName = '', platformIcon = '🔗', siteName = '';
    const parsedInitUrl = new URL(rawUrl), hostname = parsedInitUrl.hostname;

    if (hostname.includes('bilibili.com')) { platformName = '哔哩哔哩'; platformIcon = '📺'; siteName = '哔哩哔哩'; }
    else if (hostname.includes('zhihu.com')) { platformName = '知乎'; platformIcon = '💡'; siteName = '知乎'; }
    else if (hostname.includes('github.com')) { platformName = 'GitHub'; platformIcon = '🐙'; siteName = 'GitHub'; }
    else if (hostname.includes('xiaoyuzhoufm.com')) { platformName = '小宇宙'; platformIcon = '🎙️'; siteName = '小宇宙'; }

    // 小宇宙专用解析管道（直连 + Jina 兜底 + Apple 播客原生 RSS 桥接）
    if (hostname.includes('xiaoyuzhoufm.com')) {
        const xyzData = await resolveXiaoyuzhou(rawUrl, titleHint);
        return jsonResponse({ url: rawUrl, ...(xyzData || {}) }, 200);
    }

    // Apple Podcasts URL 自动反查底层原生 RSS
    const appleMatch = rawUrl.match(/podcasts\.apple\.com\/(?:([^/]+)\/)?podcast\/(?:[^/]+\/)?id(\d+)/i);
    if (appleMatch) {
        const country = (appleMatch[1] && appleMatch[1].length === 2) ? appleMatch[1] : 'cn';
        try {
            const lookupRes = await fetchWithTimeout(`https://itunes.apple.com/lookup?id=${appleMatch[2]}&country=${country}&entity=podcast`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3500
            });
            if (lookupRes && lookupRes.ok) {
                const pod = (await lookupRes.json())?.results?.[0];
                if (pod) {
                    title = pod.collectionName || pod.trackName || '';
                    siteName = `${title || 'Apple 播客'} · 播客`;
                    cover = pod.artworkUrl600 || pod.artworkUrl100 || '';
                    description = pod.primaryGenreName ? `分类：${pod.primaryGenreName}` : '';
                    platformName = '播客 (Apple)';
                    platformIcon = '🎙️';
                    if (pod.feedUrl && isSafeFetchUrl(pod.feedUrl)) {
                        try {
                            const feedRes = await fetchWithTimeout(pod.feedUrl, {
                                headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 2500
                            });
                            if (feedRes && feedRes.ok) {
                                const feedXml = await readTextCapped(feedRes, 512 * 1024);
                                const rss = parseRssOrAtom(feedXml);
                                if (rss?.audioUrl) audioUrl = rss.audioUrl;
                                if (rss?.title) title = rss.title;
                                if (rss?.description) description = rss.description;
                                if (rss?.cover) cover = rss.cover;
                            }
                        } catch {}
                    }
                    return jsonResponse({ url: rawUrl, title, description, cover, platform: platformName, icon: platformIcon, siteName, audioUrl }, 200);
                }
            }
        } catch {}
    }

    try {
        let hop = 0;
        let finalResponse = null;
        while (hop < 3) {
            finalResponse = await fetchWithTimeout(currentUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                redirect: 'manual'
            });
            if ([301, 302, 303, 307, 308].includes(finalResponse.status)) {
                const loc = finalResponse.headers.get('location');
                if (!loc) break;
                const nextUrl = new URL(loc, currentUrl).toString();
                if (!isSafeFetchUrl(nextUrl) || isBlockedLinkUrl(nextUrl)) return jsonResponse({ error: '重定向到非法或违规地址' }, 403);
                currentUrl = nextUrl;
                hop++;
                continue;
            }
            break;
        }

        const html = finalResponse && finalResponse.ok ? await readTextCapped(finalResponse, 512 * 1024) : '';
        const rssData = parseRssOrAtom(html);
        if (rssData && (rssData.title || rssData.audioUrl)) {
            title = rssData.title || title; description = rssData.description || description;
            cover = rssData.cover || cover; audioUrl = rssData.audioUrl || '';
            platformName = rssData.platform || platformName; platformIcon = rssData.icon || platformIcon;
            siteName = rssData.siteName || siteName;
        }

        if (!title && html) {
            const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                                 html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
            const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            title = ogTitleMatch ? ogTitleMatch[1].trim() : (titleTagMatch ? titleTagMatch[1].trim() : '');
        }

        if (!cover && html) {
            const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                                 html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
            cover = ogImageMatch ? ogImageMatch[1].trim() : '';
        }
        if (cover && cover.startsWith('http://')) cover = cover.replace(/^http:\/\//i, 'https://');
        else if (cover && cover.startsWith('//')) cover = 'https:' + cover;

        if (!description && html) {
            const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                                 html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
            description = ogDescMatch ? ogDescMatch[1].trim() : '';
        }

        const decodeEntities = (str) => (str || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").trim();
        title = decodeEntities(title);
        description = decodeEntities(description);

        // 6. 服务端外链兜底：页面自身未给出标题/封面时，交由后端调用 Microlink
        // 隐私开关：LINK_ENRICH_MICROLINK=false 时完全不把用户链接送往第三方
        const microlinkEnabled = !env || env.LINK_ENRICH_MICROLINK !== 'false';
        if (microlinkEnabled && (!title || title === hostname) && !cover) {
            const enriched = await fetchMicrolinkPreview(rawUrl);
            if (enriched) {
                title = enriched.title || title;
                description = enriched.description || description;
                cover = enriched.cover || cover;
            }
        }

        if (!title || /^(403|404|500|502|503|Forbidden|Access Denied|Error|Just a moment|Cloudflare)/i.test(title)) {
            title = hostname;
        }

        return jsonResponse({ url: rawUrl, title, description, cover, platform: platformName, icon: platformIcon, siteName, audioUrl }, 200);
    } catch {
        return jsonResponse({ url: rawUrl, title: hostname, description: '', cover: '', platform: platformName, icon: platformIcon, siteName: platformName, audioUrl: '' }, 200);
    }
}
