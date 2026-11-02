/**
 * Agent 只读工具层：工具契约、参数校验、执行网关与花园查询。
 *
 * 阶段 3 扩展了周记/随手记/收藏/提示词、混合检索与长期线索；
 * 边界仍然不变：
 * - 只暴露 read 工具，不允许写库、发消息、出站抓取；
 * - 所有查询按 user_id 隔离、过滤软删；
 * - 工具结果必须带 type/id 引用，供回答追溯；
 * - 模型只能调用注册表里的工具，不能直接碰 D1。
 */
import { MEMORY_TABLES, normalizeMemoryRow } from './rag-index.js';
import { tokenizeQuery, scoreMemoryChunk, east8NowParts, pad2 } from './rag.js';
import { EXPANDED_AGENT_TOOLS } from './agent-tools-expanded.js';

const TYPE_NAMES = MEMORY_TABLES.map((cfg) => cfg.type);

function toYmd(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayYmd() {
    return toYmd(east8NowParts().date);
}

function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeTypes(value) {
    if (!Array.isArray(value) || value.length === 0) return TYPE_NAMES.slice();
    const allowed = new Set(TYPE_NAMES);
    const picked = value.map(String).filter((type) => allowed.has(type));
    return picked.length ? [...new Set(picked)] : TYPE_NAMES.slice();
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

function itemTitle(item, body) {
    const title = cleanText(item.title, 80);
    if (title) return title;
    const text = cleanText(body, 40);
    return text || '未命名记录';
}

function toCitation(item, body) {
    return {
        type: item.type,
        id: item.id,
        title: itemTitle(item, body),
        date: item.date || '',
        snippet: cleanText(body, 160),
        related: Boolean(item.relation),
        relation: item.relation || '',
        citation: `[${item.type}#${item.id}]`
    };
}

function toItem(item, includeBody = false) {
    const rawBody = cleanText(item.body, 4000);
    const out = {
        type: item.type,
        id: item.id,
        title: itemTitle(item, rawBody),
        date: item.date || '',
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
        excerpt: cleanText(rawBody, 260),
        citation: `[${item.type}#${item.id}]`,
        updated_at: item.updated_at || ''
    };
    if (includeBody) out.body = rawBody;
    return out;
}

function rowWhere(cfg, userId, range, tokens, limit) {
    const clauses = ['user_id = ?', 'COALESCE(is_deleted, 0) = 0'];
    const binds = [userId];
    if (range) {
        clauses.push('COALESCE(updated_at, created_at) >= ?');
        binds.push(range.start + ' 00:00:00');
        clauses.push('COALESCE(updated_at, created_at) <= ?');
        binds.push(range.end + ' 23:59:59');
    }
    if (tokens.length) {
        const parts = [];
        for (const token of tokens) {
            for (const field of cfg.likeFields) {
                parts.push(`COALESCE(${field}, '') LIKE ?`);
                binds.push(`%${token}%`);
            }
        }
        clauses.push('(' + parts.join(' OR ') + ')');
    }
    binds.push(limit);
    return {
        sql: `SELECT ${cfg.select} FROM ${cfg.table} WHERE ${clauses.join(' AND ')} ` +
            `ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`,
        binds
    };
}

async function fetchRows(db, userId, cfg, range, tokens, limit) {
    const query = rowWhere(cfg, userId, range, tokens, limit);
    const res = await db.prepare(query.sql).bind(...query.binds).all();
    return ((res && res.results) || []).map((row) => normalizeMemoryRow(cfg, row)).filter(Boolean);
}

async function listRecentNotes(db, userId, args) {
    const types = normalizeTypes(args.types);
    const limit = clampInt(args.limit, 12, 1, 20);
    const range = daysRange(args.days == null ? 30 : args.days);
    const configs = MEMORY_TABLES.filter((cfg) => types.includes(cfg.type));
    const groups = await Promise.all(configs.map((cfg) => fetchRows(db, userId, cfg, range, [], limit)));
    const items = groups.flat()
        .sort((a, b) => String(b.updated_at || b.date || '').localeCompare(String(a.updated_at || a.date || '')) || Number(b.id) - Number(a.id))
        .slice(0, limit);
    const citations = items.map((item) => toCitation(item, item.body));
    const data = items.map((item) => toItem(item));
    return {
        data: {
            items: data,
            range: range ? { start: range.start, end: range.end, label: range.label } : null,
            types,
            count: data.length,
            has_more: groups.some((group) => group.length >= limit)
        },
        citations,
        truncated: groups.some((group) => group.length >= limit)
    };
}

async function searchNotes(db, userId, args) {
    const types = normalizeTypes(args.types);
    const limit = clampInt(args.limit, 12, 1, 20);
    const tokens = tokenizeQuery(String(args.query || '')).slice(0, 12);
    const range = args.days == null ? null : daysRange(args.days);
    const configs = MEMORY_TABLES.filter((cfg) => types.includes(cfg.type));
    const groups = await Promise.all(configs.map((cfg) => fetchRows(db, userId, cfg, range, tokens, limit * 2)));
    const ranked = groups.flat()
        .map((item) => ({ ...item, score: scoreMemoryChunk(item, tokens, null) }))
        .filter((item) => item.score >= 0)
        .sort((a, b) => b.score - a.score ||
            String(b.updated_at || b.date || '').localeCompare(String(a.updated_at || a.date || '')) ||
            Number(b.id) - Number(a.id))
        .slice(0, limit);
    const citations = ranked.map((item) => toCitation(item, item.body));
    const data = ranked.map((item) => toItem(item));
    return {
        data: {
            items: data,
            query: String(args.query || ''),
            query_tokens: tokens,
            range: range ? { start: range.start, end: range.end, label: range.label } : null,
            count: data.length,
            has_more: groups.some((group) => group.length >= limit * 2)
        },
        citations,
        truncated: groups.some((group) => group.length >= limit * 2)
    };
}

async function getNote(db, userId, args) {
    const cfg = MEMORY_TABLES.find((item) => item.type === args.type);
    if (!cfg) {
        return { data: { found: false, item: null }, citations: [], truncated: false };
    }
    const res = await db.prepare(
        `SELECT ${cfg.select} FROM ${cfg.table} WHERE user_id = ? AND COALESCE(is_deleted, 0) = 0 AND id = ? LIMIT 1`
    ).bind(userId, args.id).first();
    const item = normalizeMemoryRow(cfg, res);
    if (!item) {
        return { data: { found: false, item: null }, citations: [], truncated: false };
    }
    const data = toItem(item, true);
    return {
        data: { found: true, item: data },
        citations: [toCitation(item, item.body)],
        truncated: String(item.body || '').length > 4000
    };
}

async function getGardenOverview(db, userId) {
    const rows = await Promise.all(MEMORY_TABLES.map(async (cfg) => {
        const res = await db.prepare(
            `SELECT COUNT(*) AS count, MAX(COALESCE(updated_at, created_at)) AS latest ` +
            `FROM ${cfg.table} WHERE user_id = ? AND COALESCE(is_deleted, 0) = 0`
        ).bind(userId).first();
        return {
            type: cfg.type,
            count: Number((res && res.count) || 0),
            latest: (res && res.latest) || ''
        };
    }));
    return {
        data: {
            total: rows.reduce((sum, row) => sum + row.count, 0),
            types: rows,
            today: todayYmd()
        },
        citations: [],
        truncated: false
    };
}

const TYPE_SCHEMA = { type: 'string', enum: TYPE_NAMES };

export const AGENT_TOOLS = [
    {
        name: 'get_garden_overview',
        description: '查看用户花园五类记录的总量与最近更新时间。用户问“我记录了什么/有没有数据”或不确定是否有内容时先用它。',
        risk: 'read',
        timeoutMs: 5000,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        handler: getGardenOverview
    },
    {
        name: 'list_recent_notes',
        description: '按时间倒序列出最近的花园记录，返回短摘录和引用。适合“最近在想什么/最近记录/总结主要主题”这类没有明确关键词的问题。',
        risk: 'read',
        timeoutMs: 5000,
        parameters: {
            type: 'object',
            properties: {
                days: { type: 'integer', minimum: 1, maximum: 3650, description: '回看最近多少天，默认 30' },
                types: { type: 'array', items: TYPE_SCHEMA, maxItems: 5, description: '限定记录类型；不传则五类都查' },
                limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回多少条，默认 12' }
            },
            additionalProperties: false
        },
        handler: listRecentNotes
    },
    {
        name: 'search_notes',
        description: '按关键词检索花园记录，可限定最近天数与记录类型。适合有明确关键词的问题；需要正文时再用 get_note。',
        risk: 'read',
        timeoutMs: 5000,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', minLength: 1, maxLength: 200, description: '检索词，保留用户原话中的关键词' },
                days: { type: 'integer', minimum: 1, maximum: 3650, description: '只查最近多少天；不传则查全部历史' },
                types: { type: 'array', items: TYPE_SCHEMA, maxItems: 5, description: '限定记录类型；不传则五类都查' },
                limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回多少条，默认 12' }
            },
            required: ['query'],
            additionalProperties: false
        },
        handler: searchNotes
    },
    {
        name: 'get_note',
        description: '读取一条花园记录的正文。必须先用 list_recent_notes、search_notes、search_memory 或对应列表工具拿到 type 和 id。',
        risk: 'read',
        timeoutMs: 5000,
        parameters: {
            type: 'object',
            properties: {
                type: TYPE_SCHEMA,
                id: { type: 'integer', minimum: 1 }
            },
            required: ['type', 'id'],
            additionalProperties: false
        },
        handler: getNote
    },
    ...EXPANDED_AGENT_TOOLS
];

