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
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
        return jsonResponse({ error: '仅支持 http/https 链接' }, 400);
    }
    if (!isSafeFetchUrl(rawUrl)) {
        return jsonResponse({ error: '禁止访问该地址' }, 403);
    }
    if (isBlockedLinkUrl(rawUrl)) {
        return jsonResponse({ error: '该链接属于合规黑名单，禁止解析' }, 403);
    }

    let currentUrl = rawUrl;
    let title = '';
    let description = '';
    let cover = '';
    let platformName = '';
    let platformIcon = '🔗';
    let siteName = '';
    const parsedInitUrl = new URL(rawUrl);
    const hostname = parsedInitUrl.hostname;

    if (hostname.includes('bilibili.com')) { platformName = '哔哩哔哩'; platformIcon = '📺'; siteName = '哔哩哔哩'; }
    else if (hostname.includes('zhihu.com')) { platformName = '知乎'; platformIcon = '💡'; siteName = '知乎'; }
    else if (hostname.includes('github.com')) { platformName = 'GitHub'; platformIcon = '🐙'; siteName = 'GitHub'; }
    else if (hostname.includes('xiaoyuzhoufm.com')) { platformName = '小宇宙'; platformIcon = '🎙️'; siteName = '小宇宙'; }

    try {
        let hop = 0;
        let finalResponse = null;
        while (hop < 3) {
            finalResponse = await fetchWithTimeout(currentUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                redirect: 'manual'
            });
            if ([301, 302, 303, 307, 308].includes(finalResponse.status)) {
                const loc = finalResponse.headers.get('location');
                if (!loc) break;
                const nextUrl = new URL(loc, currentUrl).toString();
                if (!isSafeFetchUrl(nextUrl)) return jsonResponse({ error: '重定向到非法地址' }, 403);
                currentUrl = nextUrl;
                hop++;
                continue;
            }
            break;
        }

        // 限长读取：防止恶意站点用超大响应体撑爆 Worker 内存
        const html = finalResponse && finalResponse.ok ? await readTextCapped(finalResponse, 512 * 1024) : '';

        // 1. Xiaoyuzhou special parsing
        if (hostname.includes('xiaoyuzhoufm.com') && html) {
            const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (nextDataMatch) {
                try {
                    const parsed = JSON.parse(nextDataMatch[1]);
                    const ep = parsed?.props?.pageProps?.episode;
                    if (ep) {
                        title = ep.title || '';
                        description = ep.description || '';
                        cover = ep.image?.picUrl || ep.image?.thumbnailUrl || ep.image?.middlePicUrl || ep.podcast?.image?.picUrl || '';
                        siteName = ep.podcast?.title ? `${ep.podcast.title} · 小宇宙` : '小宇宙';
                    }
                } catch {}
            }
        }

        // 2. Priority OG title / twitter title / <title>
        if (!title && html) {
            const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                                 html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
            const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            title = ogTitleMatch ? ogTitleMatch[1].trim() : (titleTagMatch ? titleTagMatch[1].trim() : '');
        }

        // 3. Cover image extraction
        if (!cover && html) {
            const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                                 html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
            cover = ogImageMatch ? ogImageMatch[1].trim() : '';
        }
        if (cover && cover.startsWith('http://')) cover = cover.replace(/^http:\/\//i, 'https://');
        else if (cover && cover.startsWith('//')) cover = 'https:' + cover;

        // 4. Description extraction
        if (!description && html) {
            const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                                html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
            description = ogDescMatch ? ogDescMatch[1].trim() : '';
        }

        const decodeEntities = (str) => str ? str.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").trim() : '';
        title = decodeEntities(title);
        description = decodeEntities(description);

        // 5. 服务端外链兜底：页面自身未给出标题/封面时，交由后端调用 Microlink
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

        return jsonResponse({ url: rawUrl, title, description, cover, platform: platformName, icon: platformIcon, siteName }, 200);
    } catch {
        return jsonResponse({ url: rawUrl, title: hostname, description: '', cover: '', platform: platformName, icon: platformIcon, siteName: platformName }, 200);
    }
}

// ── Weeklies Handlers ──
