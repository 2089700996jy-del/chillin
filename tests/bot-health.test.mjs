/**
 * 健康打卡（v2.5.155，小米运动健康接入的 A 方案）：一句话 → 一天一行的结构化数据。
 *
 * 这套用例盯四个点——
 *   1. 只认显式格式：普通聊天（「健康最重要了」）绝不被劫持成写入，宁可漏记不可错记；
 *   2. 值域与单位：斤折半成公斤、千分位、越界值不静默丢弃而要在回执里点名；
 *   3. 一天一行：同一天两次打卡是合并（只覆盖这次说到的字段），不是新增一行；
 *   4. 东八区日期：「昨晚」归昨天，UTC 深夜算东八区第二天，绝不用 date('now') 算错一天。
 * 全部离线：只碰纯函数与 D1，不出站。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import {
    east8Ymd,
    shiftYmd,
    formatHealthDate,
    formatMinutes,
    resolveHealthDate,
    parseHealthEntry,
    parseHealthCommand,
    saveHealthDaily,
    getHealthRange,
    formatHealthSummary,
    maybeRunHealthCommand,
    HEALTH_REPORT_DAYS,
    HEALTH_RANGES
} from '../workers/src/bot-health.js';

/** 冻结的「现在」：东八区 2026-10-23 20:19 */
const NOW = Date.parse('2026-10-23T12:19:00+00:00');

function assertRecentCst(value, label) {
    const ms = Date.parse(String(value).replace(' ', 'T') + '+08:00');
    assert.ok(Number.isFinite(ms), label + ' 应是可解析的东八区时间戳：' + value);
    assert.ok(Math.abs(Date.now() - ms) < 120000, label + ' 应是此刻（东八区）：' + value);
}

test('健康 - 解析：一句话里能同时认出睡眠、步数、运动、心率、体重', () => {
    const entry = parseHealthEntry('昨晚睡了 6 小时 20 分，走了 12,000 步，中高强度 45 分钟，静息心率 62，体重 68.5 公斤', NOW);
    assert.equal(entry.date, '2026-10-22', '「昨晚」归到昨天（东八区）');
    assert.deepEqual(entry.fields, { sleepMin: 380, steps: 12000, activeMin: 45, restingHr: 62, weightKg: 68.5 });
    assert.deepEqual(entry.rejected, [], '全都在合理范围内');
});

test('健康 - 解析：单位与写法边界（斤折半、只有分钟、小时带小数）', () => {
    assert.deepEqual(parseHealthEntry('体重 130 斤', NOW).fields, { weightKg: 65 }, '1 斤 = 0.5 公斤');
    assert.deepEqual(parseHealthEntry('睡了 45 分钟', NOW).fields, { sleepMin: 45 });
    assert.deepEqual(parseHealthEntry('运动 1.5 小时', NOW).fields, { activeMin: 90 }, '小时要换算成分钟');
    assert.deepEqual(parseHealthEntry('步数 8500', NOW).fields, { steps: 8500 }, '没写「步」只说「步数」也认');
    assert.deepEqual(parseHealthEntry('62 次/分', NOW).fields, { restingHr: 62 });
    assert.equal(parseHealthEntry('今天天气不错', NOW), null, '一个数值都没有就不是打卡');
    assert.equal(parseHealthEntry('我睡了一觉', NOW), null, '「睡了一觉」没有时长，不猜');
});

test('健康 - 越界值不落库，但要在回执里点名', () => {
    const entry = parseHealthEntry('走了 999999 步，心率 300', NOW);
    assert.deepEqual(entry.fields, {}, '越界的一个都不记');
    assert.equal(entry.rejected.length, 2);
    assert.match(entry.rejected.join('、'), /步数/);
    assert.match(entry.rejected.join('、'), /心率/);

    const mixed = parseHealthEntry('走了 9000 步，心率 300', NOW);
    assert.deepEqual(mixed.fields, { steps: 9000 }, '好的照记');
    assert.deepEqual(mixed.rejected, ['心率 300'], '坏的单列出来，不静默吞掉');
    assert.deepEqual(HEALTH_RANGES.restingHr, [30, 220]);
    assert.deepEqual(HEALTH_RANGES.sleepMin, [0, 1440], '一天最多 1440 分钟，再多就是打错了');
});

test('健康 - 指令识别：显式才认，普通聊天不被劫持', () => {
    assert.equal(parseHealthCommand('健康', NOW).kind, 'report');
    assert.equal(parseHealthCommand('我的健康', NOW).kind, 'report');
    assert.equal(parseHealthCommand('健康数据', NOW).kind, 'report');

    const colon = parseHealthCommand('健康：昨晚睡了 6 小时', NOW);
    assert.equal(colon.kind, 'write');
    assert.deepEqual(colon.entry.fields, { sleepMin: 360 });

    const relaxed = parseHealthCommand('健康 8500步', NOW);
    assert.equal(relaxed.matched, true, '没冒号、但真的解析出数值才认');
    assert.deepEqual(relaxed.entry.fields, { steps: 8500 });

    assert.equal(parseHealthCommand('健康最重要了', NOW).matched, false, '聊健康观念不是打卡');
    assert.equal(parseHealthCommand('健康 最重要了', NOW).matched, false, '解析不出数值就还给聊天');
    assert.equal(parseHealthCommand('今天天气不错', NOW).matched, false);
    assert.equal(parseHealthCommand('记录：今天走了 8000 步', NOW).matched, false, '「记录：」走随手记通道，两条不抢');

    const explicit = parseHealthCommand('健康打卡 早上好', NOW);
    assert.equal(explicit.matched, true, '显式指令词即使没有数值也要认领，好把格式告诉他');
    assert.match(explicit.error, /健康数值/);
});

