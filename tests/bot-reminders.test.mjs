/**
 * 定点提醒（v2.5.143）：时间解析的纯函数 + D1 状态机。
 *
 * 这是「用户授权的打扰」，与 bot-outreach 的主动关怀是两件事：本套用例盯四个点——
 *   1. 时间解析宁可返回 null 也不猜（猜错要在回执里看得见）；
 *   2. 指令识别不误伤聊天（「我今天提醒我自己要早睡」不是指令）；
 *   3. 到点必达，且普通 10 分钟 / 慢任务 2 小时后追问，失败退避重试；超 2 小时不补发；
 *   4. 幂等：同一分钟跑两次只发一条；发送失败退回 pending。
 * 出站全部走 fetchImpl 替身，用例完全离线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import {
    cnNumber,
    parseReminderTime,
    formatReminderTime,
    cleanReminderText,
    parseRemindCommand,
    isReminderList,
    parseCancelReminder,
    parseDoneReply,
    parseNotYetReply,
    runRemind,
    listReminders,
    cancelReminder,
    recentFiredReminder,
    completeReminder,
    runReminderChecks,
    followUpMsForText,
    skipReminderFollowUp,
    REMINDER_FOLLOW_UP_MS,
    REMINDER_FOLLOW_UP_SLOW_MS,
    REMINDER_FOLLOW_UP_MAX_ATTEMPTS,
    REMINDER_MAX_ACTIVE,
    REMINDER_STALE_MS
} from '../workers/src/bot-reminders.js';

/** 冻结的「现在」：东八区 2026-10-23 20:19 */
const NOW = Date.parse('2026-10-23T12:19:00+00:00');
const cst = (iso) => Date.parse(iso);

