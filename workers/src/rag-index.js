/**
 * 长期记忆候选层：六类花园内容（随手记、笔记、周记、收藏、提示词、书库）的 D1 候选查询、FTS5 命中回表与跨模块主题/wikilink 关联加载。
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
    },
    {
        type: '书籍',
        table: 'reader_books',
        select: 'id, title, author, book_key, total_chapters, created_at, updated_at',
        titleColumn: 'title',
        likeFields: ['title', 'author'],
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

export function extractHashtags(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(/(?:^|[\s，。；;、])#([^\s#，。；;、]{1,30})/g)) {
        if (m[1]) out.add(m[1]);
    }
    return [...out];
}

/** 服务端轻量 wikilink 解析：[[标题]] / [[标题|别名]] / [[标题#段落]] */
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
        tags = [...new Set([...parseTagList(row.tags), ...extractHashtags(String(row.content || '') + ' ' + String(row.summary || ''))])];
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
        tags = extractHashtags(title + ' ' + (row.description || ''));
    } else if (cfg.type === '提示词') {
        title = '[' + (row.project || '通用') + '/' + (row.scene || '场景') + '] ' + (row.title || '');
        body = [row.description, row.content].filter(Boolean).join(' ');
        tags = [...new Set([...parseTagList(row.tags), ...extractHashtags(title + ' ' + (row.description || ''))])];
    } else if (cfg.type === '书籍') {
        title = String(row.title || '');
        const authorPart = row.author ? '作者: ' + row.author : '';
        const chPart = row.total_chapters ? '共 ' + row.total_chapters + ' 章' : '';
        const progPart = row.progress_text ? '阅读进度: ' + row.progress_text : '';
        body = [authorPart, chPart, progPart].filter(Boolean).join(' · ');
        tags = ['书籍', '阅读', '书架', '在读', '读书', ...(row.author ? [row.author] : [])];
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

async function attachBookProgress(db, userId, rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const bookKeys = rows.map(r => r.book_key).filter(Boolean);
    if (!bookKeys.length) return rows;
    try {
        const placeholders = bookKeys.map(() => '?').join(',');
        const res = await db.prepare(
            'SELECT book_key, chapter_title, scroll_percentage FROM reader_progress WHERE user_id = ? AND book_key IN (' + placeholders + ')'
        ).bind(userId, ...bookKeys).all();
        const map = new Map();
        for (const p of ((res && res.results) || [])) {
            if (p && p.book_key) map.set(p.book_key, p);
        }
        for (const r of rows) {
            const p = map.get(r.book_key);
            if (p) {
                const ch = p.chapter_title ? p.chapter_title : '';
                const pct = p.scroll_percentage != null ? '已读 ' + p.scroll_percentage + '%' : '';
                r.progress_text = [ch, pct].filter(Boolean).join(' · ');
            }
        }
    } catch (_) {}
    return rows;
}

function buildLikeFilter(cfg, tokens) {
    if (!tokens.length) return { sql: '', binds: [] };
    if (cfg.type === '书籍') {
        const bookKeywords = ['在读', '书架', '书籍', '看书', '读书', '阅读'];
        if (tokens.some(t => bookKeywords.includes(t))) {
            return { sql: '1 = 1', binds: [] };
        }
    }
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
    let rows = (res && res.results) || [];
    if (cfg.type === '书籍') rows = await attachBookProgress(db, userId, rows);
    return rows;
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
        return [];
    }
}

export async function fetchRowsByIds(db, cfg, userId, ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const sql = 'SELECT ' + cfg.select + ' FROM ' + cfg.table +
        ' WHERE user_id = ? AND is_deleted = 0 AND id IN (' + placeholders + ')';
    const res = await db.prepare(sql).bind(userId, ...ids).all();
    let rows = (res && res.results) || [];
    if (cfg.type === '书籍') rows = await attachBookProgress(db, userId, rows);
    return rows;
}

/** 跨模块常青主题（#tag）与双向链接（wikilink）关联加载 */
export async function loadLinkedMemories(db, userId, seeds) {
    const links = [...new Set(seeds.flatMap(seed => extractWikiLinks(seed.title + ' ' + seed.body)))].slice(0, 6);
    const tags = [...new Set(seeds.flatMap(seed => seed.tags || []))]
        .filter(t => t.length >= 2 && !['书籍', '阅读', '书架', '通用', '场景'].includes(t))
        .slice(0, 4);

    if (!links.length && !tags.length) return [];

    const configs = MEMORY_TABLES.filter(cfg => cfg.titleColumn || cfg.likeFields.includes('tags') || cfg.likeFields.includes('content'));
    const groups = await Promise.all(configs.map(async cfg => {
        const clauses = [];
        const binds = [];
        if (links.length && cfg.titleColumn) {
            clauses.push(...links.map(() => "COALESCE(" + cfg.titleColumn + ", '') LIKE ?"));
            binds.push(...links.map(l => '%' + l + '%'));
        }
        if (tags.length) {
            const targetField = cfg.likeFields.includes('tags') ? 'tags' : (cfg.likeFields.includes('content') ? 'content' : '');
            if (targetField) {
                clauses.push(...tags.map(() => "COALESCE(" + targetField + ", '') LIKE ?"));
                binds.push(...tags.map(t => '%' + t + '%'));
            }
        }
        if (!clauses.length) return [];
        const sql = 'SELECT ' + cfg.select + ' FROM ' + cfg.table +
            ' WHERE user_id = ? AND is_deleted = 0 AND (' + clauses.join(' OR ') + ') LIMIT 30';
        const res = await db.prepare(sql).bind(userId, ...binds).all();
        let rows = (res && res.results) || [];
        if (cfg.type === '书籍') rows = await attachBookProgress(db, userId, rows);
        return rows.map(row => {
            const item = normalizeMemoryRow(cfg, row);
            if (!item) return null;
            const matchedLink = links.find(link => item.title.toLowerCase().includes(link));
            if (matchedLink) {
                item.relation = '链接「' + matchedLink + '」';
                return item;
            }
            const matchedTag = tags.find(t => item.tags.includes(t) || item.body.includes('#' + t));
            if (matchedTag) {
                item.relation = '同主题 #' + matchedTag;
                return item;
            }
            return item;
        }).filter(Boolean);
    }));
    return groups.flat();
}
