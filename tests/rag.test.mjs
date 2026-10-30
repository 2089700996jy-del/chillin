import test from 'node:test';
import assert from 'node:assert/strict';
import {
    tokenizeQuery,
    parseTimeRangeFromQuestion,
    parseDateToYmd,
    extractItemDate,
    scoreMemoryChunk
} from '../workers/src/rag.js';
import { formatPrompt } from '../workers/src/garden-shared.js';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import { retrieveGardenMemories } from '../workers/src/rag.js';
import { handleAiChat } from '../workers/src/ai.js';
import { handleAiReview } from '../workers/src/garden-echo.js';
import { moderateText, callCustomLlm, callCustomLlmWithMessages } from '../workers/src/llm.js';

test('RAG - tokenizeQuery extracts keywords and filters stopwords', () => {
    const tokens = tokenizeQuery('请问关于代码重构和深色模式有哪些想法呢？');
    assert.ok(tokens.includes('代码'));
    assert.ok(tokens.includes('重构'));
    assert.ok(tokens.includes('模式'));
    // Stopwords should be excluded
    assert.ok(!tokens.includes('请问'));
    assert.ok(!tokens.includes('关于'));
    assert.ok(!tokens.includes('哪些'));
});

test('RAG - parseTimeRangeFromQuestion recognizes natural date queries', () => {
    const tYesterday = parseTimeRangeFromQuestion('昨天我写了什么');
    assert.ok(tYesterday && tYesterday.label === '昨天');

    const tBeforeYesterday = parseTimeRangeFromQuestion('前天记录了什么');
    assert.ok(tBeforeYesterday && tBeforeYesterday.label === '前天');

    const tThisWeek = parseTimeRangeFromQuestion('本周的工作总结');
    assert.ok(tThisWeek && tThisWeek.label === '本周');

    const tThisWeekVar = parseTimeRangeFromQuestion('这一周的心情');
    assert.ok(tThisWeekVar && tThisWeekVar.label === '本周');

    const tLastWeek1 = parseTimeRangeFromQuestion('上一周我做了什么');
    assert.ok(tLastWeek1 && tLastWeek1.label === '上周');

    const tLastWeek2 = parseTimeRangeFromQuestion('上个星期的周记');
    assert.ok(tLastWeek2 && tLastWeek2.label === '上周');

    const tLastMonth = parseTimeRangeFromQuestion('上个月看过的书');
    assert.ok(tLastMonth && tLastMonth.label === '上个月');
});

test('RAG - parseDateToYmd and extractItemDate correctly normalize all date formats', () => {
    assert.equal(parseDateToYmd('2026年6月26日'), '2026-06-26');
    assert.equal(parseDateToYmd('2026年10月13日'), '2026-10-13');
    assert.equal(parseDateToYmd('2026.6.26'), '2026-06-26');
    assert.equal(parseDateToYmd('2026/06/26'), '2026-06-26');
    assert.equal(parseDateToYmd('2026-6-26'), '2026-06-26');
    assert.equal(parseDateToYmd('2023-W42: 记忆切片'), '2023-10-16');

    // extractItemDate 各种资产真实格式提取
    assert.equal(extractItemDate({ date: '2026年6月26日' }), '2026-06-26');
    assert.equal(extractItemDate({ title: '2026.6.26 — PO8测试' }), '2026-06-26');
    assert.equal(extractItemDate({ title: '2023-W42: 记忆切片' }), '2023-10-16');
    assert.equal(extractItemDate({ created_at: '2026-10-06 15:30:00' }), '2026-10-06');
});