async function seedClawAccount(db) {
    await db.prepare(
        "INSERT INTO bot_claw_accounts (user_id, status, bot_token, baseurl, ilink_bot_id, ilink_user_id, cursor, bound_at_ms) "
        + "VALUES (1, 'bound', ?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind('BOT-TOKEN', 'https://ilinkai.weixin.qq.com', 'bot@im.bot', 'owner@im.wechat', 'CURSOR-0', Date.now()).run();
}

/** 记录每一次出站发送；sendClawText 只看 res.ok */
function sentStub(fail = false) {
    const calls = [];
    const impl = async (url, init) => {
        let body = null;
        try { body = JSON.parse(init.body); } catch { body = init.body; }
        calls.push({ url: String(url), body });
        if (fail) throw new Error('sendmessage http 503');
        return new Response('{"ret":0}', { status: 200 });
    };
    return { impl, calls };
}

function assertRecentCst(value, label) {
    const ms = Date.parse(String(value).replace(' ', 'T') + '+08:00');
    assert.ok(Number.isFinite(ms), label + ' 应是可解析的东八区时间戳：' + value);
    assert.ok(Math.abs(Date.now() - ms) < 120000, label + ' 应是此刻（东八区）：' + value);
}

test('提醒 - 中文数字只认时/分范围里的写法', () => {
    assert.equal(cnNumber('8'), 8);
    assert.equal(cnNumber('十'), 10);
    assert.equal(cnNumber('十一'), 11);
    assert.equal(cnNumber('二十三'), 23);
    assert.equal(cnNumber('两'), 2);
    assert.equal(cnNumber('abc'), null);
    assert.equal(cnNumber('二十三点'), null, '带「点」的整句不是数字');
    assert.equal(cnNumber(''), null);
});

test('提醒 - 相对时间：半小时后 / N 小时后 / N 分钟后', () => {
    assert.equal(parseReminderTime('半小时后提醒我', NOW), NOW + 30 * 60 * 1000);
    assert.equal(parseReminderTime('2小时后', NOW), NOW + 2 * 3600 * 1000);
    assert.equal(parseReminderTime('45分钟后', NOW), NOW + 45 * 60 * 1000);
    assert.equal(parseReminderTime('一小时后', NOW), NOW + 3600 * 1000, '中文数字同样识别');
});

test('提醒 - 绝对时刻：今天/明天/早上/晚上/18:00/裸时刻顺延到明天', () => {
    assert.equal(parseReminderTime('今天 21:00', NOW), cst('2026-10-23T21:00:00+08:00'));
    assert.equal(parseReminderTime('明天早上8点', NOW), cst('2026-10-24T08:00:00+08:00'));
    assert.equal(parseReminderTime('晚上9点', NOW), cst('2026-10-23T21:00:00+08:00'), '晚上 9 点 = 21:00');
    assert.equal(parseReminderTime('下午3点', NOW), cst('2026-10-24T15:00:00+08:00'), '今天这个点已经过去，顺延到明天，不许回到过去');
    assert.equal(parseReminderTime('8点30', NOW), cst('2026-10-24T08:30:00+08:00'), '今天已过的裸时刻顺延到明天');
    assert.equal(parseReminderTime('20:00', NOW), cst('2026-10-24T20:00:00+08:00'));
});

test('提醒 - 解析不了或越界一律 null，不猜', () => {
    assert.equal(parseReminderTime('今天 20:00', NOW), null, '今天这个点已经过去了：宁可反问');
    assert.equal(parseReminderTime('25点', NOW), null);
    assert.equal(parseReminderTime('13点70', NOW), null);
    assert.equal(parseReminderTime('交电费', NOW), null);
    assert.equal(parseReminderTime('', NOW), null);
});

test('提醒 - 展示格式：今天 / 明天 / 具体日期', () => {
    assert.equal(formatReminderTime(NOW + 3600 * 1000, NOW), '今天 21:19');
    assert.equal(formatReminderTime(cst('2026-10-24T08:00:00+08:00'), NOW), '明天 08:00');
    assert.equal(formatReminderTime(cst('2026-11-02T09:00:00+08:00'), NOW), '11月2日 09:00');
});

test('提醒 - 内容清洗剥掉时间词与触发词，不误伤正文', () => {
    assert.equal(cleanReminderText('等会6点30记得提醒我给电动牙刷充电'), '给电动牙刷充电');
    assert.equal(cleanReminderText('提醒我20:00给电动牙刷充电'), '给电动牙刷充电');
    assert.equal(cleanReminderText('明天早上8点提醒我交电费'), '交电费');
    assert.equal(cleanReminderText('提醒我拿快递'), '拿快递', '没有时间词也要留下正文');
});

test('提醒 - 指令识别：三条命中路径与三条拒绝路径', () => {
    const direct = parseRemindCommand('提醒我 6:30 充电', NOW);
    assert.equal(direct.matched, true);
    assert.equal(direct.ok, true);
    assert.equal(direct.text, '充电');
    assert.equal(direct.fireAtMs, cst('2026-10-24T06:30:00+08:00'));

    const withDirective = parseRemindCommand('等会6点30记得提醒我给电动牙刷充电', NOW);
    assert.equal(withDirective.matched, true);
    assert.equal(withDirective.text, '给电动牙刷充电');

    const iso = parseRemindCommand('提醒我 明天早上8点 交电费', NOW);
    assert.equal(iso.matched, true);
    assert.equal(iso.text, '交电费');
    assert.equal(iso.fireAtMs, cst('2026-10-24T08:00:00+08:00'));

    assert.equal(parseRemindCommand('我今天提醒我自己要早睡', NOW).matched, false, '叙述句不是指令');
    assert.equal(parseRemindCommand('提醒我妈吃药', NOW).matched, false, '让「我」去提醒第三人，不是让我提醒他');
    assert.equal(parseRemindCommand('晚安', NOW).matched, false);

    const noTime = parseRemindCommand('记得提醒我给电动牙刷充电', NOW);
    assert.equal(noTime.matched, true);
    assert.equal(noTime.ok, false);
    assert.match(noTime.reply, /几点/, '缺时刻要反问，绝不默认随便一个点');

    const noBody = parseRemindCommand('提醒我', NOW);
    assert.equal(noBody.ok, false);
    assert.match(noBody.reply, /做什么/);
});

test('提醒 - 列表/取消/完成/还没 的短语识别', () => {
    assert.equal(isReminderList('我的提醒'), true);
    assert.equal(isReminderList('待办'), true);
    assert.equal(isReminderList('提醒我 6:30 充电'), false);
    assert.deepEqual(parseCancelReminder('取消提醒 2'), { arg: '2' });
    assert.equal(parseCancelReminder('取消提醒').arg, '', '光杆取消也要接住并反问');
    assert.equal(parseCancelReminder('提醒我 6点 充电'), null);
    assert.equal(parseDoneReply('完成'), true);
    assert.equal(parseDoneReply('好了'), true);
    assert.equal(parseDoneReply('还没'), false);
    assert.equal(parseNotYetReply('还没呢'), true);
});

sqliteTest('提醒 - 设提醒落库：回执写清时间、状态 pending、时间戳走东八区', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);

    const reply = await runRemind(db, 1, parseRemindCommand('提醒我 明天早上8点 交电费', NOW), NOW);
    assert.match(reply, /已记下/);
    assert.match(reply, /明天 08:00/);

    const row = await db.prepare('SELECT * FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.status, 'pending');
    assert.equal(row.text, '交电费');
    assert.equal(row.fire_at_ms, cst('2026-10-24T08:00:00+08:00'));
    assert.equal(row.is_deleted, 0);
    assertRecentCst(row.created_at, 'bot_reminders.created_at');
    assertRecentCst(row.updated_at, 'bot_reminders.updated_at');

    const list = await listReminders(db, 1, NOW);
    assert.match(list, /1\. 明天 08:00 — 交电费/);
});

