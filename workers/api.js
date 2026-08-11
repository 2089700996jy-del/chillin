// Chillin API Worker — REST API for auth, weeklies, notes, bookmarks
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS 预检
        if (method === 'OPTIONS') {
            return corsResponse(null, 204);
        }

        // 校验 API Key (对于获取文件的公开 GET 请求，予以放行)
        const isPublicFileRoute = method === 'GET' && path.startsWith('/api/file/');
        if (!isPublicFileRoute) {
            const apiKey = request.headers.get('X-API-Key');
            if (apiKey !== env.API_KEY) {
                return jsonResponse({ error: 'Forbidden: Invalid API Key' }, 403);
            }
        }

        try {
            return await router(path, method, request, env);
        } catch (err) {
            return jsonResponse({ error: err.message }, 500);
        }
    }
};

function corsResponse(body, status) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization'
    };
    if (!body) return new Response(null, { status, headers });
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json' }
    });
}

function jsonResponse(body, status) {
    return corsResponse(body, status);
}

// 密码哈希加密
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 解析 Token 鉴权
async function authenticate(request, db) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    const token = authHeader.split(' ')[1];
    
    // 检查 session 是否有效且未过期
    const session = await db.prepare('SELECT user_id FROM sessions WHERE token = ?1 AND expires_at > ?2')
        .bind(token, Date.now()).first();
        
    return session ? session.user_id : null;
}

