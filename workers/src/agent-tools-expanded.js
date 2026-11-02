/**
 * Agent 阶段 3 只读工具：花园垂直列表、混合检索与长期线索。
 *
 * 这些工具与 ai-tools.js 共享同一套执行网关和引用协议；拆开是为了守住
 * “单个领域模块不超过 500 行”的架构红线。
 */
import { retrieveGardenMemories, east8NowParts, pad2 } from './rag.js';
import { buildRecurringThreads, loadInsightRecords } from './insights.js';

function toYmd(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}

function daysRange(days) {
    if (days == null) return null;
    const end = east8NowParts().date;
    const start = new Date(end);
    start.setDate(start.getDate() - clampInt(days, 30, 1, 3650) + 1);
    return { start: toYmd(start), end: toYmd(end), label: `最近 ${clampInt(days, 30, 1, 3650)} 天` };
}

function cleanText(value, max = 220) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseTagList(value) {
    if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String).map((tag) => tag.trim()).filter(Boolean);
    } catch (_) {}
    return raw.split(/[,，\s#]+/).map((tag) => tag.trim()).filter(Boolean);
}

function citationOf(type, id, title, date, snippet, extra = {}) {
    return {
        type,
        id: Number(id),
        title: cleanText(title, 80) || '未命名记录',
        date: String(date || ''),
        snippet: cleanText(snippet, 160),
        citation: `[${type}#${id}]`,
        ...extra
    };
}

function listResult(items, extra, truncated) {
    return {
        data: { ...extra, items, count: items.length, has_more: Boolean(truncated) },
        citations: items.map((item) => citationOf(item.type, item.id, item.title, item.date, item.snippet, {
            related: Boolean(item.related),
            relation: item.relation || ''
        })),
        truncated: Boolean(truncated)
    };
}

function listRange(days) {
    return days == null ? null : daysRange(days);
}

async function listWeeklies(db, userId, args) {
    const limit = clampInt(args.limit, 6, 1, 12);
    const range = listRange(args.days == null ? 90 : args.days);
    const clauses = ['user_id = ?', 'COALESCE(is_deleted, 0) = 0'];
    const binds = [userId];
    if (range) {
        clauses.push('COALESCE(updated_at, created_at) >= ?', 'COALESCE(updated_at, created_at) <= ?');
        binds.push(range.start + ' 00:00:00', range.end + ' 23:59:59');
    }
    const query = String(args.query || '').trim();
    if (query) {
        clauses.push('(COALESCE(title, \'\') LIKE ? OR COALESCE(summary, \'\') LIKE ? OR COALESCE(content, \'\') LIKE ?)');
        binds.push('%' + query + '%', '%' + query + '%', '%' + query + '%');
    }
    binds.push(limit + 1);
    const res = await db.prepare(
        `SELECT id, title, summary, content, date, created_at, updated_at FROM weeklies ` +
        `WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`
    ).bind(...binds).all();
    const rows = (res && res.results) || [];
    const truncated = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
        const summary = cleanText(row.summary, 300);
        const excerpt = cleanText(row.content, 260);
        return {
            type: '周记',
            id: Number(row.id),
            title: cleanText(row.title, 80) || '未命名周记',
            date: String(row.date || row.updated_at || row.created_at || ''),
            summary,
            excerpt,
            snippet: summary || excerpt,
            citation: `[周记#${row.id}]`,
            updated_at: row.updated_at || ''
        };
    });
    return listResult(items, { range: range ? { start: range.start, end: range.end, label: range.label } : null, query }, truncated);
}