sqliteTest('提醒 - 没绑定通道时先说清送不到，不写库', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const reply = await runRemind(db, 1, parseRemindCommand('提醒我 6:30 充电', NOW), NOW);
    assert.match(reply, /绑定/, '要说清没有通道：' + reply);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_reminders').first()).n, 0);
});

sqliteTest('提醒 - 待提醒攒到上限就拒绝并给出清理路径', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    for (let i = 0; i < REMINDER_MAX_ACTIVE; i++) {
        await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, status, is_deleted) VALUES (1, 1, ?1, ?2, 'pending', 0)")
            .bind('事情' + i, NOW + (i + 1) * 3600 * 1000).run();
    }
    const reply = await runRemind(db, 1, parseRemindCommand('提醒我 6:30 充电', NOW), NOW);
    assert.match(reply, /攒到 20 条/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_reminders').first()).n, REMINDER_MAX_ACTIVE);
});

sqliteTest('提醒 - 列表与按编号取消：只动 pending，一律软删', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    await runRemind(db, 1, parseRemindCommand('提醒我 明天早上8点 交电费', NOW), NOW);
    await runRemind(db, 1, parseRemindCommand('提醒我 6:30 充电', NOW), NOW);

    const list = await listReminders(db, 1, NOW);
    assert.match(list, /1\. 明天 06:30 — 充电/, '列表按时间升序（先到点先编号）：' + list);
    assert.match(list, /2\. 明天 08:00 — 交电费/, '列表按时间升序（先到点先编号）：' + list);

    const cancelled = await cancelReminder(db, 1, '2', NOW);
    assert.match(cancelled, /取消了：明天 08:00 — 交电费/);
    const row = await db.prepare('SELECT status, is_deleted FROM bot_reminders WHERE text = ?1').bind('交电费').first();
    assert.equal(row.status, 'cancelled');
    assert.equal(row.is_deleted, 1, '用户数据只软删，墓碑才能同步到各端');
    assert.match(await listReminders(db, 1, NOW), /1\. 明天 06:30 — 充电/, '取消后重新编号');
    assert.match(await cancelReminder(db, 1, '9', NOW), /没有第 9 条/);
    assert.match(await cancelReminder(db, 1, '交电费', NOW), /没找到待提醒里含/);
});