const TOOL_MAP = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

export function getAgentToolDefs() {
    return AGENT_TOOLS.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }
    }));
}

function checkValue(spec, value, path) {
    if (!spec || typeof spec !== 'object') return null;
    if (value === undefined || value === null) return `${path} 不能为空`;
    if (spec.type === 'string') {
        if (typeof value !== 'string') return `${path} 必须是字符串`;
        if (spec.minLength != null && value.length < spec.minLength) return `${path} 太短`;
        if (spec.maxLength != null && value.length > spec.maxLength) return `${path} 太长`;
        if (spec.enum && !spec.enum.includes(value)) return `${path} 不在允许范围`;
    } else if (spec.type === 'integer') {
        if (!Number.isInteger(value)) return `${path} 必须是整数`;
        if (spec.minimum != null && value < spec.minimum) return `${path} 小于最小值`;
        if (spec.maximum != null && value > spec.maximum) return `${path} 超过最大值`;
    } else if (spec.type === 'array') {
        if (!Array.isArray(value)) return `${path} 必须是数组`;
        if (spec.maxItems != null && value.length > spec.maxItems) return `${path} 条目过多`;
        for (let i = 0; i < value.length; i += 1) {
            const err = checkValue(spec.items, value[i], `${path}[${i}]`);
            if (err) return err;
        }
    }
    return null;
}