test('健康 - 日期一律东八区：默认今天，昨天/前天各归其位', () => {
    assert.equal(east8Ymd(NOW), '2026-10-23');
    assert.equal(resolveHealthDate('没提日期的', NOW), '2026-10-23');
    assert.equal(resolveHealthDate('昨晚睡了 6 小时', NOW), '2026-10-22');
    assert.equal(resolveHealthDate('前天走了 8000 步', NOW), '2026-10-21');
    assert.equal(shiftYmd('2026-03-01', -1), '2026-02-28', '自然日平移要跨月');
    assert.equal(formatHealthDate('2026-10-23', NOW), '今天');
    assert.equal(formatHealthDate('2026-10-22', NOW), '昨天');
    assert.equal(formatHealthDate('2026-10-21', NOW), '前天');
    assert.equal(formatHealthDate('2026-10-18', NOW), '10月18日');
    assert.equal(formatMinutes(390), '6 小时 30 分');
    assert.equal(formatMinutes(45), '45 分钟');
    assert.equal(east8Ymd(Date.parse('2026-10-23T23:30:00+00:00')), '2026-10-24', 'UTC 深夜就是东八区第二天');
});

sqliteTest('健康 - 一天一行：同一天两次打卡是合并，只覆盖这次说到的字段', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    const first = await saveHealthDaily(db, 1, parseHealthEntry('昨晚睡了 6 小时 20 分', NOW));
    assert.equal(first.date, '2026-10-22');
    assert.equal(first.sleep_min, 380);

    const second = await saveHealthDaily(db, 1, parseHealthEntry('昨晚走了 8500 步', NOW));
    assert.equal(second.steps, 8500, '这次说的步数要写进去');
    assert.equal(second.sleep_min, 380, '上次说的睡眠不能被 null 覆盖');
    assert.equal(second.source, 'manual');

    const count = await db.prepare('SELECT COUNT(*) AS n FROM health_daily WHERE user_id = 1').first();
    assert.equal(count.n, 1, '同一人同一天只有一行');
    const row = await db.prepare('SELECT is_deleted, created_at FROM health_daily WHERE user_id = 1').first();
    assert.equal(row.is_deleted, 0);
    assertRecentCst(row.created_at, 'created_at');
});

sqliteTest('健康 - 汇总：只统计真的记过该字段的天，没记的不按 0 摊', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await saveHealthDaily(db, 1, parseHealthEntry('昨天走了 10000 步，睡了 6 小时', NOW));
    await saveHealthDaily(db, 1, parseHealthEntry('前天走了 5000 步', NOW));

    const rows = await getHealthRange(db, 1, HEALTH_REPORT_DAYS, NOW);
    assert.equal(rows.length, 2);
    const summary = formatHealthSummary(rows, NOW);
    assert.match(summary, /- 昨天：睡眠 6 小时 · 10000 步/);
    assert.match(summary, /- 前天：5000 步/);
    assert.match(summary, /步数日均 7500（2 天有记录）/, '两天都记了步数');
    assert.match(summary, /睡眠日均 6 小时（1 天有记录）/, '只有一天记了睡眠，不拿另一天当 0');
    assert.match(formatHealthSummary([], NOW), /还没有健康记录/);

    await db.prepare("INSERT INTO health_daily (user_id, date, steps) VALUES (1, '2026-09-01', 3000)").run();
    assert.equal((await getHealthRange(db, 1, HEALTH_REPORT_DAYS, NOW)).length, 2, '窗口外的旧数据不进汇总');
});

sqliteTest('健康 - 端到端：写一句 → 回执写清理解到的值 → 发「健康」读得回来', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    const reply = await maybeRunHealthCommand(db, 1, '健康：昨晚睡了 6 小时 20 分，8500 步', NOW);
    assert.match(reply, /记下了 ✅ 昨天：睡眠 6 小时 20 分 · 8500 步/);
    assert.match(reply, /发「健康」能看最近 7 天/);

    const report = await maybeRunHealthCommand(db, 1, '健康', NOW);
    assert.match(report, /健康打卡 · 最近 7 天/);
    assert.match(report, /昨天：睡眠 6 小时 20 分 · 8500 步/);
    assert.match(report, /都是你自己说的/);

    assert.equal(await maybeRunHealthCommand(db, 1, '今天天气不错', NOW), null, '不是指令就还给聊天');
    assert.match(await maybeRunHealthCommand(db, 1, '健康打卡 早上好', NOW), /没读到任何健康数值/);
    const bad = await maybeRunHealthCommand(db, 1, '健康：心率 300', NOW);
    assert.match(bad, /不像真的/);
    assert.match(bad, /心率 300/);
    const after = await db.prepare('SELECT COUNT(*) AS n FROM health_daily WHERE user_id = 1').first();
    assert.equal(after.n, 1, '越界那次没有写库');
});
