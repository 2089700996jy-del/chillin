/**
 * Garden Resource CRUD
 * Create / read / update / soft-delete for weeklies, notes, bookmarks, prompts and quick feeds.
 */
import {
    jsonResponse,
    isValidRecordId
} from './security.js';
import {
    extractTagsFromContent,
    formatWeekly,
    formatNote,
    formatBookmark,
    formatPrompt,
    formatFeed,
    isOwnedRecord,
    isSoftDeletedRecord
} from './garden-shared.js';

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

// ── Reader Reading Progress (Sync) ──

export async function handleGetReaderProgress(db, userId) {
    const res = await db.prepare(
        'SELECT book_key, book_title, chapter_index, chapter_title, scroll_percentage, updated_at FROM reader_progress WHERE user_id = ?1 ORDER BY updated_at DESC'
    ).bind(userId).all();
    return jsonResponse(res.results || [], 200);
}

export async function handlePostReaderProgress(request, db, userId) {
    const body = await request.json();
    const bookKey = (body.book_key || body.bookKey || '').trim();
    const bookTitle = (body.book_title || body.bookTitle || '').trim();
    if (!bookKey || !bookTitle) {
        return jsonResponse({ error: 'Missing book_key or book_title' }, 400);
    }
    const chapterIndex = Number.isInteger(body.chapter_index) ? body.chapter_index : Number(body.chapterIndex || 0);
    const chapterTitle = String(body.chapter_title || body.chapterTitle || '');
    const scrollPercentage = Math.min(100, Math.max(0, Math.round(Number(body.scroll_percentage ?? body.scrollPct ?? 0))));

    await db.prepare(
        `INSERT INTO reader_progress (user_id, book_key, book_title, chapter_index, chapter_title, scroll_percentage, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'))
         ON CONFLICT(user_id, book_key) DO UPDATE SET
            book_title = excluded.book_title,
            chapter_index = excluded.chapter_index,
            chapter_title = excluded.chapter_title,
            scroll_percentage = excluded.scroll_percentage,
            updated_at = datetime('now', '+8 hours')`
    ).bind(userId, bookKey, bookTitle, chapterIndex, chapterTitle, scrollPercentage).run();

    return jsonResponse({ success: true, book_key: bookKey, chapter_index: chapterIndex, scroll_percentage: scrollPercentage }, 200);
}


// ── Aggregated Sync Pull (NEW: 1 RTT replaces 5 sequential pulls) ──
