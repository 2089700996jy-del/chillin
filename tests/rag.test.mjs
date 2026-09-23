import test from 'node:test';
import assert from 'node:assert/strict';
import {
    tokenizeQuery,
    parseTimeRangeFromQuestion,
    scoreMemoryChunk
} from '../workers/src/rag.js';
import { formatPrompt } from '../workers/src/garden.js';

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

    const tThisWeek = parseTimeRangeFromQuestion('本周的工作总结');
    assert.ok(tThisWeek && tThisWeek.label === '本周');

    const tLastMonth = parseTimeRangeFromQuestion('上个月看过的书');
    assert.ok(tLastMonth && tLastMonth.label === '上个月');
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

    const tokens = tokenizeQuery('代码重构');
    const scorePrompt = scoreMemoryChunk(promptItem, tokens, null);
    const scoreUnrelated = scoreMemoryChunk(unrelatedItem, tokens, null);

    assert.ok(scorePrompt > 0, 'Prompt item should have positive match score');
    assert.equal(scoreUnrelated, -1, 'Unrelated item with no keyword hits should return -1');
    assert.ok(scorePrompt > scoreUnrelated);
});
