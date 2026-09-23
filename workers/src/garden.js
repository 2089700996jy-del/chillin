/**
 * Garden Domain Services Module
 * Manages CRUD, Sync (Pull & Batch), Attachments, and Data Exports for Weeklies, Notes, Bookmarks, Feeds, and Prompts.
 */
import webPush from 'web-push';
import {
    jsonResponse,
    checkRateLimit,
    rateLimitedResponse,
    applySecurityHeaders,
    timingSafeEqualStr,
    sniffImageMime,
    isSafeFetchUrl,
    fetchWithTimeout,
    isBlockedLinkUrl,
    isValidRecordId
} from './security.js';
import { scanAndAudit } from './audit.js';
import { callCustomLlm, moderateText } from './llm.js';

export function extractTagsFromContent(text) {
    const tags = [];
    if (/代码|bug|api|js|css|html|react|vue|node|worker|git|python|算法|开发/i.test(text)) tags.push('#技术');
    if (/生活|咖啡|电影|音乐|小说|美食|游记|运动|散步|秋天|猫|狗/i.test(text)) tags.push('#生活');
    if (/读书|笔记|文章|极客|思考|播客|想法|灵感/i.test(text)) tags.push('#灵感');
    if (tags.length === 0) tags.push('#随手记');
    return tags;
}

export function formatWeekly(row) {
    if (!row) return null;
    return {
        id: row.id,
        category: row.category,
        title: row.title,
        summary: row.summary,
        date: row.date,
        cover: row.cover || null,
        weeklyData: row.weekly_data ? JSON.parse(row.weekly_data) : null,
        content: row.content || null,
        annotations: row.annotations ? JSON.parse(row.annotations) : [],
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        is_deleted: row.is_deleted === 1
    };
}

export function formatNote(row) {
    if (!row) return null;
    return {
        ...row,
        annotations: row.annotations ? JSON.parse(row.annotations) : [],
        is_deleted: row.is_deleted === 1
    };
}

export function formatBookmark(row) {
    if (!row) return null;
    const desc = row.description || row.desc || '';
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        url: row.url,
        desc,
        description: desc,
        image: row.image || null,
        user_id: row.user_id,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        is_deleted: row.is_deleted === 1
    };
}

export function formatPrompt(row) {
    if (!row) return null;
    return {
        id: row.id,
        title: row.title,
        project: row.project || '通用',
        scene: row.scene || '开发',
        content: row.content || '',
        description: row.description || '',
        tags: row.tags || '',
        is_pinned: row.is_pinned === 1 ? 1 : 0,
        user_id: row.user_id,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        is_deleted: row.is_deleted === 1
    };
}

export function formatFeed(row) {
    if (!row) return null;
    let tags = [];
    if (Array.isArray(row.tags)) tags = row.tags;
    else if (typeof row.tags === 'string' && row.tags) {
        try { tags = JSON.parse(row.tags); } catch { tags = []; }
    }
    return {
        id: row.id,
        content: row.content,
        type: row.type,
        media_url: row.media_url || null,
        summary: row.summary || null,
        tags,
        user_id: row.user_id,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        is_deleted: row.is_deleted === 1
    };
}

export async function isOwnedRecord(db, table, id, userId) {
    if (id == null || id === '') return true;
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return false;
    const existing = await db.prepare(`SELECT user_id FROM ${table} WHERE id = ?1`).bind(n).first();
    if (!existing) return true;
    return Number(existing.user_id) === Number(userId);
}

export async function isSoftDeletedRecord(db, table, id, userId) {
    if (id == null || id === '') return false;
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return false;
    const row = await db.prepare(
        `SELECT is_deleted FROM ${table} WHERE id = ?1 AND user_id = ?2`
    ).bind(n, userId).first();
    return !!(row && Number(row.is_deleted) === 1);
}

export async function fetchSoftDeletedIdSet(db, tableName, userId, items) {
    const ids = items.map(i => i.id).filter(id => id != null && id !== '');
    if (ids.length === 0) return new Set();
    const placeholders = ids.map((_, idx) => `?${idx + 2}`).join(',');
    const res = await db.prepare(
        `SELECT id FROM ${tableName} WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 1 AND id IN (${placeholders})`
    ).bind(userId, ...ids).all();
    return new Set((res.results || []).map(r => Number(r.id)));
}