sqliteTest('提醒 - cron：到点开口带空 context_token，10 分钟后追问一次', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, status, is_deleted) VALUES (1, 1, ?1, ?2, 'pending', 0)")
        .bind('交电费', NOW - 1000).run();

    const st = sentStub();
    const first = await runReminderChecks({}, db, st.impl, { nowMs: NOW });
    assert.deepEqual(first, { due: 1, sent: 1, asked: 0, missed: 0, failed: 0 });
    assert.equal(st.calls.length, 1);
    assert.ok(st.calls[0].url.endsWith('/ilink/bot/sendmessage'));
    assert.match(st.calls[0].body.msg.item_list[0].text_item.text, /⏰ 提醒你：交电费/);
    assert.equal(st.calls[0].body.msg.context_token, '', '主动开口靠空 context_token，v2.5.110 实测可送达');

    let row = await db.prepare('SELECT * FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.status, 'fired');
    assert.equal(row.fired_at_ms, NOW);
    assert.equal(row.follow_up_at_ms, NOW + REMINDER_FOLLOW_UP_MS);
    assert.equal(row.follow_up_ms, REMINDER_FOLLOW_UP_MS);
    assert.equal(row.follow_up_status, 'pending');
    assert.equal(row.follow_up_retry_at_ms, NOW + REMINDER_FOLLOW_UP_MS);
    assert.equal(row.follow_up_attempts, 0);

    // 5 分钟时不该追问；10 分钟到了才追问，且只问一次
    assert.deepEqual(await runReminderChecks({}, db, st.impl, { nowMs: NOW + 5 * 60 * 1000 }),
        { due: 0, sent: 0, asked: 0, missed: 0, failed: 0 });
    const asked = await runReminderChecks({}, db, st.impl, { nowMs: NOW + REMINDER_FOLLOW_UP_MS + 1 });
    assert.deepEqual(asked, { due: 0, sent: 0, asked: 1, missed: 0, failed: 0 });
    assert.equal(st.calls.length, 2);
    assert.match(st.calls[1].body.msg.item_list[0].text_item.text, /做得怎么样了/);
    assert.deepEqual(await runReminderChecks({}, db, st.impl, { nowMs: NOW + REMINDER_FOLLOW_UP_MS + 2 }),
        { due: 0, sent: 0, asked: 0, missed: 0, failed: 0 }, '追问成功后不再重发');

    row = await db.prepare('SELECT status, follow_up_sent, follow_up_status, follow_up_attempts, follow_up_retry_at_ms FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.status, 'fired', '等用户回「完成」之前一直停在 fired');
    assert.equal(row.follow_up_sent, 1);
    assert.equal(row.follow_up_status, 'sent');
    assert.equal(row.follow_up_attempts, 1);
    assert.equal(row.follow_up_retry_at_ms, 0);

    const fired = await recentFiredReminder(db, 1, NOW + REMINDER_FOLLOW_UP_MS);
    assert.equal(fired.text, '交电费');
    assert.equal(await completeReminder(db, 1, fired), true);
    assert.equal(await completeReminder(db, 1, fired), false, '第二次是空操作（幂等）');
    assert.equal(await recentFiredReminder(db, 1, NOW + REMINDER_FOLLOW_UP_MS), null, '完成后不再计入「刚提醒过」');
});

