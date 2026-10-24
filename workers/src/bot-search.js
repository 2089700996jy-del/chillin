/**
 * 检索上游适配层（v2.5.149）：从 bot-web.js 拆出来，只干「怎么问上游、怎么读回包」这一件事。
 *
 * 为什么要单独一个模块：bot-web.js 曾长到 503 行（AGENTS 规约 `workers/src/*` ≤500 行），而它内部
 * 本来就有两条清楚的缝——① 上游协议（端点推导、鉴权、请求体、应答解析）；② 闸门 + 合成 + 缓存 +
 * 回复组装。这一段只依赖 fetch，不碰 D1、不碰提示词、不碰存储，最容易单独演进与单测。
 *
 * 上游是 **DeepSeek 官方 Search API**（v2.5.146 起）：POST https://api.deepseek.com/v1/tools/search，
 * 复用同一把 LLM_API_KEY（零新增密钥）。2026-10-24 边缘实测：320–420ms、单次约 2–4 KB，每条结果自带
 * summary（600–800 字，给模型读）、date、authority 与 rerank_score。
 * v2.5.149 起请求带 need_content：网页正文（赛程表/比分这类事实只在正文里）随包回来——实测 8 条约
 * 50 KB，耗时几乎不变（485ms → 524ms）；只给 summary 时，遇到表格页就会退化成「只看到标题」。
 * v2.5.150 起支持多检索词并行（runWebSearchMulti）：自然语言问句直接丢给上游常常只能捞到新闻，
 * 「76人下次比赛是什么时间」在 2026-10-24 就退化成「只有虎扑赛程表的标题」；改由 bot-web.js 先规划 1–3 条
 * 关键词再并行搜、按 rerank_score 合并去重后，同一句话命中直播吧的赛程正文（10月25日主场雄鹿 / 10月26日活塞）。
 * 相对时间在检索端没有语境（上游不知道「现在」是哪天），所以 dateHints 把能确定的日期并进查询词：
 * 2026-10-24 实测「76人 赛程 10月24日 10月25日」直接命中官方赛程页，而「这周 周六 周日 76人」只捞到新闻。
 *
 * Jina 保留为回落：SEARCH_PROVIDER=jina 显式指定，或 SEARCH_API_URL 指向自建/第三方「路径拼查询词」的
 * GET 端点时自动沿用旧逻辑（老配置零迁移）。
 *
 * 解析纪律：JSON 形状但解析失败（回包被上限截断）→ 直接返回空数组，绝不掉进 markdown 兜底——那样会
 * 造出一条「标题是整段 JSON」的假来源喂给模型（2026-10-24 实测）。
 */

/** 默认检索端点（DeepSeek 官方 Search API：POST + JSON） */
export const WEB_SEARCH_DEFAULT_URL = 'https://api.deepseek.com/v1/tools/search';
/** Jina Search 端点（回落用：GET + 路径拼接查询词） */
export const JINA_SEARCH_DEFAULT_URL = 'https://s.jina.ai';
/** DeepSeek Search 文档规定 query / ori_question 上限 128 字符，超了先截断再发 */
export const WEB_SEARCH_QUERY_MAX_CHARS = 128;
/**
 * 客户端上限：DeepSeek Search 实测 330–530ms（need_content 几乎不加耗时），12s 已是 20 倍余量。
 * v2.5.150 起从 20s 收到 12s：一轮 cron 收信预算 55s，加上检索词规划 4s 与合成 20s 必须留出余量。
 */
export const WEB_SEARCH_TIMEOUT_MS = 12000;

/** 应答体积上限：no-content 模式实测只有约 3 KB；这里只是防上游失控（全文模式单次 600–750 KB，旧值 512 KB 会把 JSON 拦腰截断） */
export const WEB_SEARCH_MAX_BYTES = 1024 * 1024;
export const WEB_SEARCH_RESULTS = 8;
/** 一次问答最多并行搜几条检索词（规划出来的变体）；再多只是重复付费 */
export const WEB_SEARCH_MAX_QUERIES = 3;

