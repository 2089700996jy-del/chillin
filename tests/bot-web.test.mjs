/**
 * 联网检索（v2.5.143）：分类闸门 + 上游解析 + 端到端（含缓存与日配额）。
 * v2.5.149 起：请求带 need_content（正文优先于 summary）、相对时间问句并进具体日期。
 *
 * 这一能力的风险不对称：多发一次检索只花一次额度，但把「我记过的那个想法」交给搜索引擎，
 * 等于把第二大脑降级成搜索引擎。所以用例盯的是**别乱发**，而不是多发。
 * 上游与模型全部注入替身，用例完全离线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import {
    wantsWebSearch,
    extractWebQuery,
    composeWebReply,
    sourcesFootnote,
    stripSourcesFootnote,
    webFailureText,
    maybeWebAnswer,
    WEB_CACHE_TTL_MS,
    WEB_DAILY_LIMIT,
    WEB_BURST_LIMIT,
    WEB_ANSWER_TIMEOUT_MS,
    WEB_QUERY_PLAN_TIMEOUT_MS,
    parseQueryLines
} from '../workers/src/bot-web.js';
import {
    parseSearchPayload,
    runWebSearch,
    dateHints,
    runWebSearchMulti,
    WEB_SEARCH_TIMEOUT_MS,
    WEB_SEARCH_MAX_QUERIES
} from '../workers/src/bot-search.js';

const NOW = Date.parse('2026-10-23T12:19:00+00:00');
const SEARCH_JSON = JSON.stringify({
    data: [
        { title: 'NBA 赛程', url: 'https://sports.example/nba', description: '<b>76 人今晚 19:30 主场</b>' },
        { title: '另一条', url: 'https://news.example/x', content: '补充说明' }
    ]
});

/** 检索替身：记录 URL 与 init，返回 JSON；可指定失败形态 */
function searchStub(mode = 'ok') {
    const calls = [];
    const inits = [];
    const impl = async (url, init) => {
        calls.push(String(url));
        inits.push(init || {});
        if (mode === 'http-403') return new Response('{}', { status: 403 });
        if (mode === 'empty') return new Response('[]', { status: 200 });
        if (mode === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        return new Response(SEARCH_JSON, { status: 200 });
    };
    return { impl, calls, inits };
}

function webEnv() {
    const said = [];
    return {
        env: {
            SEARCH_API_KEY: 'search-key',
            AI: { run: async (model, opts) => { said.push(opts.messages); return { response: '76 人今晚 19:30 主场迎战，是常规赛。' }; } }
        },
        said
    };
}

test('联网 - 三档分类：显式检索、时效性问句、闲聊与花园线索', () => {
    assert.equal(wantsWebSearch('帮我查一下今天NBA76人有比赛吗'), true);
    assert.equal(wantsWebSearch('今天有比赛吗'), true);
    assert.equal(wantsWebSearch('最近有什么新电影上映吗'), true);
    assert.equal(wantsWebSearch('上网搜一下明天的天气'), true);
    assert.equal(wantsWebSearch('北京现在几点了'), true, '「几点」这类此刻外部事实才算');
    assert.equal(wantsWebSearch('我今天有点累'), false, '「今天」不是问题就不该上网');
    assert.equal(wantsWebSearch('晚上吃什么'), false);
    assert.equal(wantsWebSearch('我上周记的那个想法是什么'), false, '花园线索一出现就强制走本地');
    assert.equal(wantsWebSearch('花园里我写过关于咖啡的吗'), false);
    assert.equal(wantsWebSearch('搜 咖啡'), false, '「搜」是花园检索指令，不是上网');
    // 2026-10-24 线上：这句落在闸门外，走聊天路径复述了上一轮的旧来源，看着像检索结果
    assert.equal(wantsWebSearch('查看一下76人下次比赛是什么时间'), true, '「查看一下」+「下次/比赛」+「什么时间」必须放行');
    assert.equal(wantsWebSearch('查看一下今天天气怎么样'), true);
    assert.equal(wantsWebSearch(''), false);
});

test('联网 - 检索词清洗去掉「帮我查一下」噪声', () => {
    assert.equal(extractWebQuery('帮我查一下今天NBA76人有比赛吗'), '今天NBA76人有比赛吗');
    assert.equal(extractWebQuery('今天有比赛吗'), '今天有比赛吗');
    assert.equal(extractWebQuery('今天有比赛吗 帮我查一下'), '今天有比赛吗');
    assert.equal(extractWebQuery('查一下'), '查一下', '只剩下噪声时原样返回，交给上游去空搜');
    assert.equal(extractWebQuery('查看一下76人下次比赛是什么时间'), '76人下次比赛是什么时间');
});

test('联网 - 解析上游应答：JSON 与 markdown 两种形态、去重、只留 http(s)', () => {
    const json = parseSearchPayload(JSON.stringify({
        data: [
            { title: 'A', url: 'https://a.example/1', description: '<b>你好</b>' },
            { title: 'B', url: 'https://a.example/1', description: '重复的' },
            { title: 'C', url: 'notaurl', description: '丢弃' },
            { url: 'https://c.example/3', description: '无标题就用 URL 当标题' }
        ]
    }));
    assert.deepEqual(json.map((it) => it.url), ['https://a.example/1', 'https://c.example/3']);
    assert.equal(json[0].title, 'A');
    assert.equal(json[0].snippet, '你好', 'HTML 标签要剥掉');
    assert.equal(json[1].title, 'https://c.example/3');

    const text = parseSearchPayload('Title: 赛程\nURL Source: https://sports.example/nba\nMarkdown Content: 76 人 19:30 主场\n\n'
        + 'Title: 另一条\nURL Source: https://news.example/x\nMarkdown Content: 内容');
    assert.deepEqual(text.map((it) => it.url), ['https://sports.example/nba', 'https://news.example/x']);
    assert.match(text[0].snippet, /76 人 19:30 主场/);

    assert.deepEqual(parseSearchPayload(''), []);
    assert.deepEqual(parseSearchPayload('{ 坏掉的 json'), [], '解析不了就当没有来源，绝不编');
});

test('联网 - 回包被截断（半截 JSON）时必须当没有来源，绝不把 JSON 片段当标题摘要', () => {
    // 2026-10-24 线上实测：全文模式回包 618–728 KB，被 512 KB 上限拦腰截断 → JSON.parse 失败
    // → 旧逻辑掉进 markdown 兜底 → 只解析出 1 条「来源」，title/snippet 就是整段 JSON 碎片。
    const full = JSON.stringify({
        code: 200,
        data: [{
            title: 'Philadelphia 76ers Schedule',
            url: 'https://sports.example/nba',
            description: 'Regular Season home Saturday Oct 24 7:30 PM EDT. Sunday Oct 25 6:00 PM EDT.'
        }]
    });
    const truncated = full.slice(0, Math.floor(full.length * 0.7));
    assert.ok(truncated.includes('https://sports.example/nba'), '构造的截断样本要含 URL：' + truncated);
    assert.throws(() => JSON.parse(truncated), '样本必须是坏 JSON');
    assert.deepEqual(parseSearchPayload(truncated), [], '半截 JSON 只能当没有来源');
    assert.deepEqual(parseSearchPayload(full).map((it) => it.url), ['https://sports.example/nba'], '完整 JSON 照常解析');
});

test('联网 - 上游失败分类：无密钥 / 无结果 / HTTP 错误 / 超时', async () => {
    const noKey = await runWebSearch({}, '今天有比赛吗', searchStub().impl);
    assert.deepEqual(noKey, { ok: false, reason: 'no-key' });

    const empty = await runWebSearch({ SEARCH_API_KEY: 'k' }, '今天有比赛吗', searchStub('empty').impl);
    assert.deepEqual(empty, { ok: false, reason: 'empty' });

    const forbidden = await runWebSearch({ SEARCH_API_KEY: 'k' }, '今天有比赛吗', searchStub('http-403').impl);
    assert.deepEqual(forbidden, { ok: false, reason: 'http-403' });

    const aborted = await runWebSearch({ SEARCH_API_KEY: 'k' }, '今天有比赛吗', searchStub('abort').impl);
    assert.deepEqual(aborted, { ok: false, reason: 'timeout' });

    const ok = await runWebSearch({ SEARCH_API_KEY: 'k' }, '今天有比赛吗', searchStub('ok').impl);
    assert.equal(ok.ok, true);
    assert.equal(ok.sources.length, 2);
});

test('联网 - 检索走 GET 且带令牌，链接复用只做拼接', async () => {
    const st = searchStub();
    await runWebSearch({ SEARCH_API_KEY: 'k', SEARCH_API_URL: 'https://s.jina.ai' }, '今天 76 人有比赛吗', st.impl);
    assert.equal(st.calls.length, 1);
    assert.ok(st.calls[0].startsWith('https://s.jina.ai/'), st.calls[0]);
    assert.ok(st.calls[0].includes(encodeURIComponent('今天 76 人有比赛吗')));
});

test('联网 - 上游请求要摘要模式（no-content）并交给上游设超时，避免全文渲染拖到整条超时', async () => {
    const st = searchStub();
    await runWebSearch({ SEARCH_API_KEY: 'k', SEARCH_API_URL: 'https://s.jina.ai' }, '今天 76 人有比赛吗', st.impl);
    const headers = st.inits[0].headers;
    assert.equal(headers['X-Respond-With'], 'no-content', '全文模式实测 618-728 KB / 2-15s 抖动；摘要模式约 3 KB / 2.5s 且已含事实');
    assert.equal(headers['X-Timeout'], '10', '上游自己也要设服务端死线');
    assert.equal(headers.Authorization, 'Bearer k');
    assert.equal(headers['x-api-key'], 'k');
});

test('联网 - 默认上游是 DeepSeek 官方 Search：POST + JSON 体 + 复用 LLM_API_KEY', async () => {
    const st = searchStub();
    await runWebSearch({ LLM_API_KEY: 'sk-1' }, '今天 76 人有比赛吗', st.impl, '帮我查一下今天 76 人有比赛吗');
    assert.equal(st.calls.length, 1);
    assert.equal(st.calls[0], 'https://api.deepseek.com/v1/tools/search');
    const init = st.inits[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Authorization, 'Bearer sk-1', '复用同一把 LLM_API_KEY，零新增密钥');
    const body = JSON.parse(init.body);
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    assert.ok(body.query.startsWith('今天 76 人有比赛吗'), body.query);
    assert.ok(body.query.includes(today), '「今天」要并成具体日期再发：检索端没有「现在」是哪天的语境');
    assert.equal(body.count, 8, '取 8 条候选，展示仍只给 3 条');
    assert.equal(body.need_content, true, '要正文：赛程表、比分这类事实只在 content 里，光给 summary 会退化成「只有标题」');
    assert.equal(body.ori_question, '帮我查一下今天 76 人有比赛吗', 'ori_question 给用户原话，帮上游理解「这周六」这类指代');
});

test('联网 - DeepSeek 端点：LLM_API_BASE 缺 /v1 时补上，显式 SEARCH_API_URL 优先且尾斜杠不双拼', async () => {
    const a = searchStub();
    await runWebSearch({ LLM_API_KEY: 'k', LLM_API_BASE: 'https://api.deepseek.com' }, '今天有比赛吗', a.impl);
    assert.equal(a.calls[0], 'https://api.deepseek.com/v1/tools/search');
    const b = searchStub();
    await runWebSearch({ LLM_API_KEY: 'k', LLM_API_BASE: 'https://proxy.example/v1/' }, '今天有比赛吗', b.impl);
    assert.equal(b.calls[0], 'https://proxy.example/v1/tools/search', '尾斜杠不能拼成双斜杠');
    const c = searchStub();
    await runWebSearch({ LLM_API_KEY: 'k', SEARCH_API_URL: 'https://search.example/v1/tools/search' }, '今天有比赛吗', c.impl);
    assert.equal(c.calls[0], 'https://search.example/v1/tools/search');
});

test('联网 - query / ori_question 超过文档上限 128 字符先截断再发', async () => {
    const st = searchStub();
    await runWebSearch({ LLM_API_KEY: 'k' }, 'x'.repeat(200), st.impl, 'y'.repeat(200));
    const body = JSON.parse(st.inits[0].body);
    assert.equal(body.query.length, 128, '文档规定 query 1–128 字符');
    assert.equal(body.ori_question.length, 128);
});

test('联网 - 相对时间问句并进具体日期（东八区）：今天 / 明天 / 这周六周日 / 周末', () => {
    const wed = Date.parse('2026-10-21T04:00:00Z'); // 东八区 2026-10-21 周三 12:00
    assert.deepEqual(dateHints('今天有什么新闻吗', wed), ['2026-10-21']);
    assert.deepEqual(dateHints('明天会下雨吗', wed), ['2026-10-22']);
    assert.deepEqual(dateHints('这周六周日 NBA 有 76 人吗', wed), ['2026-10-24', '2026-10-25']);
    assert.deepEqual(dateHints('周末有什么比赛', wed), ['2026-10-24', '2026-10-25']);
    assert.deepEqual(dateHints('那家店好吃吗', wed), [], '解析不出就一个字都不加，绝不塞猜出来的日期');
});

test('联网 - need_content 的正文优先于 summary，正文太短才回落（短正文多半是导航残渣）', () => {
    const long = 'x'.repeat(300);
    const items = parseSearchPayload(JSON.stringify({
        results: [
            { title: 'A', url: 'https://a.example/1', summary: '摘要甲', content: long },
            { title: 'B', url: 'https://b.example/2', summary: '摘要乙', content: '首页 赛程' }
        ]
    }));
    assert.equal(items.length, 2);
    assert.match(items[0].snippet, /^x+$/, '正文够长就用正文，赛程表这类事实只在这里');
    assert.equal(items[1].snippet, '摘要乙', '正文太短（这里是导航残渣）回落到 summary');
});

test('联网 - 解析 DeepSeek 形状：summary 优先于 snippet，日期换算东八区并带上站点', () => {
    const items = parseSearchPayload(JSON.stringify({
        results: [{
            title: '76 人接下来的赛程',
            url: 'https://news.example/nba',
            snippet: '短摘要（给 UI）',
            summary: '长摘要（给模型读）：10月25日周日主场迎战雄鹿',
            site_name: 'zhibo8.com',
            date: '2026-10-22T16:00:00+00:00',
            authority: 3,
            rerank_score: 2.21
        }]
    }));
    assert.equal(items.length, 1);
    assert.match(items[0].snippet, /10月25日周日/, '给模型读的是 summary，不是给 UI 的 snippet');
    assert.equal(items[0].site, 'zhibo8.com');
    assert.equal(items[0].date, '2026-10-23', 'UTC 午夜 16:00Z 属于次日东八区，不能读成 10-22');
});

test('联网 - Jina 回落：显式 SEARCH_PROVIDER，或 SEARCH_API_URL 指向自建 GET 端点时沿用旧逻辑', async () => {
    const forced = searchStub();
    await runWebSearch({ SEARCH_PROVIDER: 'jina', SEARCH_API_KEY: 'k' }, '今天 76 人有比赛吗', forced.impl);
    assert.ok(forced.calls[0].startsWith('https://s.jina.ai/'), forced.calls[0]);
    assert.equal(forced.inits[0].method, 'GET');
    assert.equal(forced.inits[0].headers['X-Respond-With'], 'no-content');
    assert.equal(forced.inits[0].headers['x-api-key'], 'k', 'Jina 回落用 LINK_READER_API_KEY（此处被 SEARCH_API_KEY 覆盖）');

    const legacy = searchStub();
    await runWebSearch({ SEARCH_API_KEY: 'k', SEARCH_API_URL: 'https://search.example' }, '今天有比赛吗', legacy.impl);
    assert.ok(legacy.calls[0].startsWith('https://search.example/'), '老配置（SEARCH_API_URL 指向 GET 端点）零迁移');
});

test('联网 - 无密钥按各自上游判定：DeepSeek 看 LLM_API_KEY，Jina 看 LINK_READER_API_KEY', async () => {
    assert.deepEqual(await runWebSearch({ SEARCH_PROVIDER: 'deepseek' }, '今天有比赛吗', searchStub().impl), { ok: false, reason: 'no-key' });
    assert.deepEqual(await runWebSearch({ SEARCH_PROVIDER: 'jina' }, '今天有比赛吗', searchStub().impl), { ok: false, reason: 'no-key' });
});

sqliteTest('联网 - 站点与东八区日期随来源进合成提示词，模型才能判断新鲜度', async () => {
    const db = createTestDb();
    await seedUser(db, 6);
    const said = [];
    const env = {
        SEARCH_API_KEY: 'k',
        AI: { run: async (model, opts) => { said.push(opts.messages); return { response: '10月25日周日主场打雄鹿。' }; } }
    };
    const stub = async (url, init) => {
        assert.equal(JSON.parse(init.body).ori_question, '查一下这周周六周日NBA有没有76人的比赛', '入口把用户原话传给了上游');
        return new Response(JSON.stringify({
            results: [{
                title: '76 人赛程',
                url: 'https://news.example/nba',
                summary: '10月25日周日，主场迎战雄鹿',
                site_name: 'zhibo8.com',
                date: '2026-10-22T16:00:00+00:00'
            }]
        }), { status: 200 });
    };
    const reply = await maybeWebAnswer(env, db, 6, '查一下这周周六周日NBA有没有76人的比赛', stub, NOW);
    assert.match(reply, /雄鹿/);
    assert.equal(said.length, 1);
    const prompt = said[0][0].content;
    assert.match(prompt, /（zhibo8.com，2026-10-23）/, '站点与东八区日期要进提示词：' + prompt.slice(0, 300));
});

test('联网 - 检索词规划：解析规划结果（剥编号/引号，丢过长与重复）', () => {
    const raw = '1. 76人 下一场比赛 赛程' + String.fromCodePoint(10) + '2. "76ers next game schedule"' + String.fromCodePoint(10)
        + '- 76人 下一场比赛 赛程' + String.fromCodePoint(10) + 'x'.repeat(80) + String.fromCodePoint(10) + '76ers next game schedule';
    assert.deepEqual(parseQueryLines(raw, 3), ['76人 下一场比赛 赛程', '76ers next game schedule'], '编号/引号/项目符号要剥掉，重复与超长丢掉');
    assert.deepEqual(parseQueryLines('', 2), []);
    assert.deepEqual(parseQueryLines('甲' + String.fromCodePoint(10) + '乙' + String.fromCodePoint(10) + '丙', 2), ['甲', '乙'], '最多拿 limit 条变体');
});

test('联网 - 多检索词并行：部分失败不影响整体，同一 URL 留高分副本并排序', async () => {
    const calls = [];
    const impl = async (url, init) => {
        const q = JSON.parse(init.body).query;
        calls.push(q);
        if (q.includes('坏')) return new Response('{}', { status: 500 });
        const rows = q.includes('乙')
            ? [{ title: '乙', url: 'https://b.example/2', rerank_score: 2.5 }, { title: '甲低分副本', url: 'https://a.example/1', rerank_score: 0.4 }]
            : [{ title: '甲', url: 'https://a.example/1', rerank_score: 3.0 }];
        return new Response(JSON.stringify({ results: rows }), { status: 200 });
    };
    const merged = await runWebSearchMulti({ LLM_API_KEY: 'k' }, ['甲', '乙', '坏', '甲', '第四'], impl);
    assert.equal(WEB_SEARCH_MAX_QUERIES, 3);
    assert.equal(merged.ok, true, '一条坏查询不该拖垮整次检索');
    assert.deepEqual(merged.queries, ['甲', '乙', '坏'], '最多 3 条并行，重复的丢掉');
    assert.deepEqual(merged.sources.map((s) => s.url), ['https://a.example/1', 'https://b.example/2'], '按相关性降序');
    assert.equal(merged.sources[0].title, '甲', '同一 URL 保留高分那条（3.0 而不是 0.4）');

    const allFail = await runWebSearchMulti({ LLM_API_KEY: 'k' }, ['坏'], impl);
    assert.deepEqual(allFail, { ok: false, reason: 'http-500' }, '全失败时把原因带回去');
    assert.deepEqual(await runWebSearchMulti({ LLM_API_KEY: 'k' }, [], impl), { ok: false, reason: 'empty' });
});

sqliteTest('联网 - 端到端多查询：规划出关键词变体一起搜，合并去重后交给模型（v2.5.150）', async () => {
    const db = createTestDb();
    await seedUser(db, 9); // 独立用户：内存突发闸按 user_id 共享，别被上面的用例打满
    const planLines = ['76人 下一场比赛 赛程', '76ers next game schedule'].join(String.fromCodePoint(10));
    const synth = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        assert.ok(u.includes('/chat/completions'), '只允许模型调用出站，实际：' + u);
        const body = JSON.parse(init.body);
        const sys = body.messages[0].content;
        if (sys.includes('检索词规划器')) {
            assert.match(body.messages[1].content, /查看一下76人下次比赛是什么时间/, '规划要看用户原话');
            return new Response(JSON.stringify({ choices: [{ message: { content: planLines } }] }), { status: 200 });
        }
        synth.push(body.messages);
        return new Response(JSON.stringify({ choices: [{ message: { content: '10月25日周日主场打雄鹿，10月26日周一主场打活塞。' } }] }), { status: 200 });
    };
    const calls = [];
    const search = async (url, init) => {
        assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
        const q = JSON.parse(init.body).query;
        calls.push(q);
        const rows = /76ers/i.test(q)
            ? [{ title: 'D', url: 'https://d.example/4', rerank_score: 0.5 }, { title: 'C 低分副本', url: 'https://c.example/3', rerank_score: 1.0 }]
            : q.includes('下一场比赛')
                ? [{ title: 'C', url: 'https://c.example/3', rerank_score: 2.5 }, { title: 'A 低分副本', url: 'https://a.example/1', rerank_score: 1.2 }]
                : [{ title: 'A', url: 'https://a.example/1', rerank_score: 3.0 }, { title: 'B', url: 'https://b.example/2', rerank_score: 1.0 }];
        return new Response(JSON.stringify({ results: rows }), { status: 200 });
    };
    let reply = '';
    try {
        reply = await maybeWebAnswer({ LLM_API_KEY: 'sk-plan', SEARCH_API_KEY: 'k' }, db, 9, '查看一下76人下次比赛是什么时间', search, NOW);
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.match(reply, /10月25日周日主场打雄鹿/);
    assert.equal(calls.length, WEB_SEARCH_MAX_QUERIES, '一个原句 + 两条规划变体：' + JSON.stringify(calls));
    assert.ok(calls[0].startsWith('76人下次比赛是什么时间'), calls[0]);
    assert.ok(calls[1].includes('下一场比赛'), calls[1]);
    assert.ok(/76ers/i.test(calls[2]), calls[2]);
    assert.equal(synth.length, 1);
    const prompt = synth[0].map((m) => m.content).join(String.fromCodePoint(10));
    const order = ['https://a.example/1', 'https://c.example/3', 'https://b.example/2', 'https://d.example/4'].map((u) => prompt.indexOf(u));
    assert.ok(order.every((i) => i >= 0), '四条唯一来源都要进提示词：' + JSON.stringify(order));
    assert.deepEqual(order.slice().sort((x, y) => x - y), order, '按相关性排序：' + JSON.stringify(order));
});

test('联网 - 三道超时加起来必须装进一轮收信预算（55s，workers/src/bot-claw.js:47）', () => {
    const sum = WEB_QUERY_PLAN_TIMEOUT_MS + WEB_SEARCH_TIMEOUT_MS + WEB_ANSWER_TIMEOUT_MS;
    assert.equal(Math.max(0, sum - 40000), 0, '规划 ' + WEB_QUERY_PLAN_TIMEOUT_MS + 'ms + 检索 ' + WEB_SEARCH_TIMEOUT_MS + 'ms + 合成 ' + WEB_ANSWER_TIMEOUT_MS + 'ms 若逼近 55s，一次检索就会拖垮整轮 cron 收信');
});

test('联网 - 回复组装：来源最多 3 条；失败文案按原因给下一步', () => {
    const sources = [1, 2, 3, 4, 5].map((i) => ({ title: '来源' + i, url: 'https://s' + i + '.example/x' }));
    const reply = composeWebReply('结论。', sources);
    assert.match(reply, /结论。/);
    assert.match(reply, /来源：/);
    assert.ok(reply.includes('https://s1.example/x') && reply.includes('https://s3.example/x'));
    assert.ok(!reply.includes('https://s4.example/x'), '微信里只给前 3 条，避免糊成链接墙');
    assert.match(composeWebReply('', []), /没能整理出结论/, '合成失败也要给来源列表');

    assert.match(webFailureText('no-key'), /没配检索用的钥匙/);
    assert.match(webFailureText('timeout'), /超时/);
    assert.match(webFailureText('empty'), /换个说法/);
    assert.match(webFailureText('http-403'), /不让我进/);
});

test('联网 - 出处脚注按需：默认剥掉，追问时取出；合成失败时来源就是内容，不许剥成空话', () => {
    const sources = [{ title: '费城 76 人赛程', url: 'https://sports.example/nba' }];
    const full = composeWebReply('10 月 25 日主场打雄鹿。', sources);
    assert.match(full, /来源：/, '缓存里始终存全量，追问时才不必再查一次');

    const foot = sourcesFootnote(full);
    assert.match(foot, /来源：/);
    assert.match(foot, /https:\/\/sports\.example\/nba/);

    const body = stripSourcesFootnote(full);
    assert.equal(body, '10 月 25 日主场打雄鹿。', '默认回复只留结论，实际：' + body);
    assert.equal(sourcesFootnote(body), '', '剥过之后取不到脚注');
    assert.equal(stripSourcesFootnote('纯聊天回复。'), '纯聊天回复。', '没有脚注的回复原样返回');

    const failed = composeWebReply('', sources);
    assert.equal(stripSourcesFootnote(failed), failed, '合成失败时来源就是内容本身，剥离只会剩一句空话');
});

sqliteTest('联网 - 端到端：检索+合成+来源，第二次同一句走缓存不再请求', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const st = searchStub();
    const { env, said } = webEnv();

    const reply = await maybeWebAnswer(env, db, 1, '查一下今天76人有比赛吗', st.impl, NOW);
    assert.match(reply, /76 人今晚 19:30 主场迎战/);
    assert.match(reply, /来源：/);
    assert.ok(reply.includes('https://sports.example/nba'));
    assert.equal(st.calls.length, 1);
    assert.equal(said.length, 1, '合成必须带检索结果走模型');
    const CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const today = CN[new Date(Date.now() + 8 * 3600 * 1000).getUTCDay()];
    assert.ok(said[0][0].content.includes(today), '时间锚点必须带星期（缺了它「这周六」会算错一天）：' + today);
    assert.match(said[0][0].content, /现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[一二三四五六日]（东八区）/);

    const again = await maybeWebAnswer(env, db, 1, '查一下今天76人有比赛吗', st.impl, NOW + 60 * 1000);
    assert.equal(again, reply, '同一句话 6 小时内直接回缓存');
    assert.equal(st.calls.length, 1, '缓存命中不能再花上游额度');

    const row = await db.prepare('SELECT query_key, payload, expires_at_ms, created_at FROM bot_web_cache WHERE user_id = 1').first();
    assert.ok(row, '必须落缓存');
    assert.equal(row.payload, reply);
    assert.equal(row.expires_at_ms, NOW + WEB_CACHE_TTL_MS);
    const created = Date.parse(String(row.created_at).replace(' ', 'T') + '+08:00');
    assert.ok(Math.abs(Date.now() - created) < 120000, 'created_at 应是此刻（东八区）：' + row.created_at);
});