sqliteTest('提醒 - 追问间隔：普通 10 分钟，充电等慢任务 2 小时', async () => {
    assert.equal(REMINDER_FOLLOW_UP_MS, 10 * 60 * 1000);
    assert.equal(followUpMsForText('交电费'), REMINDER_FOLLOW_UP_MS);
    assert.equal(followUpMsForText('给电动车充电'), REMINDER_FOLLOW_UP_SLOW_MS);
    assert.equal(followUpMsForText('炖一锅汤'), REMINDER_FOLLOW_UP_SLOW_MS);

    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    const reply = await runRemind(db, 1, parseRemindCommand('提醒我 明天早上8点 给电动车充电', NOW), NOW);
    assert.match(reply, /已记下/);
    const row = await db.prepare('SELECT follow_up_ms FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.follow_up_ms, REMINDER_FOLLOW_UP_SLOW_MS, '慢任务要在创建时就把 2 小时间隔落库');
});

sqliteTest('提醒 - cron：追问发送失败按退避重试，成功后只发一次', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, status, follow_up_at_ms, follow_up_ms, follow_up_status, follow_up_attempts, follow_up_retry_at_ms, is_deleted) VALUES (1, 1, ?1, ?2, 'fired', ?2, ?3, 'pending', 0, ?2, 0)")
        .bind('交电费', NOW - 1000, REMINDER_FOLLOW_UP_MS).run();

    let calls = 0;
    const flaky = async (url, init) => {
        calls += 1;
        if (calls === 1) throw new Error('sendmessage http 503');
        return new Response('{"ret":0}', { status: 200 });
    };

    const failed = await runReminderChecks({}, db, flaky, { nowMs: NOW });
    assert.deepEqual(failed, { due: 0, sent: 0, asked: 0, missed: 0, failed: 1 });
    let row = await db.prepare('SELECT follow_up_status, follow_up_attempts, follow_up_retry_at_ms, follow_up_sent FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.follow_up_status, 'pending', '发送失败不能标记 sent');
    assert.equal(row.follow_up_attempts, 1);
    assert.equal(row.follow_up_sent, 0);
    assert.equal(row.follow_up_retry_at_ms, NOW + 60 * 1000, '第一次退避 1 分钟');

    assert.deepEqual(await runReminderChecks({}, db, flaky, { nowMs: NOW + 59 * 1000 }),
        { due: 0, sent: 0, asked: 0, missed: 0, failed: 0 }, '未到退避时间不重试');

    const retried = await runReminderChecks({}, db, flaky, { nowMs: row.follow_up_retry_at_ms });
    assert.deepEqual(retried, { due: 0, sent: 0, asked: 1, missed: 0, failed: 0 });
    row = await db.prepare('SELECT follow_up_status, follow_up_attempts, follow_up_retry_at_ms, follow_up_sent FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.follow_up_status, 'sent');
    assert.equal(row.follow_up_attempts, 2);
    assert.equal(row.follow_up_sent, 1);
    assert.equal(row.follow_up_retry_at_ms, 0);
    assert.equal(calls, 2);
});

sqliteTest('提醒 - cron：追问前读不到账号也重试，次数耗尽才 failed', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, status, follow_up_at_ms, follow_up_ms, follow_up_status, follow_up_attempts, follow_up_retry_at_ms, is_deleted) VALUES (1, 1, ?1, ?2, 'fired', ?2, ?3, 'pending', 0, ?2, 0)")
        .bind('交电费', NOW - 1000, REMINDER_FOLLOW_UP_MS).run();

    const st = sentStub();
    const first = await runReminderChecks({}, db, st.impl, { nowMs: NOW });
    assert.deepEqual(first, { due: 0, sent: 0, asked: 0, missed: 0, failed: 1 });
    assert.equal(st.calls.length, 0, '读不到账号时不能假装发出');
    let row = await db.prepare('SELECT follow_up_status, follow_up_attempts, follow_up_retry_at_ms FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.follow_up_status, 'pending');
    assert.equal(row.follow_up_attempts, 1);
    assert.ok(row.follow_up_retry_at_ms > NOW);

    await db.prepare("UPDATE bot_reminders SET follow_up_attempts = ?1, follow_up_retry_at_ms = ?2 WHERE user_id = 1")
        .bind(REMINDER_FOLLOW_UP_MAX_ATTEMPTS, NOW).run();
    const exhausted = await runReminderChecks({}, db, st.impl, { nowMs: NOW });
    assert.deepEqual(exhausted, { due: 0, sent: 0, asked: 0, missed: 0, failed: 1 });
    row = await db.prepare('SELECT follow_up_status, follow_up_retry_at_ms FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.follow_up_status, 'failed');
    assert.equal(row.follow_up_retry_at_ms, 0);
});

sqliteTest('提醒 - 回「还没」会停掉待发追问，但仍可回「完成」', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, fired_at_ms, status, follow_up_at_ms, follow_up_ms, follow_up_status, follow_up_attempts, follow_up_retry_at_ms, is_deleted) VALUES (1, 1, ?1, ?2, ?2, 'fired', ?2, ?3, 'pending', 0, ?2, 0)")
        .bind('交电费', NOW - 1000, REMINDER_FOLLOW_UP_MS).run();

    const fired = await recentFiredReminder(db, 1, NOW);
    assert.equal(await skipReminderFollowUp(db, 1, fired), true);
    const row = await db.prepare('SELECT follow_up_status, follow_up_retry_at_ms FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.follow_up_status, 'skipped');
    assert.equal(row.follow_up_retry_at_ms, 0);

    const st = sentStub();
    const later = await runReminderChecks({}, db, st.impl, { nowMs: NOW + REMINDER_FOLLOW_UP_MS + 1 });
    assert.deepEqual(later, { due: 0, sent: 0, asked: 0, missed: 0, failed: 0 });
    assert.equal(st.calls.length, 0);
    assert.equal(await completeReminder(db, 1, fired), true, '不追问不等于不能完成');
});

