/**
 * 长期线索与行动转化（Recurring Insights）
 *
 * 目标不是再做一个「AI 摘要」，而是回答一个更具体的问题：
 *   哪些念头在不同月份反复出现，值得现在继续？
 *
 * 这里只做确定性、可解释的聚类：把每条记录里最像主题的词（#标签 / [[双链]] /
 * 中英文词组）取出来，要求同一个词跨至少两个自然月、跨度至少 14 天，才成为一条
 * 「线索」。证据永远带日期与原文短句，用户能看出系统为什么想起它。
 *
 * 不调用模型，不上传正文：排序与聚类都在 Worker 内完成。模型只在下游主动关怀里
 * 决定「要不要开口、怎么开口」，不再负责发现线索。
 */
import { jsonResponse, readJsonCapped } from './security.js';
import { createReminderAt } from './bot-reminders.js';

export const INSIGHT_DAYS_DEFAULT = 180;
export const INSIGHT_DAYS_MAX = 365;
export const INSIGHT_LIMIT_DEFAULT = 6;
export const INSIGHT_LIMIT_MAX = 12;
export const INSIGHT_MIN_SPAN_DAYS = 14;
export const INSIGHT_MIN_MONTHS = 2;
const DAY_MS = 86400000;

const TYPE_LABEL = { feed: '随手记', note: '笔记', weekly: '周记', bookmark: '收藏' };

const STOP_TERMS = new Set([
    '今天', '昨天', '明天', '后天', '最近', '现在', '当时', '时候', '之后', '之前', '以前', '以后',
    '自己', '我们', '你们', '他们', '她们', '大家', '别人', '这个', '那个', '这些', '那些', '这样', '那样',
    '什么', '怎么', '为什么', '如何', '哪里', '哪个', '多少', '是否', '不是', '就是', '还是', '但是',
    '因为', '所以', '如果', '虽然', '然后', '而且', '并且', '可以', '可能', '应该', '需要', '觉得',
    '感觉', '其实', '真的', '比较', '非常', '有点', '一些', '一点', '一下', '一直', '已经', '正在',
    '没有', '还有', '只有', '所有', '很多', '东西', '事情', '问题', '想法', '记录', '笔记', '生活',
    '工作', '时间', '地方', '方式', '开始', '结束', '继续', '希望', '计划', '准备', '打算', '下次',
    '有空', '机会', '未来', '以后', '考虑', '想要', '想做', '要做', '在做', '想到', '看到', '听到',
    '知道', '认识', '喜欢', '不喜欢', '开心', '难过', '焦虑', '压力', '状态', '今天天', '最近在', '想把', '想弄', '改成', '可以', '还是',
    '不知道', '有时候', '这一次', '那一次', '这件事', '那件事', '一件', '一次', '一种', '一样',
    '一个', '这次', '那次', '这种', '那种', '哪些', '这个', '那个',
    '关于', '对于', '通过', '以及', '其中', '上面', '下面', '里面', '外面', '这里', '那里', '起来',
    '下来', '出来', '过来', '过去', '回来', '进去', '出去', '一下下', '是不是', '有没有', '能不能',
    '要不要', '会不会', '可不可以', '的话', '而已', '之类', '等等', '感觉像', '好像', '似乎'
]);

const UNFINISHED_RE = /(想做|想试|计划|打算|准备|以后|下次|有空|要不要|考虑|希望|未来|还没|未完成|有机会|回头|改天|抽空|继续|在想要|想弄|想学|想写|想去|想见|攒|等.*再|过阵子|慢慢)/;
const EXPLICIT_RE = /#([\w\u4e00-\u9fa5-]{2,20})|\[\[([^[\]|\n]{2,30})(?:\|[^[\]]{1,30})?\]\]/g;
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g;
const EN_WORD_RE = /[a-zA-Z][a-zA-Z0-9_-]{3,24}/g;

function fnv1a(text) {
    let hash = 2166136261 >>> 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36);
}

