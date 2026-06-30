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
        await db.prepare(
            `INSERT OR REPLACE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content, user_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))`
        ).bind(body.id, body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', userId).run();
        const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        return jsonResponse(formatWeekly(row), 201);
    }

    const weeklyMatch = path.match(/^\/api\/weeklies\/(\d+)$/);
    if (weeklyMatch && method === 'PUT') {
        const id = parseInt(weeklyMatch[1]);
        const body = await request.json();
        const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
        await db.prepare(
            `UPDATE weeklies SET category=?1, title=?2, summary=?3, date=?4, cover=?5, weekly_data=?6, content=?7, updated_at=datetime('now')
             WHERE id=?8 AND user_id=?9`
        ).bind(body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', id, userId).run();
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
        return jsonResponse(result.results, 200);
    }

    if (path === '/api/notes' && method === 'POST') {
        const body = await request.json();
        await db.prepare(
            `INSERT OR REPLACE INTO notes (id, title, content, date, user_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`
        ).bind(body.id, body.title, body.content || '', body.date, userId).run();
        const row = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        return jsonResponse(row, 201);
    }

    const noteMatch = path.match(/^\/api\/notes\/(\d+)$/);
    if (noteMatch && method === 'PUT') {
        const id = parseInt(noteMatch[1]);
        const body = await request.json();
        await db.prepare(
            `UPDATE notes SET title=?1, content=?2, date=?3, updated_at=datetime('now') WHERE id=?4 AND user_id=?5`
        ).bind(body.title, body.content || '', body.date, id, userId).run();
        const row = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
        return jsonResponse(row, 200);
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

    return jsonResponse({ error: 'Not found' }, 404);
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
        content: row.content || null
    };
}