sqliteTest('提醒 - cron：超过 2 小时不补发，标 missed 且不发', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, status, is_deleted) VALUES (1, 1, ?1, ?2, 'pending', 0)")
        .bind('给电动牙刷充电', NOW - REMINDER_STALE_MS - 1000).run();

    const st = sentStub();
    const r = await runReminderChecks({}, db, st.impl, { nowMs: NOW });
    assert.deepEqual(r, { due: 1, sent: 0, asked: 0, missed: 1, failed: 0 });
    assert.equal(st.calls.length, 0, '凌晨补一句「该充电了」是伤害不是服务');
    assert.equal((await db.prepare('SELECT status FROM bot_reminders WHERE user_id = 1').first()).status, 'missed');
});

sqliteTest('提醒 - cron：发送失败退回 pending 等下一分钟重试', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, status, is_deleted) VALUES (1, 1, ?1, ?2, 'pending', 0)")
        .bind('给电动牙刷充电', NOW - 1000).run();

    const st = sentStub(true);
    const r = await runReminderChecks({}, db, st.impl, { nowMs: NOW });
    assert.deepEqual(r, { due: 1, sent: 0, asked: 0, missed: 0, failed: 1 });
    const row = await db.prepare('SELECT status, fired_at_ms FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.status, 'pending', '发不出去就退回 pending，下一分钟再试');
    assert.equal(row.fired_at_ms, 0);
});

sqliteTest('提醒 - 幂等：同一分钟跑两次只发一条', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedClawAccount(db);
    await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, status, is_deleted) VALUES (1, 1, ?1, ?2, 'pending', 0)")
        .bind('给电动牙刷充电', NOW - 1000).run();

    const st = sentStub();
    await runReminderChecks({}, db, st.impl, { nowMs: NOW });
    const again = await runReminderChecks({}, db, st.impl, { nowMs: NOW });
    assert.deepEqual(again, { due: 0, sent: 0, asked: 0, missed: 0, failed: 0 });
    assert.equal(st.calls.length, 1);
});