async function router(path, method, request, env) {
    const db = env.DB;

    // ==================== AUTH 认证 ====================
    if (path === '/api/auth/register' && method === 'POST') {
        // 校验是否允许注册
        if (env.ALLOW_REGISTRATION !== 'true') {
            return jsonResponse({ error: '注册功能已关闭，请联系管理员。' }, 403);
        }

        const { username, password } = await request.json();
        if (!username || !password || username.length < 3 || password.length < 6) {
            return jsonResponse({ error: '账号必须大于3位，密码必须大于6位' }, 400);
        }

        const existing = await db.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first();
        if (existing) {
            return jsonResponse({ error: '该账号已被注册' }, 400);
        }

        const hashedPassword = await hashPassword(password);
        
        // 插入用户
        const insertResult = await db.prepare('INSERT INTO users (username, password_hash) VALUES (?1, ?2) RETURNING id')
            .bind(username, hashedPassword).first();
            
        const userId = insertResult.id;
        
        // 自动登录生成 Token
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
        await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
            .bind(token, userId, expiresAt).run();

        return jsonResponse({ token, username, userId }, 201);
    }

    if (path === '/api/auth/login' && method === 'POST') {
        const { username, password } = await request.json();
        if (!username || !password) return jsonResponse({ error: '请输入账号和密码' }, 400);

        const user = await db.prepare('SELECT id, password_hash FROM users WHERE username = ?1').bind(username).first();
        if (!user) return jsonResponse({ error: '账号或密码错误' }, 401);

        const hashedPassword = await hashPassword(password);
        if (user.password_hash !== hashedPassword) {
            return jsonResponse({ error: '账号或密码错误' }, 401);
        }

        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
        await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
            .bind(token, user.id, expiresAt).run();

        return jsonResponse({ token, username, userId: user.id }, 200);
    }

    // ==================== FILE 公开路由 ====================
    if (path.startsWith('/api/file/') && method === 'GET') {
        const fileId = path.replace('/api/file/', '');
        if (!fileId) return new Response('Not Found', { status: 404 });
        
        const row = await db.prepare('SELECT mime_type, data FROM files WHERE id = ?1').bind(fileId).first();
        if (!row) return new Response('Not Found', { status: 404 });
        
        let responseData = row.data;
        if (Array.isArray(responseData)) {
            responseData = new Uint8Array(responseData);
        } else if (responseData instanceof ArrayBuffer) {
            responseData = new Uint8Array(responseData);
        }
        
        return new Response(responseData, {
            status: 200,
            headers: {
                'Content-Type': row.mime_type,
                'Cache-Control': 'public, max-age=31536000',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }

    // ==================== LINK PARSE 链接智能提取 ====================
    if (path === '/api/link/parse' && method === 'POST') {
        const { url } = await request.json();
        if (!url || !url.match(/^https?:\/\//i)) {
            return jsonResponse({ error: '无效的 URL' }, 400);
        }
        
        let platformName = '网络链接';
        let platformIcon = '🌐';
        let hostname = url;
        try {
            const u = new URL(url);
            hostname = u.hostname;
            if (hostname.includes('xiaoyuzhoufm.com')) {
                platformName = '小宇宙';
                platformIcon = '🪐';
            } else if (hostname.includes('xiaohongshu.com') || hostname.includes('xhslink.com')) {
                platformName = '小红书';
                platformIcon = '📕';
            } else if (hostname.includes('bilibili.com') || hostname.includes('b23.tv')) {
                platformName = 'Bilibili';
                platformIcon = '📺';
            } else if (hostname.includes('weixin.qq.com')) {
                platformName = '微信文章';
                platformIcon = '💬';
            } else if (hostname.includes('zhihu.com')) {
                platformName = '知乎';
                platformIcon = '💡';
            } else if (hostname.includes('music.163.com')) {
                platformName = '网易云音乐';
                platformIcon = '🎵';
            } else if (hostname.includes('ximalaya.com')) {
                platformName = '喜马拉雅';
                platformIcon = '🎙️';
            } else if (hostname.includes('weibo.com') || hostname.includes('weibo.cn')) {
                platformName = '微博';
                platformIcon = '🔴';
            } else if (hostname.includes('douyin.com')) {
                platformName = '抖音';
                platformIcon = '🎵';
            } else if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
                platformName = 'YouTube';
                platformIcon = '▶️';
            } else if (hostname.includes('github.com')) {
                platformName = 'GitHub';
                platformIcon = '🐙';
            } else {
                platformName = hostname;
                platformIcon = '🌐';
            }
        } catch {}

        try {
            const isXiaoyuzhou = url.includes('xiaoyuzhoufm.com');
            const userAgent = isXiaoyuzhou 
                ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
                : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

            const pageRes = await fetch(url, {
                headers: { 
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                },
                redirect: 'follow'
            });

            if (!pageRes.ok) {
                throw new Error(`HTTP status ${pageRes.status}`);
            }

            const html = await pageRes.text();
            
            let title = '';
            let description = '';
            let cover = '';
            let siteName = platformName;

            // 1. Check for Xiaoyuzhou NEXT_DATA json
            if (isXiaoyuzhou) {
                const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
                if (nextDataMatch) {
                    try {
                        const nextData = JSON.parse(nextDataMatch[1]);
                        const ep = nextData.props?.pageProps?.episode;
                        if (ep) {
                            title = ep.title || '';
                            description = ep.description || '';
                            cover = ep.image?.picUrl || ep.image?.thumbnailUrl || ep.image?.middlePicUrl || ep.podcast?.image?.picUrl || ep.podcast?.image?.thumbnailUrl || '';
                            siteName = ep.podcast?.title ? `${ep.podcast.title} · 小宇宙` : '小宇宙';
                        }
                    } catch {}
                }
            }

            // 2. Priority OG title / twitter title / <title>
            if (!title) {
                const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                                     html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i) ||
                                     html.match(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i);
                const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                title = ogTitleMatch ? ogTitleMatch[1].trim() : (titleTagMatch ? titleTagMatch[1].trim() : '');
            }

            // 3. Cover image extraction
            if (!cover) {
                const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                                     html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i) ||
                                     html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
                cover = ogImageMatch ? ogImageMatch[1].trim() : '';
            }

            // Ensure HTTPS for cover image URL
            if (cover && cover.startsWith('http://')) {
                cover = cover.replace(/^http:\/\//i, 'https://');
            } else if (cover && cover.startsWith('//')) {
                cover = 'https:' + cover;
            }

            // 4. Description extraction
            if (!description) {
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

            return jsonResponse({ url, title, description, cover, platform: platformName, icon: platformIcon, siteName }, 200);
        } catch (e) {
            return jsonResponse({ url, title: hostname, description: '', cover: '', platform: platformName, icon: platformIcon, siteName: platformName }, 200);
        }
    }

    // ========== 需要鉴权的路由 ==========
    const userId = await authenticate(request, db);
    if (!userId) {
        return jsonResponse({ error: '未登录或登录已过期' }, 401);
    }

    // ==================== UPLOAD 上传 ====================
    if (path === '/api/upload' && method === 'POST') {
        try {
            const formData = await request.formData();
            const file = formData.get('file');
            if (!file) {
                return jsonResponse({ error: 'No file uploaded' }, 400);
            }
            const arrayBuffer = await file.arrayBuffer();
            const mimeType = file.type || 'application/octet-stream';
            const id = crypto.randomUUID();
            await db.prepare('INSERT INTO files (id, mime_type, data) VALUES (?1, ?2, ?3)')
                .bind(id, mimeType, arrayBuffer).run();
                
            return jsonResponse([{ src: `/api/file/${id}` }], 201);
        } catch (err) {
            return jsonResponse({ error: err.message }, 500);
        }
    }

    if (path === '/api/auth/logout' && method === 'POST') {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader.split(' ')[1];
        await db.prepare('DELETE FROM sessions WHERE token = ?1').bind(token).run();
        return jsonResponse({ success: true }, 200);
    }

    if (path === '/api/auth/me' && method === 'GET') {
        const user = await db.prepare('SELECT id, username FROM users WHERE id = ?1').bind(userId).first();
        return jsonResponse(user, 200);
    }

    // ==================== WEEKLY 周记 ====================
    if (path === '/api/weeklies' && method === 'GET') {
        const result = await db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all();
        const rows = result.results.map(formatWeekly);
        return jsonResponse(rows, 200);
    }

    if (path === '/api/weeklies' && method === 'POST') {
        const body = await request.json();
        const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
        const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
        await db.prepare(
            `INSERT OR REPLACE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content, annotations, user_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))`
        ).bind(body.id, body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', annotations, userId).run();
        const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        return jsonResponse(formatWeekly(row), 201);
    }

    const weeklyMatch = path.match(/^\/api\/weeklies\/(\d+)$/);
    if (weeklyMatch && method === 'PUT') {
        const id = parseInt(weeklyMatch[1]);
        const body = await request.json();
        const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
        const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
        await db.prepare(
            `UPDATE weeklies SET category=?1, title=?2, summary=?3, date=?4, cover=?5, weekly_data=?6, content=?7, annotations=?8, updated_at=datetime('now')
             WHERE id=?9 AND user_id=?10`
        ).bind(body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', annotations, id, userId).run();
        const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
        return jsonResponse(formatWeekly(row), 200);
    }

    if (weeklyMatch && method === 'DELETE') {
        const id = parseInt(weeklyMatch[1]);
        await db.prepare('DELETE FROM weeklies WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== NOTES 备忘录 ====================
    if (path === '/api/notes' && method === 'GET') {
        const result = await db.prepare('SELECT * FROM notes WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all();
        const rows = result.results.map(row => ({
            ...row,
            annotations: row.annotations ? JSON.parse(row.annotations) : []
        }));
        return jsonResponse(rows, 200);
    }

    if (path === '/api/notes' && method === 'POST') {
        const body = await request.json();
        const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
        await db.prepare(
            `INSERT OR REPLACE INTO notes (id, title, content, date, annotations, user_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`
        ).bind(body.id, body.title, body.content || '', body.date, annotations, userId).run();
        const row = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        return jsonResponse({
            ...row,
            annotations: row.annotations ? JSON.parse(row.annotations) : []
        }, 201);
    }

    const noteMatch = path.match(/^\/api\/notes\/(\d+)$/);
    if (noteMatch && method === 'PUT') {
        const id = parseInt(noteMatch[1]);
        const body = await request.json();
        const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
        await db.prepare(
            `UPDATE notes SET title=?1, content=?2, date=?3, annotations=?4, updated_at=datetime('now') WHERE id=?5 AND user_id=?6`
        ).bind(body.title, body.content || '', body.date, annotations, id, userId).run();
        const row = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
        return jsonResponse({
            ...row,
            annotations: row.annotations ? JSON.parse(row.annotations) : []
        }, 200);
    }

    if (noteMatch && method === 'DELETE') {
        const id = parseInt(noteMatch[1]);
        await db.prepare('DELETE FROM notes WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== BOOKMARKS 收藏 ====================
    if (path === '/api/bookmarks' && method === 'GET') {
        const result = await db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all();
        return jsonResponse(result.results, 200);
    }

    if (path === '/api/bookmarks' && method === 'POST') {
        const body = await request.json();
        await db.prepare(
            `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description, user_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        ).bind(body.id, body.type, body.title, body.url, body.desc || '', userId).run();
        const row = await db.prepare('SELECT * FROM bookmarks WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        return jsonResponse(row, 201);
    }

    const bmMatch = path.match(/^\/api\/bookmarks\/(\d+)$/);
    if (bmMatch && method === 'DELETE') {
        const id = parseInt(bmMatch[1]);
        await db.prepare('DELETE FROM bookmarks WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== QUICK FEEDS 随手记流 ====================
    if (path === '/api/feeds' && method === 'GET') {
        const result = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all();
        const rows = (result.results || []).map(row => ({
            ...row,
            tags: row.tags ? JSON.parse(row.tags) : []
        }));
        return jsonResponse(rows, 200);
    }

    if (path === '/api/feeds' && method === 'POST') {
        const body = await request.json();
        const content = body.content || '';
        const type = body.type || (content.match(/^https?:\/\//i) ? 'link' : 'text');
        const mediaUrl = body.media_url || body.mediaUrl || null;
        let summary = body.summary || null;
        let tags = body.tags || [];

        if (!tags || tags.length === 0) {
            tags = extractTagsFromContent(content);
        }

        const tagsJson = JSON.stringify(tags);
        let res;
        if (body.id) {
            await db.prepare(
                `INSERT OR REPLACE INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, datetime('now')))`
            ).bind(body.id, userId, content, type, mediaUrl, summary, tagsJson, body.created_at || null).run();
            res = await db.prepare('SELECT * FROM quick_feeds WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        } else {
            res = await db.prepare(
                `INSERT INTO quick_feeds (user_id, content, type, media_url, summary, tags, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now')) RETURNING *`
            ).bind(userId, content, type, mediaUrl, summary, tagsJson).first();
        }

        return jsonResponse({
            ...res,
            tags: res.tags ? JSON.parse(res.tags) : []
        }, 201);
    }

    const feedMatch = path.match(/^\/api\/feeds\/(\d+)$/);
    if (feedMatch && method === 'PUT') {
        const id = parseInt(feedMatch[1]);
        const body = await request.json();
        const content = body.content || '';
        const type = body.type || 'text';
        const mediaUrl = body.media_url || body.mediaUrl || null;
        const summary = body.summary || null;
        const tags = body.tags || extractTagsFromContent(content);
        const tagsJson = JSON.stringify(tags);
        await db.prepare(
            `UPDATE quick_feeds SET content=?1, type=?2, media_url=?3, summary=?4, tags=?5 WHERE id=?6 AND user_id=?7`
        ).bind(content, type, mediaUrl, summary, tagsJson, id, userId).run();
        const row = await db.prepare('SELECT * FROM quick_feeds WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
        return jsonResponse({
            ...row,
            tags: row ? (row.tags ? JSON.parse(row.tags) : []) : []
        }, 200);
    }

    if (feedMatch && method === 'DELETE') {
        const id = parseInt(feedMatch[1]);
        await db.prepare('DELETE FROM quick_feeds WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== BATCH SYNC 批量一次性强同步备份 ====================
    if (path === '/api/sync/batch' && method === 'POST') {
        const body = await request.json();
        const weeklies = body.weeklies || [];
        const notes = body.notes || [];
        const bookmarks = body.bookmarks || [];
        const feeds = body.feeds || [];

        const statements = [];

        // 1. 周记
        for (const item of weeklies) {
            if (weeklies.length > 1 && item.id === 1) continue;
            const weeklyData = item.weeklyData ? JSON.stringify(item.weeklyData) : null;
            const annotations = item.annotations ? JSON.stringify(item.annotations) : '[]';
            statements.push(
                db.prepare(
                    `INSERT OR REPLACE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content, annotations, user_id, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))`
                ).bind(item.id, item.category, item.title, item.summary, item.date, item.cover || '', weeklyData, item.content || '', annotations, userId)
            );
        }

        // 2. 笔记
        for (const item of notes) {
            if (notes.length > 2 && (item.id === 101 || item.id === 102)) continue;
            const annotations = item.annotations ? JSON.stringify(item.annotations) : '[]';
            statements.push(
                db.prepare(
                    `INSERT OR REPLACE INTO notes (id, title, content, date, annotations, user_id, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`
                ).bind(item.id, item.title, item.content || '', item.date, annotations, userId)
            );
        }

        // 3. 收藏
        for (const item of bookmarks) {
            if (bookmarks.length > 3 && (item.id === 201 || item.id === 202 || item.id === 203)) continue;
            statements.push(
                db.prepare(
                    `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description, user_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
                ).bind(item.id, item.type, item.title, item.url, item.desc || item.description || '', userId)
            );
        }

        // 4. 随手记
        for (const item of feeds) {
            if (feeds.length > 1 && item.id === 1) continue;
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
                        `INSERT OR REPLACE INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, datetime('now')))`
                    ).bind(item.id, userId, content, type, mediaUrl, summary, tagsJson, item.created_at || null)
                );
            } else {
                statements.push(
                    db.prepare(
                        `INSERT INTO quick_feeds (user_id, content, type, media_url, summary, tags, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`
                    ).bind(userId, content, type, mediaUrl, summary, tagsJson)
                );
            }
        }

        if (statements.length > 0) {
            const CHUNK_SIZE = 80;
            for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
                await db.batch(statements.slice(i, i + CHUNK_SIZE));
            }
        }

        return jsonResponse({ success: true, count: statements.length }, 200);
    }



    // ==================== HEATMAP 统计热力图 ====================
    if (path === '/api/stats/heatmap' && method === 'GET') {
        const result = await db.prepare(`
            SELECT date_str, COUNT(*) as count FROM (
                SELECT substr(created_at, 1, 10) as date_str FROM weeklies WHERE user_id = ?1
                UNION ALL
                SELECT substr(created_at, 1, 10) as date_str FROM notes WHERE user_id = ?1
                UNION ALL
                SELECT substr(created_at, 1, 10) as date_str FROM bookmarks WHERE user_id = ?1
                UNION ALL
                SELECT substr(created_at, 1, 10) as date_str FROM quick_feeds WHERE user_id = ?1
            ) GROUP BY date_str ORDER BY date_str ASC
        `).bind(userId).all();

        return jsonResponse(result.results || [], 200);
    }

    // ==================== AI CHAT & MEMORY 记忆回响问答 ====================
    if (path === '/api/ai/chat' && method === 'POST') {
        const { question } = await request.json();
        if (!question) return jsonResponse({ error: '请输入问题' }, 400);

        const feeds = await db.prepare('SELECT content, created_at FROM quick_feeds WHERE user_id = ?1 ORDER BY id DESC LIMIT 20').bind(userId).all();
        const notes = await db.prepare('SELECT title, content, date FROM notes WHERE user_id = ?1 ORDER BY id DESC LIMIT 15').bind(userId).all();
        const weeklies = await db.prepare('SELECT title, summary, date FROM weeklies WHERE user_id = ?1 ORDER BY id DESC LIMIT 10').bind(userId).all();

        const contextText = [
            ...(feeds.results || []).map(f => `[随手记 ${f.created_at}] ${f.content}`),
            ...(notes.results || []).map(n => `[备忘录 ${n.date}] ${n.title}: ${n.content || ''}`),
            ...(weeklies.results || []).map(w => `[周记 ${w.date}] ${w.title}: ${w.summary || ''}`)
        ].join('\n');

        let reply = '';
        try {
            const systemPrompt = '你是用户在数字花园 Chillin 中的 AI 记忆回响助手。请根据提供的用户历史笔记上下文，用温暖、有条理且简炼的中文回答用户的提问。如果上下文中没有提到，请根据通识回答并友好告知。';
            const userPrompt = `用户过往记忆上下文：\n${contextText}\n\n用户的问题：${question}`;
            reply = await callCustomLlm(env, systemPrompt, userPrompt);
        } catch (err) {
            console.error('LLM Call error:', err);
        }

        if (!reply) {
            reply = generateFallbackReply(question, contextText);
        }

        return jsonResponse({ reply, question }, 200);
    }

    // ==================== AI ECHO CARD GENERATION ====================
    if (path === '/api/echo/generate' && method === 'POST') {
        const feeds = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 ORDER BY id DESC LIMIT 10').bind(userId).all();
        if (!feeds.results || feeds.results.length === 0) {
            return jsonResponse({ error: '暂无足够的随手记生成回响卡片，请先多记录一些思考吧！' }, 400);
        }

        const recentTexts = feeds.results.map(f => f.content).join('；');
        const cardTitle = "近期思维回响与灵感梳理";
        const topic = "每周灵感";
        const summary = `在最近的记录中，你关注了：${recentTexts.slice(0, 120)}... AI 建议你继续保持记录，把这些零碎灵感进一步转化为深度的笔记或周记！`;

        const feedIds = JSON.stringify(feeds.results.map(f => f.id));
        const newCard = await db.prepare(
            `INSERT INTO echo_cards (user_id, title, summary, topic, related_feed_ids, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now')) RETURNING *`
        ).bind(userId, cardTitle, summary, topic, feedIds).first();

        return jsonResponse(newCard, 201);
    }

    if (path === '/api/echo/cards' && method === 'GET') {
        const cards = await db.prepare('SELECT * FROM echo_cards WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all();
        return jsonResponse(cards.results || [], 200);
    }

    return jsonResponse({ error: 'Not found' }, 404);
}

function extractTagsFromContent(text) {
    const tags = [];
    if (/代码|bug|api|js|css|html|react|vue|node|worker|git|python|算法|开发/i.test(text)) tags.push('#技术');
    if (/生活|咖啡|电影|音乐|小说|美食|游记|运动|散步|秋天|猫|狗/i.test(text)) tags.push('#生活');
    if (/读书|笔记|文章|极客|思考|播客|想法|灵感/i.test(text)) tags.push('#灵感');
    if (tags.length === 0) tags.push('#随手记');
    return tags;
}

function generateFallbackReply(question, contextText) {
    if (!contextText || contextText.trim().length === 0) {
        return `我在您的记忆花园里还没有找到相关记录。试着在顶部“随手记”里多记录一些想法吧！`;
    }
    const keywords = question.replace(/[？?！!，,。.]/g, '').split('').filter(c => c.trim());
    const lines = contextText.split('\n');
    const matchedLines = lines.filter(line => keywords.some(kw => line.includes(kw)));
    
    if (matchedLines.length > 0) {
        return `针对您的提问 **“${question}”**，我在您的过往记忆中找到了以下匹配片段：\n\n` +
            matchedLines.slice(0, 5).map(l => `• ${l}`).join('\n') +
            `\n\n💡 *提示：您可以持续添加随手记，让记忆网络更加丰富！*`;
    }

    return `针对问题 **“${question}”**，基于您最近的记忆片段摘要：\n\n${lines.slice(0, 3).join('\n')}\n\n以上是为您整理的相关回响，请继续记录更多精彩灵感！`;
}

async function callCustomLlm(env, systemPrompt, userPrompt) {
    const apiBase = env.LLM_API_BASE || 'https://api.deepseek.com/v1';
    const apiKey = env.LLM_API_KEY;
    const model = env.LLM_MODEL || 'deepseek-chat';

    if (apiKey) {
        const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.7
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Custom LLM API error (${res.status}): ${errText}`);
        }

        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }
    }

    if (env.AI) {
        const aiRes = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        });
        return aiRes.response || '';
    }

    return null;
}

function formatWeekly(row) {
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
        annotations: row.annotations ? JSON.parse(row.annotations) : []
    };
}