/** 容忍东八区文本、ISO、epoch 与中文日期；解析失败返回 0 */
export function parseRecordMs(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const s = String(value).trim();
    if (/^\d{10,}$/.test(s)) return Number(s);
    const full = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (full) {
        return Date.UTC(+full[1], +full[2] - 1, +full[3], +(full[4] || 0), +(full[5] || 0), +(full[6] || 0)) - 8 * 3600000;
    }
    const cn = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (cn) return Date.UTC(+cn[1], +cn[2] - 1, +cn[3]) - 8 * 3600000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
}

function cstYmd(ms) {
    return new Date(Number(ms) + 8 * 3600000).toISOString().slice(0, 10);
}

function monthKey(ms) {
    return cstYmd(ms).slice(0, 7);
}

export function cleanInsightText(raw) {
    return String(raw == null ? '' : raw)
        .replace(/<[^>]+>/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);
}

const BAD_START = '把被让给对向从在是有想又要都也还就才再很更最这那哪我你他她它';
const BAD_END = '的了着过吧呢啊吗呀哦嘛把被给对向从在是有想又要都也还就才再很更最这那哪我你他她它改做看想要去来';

function isUsefulTerm(term) {
    if (!term || term.length < 2 || term.length > 6) return false;
    if (STOP_TERMS.has(term)) return false;
    if (/^\d+$/.test(term)) return false;
    if (!/[\u4e00-\u9fffA-Za-z]/.test(term)) return false;
    // 长词组常被任意边界切断（「把阳台改」「己的播客」）；首尾是虚词/动词时不要，
    // 把干净的两字核心留给聚类。两字词不裁，避免误伤「在线」「有声书」这类主题。
    if (term.length > 2 && (BAD_START.includes(term[0]) || BAD_END.includes(term[term.length - 1]))) return false;
    return true;
}

/** 一条记录的主题候选：显式标签优先，中文 2–4 字词组与英文词兜底 */
export function extractInsightTerms(rawText) {
    const text = cleanInsightText(rawText);
    const weighted = new Map();
    const add = (term, weight) => {
        const clean = String(term || '').trim();
        if (!isUsefulTerm(clean)) return;
        weighted.set(clean, Math.max(weighted.get(clean) || 0, weight));
    };
    for (const match of text.matchAll(EXPLICIT_RE)) {
        add(match[1] || match[2], 10);
    }
    for (const run of text.match(CJK_RUN_RE) || []) {
        if (run.length < 2) continue;
        for (let n = 2; n <= 4; n++) {
            for (let i = 0; i + n <= run.length; i++) {
                const term = run.slice(i, i + n);
                if (!isUsefulTerm(term)) continue;
                // 长词更具体；显式标签已经拿满分。同一条记录里只保留一次。
                add(term, n === 4 ? 4 : (n === 3 ? 3 : 2));
            }
        }
    }
    for (const word of text.match(EN_WORD_RE) || []) {
        const lower = word.toLowerCase();
        if (STOP_TERMS.has(lower) || /^\d+$/.test(lower)) continue;
        add(lower, 3);
    }
    const entries = [...weighted.entries()]
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
    // 两字词是跨不同写法的「最大公约数」（阳台 / 播客 / 书房）；只取长词会让
    // 「阳台改造成书房」与「阳台改造采光」彼此错过。长词保留前 24 个补充具体性。
    return [
        ...entries.filter(([term]) => term.length === 2),
        ...entries.filter(([term]) => term.length > 2).slice(0, 24)
    ].map(([term]) => term);
}

function makeSnippet(text, term, max = 72) {
    const body = cleanInsightText(text);
    const idx = body.toLowerCase().indexOf(String(term).toLowerCase());
    if (idx < 0) return body.slice(0, max);
    const start = Math.max(0, idx - 22);
    const end = Math.min(body.length, idx + term.length + 34);
    return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}

function recordLabel(type) {
    return TYPE_LABEL[type] || '记录';
}

function normalizeRecords(records) {
    const out = [];
    for (const raw of records || []) {
        if (!raw) continue;
        const text = cleanInsightText([raw.title, raw.text || raw.content].filter(Boolean).join(' '));
        if (text.length < 8) continue;
        const at = Number(raw.at) || parseRecordMs(raw.created_at) || parseRecordMs(raw.date);
        if (!at) continue;
        out.push({ type: raw.type || 'feed', id: raw.id, text, at, tags: Array.isArray(raw.tags) ? raw.tags : [] });
    }
    return out;
}

