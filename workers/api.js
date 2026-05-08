// Chillin API Worker — REST API for weeklies, notes, bookmarks
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS 预检
        if (method === 'OPTIONS') {
            return corsResponse(null, 204);
        }

        // API Key 鉴权
        const apiKey = request.headers.get('X-API-Key');
        if (apiKey !== env.API_KEY) {
            return jsonResponse({ error: 'Unauthorized' }, 401);
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
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
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

async function router(path, method, request, env) {
    const db = env.DB;

    // ==================== WEEKLY 周记 ====================
    if (path === '/api/weeklies' && method === 'GET') {
        const result = await db.prepare('SELECT * FROM weeklies ORDER BY id DESC').all();
        const rows = result.results.map(formatWeekly);
        return jsonResponse(rows, 200);
    }

    if (path === '/api/weeklies' && method === 'POST') {
        const body = await request.json();
        const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
        await db.prepare(
            `INSERT OR REPLACE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))`
        ).bind(body.id, body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '').run();
        const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1').bind(body.id).first();
        return jsonResponse(formatWeekly(row), 201);
    }

    const weeklyMatch = path.match(/^\/api\/weeklies\/(\d+)$/);
    if (weeklyMatch && method === 'PUT') {
        const id = parseInt(weeklyMatch[1]);
        const body = await request.json();
        const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
        await db.prepare(
            `UPDATE weeklies SET category=?1, title=?2, summary=?3, date=?4, cover=?5, weekly_data=?6, content=?7, updated_at=datetime('now')
             WHERE id=?8`
        ).bind(body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', id).run();
        const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1').bind(id).first();
        return jsonResponse(formatWeekly(row), 200);
    }

    if (weeklyMatch && method === 'DELETE') {
        const id = parseInt(weeklyMatch[1]);
        await db.prepare('DELETE FROM weeklies WHERE id = ?1').bind(id).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== NOTES 备忘录 ====================
    if (path === '/api/notes' && method === 'GET') {
        const result = await db.prepare('SELECT * FROM notes ORDER BY id DESC').all();
        return jsonResponse(result.results, 200);
    }

    if (path === '/api/notes' && method === 'POST') {
        const body = await request.json();
        await db.prepare(
            `INSERT OR REPLACE INTO notes (id, title, content, date, updated_at)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))`
        ).bind(body.id, body.title, body.content || '', body.date).run();
        const row = await db.prepare('SELECT * FROM notes WHERE id = ?1').bind(body.id).first();
        return jsonResponse(row, 201);
    }

    const noteMatch = path.match(/^\/api\/notes\/(\d+)$/);
    if (noteMatch && method === 'PUT') {
        const id = parseInt(noteMatch[1]);
        const body = await request.json();
        await db.prepare(
            `UPDATE notes SET title=?1, content=?2, date=?3, updated_at=datetime('now') WHERE id=?4`
        ).bind(body.title, body.content || '', body.date, id).run();
        const row = await db.prepare('SELECT * FROM notes WHERE id = ?1').bind(id).first();
        return jsonResponse(row, 200);
    }

    if (noteMatch && method === 'DELETE') {
        const id = parseInt(noteMatch[1]);
        await db.prepare('DELETE FROM notes WHERE id = ?1').bind(id).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== BOOKMARKS 收藏 ====================
    if (path === '/api/bookmarks' && method === 'GET') {
        const result = await db.prepare('SELECT * FROM bookmarks ORDER BY id DESC').all();
        return jsonResponse(result.results, 200);
    }

    if (path === '/api/bookmarks' && method === 'POST') {
        const body = await request.json();
        await db.prepare(
            `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description)
             VALUES (?1, ?2, ?3, ?4, ?5)`
        ).bind(body.id, body.type, body.title, body.url, body.desc || '').run();
        const row = await db.prepare('SELECT * FROM bookmarks WHERE id = ?1').bind(body.id).first();
        return jsonResponse(row, 201);
    }

    const bmMatch = path.match(/^\/api\/bookmarks\/(\d+)$/);
    if (bmMatch && method === 'DELETE') {
        const id = parseInt(bmMatch[1]);
        await db.prepare('DELETE FROM bookmarks WHERE id = ?1').bind(id).run();
        return jsonResponse({ success: true }, 200);
    }

    return jsonResponse({ error: 'Not found' }, 404);
}

function formatWeekly(row) {
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