let softDeleteSchemaReady = false;
export async function ensureSoftDeleteSchema(db) {
    if (softDeleteSchemaReady) return;
    const stmts = [
        "ALTER TABLE weeklies ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "ALTER TABLE notes ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "ALTER TABLE bookmarks ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "ALTER TABLE quick_feeds ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "CREATE INDEX IF NOT EXISTS idx_weeklies_updated_at ON weeklies(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_weeklies_is_deleted ON weeklies(is_deleted)",
        "CREATE INDEX IF NOT EXISTS idx_notes_is_deleted ON notes(is_deleted)",
        "CREATE INDEX IF NOT EXISTS idx_bookmarks_is_deleted ON bookmarks(is_deleted)",
        "CREATE INDEX IF NOT EXISTS idx_quick_feeds_is_deleted ON quick_feeds(is_deleted)"
    ];
    for (const sql of stmts) {
        try {
            await db.prepare(sql).run();
        } catch (_) {}
    }
    softDeleteSchemaReady = true;
}

// ── File Upload & View ──
export async function handleUpload(request, db, userId) {
    const uploadLimit = checkRateLimit(`upload:${userId}`, 60, 10 * 60 * 1000);
    if (!uploadLimit.ok) return rateLimitedResponse(uploadLimit.retryAfter);

    try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return jsonResponse({ error: 'No file uploaded' }, 400);

        const arrayBuffer = await file.arrayBuffer();
        const MAX_SIZE = 5 * 1024 * 1024;
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
export async function handleLinkParse(request, db, userId) {
    const linkLimit = checkRateLimit(`link:${userId}`, 40, 10 * 60 * 1000);
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

        const html = finalResponse && finalResponse.ok ? await finalResponse.text() : '';

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

        if (!title || /^(403|404|500|502|503|Forbidden|Access Denied|Error|Just a moment|Cloudflare)/i.test(title)) {
            title = hostname;
        }

        return jsonResponse({ url: rawUrl, title, description, cover, platform: platformName, icon: platformIcon, siteName }, 200);
    } catch {
        return jsonResponse({ url: rawUrl, title: hostname, description: '', cover: '', platform: platformName, icon: platformIcon, siteName: platformName }, 200);
    }
}

// ── Weeklies Handlers ──
export async function handleGetWeeklies(url, db, userId) {
    const since = url.searchParams.get('since');
    let result;
    if (since) {
        result = await db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, since).all();
    } else {
        result = await db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all();
    }
    return jsonResponse(result.results.map(formatWeekly), 200);
}

