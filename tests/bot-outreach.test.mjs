import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import {
    east8Parts, isOutreachWindow, pickOutreachInstantMs, parseRecordTimeMs,
    pickCandidate, loadOutreachState, setOutreachEnabled, runOutreachChecks,
    handleBotOutreachApi, OUTREACH_TEXT_MAX_BYTES
} from '../workers/src/bot-outreach.js';
import { buildBotReply } from '../workers/src/bot-commands.js';

const integration = sqliteTest;

function cstMs(ymd, hh, mm, ss = 0) {
    return Date.parse(ymd + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '+08:00');
}

function cstText(ms) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function todayYmd(ms) {
    return east8Parts(ms).ymd;
}

function stubFetch(routes) {
    const calls = [];
    const impl = async (url, init = {}) => {
        calls.push({ url: String(url), body: init && init.body, init });
        const route = routes.find(r => String(url).includes(r.match));
        if (!route) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify(route.json || {}), { status: route.status || 200 });
    };
    return { impl, calls };
}

async function seedClawAccount(db, overrides = {}) {
    await seedUser(db, 1);
    await db.prepare(
        'INSERT INTO bot_claw_accounts (user_id, status, bot_token, baseurl, ilink_bot_id, ilink_user_id, cursor, bound_at_ms, is_deleted, outreach_enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)'
    ).bind(
        1,
        overrides.status || 'bound',
        'test-token',
        'https://ilinkai.weixin.qq.com',
        'bot-1',
        'wx-user-1',
        '',
        overrides.boundAtMs == null ? Date.now() - 10 * 24 * 3600 * 1000 : overrides.boundAtMs,
        overrides.enabled == null ? 1 : overrides.enabled
    ).run();
}

async function seedFeed(db, id, content, ageDays) {
    const at = cstText(Date.now() - ageDays * 24 * 3600 * 1000);
    await db.prepare(
        'INSERT INTO quick_feeds (id, user_id, content, created_at, updated_at, is_deleted) VALUES (?1, 1, ?2, ?3, ?3, 0)'
    ).bind(id, content, at).run();
}

async function seedSent(db, refId, ageDays) {
    await db.prepare(
        "INSERT INTO bot_outreach (user_id, account_id, status, ref_type, ref_id, text, reason, is_deleted, created_at) VALUES (1, 1, 'sent', 'notes', ?1, '一句旧主动消息', '', 0, ?2)"
    ).bind(refId, cstText(Date.now() - ageDays * 24 * 3600 * 1000)).run();
}

async function seedTurn(db, role, content, ms) {
    await db.prepare(
        'INSERT INTO bot_chat_turns (user_id, role, content, is_deleted, created_at) VALUES (1, ?1, ?2, 0, ?3)'
    ).bind(role, content, cstText(ms)).run();
}

function aiEnv(reply) {
    const captured = [];
    const env = { AI: { run: async (model, opts) => { captured.push(opts && opts.messages); return { response: reply }; } } };
    return { env, captured };
}

test('时窗判定只认东八区 10:00–21:00', () => {
    const day = todayYmd(Date.now());
    assert.equal(isOutreachWindow(cstMs(day, 9, 59)), false);
    assert.equal(isOutreachWindow(cstMs(day, 10, 0)), true);
    assert.equal(isOutreachWindow(cstMs(day, 20, 59)), true);
    assert.equal(isOutreachWindow(cstMs(day, 21, 0)), false);
    assert.equal(isOutreachWindow(cstMs(day, 3, 0)), false);
});

test('当天的开口时刻稳定、随机且落在时窗内', () => {
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const a = pickOutreachInstantMs(1, now);
    const b = pickOutreachInstantMs(1, now + 3600 * 1000);
    assert.equal(a, b);
    const start = cstMs(todayYmd(now), 10, 0);
    const end = cstMs(todayYmd(now), 21, 0);
    assert.ok(a >= start && a < end);
    const other = pickOutreachInstantMs(2, now);
    assert.ok(other >= start && other < end);
});

test('记录时间同时容忍东八区文本与 epoch 毫秒', () => {
    assert.equal(parseRecordTimeMs('2026-10-20 08:00:00'), Date.UTC(2026, 9, 20, 0, 0, 0));
    assert.equal(parseRecordTimeMs(1792000000000), 1792000000000);
    assert.equal(parseRecordTimeMs(''), 0);
    assert.equal(parseRecordTimeMs(null), 0);
});

test('候选挑选跳过已经引用过的记录，没得挑就返回 null', () => {
    const candidates = [
        { type: 'quick_feeds', id: '1', body: 'x' },
        { type: 'notes', id: '2', body: 'y' }
    ];
    assert.equal(pickCandidate(candidates, new Set(['quick_feeds:1']), () => 0).type, 'notes');
    assert.equal(pickCandidate(candidates, new Set(['quick_feeds:1', 'notes:2']), () => 0), null);
    assert.equal(pickCandidate([], new Set(), () => 0), null);
});

