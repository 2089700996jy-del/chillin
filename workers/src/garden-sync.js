/**
 * Garden Sync & Stats
 * Single-RTT aggregated pull, delta batch push and the activity heatmap.
 */
import {
    jsonResponse,
    isValidRecordId,
    readTextCapped
} from './security.js';
import {
    extractTagsFromContent,
    formatWeekly,
    formatNote,
    formatBookmark,
    formatPrompt,
    formatFeed,
    fetchSoftDeletedIdSet
} from './garden-shared.js';

export const D1_BATCH_MAX_SIZE = 100;

/**
 * 将 D1 批处理 SQL 语句切片执行，确保单批不超过 100 条硬性上限
 */
export async function executeStatementsInChunks(db, statements, chunkSize = D1_BATCH_MAX_SIZE) {
    if (!statements || statements.length === 0) return [];
    const results = [];
    for (let i = 0; i < statements.length; i += chunkSize) {
        const chunk = statements.slice(i, i + chunkSize);
        const chunkRes = await db.batch(chunk);
        if (Array.isArray(chunkRes)) results.push(...chunkRes);
    }
    return results;
}

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

// 批量推送的防护上限：正常一份周记/笔记的增量远小于这些值
const MAX_SYNC_BODY_BYTES = 4 * 1024 * 1024;   // 单次请求体 4MB
const MAX_SYNC_RECORDS = 200;                  // 每种资源单次最多 200 条
const MAX_SYNC_RECORD_CHARS = 200 * 1024;      // 单条记录序列化后 200KB

export async function handleSyncBatch(request, db, userId) {
    // 先限长读取再解析：避免把超大 JSON 整个读进内存后再遍历
    const raw = await readTextCapped(request, MAX_SYNC_BODY_BYTES);
    if (!raw.ok) return jsonResponse({ error: '同步数据过大，请分批推送' }, 413);

    let body;
    try {
        body = JSON.parse(raw.text || '{}');
    } catch (_) {
        return jsonResponse({ error: '请求格式错误' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return jsonResponse({ error: '请求格式错误' }, 400);
    }

    const weeklies = Array.isArray(body.weeklies) ? body.weeklies : [];
    const notes = Array.isArray(body.notes) ? body.notes : [];
    const bookmarks = Array.isArray(body.bookmarks) ? body.bookmarks : [];
    const feeds = Array.isArray(body.feeds) ? body.feeds : [];
    const prompts = Array.isArray(body.prompts) ? body.prompts : [];

    // 条数与单条体积上限：防住「一次推十万条」或「一条塞 100MB 正文」
    for (const [name, items] of Object.entries({ weeklies, notes, bookmarks, feeds, prompts })) {
        if (items.length > MAX_SYNC_RECORDS) {
            return jsonResponse({ error: name + ' 单次最多 ' + MAX_SYNC_RECORDS + ' 条，请分批推送' }, 413);
        }
        for (const item of items) {
            if (item && JSON.stringify(item).length > MAX_SYNC_RECORD_CHARS) {
                return jsonResponse({ error: name + ' 中存在单条记录体积过大（上限 200KB）' }, 413);
            }
        }
    }

    const statements = [];

    const fetchOwnedSet = async (tableName, items) => {
        const ids = items.map(i => i.id).filter(id => id != null && id !== '' && isValidRecordId(id));
        if (ids.length === 0) return new Set();
        const allowed = new Set();
        const CHUNK_SIZE = 80;
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunkIds = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunkIds.map((_, idx) => `?${idx + 1}`).join(',');
            const res = await db.prepare(`SELECT id, user_id FROM ${tableName} WHERE id IN (${placeholders})`).bind(...chunkIds).all();
            const existingMap = new Map((res.results || []).map(r => [r.id, r.user_id]));
            for (const id of chunkIds) {
                if (!existingMap.has(id) || Number(existingMap.get(id)) === Number(userId)) {
                    allowed.add(id);
                }
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
        await executeStatementsInChunks(db, statements);
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

// ── 全量数据备份邮件直发 (Resend API) ──

export async function handleBackupEmail(request, env, userId) {
    if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);

    let body;
    try {
        body = await request.json();
    } catch (_) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { email, filename, zipBase64 } = body || {};
    if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 254) {
        return jsonResponse({ error: 'Invalid email address' }, 400);
    }
    if (!zipBase64 || typeof zipBase64 !== 'string') {
        return jsonResponse({ error: 'Missing zip payload' }, 400);
    }

    const resendKey = env.RESEND_API_KEY;
    if (!resendKey) {
        return jsonResponse({
            success: false,
            code: 'NO_RESEND_KEY',
            message: '未配置 RESEND_API_KEY 环境变量，无法发送邮件'
        }, 200);
    }

    try {
        const fromAddress = env.RESEND_FROM || 'Chillin Garden <onboarding@resend.dev>';
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${resendKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: fromAddress,
                to: [email],
                subject: `[Chillin] 你的个人数字花园全量备份 (${new Date().toLocaleDateString('zh-CN')})`,
                html: `
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1c1c1e;">
                        <h2 style="font-size: 20px; font-weight: 700; color: #000; margin-bottom: 12px;">🌿 Chillin 数字花园全量备份</h2>
                        <p style="font-size: 15px; line-height: 1.6; color: #3c3c43;">你好！这是你在 Chillin 数字花园生成的全量数据归档压缩包。</p>
                        <div style="background: #f2f2f7; border-radius: 12px; padding: 16px; margin: 20px 0; font-size: 14px; line-height: 1.6;">
                            <div>📦 <strong>包含内容：</strong></div>
                            <ul style="margin: 8px 0 0 20px; padding: 0;">
                                <li><strong>notes/</strong>：所有笔记的独立 Markdown 文件（含 Frontmatter 元数据）</li>
                                <li><strong>weeklies/</strong>：所有周刊长文的独立 Markdown 文件</li>
                                <li><strong>feeds/feeds.md</strong>：随手记完整时间线归档</li>
                                <li><strong>bookmarks/</strong>：标准 Netscape HTML 书签（可直接导入任意浏览器）</li>
                                <li><strong>chillin-full-backup.json</strong>：全量结构化数据（供一键恢复还原）</li>
                            </ul>
                        </div>
                        <p style="font-size: 13px; color: #8e8e93; margin-top: 24px;">附件已携带压缩包文件：${filename || 'chillin-backup.zip'}<br/>Chillin · 个人离线优先数字花园</p>
                    </div>
                `,
                attachments: [
                    {
                        filename: filename || 'chillin-backup.zip',
                        content: zipBase64
                    }
                ]
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('[resend] email sending failed:', res.status, errText);
            return jsonResponse({
                success: false,
                code: 'RESEND_ERROR',
                message: `Resend 服务返回错误 (${res.status})`
            }, 200);
        }

        const data = await res.json();
        return jsonResponse({ success: true, id: data.id }, 200);
    } catch (err) {
        console.error('[resend] fetch exception:', err);
        return jsonResponse({
            success: false,
            code: 'FETCH_ERROR',
            message: err?.message || '邮件发送异常'
        }, 500);
    }
}