function pickEvidence(records, term, nowMs, limit = 4) {
    const byMonth = new Map();
    for (const record of records) {
        const key = monthKey(record.at);
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push(record);
    }
    const chosen = [];
    for (const key of [...byMonth.keys()].sort()) {
        const bucket = byMonth.get(key).sort((a, b) => a.at - b.at);
        chosen.push(bucket[bucket.length - 1]);
    }
    if (chosen.length > limit) {
        const stride = (chosen.length - 1) / (limit - 1);
        const sampled = [];
        for (let i = 0; i < limit; i++) sampled.push(chosen[Math.round(i * stride)]);
        chosen.splice(0, chosen.length, ...sampled);
    }
    return chosen.map((record) => ({
        type: record.type,
        label: recordLabel(record.type),
        id: record.id,
        date: cstYmd(record.at),
        ageDays: Math.max(0, Math.floor((nowMs - record.at) / DAY_MS)),
        snippet: makeSnippet(record.text, term),
        unfinished: UNFINISHED_RE.test(record.text)
    }));
}

/**
 * 核心聚类。records 可来自 D1、Bot 候选或测试；返回按「时间跨度 × 反复次数 × 未完感」排序的线索。
 */
export function buildRecurringThreads(records, options = {}) {
    const nowMs = Number(options.nowMs) || Date.now();
    const limit = Math.min(Math.max(Number(options.limit) || INSIGHT_LIMIT_DEFAULT, 1), INSIGHT_LIMIT_MAX);
    const normalized = normalizeRecords(records);
    if (normalized.length < 2) return [];

    const termMap = new Map();
    normalized.forEach((record, index) => {
        for (const term of extractInsightTerms([record.title, record.text, record.tags.join(' ')].filter(Boolean).join(' '))) {
            if (!termMap.has(term)) termMap.set(term, new Set());
            termMap.get(term).add(index);
        }
    });

    const candidates = [];
    for (const [term, indexes] of termMap) {
        const support = [...indexes].map(i => normalized[i]).sort((a, b) => a.at - b.at);
        if (support.length < 2) continue;
        const months = new Set(support.map(r => monthKey(r.at)));
        if (months.size < INSIGHT_MIN_MONTHS) continue;
        const spanDays = Math.floor((support[support.length - 1].at - support[0].at) / DAY_MS);
        if (spanDays < INSIGHT_MIN_SPAN_DAYS) continue;
        const evidence = pickEvidence(support, term, nowMs);
        const unfinished = evidence.some(item => item.unfinished);
        const recent = (nowMs - support[support.length - 1].at) <= 60 * DAY_MS;
        const score = months.size * 5 + support.length * 2 + (unfinished ? 4 : 0) + (recent ? 3 : 0) + Math.min(spanDays / 30, 6);
        const firstPos = support.reduce((min, record) => {
            const idx = record.text.indexOf(term);
            return idx >= 0 && idx < min ? idx : min;
        }, Number.MAX_SAFE_INTEGER);
        candidates.push({
            topic: term,
            count: support.length,
            months: months.size,
            spanDays,
            firstAt: cstYmd(support[0].at),
            lastAt: cstYmd(support[support.length - 1].at),
            unfinished,
            recent,
            score,
            firstPos,
            evidence,
            _indexes: new Set(indexes)
        });
    }

    candidates.sort((a, b) => b.score - a.score || b.topic.length - a.topic.length || a.firstPos - b.firstPos || b.spanDays - a.spanDays || b.count - a.count || a.topic.localeCompare(b.topic));
    const selected = [];
    for (const candidate of candidates) {
        if (selected.length >= limit) break;
        const overlap = selected.some((other) => {
            const shared = [...candidate._indexes].filter(i => other._indexes.has(i)).length;
            return shared >= Math.min(candidate._indexes.size, other._indexes.size);
        });
        const nested = selected.some((other) => other.topic.includes(candidate.topic) || candidate.topic.includes(other.topic));
        if (overlap || nested) continue;
        selected.push(candidate);
    }

    return selected.map((candidate) => ({
        id: 'thread-' + fnv1a(candidate.topic),
        topic: candidate.topic,
        summary: `${candidate.months} 个月里出现过 ${candidate.count} 次，最近一次是 ${candidate.lastAt}。`,
        count: candidate.count,
        months: candidate.months,
        spanDays: candidate.spanDays,
        firstAt: candidate.firstAt,
        lastAt: candidate.lastAt,
        unfinished: candidate.unfinished,
        evidence: candidate.evidence
    }));
}