async function listQuickFeeds(db, userId, args) {
    const limit = clampInt(args.limit, 8, 1, 20);
    const range = listRange(args.days == null ? 60 : args.days);
    const clauses = ['user_id = ?', 'COALESCE(is_deleted, 0) = 0'];
    const binds = [userId];
    if (range) {
        clauses.push('COALESCE(updated_at, created_at) >= ?', 'COALESCE(updated_at, created_at) <= ?');
        binds.push(range.start + ' 00:00:00', range.end + ' 23:59:59');
    }
    const query = String(args.query || '').trim();
    if (query) {
        clauses.push('(COALESCE(content, \'\') LIKE ? OR COALESCE(summary, \'\') LIKE ? OR COALESCE(tags, \'\') LIKE ?)');
        binds.push('%' + query + '%', '%' + query + '%', '%' + query + '%');
    }
    const tag = String(args.tag || '').trim();
    if (tag) {
        clauses.push('COALESCE(tags, \'\') LIKE ?');
        binds.push('%' + tag + '%');
    }
    binds.push(limit + 1);
    const res = await db.prepare(
        `SELECT id, content, summary, tags, created_at, updated_at FROM quick_feeds ` +
        `WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`
    ).bind(...binds).all();
    const rows = (res && res.results) || [];
    const truncated = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
        const excerpt = cleanText(row.content, 260);
        const summary = cleanText(row.summary, 160);
        return {
            type: '随手记',
            id: Number(row.id),
            title: cleanText(row.content || row.summary, 80) || '未命名随手记',
            date: String(row.created_at || ''),
            excerpt,
            summary,
            tags: parseTagList(row.tags).slice(0, 8),
            snippet: summary || excerpt,
            citation: `[随手记#${row.id}]`,
            updated_at: row.updated_at || ''
        };
    });
    return listResult(items, { range: range ? { start: range.start, end: range.end, label: range.label } : null, query, tag }, truncated);
}

async function listBookmarks(db, userId, args) {
    const limit = clampInt(args.limit, 8, 1, 20);
    const clauses = ['user_id = ?', 'COALESCE(is_deleted, 0) = 0'];
    const binds = [userId];
    const query = String(args.query || '').trim();
    if (query) {
        clauses.push('(COALESCE(title, \'\') LIKE ? OR COALESCE(description, \'\') LIKE ? OR COALESCE(url, \'\') LIKE ? OR COALESCE(type, \'\') LIKE ?)');
        binds.push('%' + query + '%', '%' + query + '%', '%' + query + '%', '%' + query + '%');
    }
    const category = String(args.category || '').trim();
    if (category) {
        clauses.push('COALESCE(type, \'\') = ?');
        binds.push(category);
    }
    binds.push(limit + 1);
    const res = await db.prepare(
        `SELECT id, type, title, url, description, created_at, updated_at FROM bookmarks ` +
        `WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`
    ).bind(...binds).all();
    const rows = (res && res.results) || [];
    const truncated = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
        const description = cleanText(row.description, 240);
        return {
            type: '收藏',
            id: Number(row.id),
            title: cleanText(row.title, 80) || cleanText(row.url, 80) || '未命名收藏',
            date: String(row.updated_at || row.created_at || ''),
            category: String(row.type || ''),
            url: String(row.url || ''),
            excerpt: description,
            snippet: description || String(row.url || ''),
            citation: `[收藏#${row.id}]`,
            updated_at: row.updated_at || ''
        };
    });
    return listResult(items, { query, category }, truncated);
}