integration('到点之前不打扰，到点之后主动说一句', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7001, '上周开始练吉他，手指疼但是挺开心的', 10);
    await seedFeed(db, 7002, '想把读书笔记整理成一篇长文章', 12);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: { message_id: 1 } }]);
    const { env } = aiEnv('你上次说练吉他手指疼，现在应该好一些了吧。');

    const before = await runOutreachChecks(env, db, stub.impl, { nowMs: instant - 60 * 1000, random: () => 0 });
    assert.equal(before.sent, 0);
    assert.equal(stub.calls.length, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_outreach').first()).n, 0);

    const after = await runOutreachChecks(env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.1 });
    assert.equal(after.sent, 1);
    assert.equal(stub.calls.length, 1);
    assert.ok(String(stub.calls[0].url).includes('/ilink/bot/sendmessage'));
    const row = await db.prepare('SELECT status, ref_type, ref_id, text FROM bot_outreach ORDER BY id DESC LIMIT 1').first();
    assert.equal(row.status, 'sent');
    assert.ok(['quick_feeds', 'notes', 'weeklies', 'bookmarks'].includes(row.ref_type));
    assert.ok(row.text.length > 0);
    const body = JSON.parse(stub.calls[0].body);
    assert.equal(body.msg.context_token, '');
    assert.equal(body.msg.to_user_id, 'wx-user-1');
    assert.equal(body.msg.item_list[0].text_item.text, row.text);
    assert.ok(Buffer.byteLength(row.text, 'utf8') <= OUTREACH_TEXT_MAX_BYTES);
});

integration('每天最多一次：当天已经尝试过就不再开口', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7011, '想在下个月把阳台改造成一个小书房', 20);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: { ret: 0 } }]);
    const first = await runOutreachChecks(aiEnv('想把阳台改成书房这件事，还惦记着吗。').env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.1 });
    assert.equal(first.sent, 1);
    const second = await runOutreachChecks(aiEnv('第二句不该发出去').env, db, stub.impl, { nowMs: instant + 5 * 60 * 1000, random: () => 0.1 });
    assert.equal(second.sent, 0);
    assert.equal(stub.calls.length, 1);
});

integration('刚说完话的 30 分钟内不插嘴', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7021, '最近在学做面包，第一次发酵失败了', 9);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const runAt = pickOutreachInstantMs(1, now) + 1000;
    await seedTurn(db, 'user', '在吗', runAt - 10 * 60 * 1000);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: {} }]);
    const res = await runOutreachChecks(aiEnv('hi').env, db, stub.impl, { nowMs: runAt, random: () => 0.1 });
    assert.equal(res.sent, 0);
    assert.equal(res.state, 'idle');
    assert.equal(stub.calls.length, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_outreach').first()).n, 0);
});

integration('聊完 30 分钟就能开口，并把刚才的对话当背景', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7101, '最近在学做面包，第一次发酵失败了', 9);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const runAt = pickOutreachInstantMs(1, now) + 1000;
    await seedTurn(db, 'user', '我今天有点累', runAt - 31 * 60 * 1000);
    await seedTurn(db, 'assistant', '那就早点休息，别硬撑。', runAt - 30 * 60 * 1000);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: { message_id: 9 } }]);
    const { env, captured } = aiEnv('上次那炉面包最后发起来了吗。');
    const res = await runOutreachChecks(env, db, stub.impl, { nowMs: runAt, random: () => 0.1 });
    assert.equal(res.sent, 1);
    assert.equal(stub.calls.length, 1);
    const prompt = JSON.stringify(captured[0]);
    assert.match(prompt, /【你们刚聊过】/);
    assert.match(prompt, /我今天有点累/);
    assert.match(prompt, /不重复刚才对话/);
});

integration('很久以前的对话不算「刚聊过」，不注入背景', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7111, '想学会做一杯像样的手冲咖啡', 7);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const runAt = pickOutreachInstantMs(1, now) + 1000;
    await seedTurn(db, 'user', '八小时前说过的一句旧话', runAt - 8 * 60 * 60 * 1000);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: { message_id: 10 } }]);
    const { env, captured } = aiEnv('手冲的水温这件事，最近顾上了吗。');
    const res = await runOutreachChecks(env, db, stub.impl, { nowMs: runAt, random: () => 0.1 });
    assert.equal(res.sent, 1);
    const prompt = JSON.stringify(captured[0]);
    assert.ok(!/【你们刚聊过】/.test(prompt));
    assert.ok(!/八小时前说过的一句旧话/.test(prompt));
});