sqliteTest('联网 - 花园问题不触发联网，返回空串交给本地 RAG', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const st = searchStub();
    const { env } = webEnv();

    assert.equal(await maybeWebAnswer(env, db, 1, '我上周记的那个想法是什么', st.impl, NOW), '');
    assert.equal(await maybeWebAnswer(env, db, 1, '晚安', st.impl, NOW), '');
    assert.equal(st.calls.length, 0, '没通过闸门就一次都不许发出站请求');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_web_cache').first()).n, 0);
});

sqliteTest('联网 - 缓存命中不扣额度：同一句话问三次只算一次，换问题才被日上限拦下', async () => {
    const db = createTestDb();
    await seedUser(db, 7);
    const st = searchStub();
    const { env } = webEnv();
    const e = { ...env, WEB_DAILY_LIMIT: 1, WEB_BURST_LIMIT: 0 };
    assert.equal(WEB_DAILY_LIMIT.limit, 100, '默认日上限已从 20 提到 100');

    const first = await maybeWebAnswer(e, db, 7, '今天有比赛吗', st.impl, NOW);
    assert.match(first, /来源：/);
    const second = await maybeWebAnswer(e, db, 7, '今天有比赛吗', st.impl, NOW + 60 * 1000);
    const third = await maybeWebAnswer(e, db, 7, '今天有比赛吗', st.impl, NOW + 120 * 1000);
    assert.equal(second, first, '同一句话直接回缓存');
    assert.equal(third, first);
    assert.equal(st.calls.length, 1, '缓存命中既不出站、也不该扣掉日额度');

    const other = await maybeWebAnswer(e, db, 7, '查一下明天天气怎么样', st.impl, NOW + 180 * 1000);
    assert.match(other, /查得有点多/, '额度只被真正出站的那 1 次用掉，下一个新问题就该被拦：' + other);
    assert.match(other, /上限 1 次/);
    assert.match(other, /搜 关键词/, '被限流时给本地替代路径');
    assert.equal(st.calls.length, 1, '被拦下的请求一次都不许出站');
});

