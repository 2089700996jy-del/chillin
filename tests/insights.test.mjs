import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import {
    buildRecurringThreads,
    buildThreadCandidates,
    extractInsightTerms,
    cleanInsightText,
    parseRecordMs,
    handleInsightThreads,
    handleInsightReminder
} from '../workers/src/insights.js';

const integration = sqliteTest;
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 30, 4, 0, 0); // 2026-10-30 12:00 CST

function rec(id, text, daysAgo, type = 'feed') {
    return { type, id, text, at: NOW - daysAgo * DAY };
}

function cstText(ms) {
    return new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

test('Insights - 只从文本里取主题，不把常见虚词当线索', () => {
    const terms = extractInsightTerms('想把阳台改造成书房 #阳台改造 [[书房计划|长期计划]]，最近一直觉得要抽空弄一下。');
    assert.ok(terms.includes('阳台改造'), '显式标签应优先保留');
    assert.ok(terms.includes('书房计划'), '双链目标应成为主题');
    assert.ok(!terms.includes('想把'));
    assert.ok(!terms.includes('最近'));
    assert.equal(cleanInsightText('<p>hello</p> https://example.com/a'), 'hello');
});

test('Insights - 跨三个月反复出现的主题聚成一条线索，并带日期证据', () => {
    const threads = buildRecurringThreads([
        rec(1, '三个月前想把阳台改造成书房，先量一下尺寸。', 100),
        rec(2, '上个月又想到阳台改造，书房采光应该不错。', 60),
        rec(3, '最近还在看阳台改造的案例，要不要继续？', 10)
    ], { nowMs: NOW, limit: 6 });
    assert.equal(threads.length, 1);
    const thread = threads[0];
    assert.match(thread.topic, /阳台/);
    assert.equal(thread.count, 3);
    assert.equal(thread.months, 3);
    assert.equal(thread.evidence.length, 3);
    assert.equal(thread.unfinished, true);
    assert.ok(thread.firstAt < thread.lastAt);
});

test('Insights - 同一天重复不算长期线索，跨月但没有共同主题也不硬凑', () => {
    const sameDay = buildRecurringThreads([
        rec(1, '阳台改造先量尺寸', 2),
        rec(2, '阳台改造先看案例', 2)
    ], { nowMs: NOW });
    assert.equal(sameDay.length, 0);

    const unrelated = buildRecurringThreads([
        rec(1, '今天去修了自行车链条', 90),
        rec(2, '这周想把阳台改造成书房', 40),
        rec(3, '咖啡豆快用完了', 10)
    ], { nowMs: NOW });
    assert.equal(unrelated.length, 0);
});

test('Insights - 线索候选可被 Bot 主动关怀消费，且保留跨时间证据', () => {
    const candidates = [
        { type: 'quick_feeds', id: '1', body: '想做一个自己的播客，先攒选题。', atMs: NOW - 120 * DAY },
        { type: 'quick_feeds', id: '2', body: '播客选题攒了十几条，还是没开始录。', atMs: NOW - 45 * DAY },
        { type: 'quick_feeds', id: '3', body: '今晚又想到播客，要不要先录一期？', atMs: NOW - 5 * DAY }
    ];
    const threads = buildThreadCandidates(candidates, NOW, 3);
    assert.ok(threads.length >= 1);
    assert.equal(threads[0].type, 'thread');
    assert.ok(threads[0].evidence.length >= 2);
    assert.ok(threads[0].ageDays >= 100);
});

test('Insights - 解析东八区日期与中文日期，坏值不猜', () => {
    assert.equal(parseRecordMs('2026-10-30 08:00:00'), Date.UTC(2026, 9, 30, 0, 0, 0));
    assert.equal(parseRecordMs('2026年10月30日'), Date.UTC(2026, 9, 29, 16, 0, 0));
    assert.equal(parseRecordMs('not-a-date'), 0);
});

integration('Insights - 端点只聚合当前用户最近 180 天的记录', async () => {
    const db = await createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);
    const insert = 'INSERT INTO quick_feeds (id, user_id, content, created_at, updated_at, is_deleted) VALUES (?1, ?2, ?3, ?4, ?4, 0)';
    await db.prepare(insert).bind(1, 1, '想把阳台改造成书房，先量尺寸。', cstText(NOW - 100 * DAY)).run();
    await db.prepare(insert).bind(2, 1, '上个月又想到阳台改造，书房采光不错。', cstText(NOW - 60 * DAY)).run();
    await db.prepare(insert).bind(3, 1, '最近还在看阳台改造案例，要不要继续？', cstText(NOW - 10 * DAY)).run();
    await db.prepare(insert).bind(4, 2, '别人的阳台改造记录，不该出现。', cstText(NOW - 20 * DAY)).run();
    await db.prepare(insert).bind(5, 1, '很久以前的阳台改造，超出窗口。', cstText(NOW - 300 * DAY)).run();
    const res = await handleInsightThreads(new URL('https://example.com/api/insights/threads?days=180'), db, 1);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.threads.length >= 1);
    assert.equal(data.threads[0].count, 3);
    assert.ok(data.threads[0].evidence.every(item => item.id <= 3));
});

integration('Insights - 点「明晚提醒」会落成一条 pending 的微信提醒', async () => {
    const db = await createTestDb();
    await seedUser(db, 1);
    await db.prepare("INSERT INTO bot_claw_accounts (user_id, status, bot_token, baseurl, ilink_bot_id, ilink_user_id, cursor, bound_at_ms, is_deleted, outreach_enabled) VALUES (1, 'bound', 't', 'https://ilinkai.weixin.qq.com', 'b', 'u', '', ?1, 0, 1)")
        .bind(NOW - 10 * DAY).run();
    const request = new Request('https://example.com/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '继续想想：阳台改造', fire_at_ms: NOW + DAY })
    });
    const res = await handleInsightReminder(request, db, 1);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    const row = await db.prepare("SELECT text, status FROM bot_reminders WHERE user_id = 1").first();
    assert.equal(row.text, '继续想想：阳台改造');
    assert.equal(row.status, 'pending');
});
