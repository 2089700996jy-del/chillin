/**
 * Garden Shared Helpers
 * Row formatters, ownership / soft-delete checks and the lazy schema guard.
 */
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