integration('太新的记录不碰，没有旧素材就安静', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7031, '刚刚记下的一条很新的内容', 1);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: {} }]);
    const res = await runOutreachChecks(aiEnv('hi').env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.1 });
    assert.equal(res.sent, 0);
    assert.equal(stub.calls.length, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_outreach').first()).n, 0);
});

integration('随机频率闸门：到点也可以选择不说', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7041, '想去一趟海边，看看冬天的浪是什么样', 8);
    await seedSent(db, '999', 1);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: {} }]);
    const skip = await runOutreachChecks(aiEnv('hi').env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.99 });
    assert.equal(skip.sent, 0);
    assert.equal(skip.skipped, 1);
    assert.equal(stub.calls.length, 0);
    const row = await db.prepare('SELECT status, reason FROM bot_outreach ORDER BY id DESC LIMIT 1').first();
    assert.equal(row.status, 'skipped');
    assert.equal(row.reason, 'random');
});

integration('连续多天没发过就免除随机闸门', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7051, '答应自己今年要写完十二篇周记', 30);
    await seedSent(db, '998', 5);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: {} }]);
    const res = await runOutreachChecks(aiEnv('十二篇周记写到哪里了，今年还来得及。').env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.99 });
    assert.equal(res.sent, 1);
    assert.equal(stub.calls.length, 1);
});

integration('模型有否决权：回 SKIP 就只记一条跳过', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7061, '把去年的旅行照片整理成了一个相册', 15);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: {} }]);
    const res = await runOutreachChecks(aiEnv('SKIP').env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.1 });
    assert.equal(res.sent, 0);
    assert.equal(res.skipped, 1);
    assert.equal(stub.calls.length, 0);
    const row = await db.prepare('SELECT status, reason FROM bot_outreach ORDER BY id DESC LIMIT 1').first();
    assert.equal(row.reason, 'model-skip');
});

integration('内容安全门禁：命中硬词就不发', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7071, '想把厨房的旧柜子重新刷一遍漆', 11);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: {} }]);
    const res = await runOutreachChecks(aiEnv('要不要一起去赌博').env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.1 });
    assert.equal(res.sent, 0);
    assert.equal(stub.calls.length, 0);
    const row = await db.prepare('SELECT status FROM bot_outreach ORDER BY id DESC LIMIT 1').first();
    assert.equal(row.status, 'skipped');
});

integration('发送失败只记审计，不中断 cron', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7081, '想把厨房的旧柜子重新刷一遍漆', 11);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', status: 500, json: {} }]);
    const res = await runOutreachChecks(aiEnv('柜子刷漆这件事，周末动手来得及。').env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.1 });
    assert.equal(res.failed, 1);
    const row = await db.prepare('SELECT status FROM bot_outreach ORDER BY id DESC LIMIT 1').first();
    assert.equal(row.status, 'failed');
});

integration('开关：关闭之后即使到点也不开口', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    await seedFeed(db, 7091, '想学会做一杯像样的手冲咖啡', 7);
    await setOutreachEnabled(db, 1, false);
    const state = await loadOutreachState(db, 1);
    assert.equal(state.bound, true);
    assert.equal(state.enabled, false);
    const now = cstMs(todayYmd(Date.now()), 12, 0);
    const instant = pickOutreachInstantMs(1, now);
    const stub = stubFetch([{ match: '/ilink/bot/sendmessage', json: {} }]);
    const res = await runOutreachChecks(aiEnv('hi').env, db, stub.impl, { nowMs: instant + 1000, random: () => 0.1 });
    assert.equal(res.sent, 0);
    assert.equal(stub.calls.length, 0);
});

integration('应用内接口：读取状态并切换开关，未知路径 404', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    const url = new URL('https://chillin.internal/api/bot/outreach');
    const get = await handleBotOutreachApi(new Request(url), {}, url, db, 1);
    assert.equal(get.status, 200);
    const getBody = await get.json();
    assert.equal(getBody.enabled, true);
    assert.equal(getBody.maxItems, undefined);

    const post = await handleBotOutreachApi(
        new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }),
        {}, url, db, 1
    );
    assert.equal(post.status, 200);
    assert.equal((await post.json()).enabled, false);

    const missing = new URL('https://chillin.internal/api/bot/outreach/other');
    const res = await handleBotOutreachApi(new Request(missing), {}, missing, db, 1);
    assert.equal(res.status, 404);
});

integration('微信里一句话就能开关主动关怀', async () => {
    const db = await createTestDb();
    await seedClawAccount(db);
    const off = await buildBotReply({}, db, 1, '别主动找我');
    assert.match(off, /安静/);
    assert.equal((await loadOutreachState(db, 1)).enabled, false);
    const on = await buildBotReply({}, db, 1, '可以主动找我');
    assert.match(on, /偶尔/);
    assert.equal((await loadOutreachState(db, 1)).enabled, true);
});