async function listPrompts(db, userId, args) {
    const limit = clampInt(args.limit, 8, 1, 20);
    const clauses = ['user_id = ?', 'COALESCE(is_deleted, 0) = 0'];
    const binds = [userId];
    const query = String(args.query || '').trim();
    if (query) {
        clauses.push('(COALESCE(title, \'\') LIKE ? OR COALESCE(project, \'\') LIKE ? OR COALESCE(scene, \'\') LIKE ? OR COALESCE(content, \'\') LIKE ? OR COALESCE(description, \'\') LIKE ? OR COALESCE(tags, \'\') LIKE ?)');
        binds.push('%' + query + '%', '%' + query + '%', '%' + query + '%', '%' + query + '%', '%' + query + '%', '%' + query + '%');
    }
    const project = String(args.project || '').trim();
    if (project) {
        clauses.push('COALESCE(project, \'\') = ?');
        binds.push(project);
    }
    const scene = String(args.scene || '').trim();
    if (scene) {
        clauses.push('COALESCE(scene, \'\') = ?');
        binds.push(scene);
    }
    binds.push(limit + 1);
    const res = await db.prepare(
        `SELECT id, title, project, scene, content, description, tags, is_pinned, created_at, updated_at FROM prompts ` +
        `WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(is_pinned, 0) DESC, COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`
    ).bind(...binds).all();
    const rows = (res && res.results) || [];
    const truncated = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
        const excerpt = cleanText(row.content, 260);
        const description = cleanText(row.description, 180);
        return {
            type: '提示词',
            id: Number(row.id),
            title: cleanText(row.title, 80) || '未命名提示词',
            date: String(row.updated_at || row.created_at || ''),
            project: String(row.project || '通用'),
            scene: String(row.scene || '场景'),
            pinned: Boolean(row.is_pinned),
            tags: parseTagList(row.tags).slice(0, 8),
            excerpt,
            snippet: description || excerpt,
            citation: `[提示词#${row.id}]`,
            updated_at: row.updated_at || ''
        };
    });
    return listResult(items, { query, project, scene }, truncated);
}

async function searchMemory(db, userId, args) {
    const limit = clampInt(args.limit, 6, 1, 10);
    const query = String(args.query || '').trim();
    const retrieval = await retrieveGardenMemories(db, userId, query, { topK: limit, maxChars: 1800 });
    const sources = (retrieval.sources || []).slice(0, limit);
    const items = sources.map((source) => ({
        type: source.type,
        id: Number(source.id),
        title: cleanText(source.title, 80) || '未命名记录',
        date: String(source.date || ''),
        excerpt: cleanText(source.snippet, 220),
        snippet: cleanText(source.snippet, 160),
        score: Number(source.score || 0),
        related: Boolean(source.related),
        relation: source.relation || '',
        citation: `[${source.type}#${source.id}]`
    }));
    return {
        data: {
            query,
            tokens: retrieval.tokens || [],
            range: retrieval.timeRange ? {
                start: retrieval.timeRange.start,
                end: retrieval.timeRange.end,
                label: retrieval.timeRange.label
            } : null,
            items,
            count: items.length,
            candidate_count: Number(retrieval.candidateCount || 0),
            related_count: Number(retrieval.relatedCount || 0),
            context: String(retrieval.contextText || '').slice(0, 1800)
        },
        citations: items.map((item) => citationOf(item.type, item.id, item.title, item.date, item.snippet, {
            related: item.related,
            relation: item.relation
        })),
        truncated: sources.length >= limit
    };
}

async function getRecurringThreads(db, userId, args) {
    const days = clampInt(args.days, 180, 30, 365);
    const limit = clampInt(args.limit, 6, 1, 12);
    const records = await loadInsightRecords(db, userId, days);
    const threads = buildRecurringThreads(records, { limit, nowMs: Date.now() });
    const typeMap = { feed: '随手记', note: '笔记', weekly: '周记' };
    const citations = [];
    const seen = new Set();
    for (const thread of threads) {
        for (const evidence of thread.evidence || []) {
            const type = typeMap[evidence.type] || evidence.label || '记录';
            const key = type + '#' + evidence.id;
            if (seen.has(key)) continue;
            seen.add(key);
            citations.push(citationOf(type, evidence.id, thread.topic, evidence.date, evidence.snippet));
        }
    }
    return {
        data: {
            threads,
            days,
            scanned: records.length,
            count: threads.length,
            total: threads.length
        },
        citations,
        truncated: records.length >= 640
    };
}

