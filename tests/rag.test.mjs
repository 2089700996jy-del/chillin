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
import { createTestDb, seedUser, sqliteAvailable } from './fake-d1.mjs';
import { retrieveGardenMemories } from '../workers/src/rag.js';

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

const integration = sqliteAvailable ? test : test.skip;
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