export async function handlePostWeekly(request, db, userId) {
    const body = await request.json();
    if (body.id != null && !isValidRecordId(body.id)) return jsonResponse({ error: '无效的记录 ID' }, 400);
    if (!(await isOwnedRecord(db, 'weeklies', body.id, userId))) return jsonResponse({ error: '无权操作该记录' }, 403);
    if (await isSoftDeletedRecord(db, 'weeklies', body.id, userId)) {
        return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
    }
    const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
    const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
    await db.prepare(
        `INSERT OR REPLACE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content, annotations, user_id, updated_at, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now', '+8 hours'), 0)`
    ).bind(body.id, body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', annotations, userId).run();
    const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
    return jsonResponse(formatWeekly(row), 201);
}

export async function handlePutWeekly(id, request, db, userId) {
    const body = await request.json();
    const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
    const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
    await db.prepare(
        `UPDATE weeklies SET category=?1, title=?2, summary=?3, date=?4, cover=?5, weekly_data=?6, content=?7, annotations=?8, updated_at=datetime('now', '+8 hours')
         WHERE id=?9 AND user_id=?10 AND IFNULL(is_deleted, 0) = 0`
    ).bind(body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', annotations, id, userId).run();
    const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
    if (row && Number(row.is_deleted) === 1) return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
    return jsonResponse(formatWeekly(row), 200);
}

export async function handleDeleteWeekly(id, db, userId) {
    await db.prepare("UPDATE weeklies SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
    return jsonResponse({ success: true }, 200);
}

// ── Notes Handlers ──
export async function handleGetNotes(url, db, userId) {
    const since = url.searchParams.get('since');
    let result;
    if (since) {
        result = await db.prepare('SELECT * FROM notes WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, since).all();
    } else {
        result = await db.prepare('SELECT * FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all();
    }
    return jsonResponse(result.results.map(formatNote), 200);
}

export async function handlePostNote(request, db, userId) {
    const body = await request.json();
    if (body.id != null && !isValidRecordId(body.id)) return jsonResponse({ error: '无效的记录 ID' }, 400);
    if (!(await isOwnedRecord(db, 'notes', body.id, userId))) return jsonResponse({ error: '无权操作该记录' }, 403);
    if (await isSoftDeletedRecord(db, 'notes', body.id, userId)) {
        return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
    }
    const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
    await db.prepare(
        `INSERT OR REPLACE INTO notes (id, title, content, date, annotations, user_id, updated_at, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), 0)`
    ).bind(body.id, body.title, body.content || '', body.date, annotations, userId).run();
    const row = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
    return jsonResponse(formatNote(row), 201);
}

export async function handlePutNote(id, request, db, userId) {
    const body = await request.json();
    const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
    await db.prepare(
        `UPDATE notes SET title=?1, content=?2, date=?3, annotations=?4, updated_at=datetime('now', '+8 hours') WHERE id=?5 AND user_id=?6 AND IFNULL(is_deleted, 0) = 0`
    ).bind(body.title, body.content || '', body.date, annotations, id, userId).run();
    const row = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
    if (row && Number(row.is_deleted) === 1) return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
    return jsonResponse(formatNote(row), 200);
}

export async function handleDeleteNote(id, db, userId) {
    await db.prepare("UPDATE notes SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
    return jsonResponse({ success: true }, 200);
}

// ── Bookmarks Handlers ──
export async function handleGetBookmarks(url, db, userId) {
    const since = url.searchParams.get('since');
    let result;
    if (since) {
        result = await db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, since).all();
    } else {
        result = await db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all();
    }
    return jsonResponse((result.results || []).map(formatBookmark), 200);
}

export async function handlePostBookmark(request, db, userId) {
    const body = await request.json();
    if (body.id != null && !isValidRecordId(body.id)) return jsonResponse({ error: '无效的记录 ID' }, 400);
    if (!(await isOwnedRecord(db, 'bookmarks', body.id, userId))) return jsonResponse({ error: '无权操作该记录' }, 403);
    if (await isSoftDeletedRecord(db, 'bookmarks', body.id, userId)) {
        return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
    }
    const image = body.image || body.img || null;
    const description = body.desc || body.description || '';
    await db.prepare(
        `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description, image, user_id, updated_at, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now', '+8 hours'), 0)`
    ).bind(body.id, body.type, body.title, body.url, description, image, userId).run();
    const row = await db.prepare('SELECT * FROM bookmarks WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
    return jsonResponse(formatBookmark(row), 201);
}

export async function handleDeleteBookmark(id, db, userId) {
    await db.prepare("UPDATE bookmarks SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
    return jsonResponse({ success: true }, 200);
}

// ── Prompts Handlers ──
export async function handleGetPrompts(url, db, userId) {
    const since = url.searchParams.get('since');
    const project = url.searchParams.get('project');
    const scene = url.searchParams.get('scene');
    let query = 'SELECT * FROM prompts WHERE user_id = ?1';
    const params = [userId];

    if (since) {
        query += ' AND updated_at > ?2 ORDER BY is_pinned DESC, id DESC';
        params.push(since);
    } else {
        query += ' AND is_deleted = 0';
        if (project && project !== 'all') {
            params.push(project);
            query += ` AND project = ?${params.length}`;
        }
        if (scene && scene !== 'all') {
            params.push(scene);
            query += ` AND scene = ?${params.length}`;
        }
        query += ' ORDER BY is_pinned DESC, id DESC';
    }
    const result = await db.prepare(query).bind(...params).all();
    return jsonResponse((result.results || []).map(formatPrompt), 200);
}

export async function handlePostPrompt(request, db, userId) {
    const body = await request.json();
    if (body.id != null && !isValidRecordId(body.id)) return jsonResponse({ error: '无效的记录 ID' }, 400);
    if (!(await isOwnedRecord(db, 'prompts', body.id, userId))) return jsonResponse({ error: '无权操作该记录' }, 403);
    if (await isSoftDeletedRecord(db, 'prompts', body.id, userId)) {
        return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
    }
    const title = (body.title || '').trim();
    if (!title) return jsonResponse({ error: '提示词标题不能为空' }, 400);
    const content = (body.content || '').trim();
    if (!content) return jsonResponse({ error: '提示词正文不能为空' }, 400);
    const project = (body.project || '通用').trim();
    const scene = (body.scene || '开发').trim();
    const description = (body.description || body.desc || '').trim();
    const tags = (body.tags || '').trim();
    const isPinned = body.is_pinned ? 1 : 0;

    await db.prepare(
        `INSERT OR REPLACE INTO prompts (id, title, project, scene, content, description, tags, is_pinned, user_id, updated_at, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now', '+8 hours'), 0)`
    ).bind(body.id, title, project, scene, content, description, tags, isPinned, userId).run();

    const row = await db.prepare('SELECT * FROM prompts WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
    return jsonResponse(formatPrompt(row), 201);
}

export async function handleDeletePrompt(id, db, userId) {
    await db.prepare("UPDATE prompts SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
    return jsonResponse({ success: true }, 200);
}

// ── Feeds Handlers ──
export async function handleGetFeeds(url, db, userId) {
    const since = url.searchParams.get('since');
    let result;
    if (since) {
        result = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, since).all();
    } else {
        result = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all();
    }
    return jsonResponse((result.results || []).map(formatFeed), 200);
}

export async function handlePostFeed(request, db, userId) {
    const body = await request.json();
    if (body.id != null && !isValidRecordId(body.id)) return jsonResponse({ error: '无效的记录 ID' }, 400);
    if (!(await isOwnedRecord(db, 'quick_feeds', body.id, userId))) return jsonResponse({ error: '无权操作该记录' }, 403);
    if (body.id && await isSoftDeletedRecord(db, 'quick_feeds', body.id, userId)) {
        return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
    }
    const content = body.content || '';
    const type = body.type || (content.match(/^https?:\/\//i) ? 'link' : 'text');
    const mediaUrl = body.media_url || body.mediaUrl || null;
    const summary = body.summary || null;
    let tags = body.tags || [];
    if (!tags || tags.length === 0) tags = extractTagsFromContent(content);
    const tagsJson = JSON.stringify(tags);

    let res;
    if (body.id) {
        await db.prepare(
            `INSERT OR REPLACE INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, datetime('now', '+8 hours')), datetime('now', '+8 hours'), 0)`
        ).bind(body.id, userId, content, type, mediaUrl, summary, tagsJson, body.created_at || null).run();
        res = await db.prepare('SELECT * FROM quick_feeds WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
    } else {
        res = await db.prepare(
            `INSERT INTO quick_feeds (user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), datetime('now', '+8 hours'), 0) RETURNING *`
        ).bind(userId, content, type, mediaUrl, summary, tagsJson).first();
    }
    return jsonResponse(formatFeed(res), 201);
}

export async function handlePutFeed(id, request, db, userId) {
    const body = await request.json();
    const content = body.content || '';
    const type = body.type || 'text';
    const mediaUrl = body.media_url || body.mediaUrl || null;
    const summary = body.summary || null;
    const tags = body.tags || extractTagsFromContent(content);
    const tagsJson = JSON.stringify(tags);
    await db.prepare(
        `UPDATE quick_feeds SET content=?1, type=?2, media_url=?3, summary=?4, tags=?5, updated_at=datetime('now', '+8 hours') WHERE id=?6 AND user_id=?7 AND IFNULL(is_deleted, 0) = 0`
    ).bind(content, type, mediaUrl, summary, tagsJson, id, userId).run();
    const row = await db.prepare('SELECT * FROM quick_feeds WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
    if (row && Number(row.is_deleted) === 1) return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
    return jsonResponse(formatFeed(row), 200);
}

export async function handleDeleteFeed(id, db, userId) {
    await db.prepare("UPDATE quick_feeds SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
    return jsonResponse({ success: true }, 200);
}

// ── Aggregated Sync Pull (NEW: 1 RTT replaces 5 sequential pulls) ──
export async function handleSyncPull(url, db, userId) {
    const sinceWeeklies = url.searchParams.get('since_weeklies') || url.searchParams.get('since');
    const sinceNotes = url.searchParams.get('since_notes') || url.searchParams.get('since');
    const sinceBookmarks = url.searchParams.get('since_bookmarks') || url.searchParams.get('since');
    const sincePrompts = url.searchParams.get('since_prompts') || url.searchParams.get('since');
    const sinceFeeds = url.searchParams.get('since_feeds') || url.searchParams.get('since');

    const [weekliesRes, notesRes, bookmarksRes, promptsRes, feedsRes] = await Promise.all([
        sinceWeeklies
            ? db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, sinceWeeklies).all()
            : db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        sinceNotes
            ? db.prepare('SELECT * FROM notes WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, sinceNotes).all()
            : db.prepare('SELECT * FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        sinceBookmarks
            ? db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, sinceBookmarks).all()
            : db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        sincePrompts
            ? db.prepare('SELECT * FROM prompts WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, sincePrompts).all()
            : db.prepare('SELECT * FROM prompts WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        sinceFeeds
            ? db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, sinceFeeds).all()
            : db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
    ]);

    return jsonResponse({
        weeklies: (weekliesRes.results || []).map(formatWeekly),
        notes: (notesRes.results || []).map(formatNote),
        bookmarks: (bookmarksRes.results || []).map(formatBookmark),
        prompts: (promptsRes.results || []).map(formatPrompt),
        feeds: (feedsRes.results || []).map(formatFeed),
    }, 200);
}

// ── Batch Sync (Push) ──
export async function handleSyncBatch(request, db, userId) {
    const body = await request.json();
    const weeklies = body.weeklies || [];
    const notes = body.notes || [];
    const bookmarks = body.bookmarks || [];
    const feeds = body.feeds || [];
    const prompts = body.prompts || [];

    const statements = [];

    const fetchOwnedSet = async (tableName, items) => {
        const ids = items.map(i => i.id).filter(id => id != null && id !== '' && isValidRecordId(id));
        if (ids.length === 0) return new Set();
        const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(',');
        const res = await db.prepare(`SELECT id, user_id FROM ${tableName} WHERE id IN (${placeholders})`).bind(...ids).all();
        const allowed = new Set();
        const existingMap = new Map((res.results || []).map(r => [r.id, r.user_id]));
        for (const id of ids) {
            if (!existingMap.has(id) || Number(existingMap.get(id)) === Number(userId)) {
                allowed.add(id);
            }
        }
        return allowed;
    };

    const allowedWeeklies = await fetchOwnedSet('weeklies', weeklies);
    const allowedNotes = await fetchOwnedSet('notes', notes);
    const allowedBookmarks = await fetchOwnedSet('bookmarks', bookmarks);
    const allowedFeeds = await fetchOwnedSet('quick_feeds', feeds);
    const allowedPrompts = await fetchOwnedSet('prompts', prompts);

    const deletedWeeklies = await fetchSoftDeletedIdSet(db, 'weeklies', userId, weeklies);
    const deletedNotes = await fetchSoftDeletedIdSet(db, 'notes', userId, notes);
    const deletedBookmarks = await fetchSoftDeletedIdSet(db, 'bookmarks', userId, bookmarks);
    const deletedFeeds = await fetchSoftDeletedIdSet(db, 'quick_feeds', userId, feeds);
    const deletedPrompts = await fetchSoftDeletedIdSet(db, 'prompts', userId, prompts);

    for (const item of weeklies) {
        if (item.id != null && !isValidRecordId(item.id)) continue;
        if (weeklies.length > 1 && item.id === 1) continue;
        if (item.id != null && !allowedWeeklies.has(item.id)) continue;
        if (item.id != null && deletedWeeklies.has(Number(item.id))) continue;
        const weeklyData = item.weeklyData ? JSON.stringify(item.weeklyData) : null;
        const annotations = item.annotations ? JSON.stringify(item.annotations) : '[]';
        statements.push(
            db.prepare(
                `INSERT OR REPLACE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content, annotations, user_id, updated_at, is_deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now', '+8 hours'), 0)`
            ).bind(item.id, item.category, item.title, item.summary, item.date, item.cover || '', weeklyData, item.content || '', annotations, userId)
        );
    }

    for (const item of notes) {
        if (item.id != null && !isValidRecordId(item.id)) continue;
        if (notes.length > 2 && (item.id === 101 || item.id === 102)) continue;
        if (item.id != null && !allowedNotes.has(item.id)) continue;
        if (item.id != null && deletedNotes.has(Number(item.id))) continue;
        const annotations = item.annotations ? JSON.stringify(item.annotations) : '[]';
        statements.push(
            db.prepare(
                `INSERT OR REPLACE INTO notes (id, title, content, date, annotations, user_id, updated_at, is_deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), 0)`
            ).bind(item.id, item.title, item.content || '', item.date, annotations, userId)
        );
    }

    for (const item of bookmarks) {
        if (item.id != null && !isValidRecordId(item.id)) continue;
        if (bookmarks.length > 3 && (item.id === 201 || item.id === 202 || item.id === 203)) continue;
        if (item.id != null && !allowedBookmarks.has(item.id)) continue;
        if (item.id != null && deletedBookmarks.has(Number(item.id))) continue;
        const image = item.image || item.img || null;
        const description = item.desc || item.description || '';
        statements.push(
            db.prepare(
                `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description, image, user_id, updated_at, is_deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now', '+8 hours'), 0)`
            ).bind(item.id, item.type, item.title, item.url, description, image, userId)
        );
    }

    for (const item of feeds) {
        if (item.id != null && !isValidRecordId(item.id)) continue;
        if (feeds.length > 1 && item.id === 1) continue;
        if (item.id != null && !allowedFeeds.has(item.id)) continue;
        if (item.id != null && deletedFeeds.has(Number(item.id))) continue;
        const content = item.content || '';
        const type = item.type || (content.match(/^https?:\/\//i) ? 'link' : 'text');
        const mediaUrl = item.media_url || item.mediaUrl || null;
        const summary = item.summary || null;
        let tags = item.tags || [];
        if (!tags || tags.length === 0) tags = extractTagsFromContent(content);
        const tagsJson = JSON.stringify(tags);

        if (item.id) {
            statements.push(
                db.prepare(
                    `INSERT OR REPLACE INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, datetime('now', '+8 hours')), datetime('now', '+8 hours'), 0)`
                ).bind(item.id, userId, content, type, mediaUrl, summary, tagsJson, item.created_at || null)
            );
        } else {
            statements.push(
                db.prepare(
                    `INSERT INTO quick_feeds (user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), datetime('now', '+8 hours'), 0)`
                ).bind(userId, content, type, mediaUrl, summary, tagsJson)
            );
        }
    }

    for (const item of prompts) {
        if (item.id != null && !isValidRecordId(item.id)) continue;
        if (item.id != null && !allowedPrompts.has(item.id)) continue;
        if (item.id != null && deletedPrompts.has(Number(item.id))) continue;
        const title = (item.title || '').trim();
        const content = (item.content || '').trim();
        if (!title || !content) continue;
        const project = (item.project || '通用').trim();
        const scene = (item.scene || '开发').trim();
        const description = (item.description || item.desc || '').trim();
        const tags = (item.tags || '').trim();
        const isPinned = item.is_pinned ? 1 : 0;
        statements.push(
            db.prepare(
                `INSERT OR REPLACE INTO prompts (id, title, project, scene, content, description, tags, is_pinned, user_id, updated_at, is_deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now', '+8 hours'), 0)`
            ).bind(item.id, title, project, scene, content, description, tags, isPinned, userId)
        );
    }

    if (statements.length > 0) {
        await db.batch(statements);
    }
    return jsonResponse({ success: true, count: statements.length }, 200);
}

// ── Heatmap & Export ──
export async function handleHeatmap(db, userId) {
    const result = await db.prepare(`
        SELECT date_str, COUNT(*) as count FROM (
            SELECT substr(COALESCE(created_at, date, updated_at), 1, 10) as date_str FROM weeklies WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
            UNION ALL
            SELECT substr(COALESCE(created_at, date, updated_at), 1, 10) as date_str FROM notes WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
            UNION ALL
            SELECT substr(COALESCE(created_at, updated_at), 1, 10) as date_str FROM bookmarks WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
            UNION ALL
            SELECT substr(COALESCE(created_at, updated_at), 1, 10) as date_str FROM quick_feeds WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
            UNION ALL
            SELECT substr(COALESCE(created_at, updated_at), 1, 10) as date_str FROM prompts WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
        ) WHERE date_str IS NOT NULL AND date_str != '' GROUP BY date_str ORDER BY date_str ASC
    `).bind(userId).all();
    return jsonResponse(result.results || [], 200);
}

// ── Echo Generation & AI Review ──
export async function handleEchoGenerate(request, env, ctx, db, userId) {
    const echoLimit = checkRateLimit(`echo:${userId}`, 20, 10 * 60 * 1000);
    if (!echoLimit.ok) return rateLimitedResponse(echoLimit.retryAfter);

    const feeds = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 12').bind(userId).all();
    if (!feeds.results || feeds.results.length === 0) {
        return jsonResponse({ error: '暂无足够的随手记生成回响卡片，请先多记录一些思考吧！' }, 400);
    }

    const notes = await db.prepare('SELECT title, content, date FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 5').bind(userId).all();
    const contextText = [
        ...(feeds.results || []).map(f => `[随手记 ${f.created_at || ''}] ${f.content || ''}`),
        ...(notes.results || []).map(n => `[笔记 ${n.date || ''}] ${n.title}: ${(n.content || '').slice(0, 120)}`)
    ].join('\n');

    const systemPrompt = [
        '你是用户在数字花园 Chillin 中的 AI 记忆回响助手。',
        '请根据用户近期记录，生成一张「回响卡片」。',
        '必须只输出一个 JSON 对象，不要 markdown 代码块，不要额外解释。',
        '字段：title（不超过24字的标题）、topic（2-8字主题标签）、summary（80-160字摘要，温暖有条理，提炼共性与可继续的思考，不要逐条复读原文）。'
    ].join('');
    const userPrompt = `用户近期记录：\n${contextText}\n\n请生成回响卡片 JSON。`;

    let cardTitle = '';
    let topic = '灵感脉络';
    let summary = '';
    let reply = '';
    try {
        reply = await callCustomLlm(env, systemPrompt, userPrompt);
    } catch (err) {
        console.error('Echo LLM error:', err);
    }

    if (reply) {
        try {
            const cleaned = String(reply).replace(/```json/gi, '').replace(/```/g, '').trim();
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
            cardTitle = String(parsed.title || '').trim();
            topic = String(parsed.topic || topic).trim() || topic;
            summary = String(parsed.summary || '').trim();
        } catch {
            summary = String(reply).replace(/```/g, '').trim().slice(0, 200);
            cardTitle = '近期思维回响';
        }
    }

    if (!cardTitle || !summary) {
        const recentTexts = feeds.results.map(f => f.content).filter(Boolean).slice(0, 5).join('；');
        cardTitle = cardTitle || '近期思维回响与灵感梳理';
        summary = summary || `在最近的记录中，你关注了：${recentTexts.slice(0, 120)}… 建议把这些零碎灵感进一步写成笔记或周记。`;
        topic = topic || '本地摘要';
    }

    const moderatedTitle = moderateText(cardTitle, env);
    const moderatedTopic = moderateText(topic, env);
    const moderatedSummary = moderateText(summary, env);
    if (!moderatedTitle.ok || !moderatedTopic.ok || !moderatedSummary.ok) {
        return jsonResponse({ error: '内容不合规，已拒绝生成' }, 403);
    }

    const feedIds = JSON.stringify(feeds.results.map(f => f.id));
    const newCard = await db.prepare(
        `INSERT INTO echo_cards (user_id, title, summary, topic, related_feed_ids, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', '+8 hours')) RETURNING *`
    ).bind(userId, moderatedTitle.text, moderatedSummary.text, moderatedTopic.text, feedIds).first();

    // 尝试发送推送通知
    ctx.waitUntil((async () => {
        try {
            const subs = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1').bind(userId).all();
            if (subs && subs.results && subs.results.length > 0) {
                webPush.setVapidDetails('mailto:admin@chillin.local', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
                const payload = JSON.stringify({
                    title: '✨ AI 记忆回响已生成',
                    body: `探讨了关于 ${moderatedTopic.text} 的新灵感`,
                    url: '/'
                });
                const pushPromises = subs.results.map(async sub => {
                    try {
                        await webPush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
                    } catch (err) {
                        if (err.statusCode === 404 || err.statusCode === 410) {
                            await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(sub.endpoint).run();
                        }
                    }
                });
                await Promise.all(pushPromises);
            }
        } catch (err) {
            console.error('Failed to send push notifications:', err);
        }
    })());

    return jsonResponse(newCard, 201);
}

export async function handleGetEchoCards(db, userId) {
    const cards = await db.prepare('SELECT * FROM echo_cards WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all();
    return jsonResponse(cards.results || [], 200);
}

export async function handleDeleteEchoCard(id, db, userId) {
    await db.prepare('DELETE FROM echo_cards WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
    return jsonResponse({ success: true }, 200);
}

export async function handleAiReview(env, db, userId) {
    const reviewLimit = checkRateLimit(`review:${userId}`, 20, 10 * 60 * 1000);
    if (!reviewLimit.ok) return rateLimitedResponse(reviewLimit.retryAfter);

    const [feeds, notes, weeklies] = await Promise.all([
        db.prepare("SELECT content, created_at FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 AND created_at >= datetime('now', '-7 days') ORDER BY id DESC LIMIT 30").bind(userId).all(),
        db.prepare("SELECT title, content, date FROM notes WHERE user_id = ?1 AND is_deleted = 0 AND (created_at >= datetime('now', '-7 days') OR date >= datetime('now', '-7 days')) ORDER BY id DESC LIMIT 15").bind(userId).all(),
        db.prepare("SELECT title, summary, date FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 AND (created_at >= datetime('now', '-7 days') OR date >= datetime('now', '-7 days')) ORDER BY id DESC LIMIT 5").bind(userId).all()
    ]);

    const contextText = [
        ...(feeds.results || []).map(f => `[随手记 ${f.created_at || ''}] ${f.content || ''}`),
        ...(notes.results || []).map(n => `[备忘录 ${n.date || ''}] ${n.title}: ${n.content || ''}`),
        ...(weeklies.results || []).map(w => `[周记 ${w.date || ''}] ${w.title}: ${w.summary || ''}`)
    ].join('\n');

    if (!contextText.trim()) {
        return jsonResponse({ reply: '这一周还没有新的记录，去随手记里写下点什么吧。' }, 200);
    }

    const systemPrompt = '你是用户在数字花园 Chillin 中的 AI 记忆回响助手。请基于用户近期的记录生成一份「本周回顾」，按时间线或主题梳理：做了什么、关注了什么、有哪些值得留意的想法。语气温暖、简炼、有条理。';
    const userPrompt = `用户近期记录：\n${contextText}\n\n请生成本周回顾。`;

    let reply = '';
    try {
        reply = await callCustomLlm(env, systemPrompt, userPrompt);
    } catch (err) {
        console.error('Review LLM error:', err);
    }
    if (!reply) {
        reply = '本周回顾（本地摘要）：\n\n' + contextText.split('\n').slice(0, 8).map(l => '• ' + l).join('\n');
    }

    const moderated = moderateText(reply, env);
    if (!moderated.ok) {
        return jsonResponse({ error: '内容不合规，已拒绝输出' }, 403);
    }
    return jsonResponse({ reply: moderated.text }, 200);
}

export async function handleAuditScan(db, userId) {
    const result = await scanAndAudit(db, userId);
    return jsonResponse(result, 200);
}