/** 单条来源正文上限：need_content 会把网页正文一起带回来（实测 0.5–10 KB/条），截到 3000 字留事实、丢噪声 */
export const WEB_SNIPPET_MAX_CHARS = 3000;

/** 正文短到这个长度以下当导航残渣，宁可回落到 summary */
export const WEB_CONTENT_MIN_CHARS = 200;

function searchEndpoint(base, query) {
    const clean = String(base || JINA_SEARCH_DEFAULT_URL).replace(/\s+/g, '');
    const trimmed = clean.replace(/\/+$/, '');
    const q = encodeURIComponent(query);
    return trimmed.includes('?') ? trimmed + '&q=' + q : trimmed + '/' + q;
}

async function readBodyCapped(res, maxBytes) {
    if (!res || !res.body || !res.body.getReader) {
        const text = await res.text();
        return String(text || '').slice(0, maxBytes);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    let total = 0;
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value ? chunk.value.byteLength : 0;
        out += decoder.decode(chunk.value || new Uint8Array(), { stream: true });
        if (total > maxBytes) break;
    }
    out += decoder.decode();
    return out;
}

function cleanText(raw, maxChars) {
    const text = String(raw || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ')
        .trim();
    return text.slice(0, maxChars);
}

function parseTextPayload(text) {
    const items = [];
    for (const block of String(text || '').split(/\n{2,}/)) {
        const urlMatch = block.match(/https?:\/\/[^\s)>\]]+/);
        if (!urlMatch) continue;
        const titleLine = block.split('\n').map((l) => l.trim()).find((l) => l
            && !/^https?:\/\//.test(l)
            && !/^(Title|URL|URL Source|Published Time|Markdown Content)\s*:/i.test(l));
        items.push({ title: titleLine || '', url: urlMatch[0], snippet: block });
    }
    return items;
}

/** 选喂给模型的那段文本：正文够长就用正文，否则回落到 summary / snippet（短正文常常只是导航残渣） */
function pickSnippet(it) {
    const content = String(it.content || '').trim();
    if (content.length >= WEB_CONTENT_MIN_CHARS) return content;
    return it.summary || content || it.snippet || it.description || it.text || '';
}

/** 解析上游应答（JSON 优先，退回 markdown 文本），统一成 {title,url,snippet} */
export function parseSearchPayload(body) {
    const text = String(body || '').trim();
    let items = [];
    const looksJson = text.startsWith('{') || text.startsWith('[');
    if (looksJson) {
        try {
            const json = JSON.parse(text);
            const data = Array.isArray(json) ? json : (json.data || json.results || []);
            items = (Array.isArray(data) ? data : []).map((it) => ({
                title: it.title || '',
                url: it.url || '',
                // DeepSeek Search 带 need_content 时 content 是网页正文（赛程表/比分这种事实只在这里）；
                // 正文太短才回落到给模型读的 summary（600–800 字），再回落到给 UI 的 snippet。
                // Jina 等旧形态仍按 description → content → text 回落。结果本身已按 rerank_score 从高到低排。
                snippet: pickSnippet(it),
                site: it.site_name || it.site || '',
                date: dateInEast8(it.date || it.published_time || ''),
                // 相关性分（DeepSeek 的 rerank_score）：多查询合并时用它决定谁进最终 8 条
                score: Number(it.rerank_score || it.score || 0) || 0
            }));
        } catch (err) {
            // 半截 JSON（回包被截断）绝不能掉进下面的 markdown 解析：那样会把 JSON 片段当成
            // 「标题 + 摘要」喂给模型（2026-10-24 实测：截断后只解析出 1 条假来源，标题是整段 JSON）。
            // 宁可当没有来源，让上层诚实地说「没搜到」。
            return [];
        }
    }
    if (!items.length && !looksJson) items = parseTextPayload(text);
    const seen = new Set();
    const out = [];
    for (const it of items) {
        const url = String(it.url || '').trim();
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        out.push({
            title: cleanText(it.title, 120) || url,
            url: url.slice(0, 300),
            snippet: cleanText(it.snippet, WEB_SNIPPET_MAX_CHARS),
            site: cleanText(it.site, 60),
            date: String(it.date || '').slice(0, 10),
            score: Number(it.score || 0) || 0
        });
        if (out.length >= WEB_SEARCH_RESULTS) break;
    }
    return out;
}