export function validateToolArgs(tool, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '参数必须是对象';
    const spec = tool.parameters || {};
    const properties = spec.properties || {};
    for (const key of Object.keys(args)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) return `未知参数：${key}`;
    }
    for (const key of spec.required || []) {
        if (args[key] === undefined || args[key] === null || args[key] === '') return `缺少参数：${key}`;
    }
    for (const [key, propSpec] of Object.entries(properties)) {
        if (args[key] === undefined) continue;
        const err = checkValue(propSpec, args[key], key);
        if (err) return err;
    }
    return '';
}

function timeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('TOOL_TIMEOUT')), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

function errorResult(code, message) {
    return { ok: false, error: { code, message } };
}

export async function executeAgentTool(db, userId, name, rawArgs) {
    const tool = TOOL_MAP.get(String(name || ''));
    if (!tool) return errorResult('UNKNOWN_TOOL', '未注册的工具');
    if (tool.risk !== 'read') return errorResult('TOOL_FORBIDDEN', '阶段 3 仍只允许只读工具');

    let args = rawArgs;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args || '{}');
        } catch (_) {
            return errorResult('INVALID_ARGUMENTS', '工具参数不是合法 JSON');
        }
    }
    const validationError = validateToolArgs(tool, args || {});
    if (validationError) return errorResult('INVALID_ARGUMENTS', validationError);

    const started = Date.now();
    try {
        const result = await timeout(Promise.resolve(tool.handler(db, userId, args || {})), tool.timeoutMs || 5000);
        const citations = Array.isArray(result.citations) ? result.citations : [];
        return {
            ok: true,
            tool: tool.name,
            data: result.data,
            citations,
            truncated: Boolean(result.truncated),
            duration_ms: Date.now() - started
        };
    } catch (err) {
        console.error('[agent-tool] ' + tool.name + ' failed:', err && err.message ? err.message : err);
        return {
            ...errorResult(err && err.message === 'TOOL_TIMEOUT' ? 'TOOL_TIMEOUT' : 'TOOL_FAILED', '工具执行失败'),
            tool: tool.name,
            duration_ms: Date.now() - started
        };
    }
}

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name);
