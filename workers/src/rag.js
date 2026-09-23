/**
 * RAG (Retrieval-Augmented Generation) & Memory Retrieval Module
 * Handles time-range parsing, query tokenization, corpus extraction (feeds, notes, weeklies, bookmarks, prompts),
 * memory chunk scoring, and history topic inheritance for follow-up questions.
 */

export const RAG_STOPWORDS = new Set([
    '的', '了', '呢', '吗', '啊', '呀', '么', '吧', '就', '都', '也', '和', '与', '或',
    '在', '是', '有', '我', '你', '他', '她', '它', '们', '这', '那', '什么', '怎么',
    '为什么', '如何', '关于', '一下', '一些', '还是', '但是', '如果', '因为', '所以',
    '可以', '会', '能', '要', '到', '从', '上', '中', '下', '内', '被', '把', '让',
    '给', '对', '为', '及', '等', '着', '过', '嘛', '嗯', '哈', '请问', '帮我',
    '看看', '说说', '讲讲', '总结', '最近', '有没有', '哪些', '哪个', '这些', '那些'
]);

export function east8NowParts(base = new Date()) {
    const utc = base.getTime() + base.getTimezoneOffset() * 60000;
    const east8 = new Date(utc + 8 * 3600000);
    return {
        y: east8.getFullYear(),
        m: east8.getMonth(), // 0-11
        d: east8.getDate(),
        date: east8
    };
}

export function pad2(n) {
    return String(n).padStart(2, '0');
}