/** 上游时间戳（RFC3339，可能是 UTC 午夜）换算成东八区日期——否则 2026-10-22T16:00:00Z 会被读成 10-22 */
function dateInEast8(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return '';
    return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 选上游：显式 SEARCH_PROVIDER 优先；否则看 SEARCH_API_URL——
 * 指向「路径拼查询词」的 GET 端点（自建 / Jina）时沿用旧逻辑，其余一律 DeepSeek 官方 Search。
 */
export function resolveSearchProvider(env) {
    const forced = String((env && env.SEARCH_PROVIDER) || '').trim().toLowerCase();
    if (forced === 'jina' || forced === 'deepseek') return forced;
    const url = String((env && env.SEARCH_API_URL) || '').trim();
    if (url && !url.includes('/tools/search')) return 'jina';
    return 'deepseek';
}

/** DeepSeek Search 地址：优先显式 SEARCH_API_URL，否则从 LLM_API_BASE 推（缺 /v1 时补上，避免拼成 /tools/search） */
function deepseekSearchUrl(env) {
    const explicit = String((env && env.SEARCH_API_URL) || '').trim();
    if (explicit.includes('/tools/search')) return explicit.replace(/\/+$/, '');
    let base = String((env && env.LLM_API_BASE) || WEB_SEARCH_DEFAULT_URL).trim().replace(/\/+$/, '');
    if (base.includes('/tools/search')) return base;
    if (!/v[0-9]+$/.test(base)) base += '/v1';
    return base + '/tools/search';
}

/** 两把钥匙各归各家：DeepSeek 复用 LLM_API_KEY，Jina 回落 LINK_READER_API_KEY（都可被 SEARCH_API_KEY 覆盖） */
function searchKey(env, provider) {
    const fallback = provider === 'deepseek' ? env && env.LLM_API_KEY : env && env.LINK_READER_API_KEY;
    return String((env && env.SEARCH_API_KEY) || fallback || '').trim();
}

/** 调上游检索；失败返回 {ok:false, reason}，绝不抛给上层 */
export async function runWebSearch(env, query, fetchImpl = fetch, oriQuestion = '') {
    const provider = resolveSearchProvider(env);
    const key = searchKey(env, provider);
    if (!key) return { ok: false, reason: 'no-key' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WEB_SEARCH_TIMEOUT_MS);
    try {
        let res;
        if (provider === 'deepseek') {
            // 相对时间问句在检索端是没有语境的：上游不知道「现在」是哪天，只按字面匹配网页。
            // 所以把能确定的日期并进查询词——2026-10-24 实测「76人 赛程 10月24日 10月25日」直接命中
            // 官方赛程页，而「这周 周六 周日 76人」只捞到新闻。解析不出就一个字不加。
            const hints = dateHints(oriQuestion || query, Date.now()).join(' ');
            const queryText = [String(query || '').trim(), hints].filter(Boolean).join(' ');
            const body = {
                query: queryText.slice(0, WEB_SEARCH_QUERY_MAX_CHARS),
                count: WEB_SEARCH_RESULTS,
                // 网页正文（实测每条 0.5–10 KB、总耗时几乎不变）：赛程表、比分这类事实只在正文里，
                // 只靠 600 字的 summary，遇到表格页就会退化成「检索结果只有标题，没法确认」。
                need_content: true
            };
            // ori_question 帮上游理解「这周六」这类指代：给用户原话，不给清洗后的查询词。
            const ori = String(oriQuestion || '').trim().slice(0, WEB_SEARCH_QUERY_MAX_CHARS);
            if (ori) body.ori_question = ori;
            res = await fetchImpl(deepseekSearchUrl(env), {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer ' + key,
                    'User-Agent': 'ChillinBot/1.0'
                },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
        } else {
            const url = searchEndpoint(env && env.SEARCH_API_URL, query);
            res = await fetchImpl(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: 'Bearer ' + key,
                    'x-api-key': key,
                    // 只要标题+摘要：Jina 的全文模式会为每条结果抓取渲染网页（实测 600–750 KB、耗时 2–15s 抖动，
                    // 15s 上限下经常整条超时）；摘要里已带着「Sat, 10 …」这类事实，且回包只有约 3 KB / 约 2.5s。
                    // X-Timeout 交给上游自己设服务端死线，双保险。
                    'X-Respond-With': 'no-content',
                    'X-Timeout': '10',
                    'User-Agent': 'ChillinBot/1.0'
                },
                signal: ctrl.signal
            });
        }
        if (!res.ok) return { ok: false, reason: 'http-' + res.status };
        const sources = parseSearchPayload(await readBodyCapped(res, WEB_SEARCH_MAX_BYTES));
        if (!sources.length) return { ok: false, reason: 'empty' };
        return { ok: true, sources, provider };
    } catch (err) {
        return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 把「今天 / 明天 / 这周六」解析成具体日期（东八区），并进检索词。
 * 只认能确定的指代：解析不出返回空数组，绝不给上游塞猜出来的日期。
 */
export function dateHints(text, nowMs) {
    const t = String(text || '');
    const base = new Date((Number(nowMs) || Date.now()) + 8 * 3600 * 1000);
    const day = (n) => new Date(base.getTime() + n * 86400000).toISOString().slice(0, 10);
    const wd = base.getUTCDay();
    const seen = [];
    const push = (v) => { if (v && seen.indexOf(v) === -1) seen.push(v); };
    if (/今天|今日|今晚/.test(t)) push(day(0));
    if (/明天|明日|明晚|次日/.test(t)) push(day(1));
    if (/昨天|昨日/.test(t)) push(day(-1));
    if (/周末|周[六6]|星期[六6]/.test(t)) push(day((6 - wd + 7) % 7));
    if (/周末|周[日天]|星期[日天]/.test(t)) push(day((0 - wd + 7) % 7));
    return seen.slice(0, 3);
}

/**
 * 多检索词并行搜索（v2.5.150）：一条查询打不中就再没有机会，所以规划出 1–3 条一起搜，
 * 按 URL 去重、按 rerank_score 排序后取前 WEB_SEARCH_RESULTS 条。
 * 部分查询失败不影响整体（只要有一条成功就给结果）；全部失败时把第一条的原因带回去。
 */
export async function runWebSearchMulti(env, queries, fetchImpl = fetch, oriQuestion = '') {
    const list = [];
    const seen = new Set();
    for (const raw of (Array.isArray(queries) ? queries : [queries])) {
        const q = String(raw || '').trim();
        if (!q || seen.has(q)) continue;
        seen.add(q);
        list.push(q);
        if (list.length >= WEB_SEARCH_MAX_QUERIES) break;
    }
    if (!list.length) return { ok: false, reason: 'empty' };
    const results = await Promise.all(list.map((q) => runWebSearch(env, q, fetchImpl, oriQuestion)));
    const okOnes = results.filter((r) => r && r.ok);
    if (!okOnes.length) return { ok: false, reason: (results[0] && results[0].reason) || 'empty' };
    const byUrl = new Map();
    for (const r of okOnes) {
        for (const s of r.sources) {
            const prev = byUrl.get(s.url);
            if (!prev || Number(s.score || 0) > Number(prev.score || 0)) byUrl.set(s.url, s);
        }
    }
    const sources = [...byUrl.values()]
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, WEB_SEARCH_RESULTS);
    if (!sources.length) return { ok: false, reason: 'empty' };
    return { ok: true, sources, provider: okOnes[0].provider, queries: list };
}