export const EXPANDED_AGENT_TOOLS = [
    {
        name: 'list_weeklies',
        description: '按时间倒序列出周记，带摘要与引用。适合“最近周记/每周回顾/这周写了什么”；通用五类最近记录仍用 list_recent_notes。',
        risk: 'read',
        timeoutMs: 5000,
        parameters: {
            type: 'object',
            properties: {
                days: { type: 'integer', minimum: 1, maximum: 3650, description: '回看最近多少天，默认 90' },
                limit: { type: 'integer', minimum: 1, maximum: 12, description: '最多返回多少条，默认 6' },
                query: { type: 'string', minLength: 1, maxLength: 200, description: '可选：标题/摘要/正文关键词' }
            },
            additionalProperties: false
        },
        handler: listWeeklies
    },
    {
        name: 'list_quick_feeds',
        description: '列最近随手记，可按关键词或标签过滤。适合“最近随手记/我记过哪些灵感/带某个标签的碎片”。',
        risk: 'read',
        timeoutMs: 5000,
        parameters: {
            type: 'object',
            properties: {
                days: { type: 'integer', minimum: 1, maximum: 3650, description: '回看最近多少天，默认 60' },
                limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回多少条，默认 8' },
                query: { type: 'string', minLength: 1, maxLength: 200, description: '可选：正文/摘要/标签关键词' },
                tag: { type: 'string', minLength: 1, maxLength: 40, description: '可选：标签精确片段' }
            },
            additionalProperties: false
        },
        handler: listQuickFeeds
    },
    {
        name: 'list_bookmarks',
        description: '列收藏，返回标题、链接、分类与描述。适合“我收藏了哪些工具/网站/电影”；按分类或关键词过滤。',
        risk: 'read',
        timeoutMs: 5000,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', minLength: 1, maxLength: 200, description: '可选：标题/描述/链接/分类关键词' },
                category: { type: 'string', minLength: 1, maxLength: 40, description: '可选：收藏分类，例如“🛠️ 工具”' },
                limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回多少条，默认 8' }
            },
            additionalProperties: false
        },
        handler: listBookmarks
    },
    {
        name: 'list_prompts',
        description: '列提示词，带项目、场景、标签与正文摘录。适合“我有哪些提示词/某个项目的提示词/找一段写作或开发提示词”。',
        risk: 'read',
        timeoutMs: 5000,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', minLength: 1, maxLength: 200, description: '可选：标题/项目/场景/正文关键词' },
                project: { type: 'string', minLength: 1, maxLength: 40, description: '可选：项目名精确匹配' },
                scene: { type: 'string', minLength: 1, maxLength: 40, description: '可选：场景名精确匹配' },
                limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回多少条，默认 8' }
            },
            additionalProperties: false
        },
        handler: listPrompts
    },
    {
        name: 'search_memory',
        description: '跨五类记录做混合检索（全文/关键词 + 双链与共同标签的关联扩展），返回按相关度排序的片段与引用。适合“我以前是不是写过/跨类型找线索/关联记忆”；比 search_notes 更适合模糊、需要联想的检索。',
        risk: 'read',
        timeoutMs: 6000,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', minLength: 1, maxLength: 200, description: '检索问题或关键词，保留用户原话中的时间词' },
                limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回多少条，默认 6' }
            },
            required: ['query'],
            additionalProperties: false
        },
        handler: searchMemory
    },
    {
        name: 'get_recurring_threads',
        description: '发现跨月份反复出现的长期主题/线索，每条带时间跨度与原文证据。适合“我最近反复在想什么/长期关注什么/有没有一直没做的事”，不是普通关键词搜索。',
        risk: 'read',
        timeoutMs: 6000,
        parameters: {
            type: 'object',
            properties: {
                days: { type: 'integer', minimum: 30, maximum: 365, description: '回看最近多少天，默认 180' },
                limit: { type: 'integer', minimum: 1, maximum: 12, description: '最多返回多少条线索，默认 6' }
            },
            additionalProperties: false
        },
        handler: getRecurringThreads
    }
];