export function ymd(y, m0, d) {
    return `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
}

export function parseTimeRangeFromQuestion(question) {
    const q = String(question || '');
    const { y, m, d, date } = east8NowParts();
    if (/上个月|上月/.test(q)) {
        const prev = new Date(y, m - 1, 1);
        const last = new Date(y, m, 0);
        return {
            label: '上个月',
            start: ymd(prev.getFullYear(), prev.getMonth(), 1),
            end: ymd(last.getFullYear(), last.getMonth(), last.getDate())
        };
    }
    if (/本月|这个月/.test(q)) {
        const last = new Date(y, m + 1, 0);
        return { label: '本月', start: ymd(y, m, 1), end: ymd(y, m, last.getDate()) };
    }
    if (/上周|上星期/.test(q)) {
        const day = date.getDay() || 7;
        const end = new Date(date);
        end.setDate(d - day);
        const start = new Date(end);
        start.setDate(end.getDate() - 6);
        return {
            label: '上周',
            start: ymd(start.getFullYear(), start.getMonth(), start.getDate()),
            end: ymd(end.getFullYear(), end.getMonth(), end.getDate())
        };
    }
    if (/本周|这周|这个星期/.test(q)) {
        const day = date.getDay() || 7;
        const start = new Date(date);
        start.setDate(d - day + 1);
        return {
            label: '本周',
            start: ymd(start.getFullYear(), start.getMonth(), start.getDate()),
            end: ymd(y, m, d)
        };
    }
    if (/昨天/.test(q)) {
        const yest = new Date(date);
        yest.setDate(d - 1);
        const s = ymd(yest.getFullYear(), yest.getMonth(), yest.getDate());
        return { label: '昨天', start: s, end: s };
    }
    if (/今天|今日/.test(q)) {
        const s = ymd(y, m, d);
        return { label: '今天', start: s, end: s };
    }
    if (/今年/.test(q)) {
        return { label: '今年', start: `${y}-01-01`, end: `${y}-12-31` };
    }
    if (/去年/.test(q)) {
        return { label: '去年', start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    }
    const ym = q.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (ym) {
        const yy = Number(ym[1]);
        const mm = Number(ym[2]) - 1;
        const last = new Date(yy, mm + 1, 0);
        return {
            label: `${yy}年${mm + 1}月`,
            start: ymd(yy, mm, 1),
            end: ymd(yy, mm, last.getDate())
        };
    }
    const yOnly = q.match(/(\d{4})\s*年/);
    if (yOnly && !/月/.test(q)) {
        const yy = Number(yOnly[1]);
        return { label: `${yy}年`, start: `${yy}-01-01`, end: `${yy}-12-31` };
    }
    return null;
}

export function tokenizeQuery(question) {
    const text = String(question || '').toLowerCase();
    const tokens = new Set();
    for (const m of text.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(m[0]);
    const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of cjkRuns) {
        if (run.length >= 2 && !RAG_STOPWORDS.has(run)) tokens.add(run);
        for (let i = 0; i < run.length - 1; i++) {
            const bi = run.slice(i, i + 2);
            if (!RAG_STOPWORDS.has(bi)) tokens.add(bi);
        }
        for (let i = 0; i < run.length - 2; i++) {
            tokens.add(run.slice(i, i + 3));
        }
    }
    return [...tokens].filter(t => t && t.length >= 2);
}

export function extractItemDate(item) {
    const raw = item.date || item.created_at || item.updated_at || '';
    const m = String(raw).match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
}

export function scoreMemoryChunk(item, tokens, timeRange) {
    const dateStr = extractItemDate(item);
    if (timeRange) {
        if (!dateStr) return -1;
        if (dateStr < timeRange.start || dateStr > timeRange.end) return -1;
    }
    const title = String(item.title || '');
    const body = String(item.body || '');
    const hayTitle = title.toLowerCase();
    const hayBody = body.toLowerCase();
    let score = 0;
    let hits = 0;
    for (const t of tokens) {
        if (hayTitle.includes(t)) { score += 4; hits += 1; }
        if (hayBody.includes(t)) { score += 2; hits += 1; }
    }
    if (tokens.length > 0 && hits === 0) {
        return -1; // 有主题词时必须命中，避免不相关日记被灌进上下文
    }
    if (timeRange) score += 3;
    // 轻微偏好更新近的内容
    if (dateStr) {
        const ageDays = Math.max(0, (Date.now() - Date.parse(dateStr + 'T00:00:00+08:00')) / 86400000);
        score += Math.max(0, 2 - ageDays / 180);
    }
    return score;
}

export async function retrieveGardenMemories(db, userId, question, opts = {}) {
    const topK = opts.topK || 8;
    const maxChars = opts.maxChars || 1600;
    let tokens = tokenizeQuery(question);
    const timeRange = parseTimeRangeFromQuestion(question);

    // 多轮对话主题继承：如果是代词短问（如“还有吗”、“详细说说”），且没有独立提取到有效词，从历史提取
    if (tokens.length === 0 && Array.isArray(opts.history) && opts.history.length > 0) {
        const prevUserMessages = opts.history.filter(h => h && h.role === 'user' && typeof h.content === 'string');
        if (prevUserMessages.length > 0) {
            const lastUserMsg = prevUserMessages[prevUserMessages.length - 1].content;
            const inheritedTokens = tokenizeQuery(lastUserMsg);
            if (inheritedTokens.length > 0) {
                tokens = inheritedTokens;
            }
        }
    }

    // 并行拉取全域记忆资产（含随手记、笔记、周记、收藏以及新增的提示词库）
    const [feedsRes, notesRes, weekliesRes, bookmarksRes, promptsRes] = await Promise.all([
        db.prepare('SELECT id, content, created_at, updated_at, tags FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 100').bind(userId).all(),
        db.prepare('SELECT id, title, content, date, created_at, updated_at FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 60').bind(userId).all(),
        db.prepare('SELECT id, title, summary, content, date, created_at, updated_at FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 60').bind(userId).all(),
        db.prepare('SELECT id, title, description, url, created_at, updated_at FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 60').bind(userId).all(),
        db.prepare('SELECT id, title, project, scene, content, description, tags, created_at, updated_at FROM prompts WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 60').bind(userId).all()
    ]);

    const corpus = [];
    for (const f of (feedsRes.results || [])) {
        let tagText = '';
        try { tagText = Array.isArray(JSON.parse(f.tags || '[]')) ? JSON.parse(f.tags || '[]').join(' ') : ''; } catch (_) {}
        corpus.push({
            type: '随手记',
            id: f.id,
            title: '',
            body: `${f.content || ''} ${tagText}`.trim(),
            date: f.created_at || f.updated_at || '',
            created_at: f.created_at,
            updated_at: f.updated_at
        });
    }
    for (const n of (notesRes.results || [])) {
        corpus.push({
            type: '笔记',
            id: n.id,
            title: n.title || '',
            body: n.content || '',
            date: n.date || n.created_at || n.updated_at || '',
            created_at: n.created_at,
            updated_at: n.updated_at
        });
    }
    for (const w of (weekliesRes.results || [])) {
        corpus.push({
            type: '周记',
            id: w.id,
            title: w.title || '',
            body: `${w.summary || ''}\n${w.content || ''}`.trim(),
            date: w.date || w.created_at || w.updated_at || '',
            created_at: w.created_at,
            updated_at: w.updated_at
        });
    }
    for (const b of (bookmarksRes.results || [])) {
        corpus.push({
            type: '收藏',
            id: b.id,
            title: b.title || '',
            body: `${b.description || ''} ${b.url || ''}`.trim(),
            date: b.created_at || b.updated_at || '',
            created_at: b.created_at,
            updated_at: b.updated_at
        });
    }
    for (const p of (promptsRes.results || [])) {
        corpus.push({
            type: '提示词',
            id: p.id,
            title: `[${p.project || '通用'}/${p.scene || '场景'}] ${p.title || ''}`,
            body: `${p.description || ''}\n${p.content || ''}\n${p.tags || ''}`.trim(),
            date: p.created_at || p.updated_at || '',
            created_at: p.created_at,
            updated_at: p.updated_at
        });
    }

    const ranked = corpus
        .map(item => ({ ...item, score: scoreMemoryChunk(item, tokens, timeRange) }))
        .filter(item => item.score >= 0)
        .sort((a, b) => b.score - a.score || Number(b.id || 0) - Number(a.id || 0));

    // 无关键词且无时间：不要倾倒全文，只取少量最近片段并标明
    let selected = ranked.slice(0, topK);
    if (tokens.length === 0 && !timeRange) {
        selected = corpus
            .slice()
            .sort((a, b) => String(extractItemDate(b)).localeCompare(String(extractItemDate(a))))
            .slice(0, Math.min(5, topK))
            .map(item => ({ ...item, score: 0 }));
    }

    if (selected.length === 0) {
        return {
            tokens,
            timeRange,
            sources: [],
            contextText: '（未检索到与问题匹配的记忆片段。请如实告知用户没有找到相关记录，不要编造。）'
        };
    }

    const sources = [];
    const blocks = [];
    let used = 0;
    selected.forEach((item, idx) => {
        const dateLabel = extractItemDate(item) || '未知日期';
        const titlePart = item.title ? ` · ${item.title}` : '';
        const snippet = String(item.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const header = `[${idx + 1}] ${item.type}${titlePart} · ${dateLabel}`;
        const block = `${header}\n${snippet}`;
        if (used + block.length > maxChars && blocks.length > 0) return;
        blocks.push(block);
        used += block.length + 1;
        sources.push({
            type: item.type,
            id: item.id,
            date: dateLabel,
            title: item.title || '',
            snippet: snippet.slice(0, 80),
            score: Math.round(item.score * 10) / 10
        });
    });

    return {
        tokens,
        timeRange,
        sources,
        contextText: blocks.join('\n\n')
    };
}

export function generateFallbackReply(question, contextText) {
    if (!contextText || contextText.trim().length === 0 || contextText.includes('未检索到')) {
        return `我在您的记忆花园里没有检索到与「${question}」直接相关的片段。可以换个关键词，或先在随手记/笔记里多记下一些想法。`;
    }
    const lines = contextText.split('\n').filter(Boolean);
    return `针对您的提问 **“${question}”**，系统检索到以下相关记忆片段：\n\n` +
        lines.slice(0, 8).map(l => l.startsWith('[') ? `\n### ${l}` : l).join('\n') +
        `\n\n*(当前处于离线模式或大模型接口配置中，以上为记忆库直接检索汇总)*`;
}
