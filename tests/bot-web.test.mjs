/**
 * 联网检索（v2.5.143）：分类闸门 + 上游解析 + 端到端（含缓存与日配额）。
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
    parseSearchPayload,
    runWebSearch,
    composeWebReply,
    webFailureText,
    maybeWebAnswer,
    WEB_CACHE_TTL_MS,
    WEB_DAILY_LIMIT,
    WEB_SEARCH_TIMEOUT_MS,
    WEB_ANSWER_TIMEOUT_MS
} from '../workers/src/bot-web.js';

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
    assert.equal(wantsWebSearch(''), false);
});

test('联网 - 检索词清洗去掉「帮我查一下」噪声', () => {
    assert.equal(extractWebQuery('帮我查一下今天NBA76人有比赛吗'), '今天NBA76人有比赛吗');
    assert.equal(extractWebQuery('今天有比赛吗'), '今天有比赛吗');
    assert.equal(extractWebQuery('今天有比赛吗 帮我查一下'), '今天有比赛吗');
    assert.equal(extractWebQuery('查一下'), '查一下', '只剩下噪声时原样返回，交给上游去空搜');
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

test('联网 - 两道超时加起来必须装进一轮收信预算（55s，workers/src/bot-claw.js:47）', () => {
    const sum = WEB_SEARCH_TIMEOUT_MS + WEB_ANSWER_TIMEOUT_MS;
    assert.equal(Math.max(0, sum - 40000), 0, '检索 ' + WEB_SEARCH_TIMEOUT_MS + 'ms + 合成 ' + WEB_ANSWER_TIMEOUT_MS + 'ms 若逼近 55s，一次检索就会拖垮整轮 cron 收信');
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

sqliteTest('联网 - 每人每天上限，超出后明说并给本地替代', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const st = searchStub();
    const { env } = webEnv();

    let last = '';
    for (let i = 0; i <= WEB_DAILY_LIMIT.limit; i++) {
        last = await maybeWebAnswer(env, db, 1, '今天有比赛吗', st.impl, NOW);
    }
    assert.match(last, /查得有点多/, '第 ' + (WEB_DAILY_LIMIT.limit + 1) + ' 次要明说上限：' + last);
    assert.match(last, /搜 关键词/, '被限流时给本地替代路径');
    assert.equal(st.calls.length, 1, '前 20 次里只有第一次真的发了请求，其余命中缓存');
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