const integration = sqliteTest;
integration('RAG - recently edited older records stay in the bounded candidate window', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    for (let id = 1; id <= 61; id += 1) {
        const content = id === 1 ? '代码重构的关键想法' : `普通记录 ${id}`;
        const updated = id === 1 ? '2026-10-16 12:00:00' : `2026-09-${String(30 - Math.floor(id / 3)).padStart(2, '0')} 12:00:00`;
        await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
            VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 0)`)
            .bind(id, `笔记 ${id}`, content, updated.slice(0, 10), updated, updated).run();
    }

    const result = await retrieveGardenMemories(db, 1, '代码重构');
    assert.ok(result.sources.some((source) => source.type === '笔记' && source.id === 1));
});

integration('RAG - 全历史候选：旧记录不因最近的 300 条而被挤出', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    for (let id = 2; id <= 301; id += 1) {
        const updated = '2026-10-20 12:00:00';
        await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
            VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 0)`)
            .bind(id, `普通笔记 ${id}`, `最近的生活记录 ${id}`, '2026-10-20', updated, updated).run();
    }
    await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
        VALUES (1, 1, '模型迁移记录', '当时想换模型：deepseek-chat 太慢，换成了 deepseek-flash。', '2026-08-01', '2026-08-01 12:00:00', '2026-08-01 12:00:00', 0)`).run();

    const result = await retrieveGardenMemories(db, 1, '我之前为什么想换模型');
    assert.ok(result.sources.some(source => source.type === '笔记' && source.id === 1), '旧记录必须从全历史候选里被找回');
});

integration('RAG - wikilink 关联把没有命中关键词的目标记忆带进上下文', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
        VALUES (100, 1, '换模型的理由', '当时觉得 deepseek-chat 太慢，细节记在 [[迁移记录]]。', '2026-08-02', '2026-08-02 12:00:00', '2026-08-02 12:00:00', 0)`).run();
    await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
        VALUES (101, 1, '迁移记录', 'deepseek-flash 更快，价格也合适，适合日常闲聊。', '2026-08-02', '2026-08-02 12:00:00', '2026-08-02 12:00:00', 0)`).run();

    const result = await retrieveGardenMemories(db, 1, '为什么想换模型');
    const target = result.sources.find(source => source.type === '笔记' && source.id === 101);
    assert.ok(target, 'wikilink 目标必须被关联召回');
    assert.equal(target.related, true);
    assert.match(result.contextText, /关联：链接「迁移记录」/);
});

integration('RAG - 软删后 FTS 触发器同步移除索引，旧内容不再被召回', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
        VALUES (200, 1, '临时记忆', '独特记忆碎片只在这里出现。', '2026-09-01', '2026-09-01 12:00:00', '2026-09-01 12:00:00', 0)`).run();
    const ftsBefore = await db.prepare("SELECT source_id FROM memory_fts WHERE memory_fts MATCH '\"独特记忆\"'").all();
    assert.ok(ftsBefore.results.some(row => Number(row.source_id) === 200), '触发器必须把新笔记同步进 FTS5');
    assert.ok((await retrieveGardenMemories(db, 1, '独特记忆')).sources.some(source => source.id === 200));

    await db.prepare('UPDATE notes SET is_deleted = 1 WHERE id = 200').run();
    const ftsAfter = await db.prepare("SELECT source_id FROM memory_fts WHERE memory_fts MATCH '\"独特记忆\"'").all();
    assert.equal(ftsAfter.results.length, 0, '软删后 FTS 触发器必须移除索引行');
    const after = await retrieveGardenMemories(db, 1, '独特记忆');
    assert.ok(!after.sources.some(source => source.id === 200), '软删行必须同时从 LIKE 与 FTS 候选里消失');
});
test('RAG - scoreMemoryChunk accurately ranks matching garden chunks', () => {
    const promptItem = {
        type: '提示词',
        id: 301,
        title: '[开发/代码] 代码重构与审查专家',
        body: '深度审查代码质量，找出性能与安全性隐患并重构\n{{输入代码}}',
        date: '2026-09-12'
    };

    const unrelatedItem = {
        type: '随手记',
        id: 1,
        title: '',
        body: '今天去吃了一碗非常棒的意面，秋高气爽。',
        date: '2026-09-12'
    };

    const weeklyItem = {
        type: '周记',
        id: 42,
        title: '换环境 最近心情还不错',
        body: '下班麻木但下班后非常快乐，做了一个职业生涯规划的决定。',
        date: '2026年10月06日'
    };

    const tokens = tokenizeQuery('代码重构');
    const scorePrompt = scoreMemoryChunk(promptItem, tokens, null);
    const scoreUnrelated = scoreMemoryChunk(unrelatedItem, tokens, null);

    assert.ok(scorePrompt > 0, 'Prompt item should have positive match score');
    assert.equal(scoreUnrelated, -1, 'Unrelated item with no keyword hits should return -1');
    assert.ok(scorePrompt > scoreUnrelated);

    // 验证中文日期的周记可以在时间范围过滤下成功命中并得分
    const timeRange = { label: '上周', start: '2026-10-05', end: '2026-10-11' };
    const scoreWeekly = scoreMemoryChunk(weeklyItem, tokenizeQuery('心情 规划'), timeRange);
    assert.ok(scoreWeekly > 0, 'Weekly item with Chinese date should match within timeRange');
});
integration('AI chat - 空问题 / 超长问题 / 非法 JSON 都被拦在模型调用之前', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const post = (body) => new Request('https://x/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });

    assert.equal((await handleAiChat(post({ question: '   ' }), {}, db, 1)).status, 400, '空问题应拒绝');
    assert.equal((await handleAiChat(post({ question: 'x'.repeat(4001) }), {}, db, 1)).status, 400, '超过 4000 字应拒绝');
    assert.equal((await handleAiChat(post('{bad json'), {}, db, 1)).status, 400, '非法 JSON 应拒绝');
});

