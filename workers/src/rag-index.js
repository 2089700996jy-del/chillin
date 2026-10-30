/**
 * 长期记忆候选层：五类花园内容的 D1 候选查询、FTS5 命中回表与 wikilink 关联加载。
 *
 * 这里只做“取候选”，不做排序；排序与上下文预算仍在 rag.js，避免领域模块继续膨胀。
 */

export const MEMORY_TABLES = [
    {
        type: '随手记',
        table: 'quick_feeds',
        select: 'id, content, summary, tags, created_at, updated_at',
        titleColumn: '',
        likeFields: ['content', 'summary', 'tags'],
        order: 'COALESCE(updated_at, created_at)'
    },
    {
        type: '笔记',
        table: 'notes',
        select: 'id, title, content, date, created_at, updated_at',
        titleColumn: 'title',
        likeFields: ['title', 'content'],
        order: 'updated_at'
    },
    {
        type: '周记',
        table: 'weeklies',
        select: 'id, title, summary, content, date, created_at, updated_at',
        titleColumn: 'title',
        likeFields: ['title', 'summary', 'content'],
        order: 'updated_at'
    },
    {
        type: '收藏',
        table: 'bookmarks',
        select: 'id, title, description, url, created_at, updated_at',
        titleColumn: 'title',
        likeFields: ['title', 'description', 'url'],
        order: 'COALESCE(updated_at, created_at)'
    },
    {
        type: '提示词',
        table: 'prompts',
        select: 'id, title, project, scene, content, description, tags, created_at, updated_at',
        titleColumn: 'title',
        likeFields: ['title', 'project', 'scene', 'content', 'description', 'tags'],
        order: 'updated_at'
    }
];

function parseTagList(value) {
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String).map(s => s.trim()).filter(Boolean);
    } catch (_) {}
    return raw.split(/[,，\s#]+/).map(s => s.trim()).filter(Boolean);
}

function extractHashtags(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(/(?:^|[\s，。；;、])#([^\s#，。；;、]{1,30})/g)) {
        if (m[1]) out.add(m[1]);
    }
    return [...out];
}

/** 服务端只需要的轻量 wikilink 解析：[[标题]] / [[标题|别名]] / [[标题#段落]]。 */
export function extractWikiLinks(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
        const target = String(m[1] || '').trim().toLowerCase();
        if (target) out.add(target);
    }
    return [...out];
}

export function normalizeMemoryRow(cfg, row) {
    if (!row || row.id == null) return null;
    let title = '';
    let body = '';
    let tags = [];
    if (cfg.type === '随手记') {
        body = [row.content, row.summary].filter(Boolean).join(' ');
        tags = parseTagList(row.tags);
    } else if (cfg.type === '笔记') {
        title = String(row.title || '');
        body = String(row.content || '');
        tags = extractHashtags(title + ' ' + body);
    } else if (cfg.type === '周记') {
        title = String(row.title || '');
        body = [row.summary, row.content].filter(Boolean).join(' ');
        tags = extractHashtags(title + ' ' + body);
    } else if (cfg.type === '收藏') {
        title = String(row.title || '');
        body = [row.description, row.url].filter(Boolean).join(' ');
    } else if (cfg.type === '提示词') {
        title = '[' + (row.project || '通用') + '/' + (row.scene || '场景') + '] ' + (row.title || '');
        body = [row.description, row.content].filter(Boolean).join(' ');
        tags = parseTagList(row.tags);
    }
    return {
        type: cfg.type,
        id: Number(row.id),
        title: title.trim(),
        body: String(body || '').trim(),
        tags: [...new Set(tags)],
        date: String(row.date || row.created_at || row.updated_at || ''),
        created_at: row.created_at || '',
        updated_at: row.updated_at || '',
        key: cfg.type + ':' + row.id
    };
}

function buildLikeFilter(cfg, tokens) {
    if (!tokens.length) return { sql: '', binds: [] };
    const clauses = tokens.map(() => '(' + cfg.likeFields.map(f => "COALESCE(" + f + ", '') LIKE ?").join(' OR ') + ')');
    return {
        sql: clauses.join(' OR '),
        binds: tokens.flatMap(t => cfg.likeFields.map(() => '%' + t + '%'))
    };
}

export function buildFtsMatch(tokens) {
    return [...new Set(tokens.filter(t => t.length >= 3))].slice(0, 12)
        .map(t => '"' + t.replace(/"/g, '""') + '"')
        .join(' OR ');
}

export async function fetchMemoryRows(db, cfg, userId, tokens, limit) {
    const filter = buildLikeFilter(cfg, tokens);
    const where = filter.sql ? ' AND (' + filter.sql + ')' : '';
    const sql = 'SELECT ' + cfg.select + ' FROM ' + cfg.table +
        ' WHERE user_id = ? AND is_deleted = 0' + where +
        ' ORDER BY ' + cfg.order + ' DESC, id DESC LIMIT ?';
    const res = await db.prepare(sql).bind(userId, ...filter.binds, limit).all();
    return (res && res.results) || [];
}

export async function fetchFtsHits(db, userId, match) {
    if (!match) return [];
    try {
        const res = await db.prepare(
            'SELECT source_type AS type, source_id AS id FROM memory_fts ' +
            'WHERE memory_fts MATCH ?1 AND user_id = ?2 LIMIT 300'
        ).bind(match, userId).all();
        return (res && res.results) || [];
    } catch (_) {
        // 迁移尚未落库时不能让聊天整体失败：LIKE 仍是完整兜底。
        return [];
    }
}

export async function fetchRowsByIds(db, cfg, userId, ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const sql = 'SELECT ' + cfg.select + ' FROM ' + cfg.table +
        ' WHERE user_id = ? AND is_deleted = 0 AND id IN (' + placeholders + ')';
    const res = await db.prepare(sql).bind(userId, ...ids).all();
    return (res && res.results) || [];
}

export async function loadLinkedMemories(db, userId, seeds) {
    const links = [...new Set(seeds.flatMap(seed => extractWikiLinks(seed.title + ' ' + seed.body)))].slice(0, 6);
    if (!links.length) return [];
    const configs = MEMORY_TABLES.filter(cfg => cfg.titleColumn);
    const groups = await Promise.all(configs.map(async cfg => {
        const clauses = links.map(() => "COALESCE(title, '') LIKE ?").join(' OR ');
        const sql = 'SELECT ' + cfg.select + ' FROM ' + cfg.table +
            ' WHERE user_id = ? AND is_deleted = 0 AND (' + clauses + ') LIMIT 30';
        const res = await db.prepare(sql).bind(userId, ...links.map(l => '%' + l + '%')).all();
        return ((res && res.results) || []).map(row => {
            const item = normalizeMemoryRow(cfg, row);
            if (!item) return null;
            const matched = links.find(link => item.title.toLowerCase().includes(link));
            if (!matched) return null;
            item.relation = '链接「' + matched + '」';
            return item;
        }).filter(Boolean);
    }));
    return groups.flat();
}
