/**
 * Bot 主动关怀素材挖掘层 (bot-outreach-source.js)
 * 负责从 3~180 天前的历史随手记、笔记、周记、收藏中挖掘候选素材，
 * 进行跨月份线索聚类与候选抽取，支撑主动关怀的素材来源。
 */
import { buildThreadCandidates } from './insights.js';

/** 新记录不碰：只回忆 3 天前的东西 */
export const OUTREACH_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** 太老的东西也不翻（180 天前） */
export const OUTREACH_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** 每张表抓多少个候选旧记录（再在内存里按年龄过滤） */
export const OUTREACH_CANDIDATE_FETCH = 60;

/** 容忍两种历史写法：东八区文本（YYYY-MM-DD HH:MM:SS）与 epoch 毫秒 */
export function parseRecordTimeMs(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    if (/^\d{10,}$/.test(s)) return Number(s);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600 * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
}

/** 候选素材的来源表：全部参数化绑定，绝不拼接 SQL */
export const CANDIDATE_SOURCES = [
    {
        table: 'quick_feeds',
        kind: '随手记',
        sql: 'SELECT id, content AS body, created_at, updated_at FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT ?2'
    },
    {
        table: 'notes',
        kind: '笔记',
        sql: 'SELECT id, title, content, created_at, updated_at FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT ?2'
    },
    {
        table: 'weeklies',
        kind: '周记',
        sql: 'SELECT id, title, summary, content, created_at, updated_at FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT ?2'
    },
    {
        table: 'bookmarks',
        kind: '收藏',
        sql: 'SELECT id, title, description, url, created_at, updated_at FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT ?2'
    }
];

export function candidateBody(source, row) {
    if (source.table === 'quick_feeds') return String(row.body || '').trim();
    if (source.table === 'bookmarks') return [row.title, row.description, row.url].filter(Boolean).join(' ').trim();
    if (source.table === 'notes') return [row.title, row.content].filter(Boolean).join(' ').trim();
    return [row.title, row.summary || row.content].filter(Boolean).join(' ').trim();
}

/** 收集年龄合适的候选（导出便于单测直接喂数据） */
export async function collectCandidates(db, userId, nowMs) {
    const out = [];
    for (const source of CANDIDATE_SOURCES) {
        const res = await db.prepare(source.sql).bind(userId, OUTREACH_CANDIDATE_FETCH).all();
        for (const row of (res && res.results) || []) {
            const body = candidateBody(source, row);
            if (body.length < 8) continue;
            const at = parseRecordTimeMs(row.created_at) || parseRecordTimeMs(row.updated_at);
            if (!at) continue;
            const age = nowMs - at;
            if (age < OUTREACH_MIN_AGE_MS || age > OUTREACH_MAX_AGE_MS) continue;
            out.push({
                type: source.table,
                kind: source.kind,
                id: String(row.id),
                body: body.slice(0, 400),
                atMs: at,
                ageDays: Math.floor(age / 86400000)
            });
        }
    }
    // 跨月份反复出现的旧记录合成线索候选；Bot 因此能说「你之前也想过这个」。
    out.push(...buildThreadCandidates(out, nowMs));
    return out;
}

/** 随机挑一条没被引用过的候选；没有就返回 null（返回 null 是合法的「今天不说」） */
export function pickCandidate(candidates, usedRefs, random = Math.random) {
    const fresh = (candidates || []).filter(c => !usedRefs.has(c.type + ':' + c.id));
    if (!fresh.length) return null;
    const idx = Math.floor(random() * fresh.length) % fresh.length;
    return fresh[idx];
}