integration('Garden Echo - 近期没有记录时给出友好回复而不是空跑模型', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    const res = await handleAiReview({}, db, 1);

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.reply, /这一周还没有新的记录/, '空窗口应直接返回引导语，不调用模型');
});

integration('Garden Echo - 无 LLM 凭证时降级为本地摘要（窗口内的记录必须被取到）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    // 造一条「本周」的记录：date 用东八区当天，created_at 也用东八区，
    // 两者任一条命中窗口即可（garden-echo 的窗口条件是 OR）
    await db.prepare(
        "INSERT INTO notes (id, title, content, date, user_id, created_at, updated_at) " +
        "VALUES (7001, '本周的笔记', '关于边缘计算的一点想法', date('now', '+8 hours'), 1, datetime('now', '+8 hours'), datetime('now', '+8 hours'))"
    ).run();

    const res = await handleAiReview({}, db, 1);

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.reply, /本周回顾（本地摘要）/, '没有 LLM 凭证时应降级为本地摘要而不是报错');
    assert.match(body.reply, /本周的笔记/, '窗口内的记录必须出现在摘要里');
});

test('LLM 合规 - 硬违规词直接拒绝输出', () => {
    const r = moderateText('这里包含赌博相关的内容', {});
    assert.equal(r.ok, false, '硬违规词必须触发拒绝');
    assert.equal(r.text, '', '拒绝时不得回传原文');
});

test('LLM 合规 - 软广词打码而不是整段拒绝', () => {
    const r = moderateText('想赚钱就加微信详聊', {});
    assert.equal(r.ok, true, '软广词不应误杀正常对话');
    assert.doesNotMatch(r.text, /加微信/, '软广词必须被打码');
    assert.match(r.text, /\*{4}/, '打码占位符应是 ****');
});

test('LLM 合规 - 空文本与正常文本都不误伤', () => {
    assert.deepEqual(moderateText('', {}), { ok: true, text: '' });
    const normal = '今天读了《人月神话》，想清楚了沟通成本这件事';
    assert.deepEqual(moderateText(normal, {}), { ok: true, text: normal }, '正常内容必须原样通过');
});

test('LLM 合规 - 政治敏感词表由 env 注入，未配置时不误伤', () => {
    const word = '中性示例词';
    assert.equal(moderateText('包含' + word, {}).ok, true, '未配置词表时不应拦截');
    assert.equal(moderateText('包含' + word, { MODERATION_POLITICAL_WORDS: word }).ok, false, '配置词表后必须拦截');
});

test('LLM - 没有任何凭证时安静返回空串（上层据此降级为本地摘要）', async () => {
    assert.equal(await callCustomLlm({}, 'system', 'user'), '', '无凭证必须返回空串而不是抛错');
    assert.equal(await callCustomLlmWithMessages({}, []), '');
});