function limitParam(value, fallback, max) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
}

/** 给 Bot 主动关怀用的线索候选：把线索变成可被 pickCandidate 消费的形状。 */
export function buildThreadCandidates(candidates, nowMs = Date.now(), limit = 3) {
    return buildRecurringThreads((candidates || []).map(c => ({ type: c.type, id: c.id, text: c.body, at: c.atMs })), { limit, nowMs })
        .map(thread => ({
            type: 'thread', kind: '线索', id: thread.id, topic: thread.topic,
            body: thread.summary, evidence: thread.evidence, unfinished: thread.unfinished,
            atMs: parseRecordMs(thread.firstAt + ' 00:00:00'),
            ageDays: Math.max(0, Math.floor((nowMs - parseRecordMs(thread.firstAt + ' 00:00:00')) / DAY_MS))
        }));
}

/** GET /api/insights/threads?days=180&limit=6（只返回短句证据，不返回全文） */
export async function handleInsightThreads(url, db, userId) {
    const days = limitParam(url.searchParams.get('days'), INSIGHT_DAYS_DEFAULT, INSIGHT_DAYS_MAX);
    const limit = limitParam(url.searchParams.get('limit'), INSIGHT_LIMIT_DEFAULT, INSIGHT_LIMIT_MAX);
    const since = '-' + days + ' days';
    const [feeds, notes, weeklies] = await Promise.all([
        db.prepare("SELECT id, content, tags, created_at, updated_at FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 AND datetime(updated_at) >= datetime('now', '+8 hours', ?2) ORDER BY updated_at DESC, id DESC LIMIT 240").bind(userId, since).all(),
        db.prepare("SELECT id, title, content, date, created_at, updated_at FROM notes WHERE user_id = ?1 AND is_deleted = 0 AND datetime(updated_at) >= datetime('now', '+8 hours', ?2) ORDER BY updated_at DESC, id DESC LIMIT 240").bind(userId, since).all(),
        db.prepare("SELECT id, title, summary, content, date, created_at, updated_at FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 AND datetime(updated_at) >= datetime('now', '+8 hours', ?2) ORDER BY updated_at DESC, id DESC LIMIT 160").bind(userId, since).all()
    ]);
    const records = [];
    for (const row of (feeds && feeds.results) || []) {
        let tags = [];
        try { tags = JSON.parse(row.tags || '[]'); } catch (_) { tags = []; }
        records.push({ type: 'feed', id: row.id, text: row.content, tags, at: parseRecordMs(row.created_at) || parseRecordMs(row.updated_at) });
    }
    for (const row of (notes && notes.results) || []) {
        records.push({ type: 'note', id: row.id, title: row.title, text: row.content, at: parseRecordMs(row.date) || parseRecordMs(row.created_at) || parseRecordMs(row.updated_at) });
    }
    for (const row of (weeklies && weeklies.results) || []) {
        records.push({ type: 'weekly', id: row.id, title: row.title, text: [row.summary, row.content].filter(Boolean).join(' '), at: parseRecordMs(row.date) || parseRecordMs(row.created_at) || parseRecordMs(row.updated_at) });
    }
    return jsonResponse({ success: true, threads: buildRecurringThreads(records, { limit, nowMs: Date.now() }), scanned: records.length, days }, 200);
}

/** POST /api/reminders：把线索转成明晚的微信提醒（复用定点提醒的通道与上限） */
export async function handleInsightReminder(request, db, userId) {
    const parsed = await readJsonCapped(request, 2048);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
    const body = parsed.value || {};
    const created = await createReminderAt(db, userId, body.text, Number(body.fire_at_ms), Date.now());
    if (!created.ok) return jsonResponse({ error: created.reply }, 400);
    return jsonResponse({
        success: true,
        reply: created.reply,
        reminder: { id: created.id, text: created.text, fire_at_ms: created.fireAtMs }
    }, 201);
}
