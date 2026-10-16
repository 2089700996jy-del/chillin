/**
 * Garden Books Module
 * 阅读器书库云同步：TXT 正文存 R2，D1 只保存书目元数据，实现跨设备同一本书。
 */
import { jsonResponse, applySecurityHeaders } from './security.js';

const MAX_BOOK_SIZE = 20 * 1024 * 1024;

/** 书籍指纹：与前端 computeBookKey 保持一致（书名小写 + 章节数） */
function normalizeBookKey(raw) {
    if (typeof raw !== 'string') return '';
    let key = raw;
    try { key = decodeURIComponent(raw); } catch (_) { /* 非法转义则按原值处理 */ }
    return key.trim().slice(0, 300);
}

/** R2 对象键用指纹的 SHA-256，避免中文书名 / 特殊字符直接进对象键 */
async function bookObjectKey(userId, bookKey) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bookKey));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `books/${userId}/${hex}.txt`;
}

export async function handleListReaderBooks(db, userId) {
    const rows = await db.prepare(
        'SELECT book_key, title, author, total_chapters, size, updated_at FROM reader_books WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC'
    ).bind(userId).all();
    return jsonResponse(rows.results || []);
}

export async function handlePutReaderBook(request, env, db, userId) {
    if (!env || !env.MEDIA) return jsonResponse({ error: '对象存储未配置' }, 503);

    const url = new URL(request.url);
    const bookKey = normalizeBookKey(url.searchParams.get('key'));
    const title = (url.searchParams.get('title') || '').trim().slice(0, 200);
    const author = (url.searchParams.get('author') || '').trim().slice(0, 100);
    const totalChapters = Math.max(0, Math.floor(Number(url.searchParams.get('chapters')) || 0));
    if (!bookKey || !title) return jsonResponse({ error: '缺少书名或书籍指纹' }, 400);

    const text = await request.text();
    if (!text.trim()) return jsonResponse({ error: '书籍内容为空' }, 400);
    const size = new TextEncoder().encode(text).length;
    if (size > MAX_BOOK_SIZE) return jsonResponse({ error: '书籍过大，最大支持 20MB' }, 413);

    const r2Key = await bookObjectKey(userId, bookKey);
    await env.MEDIA.put(r2Key, text, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'private, max-age=86400' }
    });
    // 同一指纹重复导入时覆盖元数据，实现「换设备重传同一本书」不产生重复卡片
    await db.prepare(
        `INSERT INTO reader_books (user_id, book_key, title, author, total_chapters, size, r2_key, is_deleted, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, datetime('now', '+8 hours'))
         ON CONFLICT(user_id, book_key) DO UPDATE SET
            title = excluded.title,
            author = excluded.author,
            total_chapters = excluded.total_chapters,
            size = excluded.size,
            r2_key = excluded.r2_key,
            is_deleted = 0,
            updated_at = excluded.updated_at`
    ).bind(userId, bookKey, title, author, totalChapters, size, r2Key).run();

    return jsonResponse({ ok: true, book_key: bookKey, size });
}

export async function handleGetReaderBook(rawKey, env, db, userId) {
    if (!env || !env.MEDIA) return jsonResponse({ error: '对象存储未配置' }, 503);
    const bookKey = normalizeBookKey(rawKey);
    const row = await db.prepare(
        'SELECT r2_key FROM reader_books WHERE user_id = ?1 AND book_key = ?2 AND is_deleted = 0'
    ).bind(userId, bookKey).first();
    if (!row) return jsonResponse({ error: '书籍不存在' }, 404);

    const obj = await env.MEDIA.get(row.r2_key);
    if (!obj || !obj.body) return jsonResponse({ error: '书籍内容已丢失' }, 404);

    const headers = applySecurityHeaders(new Headers({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, max-age=86400',
        'X-Robots-Tag': 'noindex, nofollow, noarchive'
    }));
    return new Response(obj.body, { status: 200, headers });
}

export async function handleDeleteReaderBook(rawKey, env, db, userId) {
    const bookKey = normalizeBookKey(rawKey);
    const row = await db.prepare(
        'SELECT r2_key FROM reader_books WHERE user_id = ?1 AND book_key = ?2'
    ).bind(userId, bookKey).first();
    if (!row) return jsonResponse({ ok: true, deleted: 0 });

    // 软删除墓碑：其它设备才能在增量拉取时看到「这本书已被删除」
    await db.prepare(
        `UPDATE reader_books SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE user_id = ?1 AND book_key = ?2`
    ).bind(userId, bookKey).run();

    if (env && env.MEDIA && row.r2_key) {
        try {
            await env.MEDIA.delete(row.r2_key);
        } catch (err) {
            // 对象删除失败不影响 tombstone：残留对象由后续维护脚本清理
            console.warn('[reader-books] r2 delete failed', err);
        }
    }
    return jsonResponse({ ok: true, deleted: 1 });
}