sqliteTest('联网 - 突发闸：同一分钟最多 2 次出站，第 3 次让你等一下（护的是一轮 cron 的 55s）', async () => {
    const db = createTestDb();
    await seedUser(db, 8);
    const st = searchStub();
    const { env } = webEnv();
    const e = { ...env, WEB_DAILY_LIMIT: 100, WEB_BURST_LIMIT: 2 };
    assert.equal(WEB_BURST_LIMIT.limit, 2);

    const r1 = await maybeWebAnswer(e, db, 8, '查一下今天76人有比赛吗', st.impl, NOW);
    const r2 = await maybeWebAnswer(e, db, 8, '查一下明天天气怎么样', st.impl, NOW + 1000);
    const r3 = await maybeWebAnswer(e, db, 8, '查一下昨天晚上比分是多少', st.impl, NOW + 2000);
    assert.match(r1, /来源：/);
    assert.match(r2, /来源：/);
    assert.equal(st.calls.length, 2, '前两次真的出站');
    assert.match(r3, /有点急/, '第 3 次必须被突发闸挡下：' + r3);
    assert.equal(st.calls.length, 2, '挡下的请求不许出站');
});

sqliteTest('联网 - 合成失败也要给来源；检索失败不落缓存', async () => {
    const db = createTestDb();
    // 用独立用户：内存限流桶（rateLimitBuckets）跨用例共享，同一个人会被上一组的 21 次打满
    await seedUser(db, 4);
    const broken = { SEARCH_API_KEY: 'k', AI: { run: async () => { throw new Error('model down'); } } };
    const reply = await maybeWebAnswer(broken, db, 4, '查一下今天76人有比赛吗', searchStub().impl, NOW);
    assert.ok(reply.includes('https://sports.example/nba'), '模型挂了就把来源原样给用户：' + reply);
    assert.match(reply, /没能整理出结论/);

    const st = searchStub('http-403');
    const failed = await maybeWebAnswer(broken, db, 4, '查一下明天天气怎么样', st.impl, NOW);
    assert.match(failed, /不让我进/);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM bot_web_cache WHERE query LIKE '%天气%'").first()).n, 0, '失败结果不进缓存，否则 6 小时内都答不了');
});

sqliteTest('联网 - 模型合成卡住时按死线退化为只给来源，不拖死整轮收信', async () => {
    const db = createTestDb();
    // 独立用户：限流桶按 user_id 在模块内共享，避免被上一组的 21 次打满
    await seedUser(db, 5);
    const env = {
        SEARCH_API_KEY: 'k',
        WEB_ANSWER_TIMEOUT_MS: 40,
        AI: { run: () => new Promise(() => {}) }
    };
    const started = Date.now();
    const reply = await maybeWebAnswer(env, db, 5, '查一下今天76人有比赛吗', searchStub().impl, NOW);
    const elapsed = Date.now() - started;
    assert.ok(reply.includes('https://sports.example/nba'), '超时也要把来源原样给用户：' + reply);
    assert.match(reply, /没能整理出结论/);
    assert.equal(Math.max(0, elapsed - 3000), 0, '死线必须生效，实测 ' + elapsed + 'ms');
});
