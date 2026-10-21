import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import api from '../workers/api.js';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import {
    ilinkUin,
    ilinkHeaders,
    ilinkBase,
    requestClawQrcode,
    queryClawQrcode,
    fetchClawUpdates,
    sendClawText,
    extractClawText,
    clawDedupKey,
    startClawLogin,
    checkClawLogin,
    unbindClaw,
    handleClawApi,
    pollClawAccounts
} from '../workers/src/bot-claw.js';
import {
    extractClawImageItems,
    resolveClawImageUrl,
    sniffImageMagic,
    decryptClawImage,
    decodeAesKey,
    aesKeyKind,
    downloadClawImage,
    clawImageUrlCandidates,
    clawImageKeys,
    unwrapHexAsciiKey,
    aes128EcbDecrypt
} from '../workers/src/bot-media.js';
import { describeClawImageContent } from '../workers/src/bot-vision.js';
import { CLAW_CRON, runScheduled } from '../workers/src/maintenance.js';
import {
    parseRecordCommand,
    parseRememberCommand,
    parseForgetCommand,
    buildBotReply,
    wantsEvidence,
    sourceLabel,
    BOT_HELP_TEXT
} from '../workers/src/bot-commands.js';
import {
    loadChatContext,
    listProfile,
    addProfileItem,
    updateProfileItem,
    forgetProfileById,
    handleBotProfileApi,
    PROFILE_MAX_ITEMS,
    savePendingMedia
} from '../workers/src/bot-memory.js';

/**
 * 微信 ClawBot（官方 iLink 协议）：传输层纯函数 + D1 接入层 + 每分钟长轮询。
 * 出站请求全部注入 fetchImpl 替身，用例完全离线，不碰真实微信服务器。
 */
const integration = sqliteTest;
const OFFICIAL = 'https://ilinkai.weixin.qq.com';
const ctx = { waitUntil() {}, passThroughOnException() {} };

/** 按 URL 片段分发的 fetch 替身：记录每次调用，并返回路由脚本给出的 JSON */
function stubFetch(routes) {
    const calls = [];
    const impl = async (url, init) => {
        const u = String(url);
        let body = null;
        if (init && init.body) { try { body = JSON.parse(init.body); } catch { body = init.body; } }
        calls.push({ url: u, body, init });
        for (const key of Object.keys(routes)) {
            if (u.includes(key)) {
                const r = routes[key](u, body) || {};
                if (r.bytes) return new Response(r.bytes, { status: r.status || 200 });
                return new Response(JSON.stringify(r.json || {}), { status: r.status || 200 });
            }
        }
        return new Response('{"ret":0}', { status: 200 });
    };
    return { impl, calls };
}

test('ClawBot - 请求头带官方要求的四项标识，登录前不发令牌', () => {
    const headers = ilinkHeaders('tok-123');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['AuthorizationType'], 'ilink_bot_token');
    assert.equal(headers['iLink-App-Id'], 'bot');
    assert.equal(headers['iLink-App-ClientVersion'], '132104');
    assert.equal(headers.Authorization, 'Bearer tok-123');
    assert.match(headers['X-WECHAT-UIN'], /^[A-Za-z0-9+/]+={0,2}$/, 'X-WECHAT-UIN 应是 base64');
    assert.ok(!('Authorization' in ilinkHeaders('')), '取二维码时还没令牌');
});

test('ClawBot - X-WECHAT-UIN 是随机 uint32 的 base64，两次不同', () => {
    const first = ilinkUin();
    assert.ok(first.length > 0);
    const decoded = Number(Buffer.from(first, 'base64').toString('utf8'));
    assert.ok(Number.isInteger(decoded) && decoded >= 0 && decoded < 4294967296);
    assert.notEqual(first, ilinkUin());
});

test('ClawBot - baseurl 只接受 https 主机，非法值一律退回官方域名', () => {
    assert.equal(ilinkBase(OFFICIAL + '/'), OFFICIAL);
    assert.equal(ilinkBase('https://bot.example:8443'), 'https://bot.example:8443');
    assert.equal(ilinkBase('http://ilinkai.weixin.qq.com'), OFFICIAL);
    assert.equal(ilinkBase('https://evil.example.com@attacker.test'), OFFICIAL);
    assert.equal(ilinkBase('https://ilinkai.weixin.qq.com/path'), OFFICIAL);
    assert.equal(ilinkBase(''), OFFICIAL);
    assert.equal(ilinkBase(undefined), OFFICIAL);
});

test('ClawBot - extractClawText 只取 type=1 的文本项，clawDedupKey 叠三段标识', () => {
    assert.equal(extractClawText({
        item_list: [
            { type: 1, text_item: { text: ' 第一段 ' } },
            { type: 2, image_item: { url: 'https://x/y.png' } },
            { type: 1, text_item: { text: '第二段' } }
        ]
    }), '第一段 \n第二段'); // 单个文本项内部的空白保留，只对整体结果 trim
    assert.equal(extractClawText({ item_list: [{ type: 2 }] }), '');
    assert.equal(extractClawText(null), '');

    assert.equal(clawDedupKey({ message_id: 'M', item_list: [{ msg_id: 'I' }], client_id: 'C' }), 'M|I|C');
    assert.notEqual(
        clawDedupKey({ message_id: 'M', item_list: [{ msg_id: 'I' }], client_id: 'C' }),
        clawDedupKey({ message_id: 'M', item_list: [{ msg_id: 'I2' }], client_id: 'C' })
    );
    assert.equal(clawDedupKey(null), '');
});

test('ClawBot - 取二维码与查询扫码状态解析官方字段', async () => {
    const qr = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-1', qrcode_img_content: 'https://x/qr.png' } })
    });
    const got = await requestClawQrcode(qr.impl);
    assert.equal(got.qrcode, 'QR-1');
    assert.equal(got.url, 'https://x/qr.png');
    assert.equal(qr.calls[0].init.method, 'POST');
    assert.equal(qr.calls[0].url, OFFICIAL + '/ilink/bot/get_bot_qrcode?bot_type=3');
    assert.deepEqual(qr.calls[0].body.local_token_list, []);

    const st = stubFetch({
        '/ilink/bot/get_qrcode_status': () => ({
            json: {
                status: 'confirmed',
                bot_token: 'BOT',
                baseurl: 'https://ilinkai.example',
                ilink_bot_id: 'bot@im.bot',
                ilink_user_id: 'owner@im.wechat'
            }
        })
    });
    const state = await queryClawQrcode('QR/1', st.impl);
    assert.equal(state.status, 'confirmed');
    assert.equal(state.botToken, 'BOT');
    assert.equal(state.ilinkBotId, 'bot@im.bot');
    assert.equal(state.ilinkUserId, 'owner@im.wechat');
    assert.match(st.calls[0].url, /qrcode=QR%2F1$/);

    const missing = stubFetch({ '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: '' } }) });
    await assert.rejects(() => requestClawQrcode(missing.impl), /qrcode/);
});

test('ClawBot - 长轮询携带游标，解析消息与 get_updates_buf', async () => {
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-2', msgs: [{ message_id: '1' }] } })
    });
    const out = await fetchClawUpdates({ token: 'T', baseurl: OFFICIAL, cursor: 'CURSOR-1', fetchImpl: st.impl });
    assert.equal(out.ret, 0);
    assert.equal(out.cursor, 'CURSOR-2');
    assert.equal(out.msgs.length, 1);
    assert.equal(st.calls[0].url, OFFICIAL + '/ilink/bot/getupdates');
    assert.equal(st.calls[0].body.get_updates_buf, 'CURSOR-1');
    assert.equal(st.calls[0].body.base_info.channel_version, '2.4.8');
    assert.equal(st.calls[0].body.base_info.bot_agent, 'Chillin/0.1');

    const bad = stubFetch({ '/ilink/bot/getupdates': () => ({ status: 500, json: {} }) });
    await assert.rejects(() => fetchClawUpdates({ token: 'T', fetchImpl: bad.impl }), /getupdates http 500/);
});

test('ClawBot - 回复消息带回传的 context_token，正文截到 4000 字节内', async () => {
    const st = stubFetch({ '/ilink/bot/sendmessage': () => ({ json: { ret: 0, message_id: '9' } }) });
    await sendClawText({
        token: 'T', baseurl: OFFICIAL, botId: 'bot@im.bot', toUserId: 'owner@im.wechat',
        contextToken: 'CTX-1', text: '你好', fetchImpl: st.impl
    });
    const body = st.calls[0].body;
    assert.equal(st.calls[0].url, OFFICIAL + '/ilink/bot/sendmessage');
    assert.equal(body.msg.message_type, 2);
    assert.equal(body.msg.message_state, 2);
    assert.equal(body.msg.context_token, 'CTX-1');
    assert.equal(body.msg.from_user_id, 'bot@im.bot');
    assert.equal(body.msg.to_user_id, 'owner@im.wechat');
    assert.equal(body.msg.item_list[0].type, 1);
    assert.equal(body.msg.item_list[0].text_item.text, '你好');
    assert.match(body.msg.client_id, /^chillin-/);
    assert.equal(body.base_info.bot_agent, 'Chillin/0.1');

    await sendClawText({ token: 'T', text: '中'.repeat(3000), fetchImpl: st.impl });
    const long = st.calls[1].body.msg.item_list[0].text_item.text;
    assert.ok(Buffer.byteLength(long, 'utf8') <= 4000, '截断后不能超过 4000 字节');
    assert.ok(long.endsWith('…'));
});

/** 建一个已绑定账号，bound_at_ms 取当前时间，避免被「绑定前积压」规则丢掉 */
async function seedAccount(db, overrides = {}) {
    const row = {
        token: 'BOT-TOKEN', baseurl: OFFICIAL, botId: 'bot@im.bot', userId: 'owner@im.wechat',
        cursor: 'CURSOR-0', boundAt: Date.now(), ...overrides
    };
    await db.prepare(
        "INSERT INTO bot_claw_accounts (user_id, status, bot_token, baseurl, ilink_bot_id, ilink_user_id, cursor, bound_at_ms) "
        + "VALUES (1, 'bound', ?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(row.token, row.baseurl, row.botId, row.userId, row.cursor, row.boundAt).run();
    return row;
}

/** 每条消息都用唯一 id：排重键会先进进程内的限流 Map，用例之间不能共用同一个键 */
function clawMessage(overrides = {}) {
    const unique = Math.random().toString(36).slice(2);
    return {
        message_id: 'MSG-' + unique,
        message_type: 1,
        from_user_id: 'owner@im.wechat',
        context_token: 'CTX-1',
        create_time_ms: Date.now(),
        item_list: [{ type: 1, msg_id: 'ITEM-' + unique, text_item: { text: '今晚手冲咖啡，水温 92 度' } }],
        ...overrides
    };
}

integration('ClawBot - 取二维码落库为 pending，状态响应绝不泄露 bot_token', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const st = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-KEEP', qrcode_img_content: 'https://x/qr.png' } })
    });
    const started = await startClawLogin({}, db, 1, st.impl);
    assert.equal(started.qrcode, 'QR-KEEP');
    assert.equal(started.ttlSeconds, 90);
    assert.equal(started.status, 'pending');

    const row = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row.status, 'pending');
    assert.equal(row.qrcode, 'QR-KEEP');
    assert.ok(row.qr_expires_at, '二维码必须带过期时间');

    await db.prepare("UPDATE bot_claw_accounts SET status = 'bound', bot_token = 'SECRET-TOKEN' WHERE user_id = 1").run();
    const res = await handleClawApi(
        new Request('https://chillin.example/api/bot/claw/status'), {},
        new URL('https://chillin.example/api/bot/claw/status'), db, 1
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bound, true);
    assert.equal(body.status, 'bound');
    assert.equal(JSON.stringify(body).includes('SECRET-TOKEN'), false, '状态响应绝不能带 bot_token');
});

integration('ClawBot - 扫码确认写入凭证并规范化 baseurl，cursor 归零', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const st = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-CONFIRM' } }),
        '/ilink/bot/get_qrcode_status': () => ({
            json: {
                status: 'confirmed', bot_token: 'BOT-TOKEN', baseurl: OFFICIAL + '/',
                ilink_bot_id: 'bot@im.bot', ilink_user_id: 'owner@im.wechat'
            }
        })
    });
    await startClawLogin({}, db, 1, st.impl);
    const bound = await checkClawLogin({}, db, 1, st.impl);
    assert.equal(bound.bound, true);
    assert.equal(bound.ilinkBotId, 'bot@im.bot');
    assert.equal(JSON.stringify(bound).includes('BOT-TOKEN'), false);

    const row = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row.status, 'bound');
    assert.equal(row.bot_token, 'BOT-TOKEN');
    assert.equal(row.baseurl, OFFICIAL, 'baseurl 必须去掉尾斜杠');
    assert.equal(row.cursor, '');
    assert.equal(row.qrcode, '');
    assert.ok(Number(row.bound_at_ms) > 0);
});

integration('ClawBot - 二维码过期清空 qrcode，确认响应缺字段只记错误不绑定', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const expired = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-EXP' } }),
        '/ilink/bot/get_qrcode_status': () => ({ json: { status: 'expired' } })
    });
    await startClawLogin({}, db, 1, expired.impl);
    const out = await checkClawLogin({}, db, 1, expired.impl);
    assert.equal(out.bound, false);
    assert.equal(out.status, 'expired');
    const row = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row.qrcode, '');
    assert.equal(row.status, 'pending');
    assert.equal(row.bot_token, '');

    const partial = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-HALF' } }),
        '/ilink/bot/get_qrcode_status': () => ({ json: { status: 'confirmed', bot_token: 'ONLY-TOKEN' } })
    });
    await startClawLogin({}, db, 1, partial.impl);
    const half = await checkClawLogin({}, db, 1, partial.impl);
    assert.equal(half.bound, false);
    const row2 = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row2.status, 'pending');
    assert.equal(row2.bot_token, '');
    assert.match(row2.last_error, /bot_token\/ilink_bot_id/);
});

integration('ClawBot - 解绑软删账号并清空令牌，状态回到未绑定', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const out = await unbindClaw(db, 1);
    assert.equal(out.bound, false);
    assert.equal(out.status, 'unbound');
    const row = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row.is_deleted, 1, '用户数据只能软删');
    assert.equal(row.status, 'unbound');
    assert.equal(row.bot_token, '');
});

integration('ClawBot - 路由只认四个端点，上游故障回落 502', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const unknown = await handleClawApi(
        new Request('https://chillin.example/api/bot/claw/nope'), {},
        new URL('https://chillin.example/api/bot/claw/nope'), db, 1
    );
    assert.equal(unknown.status, 404);
    const wrongMethod = await handleClawApi(
        new Request('https://chillin.example/api/bot/claw/qrcode'), {},
        new URL('https://chillin.example/api/bot/claw/qrcode'), db, 1
    );
    assert.equal(wrongMethod.status, 404, 'GET 打二维码端点应视为不存在');

    const original = globalThis.fetch;
    globalThis.fetch = stubFetch({ '/ilink/bot/get_bot_qrcode': () => ({ status: 500, json: {} }) }).impl;
    try {
        const res = await handleClawApi(
            new Request('https://chillin.example/api/bot/claw/qrcode', { method: 'POST' }), {},
            new URL('https://chillin.example/api/bot/claw/qrcode'), db, 1
        );
        assert.equal(res.status, 502);
    } finally { globalThis.fetch = original; }
});

integration('ClawBot - 网关把 /api/bot/claw 挂在登录态之后（未登录 401）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const res = await api.fetch(new Request('https://chillin.example/api/bot/claw/status'), { DB: db }, ctx);
    assert.equal(res.status, 401);
});

integration('ClawBot - 长轮询默认只聊天：普通消息不落库，游标仍持久化', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-1', msgs: [clawMessage()] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });

    // 意图反转的核心：默认路径一句业务数据都不写
    const feeds = await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first();
    assert.equal(feeds.n, 0, '闲聊绝不能落进随手记');
    const turns = await db.prepare('SELECT role, content FROM bot_chat_turns ORDER BY id').all();
    assert.equal(turns.results.length, 2, '用户与助手各留一条对话上下文');
    assert.equal(turns.results[0].role, 'user');
    assert.equal(turns.results[0].content, '今晚手冲咖啡，水温 92 度');
    assert.equal(turns.results[1].role, 'assistant');

    const row = await db.prepare('SELECT cursor, last_poll_at FROM bot_claw_accounts WHERE id = 1').first();
    assert.equal(row.cursor, 'CURSOR-1');
    assert.ok(row.last_poll_at, '必须记录轮询时间');

    assert.equal(st.calls[0].url, OFFICIAL + '/ilink/bot/getupdates');
    assert.equal(st.calls[0].body.get_updates_buf, 'CURSOR-0');
    const send = st.calls.find(c => c.url.endsWith('/sendmessage'));
    assert.ok(send, '必须回一条消息');
    assert.equal(send.body.msg.context_token, 'CTX-1');
    assert.equal(send.body.msg.to_user_id, 'owner@im.wechat');
    assert.ok(
        !/已存入|随手记/.test(send.body.msg.item_list[0].text_item.text),
        '没写库就不该宣称保存：' + send.body.msg.item_list[0].text_item.text
    );
});

integration('ClawBot - 同一条消息重复投递只处理一次（uint64 丢精度也能排重）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    // 同一个消息对象被两次轮询返回：模拟微信对同一条消息重复投递
    const replayed = clawMessage();
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-1', msgs: [replayed] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });

    const count = await db.prepare('SELECT COUNT(*) AS n FROM bot_chat_turns').first();
    assert.equal(count.n, 2, '重复投递只应产生一组对话');
    assert.equal(st.calls.filter(c => c.url.endsWith('/sendmessage')).length, 1);
});

integration('ClawBot - 非绑定身份、绑定前积压与非文本消息都不处理', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const bound = await seedAccount(db);
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({
            json: {
                ret: 0, get_updates_buf: 'CURSOR-1',
                msgs: [
                    clawMessage({ message_id: 'm1', from_user_id: 'stranger@im.wechat' }),
                    clawMessage({ message_id: 'm2', create_time_ms: bound.boundAt - 3600 * 1000 }),
                    clawMessage({ message_id: 'm3', message_type: 2 })
                ]
            }
        }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });

    const count = await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first();
    assert.equal(count.n, 0);
    assert.equal(st.calls.filter(c => c.url.endsWith('/sendmessage')).length, 0);
});

integration('ClawBot - 上游 ret 非 0 或请求抛错时只记 last_error，不推进游标', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const ret = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: -2, errcode: 1234 } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    await pollClawAccounts({ DB: db }, db, ret.impl, { budgetMs: 0 });
    let row = await db.prepare('SELECT cursor, last_error FROM bot_claw_accounts WHERE id = 1').first();
    assert.match(row.last_error, /ret=-2 errcode=1234/);
    assert.equal(row.cursor, 'CURSOR-0');
    assert.equal(ret.calls.filter(c => c.url.endsWith('/sendmessage')).length, 0);

    const broken = stubFetch({ '/ilink/bot/getupdates': () => ({ status: 503, json: {} }) });
    await pollClawAccounts({ DB: db }, db, broken.impl, { budgetMs: 0 });
    row = await db.prepare('SELECT cursor, last_error FROM bot_claw_accounts WHERE id = 1').first();
    assert.match(row.last_error, /getupdates http 503/);
});

integration('ClawBot - scheduled 按 cron 分流：每分钟只轮询，小时维护不碰长轮询', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    assert.equal(CLAW_CRON, '* * * * *');

    const original = globalThis.fetch;
    const poll = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-9', msgs: [] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    try {
        globalThis.fetch = poll.impl;
        await runScheduled({ DB: db }, { cron: CLAW_CRON }, { budgetMs: 0 });
    } finally { globalThis.fetch = original; }
    assert.equal(poll.calls.length, 1, '单测把预算压到 0，只应有一轮长轮询');
    assert.match(poll.calls[0].url, /getupdates$/);

    const hourly = stubFetch({});
    try {
        globalThis.fetch = hourly.impl;
        await runScheduled({ DB: db }, { cron: '13 * * * *' });
    } finally { globalThis.fetch = original; }
    assert.equal(hourly.calls.filter(c => c.url.includes('ilink')).length, 0);
});

integration('ClawBot - 一次 cron 调用内持续拉取，中途到达的消息当轮就处理', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    let rounds = 0;
    // 同一条消息（同一个排重键）会在后续轮次里被反复推送
    const arriving = clawMessage();
    const st = stubFetch({
        '/ilink/bot/getupdates': () => {
            rounds++;
            // 第一轮空手而归（消息还没到），第二轮起服务端立刻推送同一条消息
            return { json: { ret: 0, get_updates_buf: 'CURSOR-' + rounds, msgs: rounds >= 2 ? [arriving] : [] } };
        },
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 60 });

    const polls = st.calls.filter(c => c.url.endsWith('/getupdates')).length;
    assert.ok(polls >= 2, '预算内应继续拉取，实测 ' + polls + ' 轮');
    const turns = await db.prepare('SELECT COUNT(*) AS n FROM bot_chat_turns').first();
    assert.equal(turns.n, 2, '同一条消息同一调用内只处理一次');
    assert.equal(st.calls.filter(c => c.url.endsWith('/sendmessage')).length, 1, '同一条消息同一调用内只回一次');

    // 预算为 0 时必须只拉一轮，循环不能空转
    st.calls.length = 0;
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });
    assert.equal(st.calls.filter(c => c.url.endsWith('/getupdates')).length, 1);
});

// ── 私人伴侣：意图分流、个人档案与对话上下文 ──────────────────────────────

test('Bot - 记录/记住/忘记只认显式写法，含糊语气一律不判为写入', () => {
    assert.equal(parseRecordCommand('记录：今晚手冲咖啡，水温 92 度'), '今晚手冲咖啡，水温 92 度');
    assert.equal(parseRecordCommand('记一下 明天买牛奶'), '明天买牛奶');
    assert.equal(parseRecordCommand('记录一下今天开会被夸了'), '今天开会被夸了');
    assert.equal(parseRecordCommand('帮我记录：周四复诊'), '周四复诊');
    assert.equal(parseRecordCommand('今天天气不错'), null);
    assert.equal(parseRecordCommand('记录了这件事'), null, '叙述句不是指令');

    assert.equal(parseRememberCommand('记住：我不吃香菜'), '我不吃香菜');
    assert.equal(parseRememberCommand('记住我不吃香菜'), '我不吃香菜');
    assert.equal(parseRememberCommand('记住'), null, '没有内容不写档案');
    assert.equal(parseRememberCommand('我记得你说过'), null);

    assert.deepEqual(parseForgetCommand('忘记 香菜'), { all: false, keyword: '香菜' });
    assert.deepEqual(parseForgetCommand('清空档案'), { all: true, keyword: '' });
    assert.equal(parseForgetCommand('忘了吧'), null, '「忘了吧」是语气词，不是遗忘指令');
});

test('Bot - 帮助文案不再宣称「直接发文字存入随手记」', () => {
    assert.ok(!/直接发文字/.test(BOT_HELP_TEXT), '意图反转后帮助文案必须改写');
    assert.match(BOT_HELP_TEXT, /记录：/);
    assert.match(BOT_HELP_TEXT, /重置对话/);
});

test('Bot - 来源脚注按需触发：只有索要依据的问法才算', () => {
    assert.equal(wantsEvidence('今天有点累'), false, '普通聊天不追问来源');
    assert.equal(wantsEvidence('记录：今天读了半小时书'), false);
    assert.equal(wantsEvidence('这个依据是什么'), true);
    assert.equal(wantsEvidence('你怎么知道我上周在读那本书'), true);
    assert.equal(wantsEvidence('说说来源'), true);
    assert.equal(wantsEvidence(''), false);
});

test('Bot - 来源标签统一成 [类型] YYYY-MM-DD，标题与日期重复时不重复展示', () => {
    assert.equal(sourceLabel({ type: '随手记', date: '2026-08-31', title: '' }), '[随手记] 2026-08-31');
    // 周记标题本身就是点分日期：归一化后与 date 相同，只留一种写法
    assert.equal(sourceLabel({ type: '周记', date: '2026-05-21', title: '2026.5.21' }), '[周记] 2026-05-21');
    assert.equal(sourceLabel({ type: '笔记', date: '2026-05-21', title: '读书笔记' }), '[笔记] 2026-05-21 · 读书笔记');
    assert.equal(sourceLabel({ type: '笔记', date: '', title: '只有标题' }), '[笔记] 只有标题');
    assert.equal(sourceLabel({ type: '笔记' }), '[笔记] 未知日期');
    assert.equal(sourceLabel(null), '[记录] 未知日期');
});

integration('Bot - 默认聊天不附依据，追问来源时才带', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await db.prepare(
        "INSERT INTO quick_feeds (id, user_id, content, created_at, updated_at, is_deleted) VALUES (?1, 1, ?2, datetime('now','+8 hours'), datetime('now','+8 hours'), 0)"
    ).bind(1799000000001, '上周在读《人类简史》，读到农业革命那一章，挺有意思').run();

    const env = { AI: { run: async () => ({ response: '你上周在读《人类简史》。' }) } };

    const plain = await buildBotReply(env, db, 1, '我还在读《人类简史》吗');
    assert.equal(plain, '你上周在读《人类简史》。', '默认回复必须干净、不带依据脚注，实际：' + plain);

    const asked = await buildBotReply(env, db, 1, '《人类简史》这个依据是什么');
    assert.match(asked, /依据：/, '追问来源时必须给出处');
    assert.match(asked, /\[随手记\]/);
    assert.match(asked, /依据：.随手记. \d{4}-\d{2}-\d{2}/, '脚注日期必须统一成 YYYY-MM-DD，实际：' + asked);
});

integration('Bot - 显式「记录：…」才落随手记，闲聊只留对话上下文', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    const chat = await buildBotReply({}, db, 1, '今天天气不错');
    assert.ok(!/已存入|随手记/.test(chat), '闲聊回复不该宣称保存，实际：' + chat);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '闲聊绝不落库');

    const saved = await buildBotReply({}, db, 1, '记录：今晚手冲咖啡，水温 92 度');
    assert.match(saved, /随手记/);
    const feed = await db.prepare('SELECT content, type FROM quick_feeds').first();
    assert.equal(feed.content, '今晚手冲咖啡，水温 92 度');
    assert.equal(feed.type, 'text');
    const turns = await db.prepare('SELECT role FROM bot_chat_turns ORDER BY id').all();
    assert.equal(turns.results.length, 4, '闲聊与记录各留下一组对话');
});

integration('Bot - 「记住：…」写进关于我，可查看、可遗忘（全程软删）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    assert.match(await buildBotReply({}, db, 1, '记住：我不吃香菜'), /我记住了/);
    assert.match(await buildBotReply({}, db, 1, '记住：我不吃香菜'), /已经记得/);
    const items = await listProfile(db, 1);
    assert.equal(items.length, 1, '重复写入不得生成第二条');

    assert.match(await buildBotReply({}, db, 1, '你记得我什么'), /不吃香菜/);
    assert.match(await buildBotReply({}, db, 1, '忘记 香菜'), /已忘记 1 条/);
    const row = await db.prepare('SELECT is_deleted FROM bot_profile WHERE id = ?1').bind(items[0].id).first();
    assert.equal(row.is_deleted, 1, '遗忘必须是软删');
    assert.equal((await listProfile(db, 1)).length, 0);
    assert.match(await buildBotReply({}, db, 1, '你记得我什么'), /还没有你的档案/);
});

/** 最小可嗅探的 PNG 头：魔数 + IHDR 开头，足够走通「先魔数后入库」的链路 */
const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01
]);

/** 图片消息的实测形状：外层 message_type 仍是 1，靠 item.type=2 + image_item 识别 */
function imageMessage(overrides = {}) {
    const unique = Math.random().toString(36).slice(2);
    return {
        message_id: 'IMG-' + unique,
        message_type: 1,
        from_user_id: 'owner@im.wechat',
        context_token: 'CTX-IMG',
        create_time_ms: Date.now(),
        item_list: [{
            type: 2,
            msg_id: 'IMGITEM-' + unique,
            image_item: { aeskey: '', media: 'https://cdn.example/photo.png', mid_size: PNG_BYTES.length }
        }],
        ...overrides
    };
}

/** 生产形态的绑定环境：R2 替身 + 一调就炸的 AI（图片通道绝不该经过模型） */
function mediaEnv(db, puts) {
    return {
        DB: db,
        MEDIA: {
            put: async (key, buf, opts) => { puts.push({ key, size: buf.byteLength, type: opts.httpMetadata.contentType }); }
        },
        AI: { run: async () => { throw new Error('图片通道不该调用模型'); } }
    };
}

/** 线上真实形态：AES-128-ECB + PKCS7（与 node:crypto 对齐，用来造测试密文） */
function encryptEcbBytes(bytes, keyBytes) {
    const cipher = createCipheriv('aes-128-ecb', keyBytes, null);
    return new Uint8Array(Buffer.concat([cipher.update(bytes), cipher.final()]));
}

async function encryptBytes(bytes, keyBytes, iv = keyBytes.slice(0, 16)) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
    const out = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, bytes);
    return new Uint8Array(out);
}

test('ClawBot - 图片 item 识别、下载地址兜底与魔数嗅探', () => {
    const msg = { message_type: 1, item_list: [{ type: 1, text_item: { text: '配文' } }, { type: 2, image_item: { media: 'https://cdn.example/a.png' } }] };
    assert.equal(extractClawImageItems(msg).length, 1, '只有 item.type=2 才算图片');
    assert.equal(extractClawImageItems({ item_list: [{ type: 1, text_item: { text: 'x' } }] }).length, 0);
    assert.equal(extractClawImageItems(null).length, 0);

    assert.equal(resolveClawImageUrl({ media: 'https://cdn.example/a.png' }), 'https://cdn.example/a.png');
    assert.equal(resolveClawImageUrl({ media: { url: 'https://cdn.example/b.png' } }), 'https://cdn.example/b.png');
    assert.equal(resolveClawImageUrl({ hd_url: 'https://cdn.example/c.png' }), 'https://cdn.example/c.png');
    assert.equal(resolveClawImageUrl({ media: 12345, thumb_size: 9 }), '', '认不出地址就返回空串');
    assert.equal(resolveClawImageUrl(null), '');

    assert.equal(sniffImageMagic(PNG_BYTES), 'image/png');
    assert.equal(sniffImageMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
    assert.equal(sniffImageMagic(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])), 'image/gif');
    assert.equal(sniffImageMagic(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0])), 'image/webp');
    assert.equal(sniffImageMagic(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), '', '密文/杂数据不得当图片');
});

test('ClawBot - base64 aeskey 按 AES-128-CBC 解密（IV 即密钥），密钥非法返回空', async () => {
    const keyBytes = new Uint8Array(16).fill(0x2a);
    const cipher = await encryptBytes(PNG_BYTES, keyBytes);
    assert.equal(sniffImageMagic(cipher), '', '密文本身不该被当成图片');
    const plain = await decryptClawImage(cipher, Buffer.from(keyBytes).toString('base64'));
    assert.ok(plain, '合法密钥必须能解出明文');
    assert.equal(sniffImageMagic(plain), 'image/png');
    assert.equal(await decryptClawImage(cipher, 'not-base64!!'), null);
    assert.equal(await decryptClawImage(cipher, ''), null);
    assert.equal(await decryptClawImage(cipher, Buffer.from(new Uint8Array(8)).toString('base64')), null, '长度不是 16 字节的密钥要用不了');
});

test('ClawBot - aeskey 兼容 32 位 hex 与 base64，AES-256 的 IV 仍取前 16 字节', async () => {
    const keyBytes = new Uint8Array(16).fill(0x2a);
    const hexKey = Buffer.from(keyBytes).toString('hex');
    assert.equal(hexKey.length, 32, '线上实测的 aeskey 就是 32 位 hex');
    assert.equal(aesKeyKind(hexKey), 'hex-16');
    assert.deepEqual(Array.from(decodeAesKey(hexKey)), Array.from(keyBytes));
    assert.equal(aesKeyKind(Buffer.from(keyBytes).toString('base64')), 'base64-16');
    assert.equal(aesKeyKind(''), 'none:0');
    assert.equal(decodeAesKey('not-base64!!'), null);
    assert.equal(decodeAesKey('0011223344'), null, '长度不足 16 字节的 hex 不是密钥');

    const cipher = await encryptBytes(PNG_BYTES, keyBytes);
    assert.equal(sniffImageMagic(await decryptClawImage(cipher, hexKey)), 'image/png', 'hex 密钥必须能解开');
    const key32 = new Uint8Array(32).fill(0x11);
    const hex32 = Buffer.from(key32).toString('hex');
    assert.equal(aesKeyKind(hex32), 'hex-32');
    const cipher32 = await encryptBytes(PNG_BYTES, key32);
    assert.equal(sniffImageMagic(await decryptClawImage(cipher32, hex32)), 'image/png', 'AES-256 用前 16 字节当 IV');
});

test('ClawBot - media.aes_key 是「hex 再 base64」的中间层，且全零 IV 也能兜底', async () => {
    const keyBytes = new Uint8Array(16).fill(0x5d);
    const hexAscii = Buffer.from(keyBytes).toString('hex');
    const wrapped = Buffer.from(hexAscii, 'utf8').toString('base64');
    assert.equal(unwrapHexAsciiKey(wrapped), hexAscii, '先 base64 再 hex 还原出真正的密钥串');
    assert.equal(unwrapHexAsciiKey('deadbeef'), '', '本来就是 hex 的不再包一层');
    assert.equal(unwrapHexAsciiKey('not-base64!!'), '');
    assert.deepEqual(clawImageKeys({ media: { aes_key: wrapped } }).map(k => k.tag), ['media.aes_key', 'media.aes_key>hex']);

    const cipher = await encryptBytes(PNG_BYTES, keyBytes);
    assert.equal(sniffImageMagic(await decryptClawImage(cipher, wrapped)), '', '中间层密钥直接当 base64 用是解不开的');
    assert.equal(sniffImageMagic(await decryptClawImage(cipher, wrapped)), '', '仍然解不开');

    const zeroIvCipher = await encryptBytes(PNG_BYTES, keyBytes, new Uint8Array(16));
    assert.equal(sniffImageMagic(await decryptClawImage(zeroIvCipher, hexAscii)), '', 'IV 不匹配时按 IV=密钥 解不开');
    assert.equal(sniffImageMagic(await decryptClawImage(zeroIvCipher, hexAscii, crypto, 'zero')), 'image/png', '全零 IV 作为兜底');

    const { impl } = stubFetch({ 'direct.bin': () => ({ bytes: zeroIvCipher }) });
    const got = await downloadClawImage({ media: { full_url: 'https://cdn.example/direct.bin', aes_key: wrapped } }, impl);
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.note, 'aes-hex-16:iv0/direct+media.aes_key>hex');
});

test('ClawBot - 图片地址与密钥多形态兜底：授权查询参数 + media.aes_key', async () => {
    const keyBytes = new Uint8Array(16).fill(0x7c);
    const cipher = await encryptBytes(PNG_BYTES, keyBytes);
    const imageItem = {
        aeskey: 'aa'.repeat(16),
        media: {
            full_url: 'https://cdn.example/direct.bin',
            encrypt_query_param: 'EQP-1',
            aes_key: Buffer.from(keyBytes).toString('base64')
        }
    };
    const urlTags = clawImageUrlCandidates(imageItem).map(u => u.tag);
    assert.equal(urlTags[0], 'direct');
    assert.ok(urlTags.includes('encrypt_query_param'), JSON.stringify(urlTags));
    assert.ok(urlTags.includes('encrypted_query_param'), '参数名两种拼法都要试');
    assert.ok(urlTags.length <= 6, JSON.stringify(urlTags));
    assert.deepEqual(clawImageKeys(imageItem).map(k => k.tag), ['item', 'media.aes_key']);

    const { impl, calls } = stubFetch({
        'encrypt_query_param=': () => ({ bytes: cipher }),
        'direct.bin': () => ({ bytes: new Uint8Array([0x3c, 0x21, 0x44, 0x4f]) })
    });
    const got = await downloadClawImage(imageItem, impl);
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.mime, 'image/png');
    assert.equal(got.note, 'aes-base64-16/encrypt_query_param+media.aes_key');
    assert.equal(calls.length, 2, '先试直链（HTML 错误页）再试带授权参数的地址');
});

test('ClawBot - 全部候选都失败时给出可判读原因码与响应头字节', async () => {
    const imageItem = { aeskey: 'bb'.repeat(16), media: { full_url: 'https://cdn.example/bad.bin' } };
    const { impl } = stubFetch({ 'bad.bin': () => ({ bytes: new Uint8Array([0x3c, 0x21, 0x44, 0x4f, 0x43]) }) });
    const got = await downloadClawImage(imageItem, impl);
    assert.equal(got.ok, false);
    assert.ok(/^not-an-image:5 head=3c21444f43 tried=/.test(got.note), got.note);
    assert.ok(got.note.includes('direct+item:hex-16:ecb:fail'), got.note);
    assert.equal(got.head, '3c21444f43', '只记前 8 字节的十六进制（这里只有 5 字节）');
});

test('ClawBot - AES-128-ECB 与 node:crypto 对齐，填充非法即拒（v2.5.126 的主力解密方式）', () => {
    for (const len of [16, 200, 4096]) {
        const key = new Uint8Array(randomBytes(16));
        const plain = new Uint8Array(randomBytes(len));
        const got = aes128EcbDecrypt(encryptEcbBytes(plain, key), key);
        assert.ok(got, '合法密文必须能解开，len=' + len);
        assert.deepEqual(Array.from(got), Array.from(plain), 'len=' + len);
    }
    assert.equal(aes128EcbDecrypt(new Uint8Array(32), new Uint8Array(16)), null, '全零密文的填充必然非法');
    assert.equal(aes128EcbDecrypt(new Uint8Array([1, 2, 3]), new Uint8Array(16)), null, '长度不是 16 的倍数');
    assert.equal(aes128EcbDecrypt(new Uint8Array(32), new Uint8Array(8)), null, '密钥必须是 16 字节');
});

test('ClawBot - 线上实测形态：item aeskey（hex）+ ECB 密文，ECB 优先于 CBC', async () => {
    const keyBytes = new Uint8Array(16).fill(0x91);
    const cipher = encryptEcbBytes(PNG_BYTES, keyBytes);
    const item = { aeskey: Buffer.from(keyBytes).toString('hex'), media: { full_url: 'https://cdn.example/ecb.bin' } };
    const { impl, calls } = stubFetch({ 'ecb.bin': () => ({ bytes: cipher }) });
    const got = await downloadClawImage(item, impl);
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.mime, 'image/png');
    assert.equal(got.note, 'aes-hex-16:ecb/direct+item', 'ECB 是主力方式，且优先尝试');
    assert.equal(calls.length, 1, '第一对候选就成功，不再浪费请求');
    assert.equal(got.bytes.length, PNG_BYTES.length, '拿到的是解密后的明文');
});

integration('ClawBot - 微信发图只暂存不落库，等「记录」才写成带图随手记', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const puts = [];
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-IMG', msgs: [imageMessage()] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } }),
        'cdn.example/photo.png': () => ({ bytes: PNG_BYTES })
    });
    await pollClawAccounts(mediaEnv(db, puts), db, st.impl, { budgetMs: 0 });

    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '没确认之前绝不能落库');
    const pending = await db.prepare('SELECT content, media_url FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    assert.ok(pending, '图片必须进待存位');
    assert.equal(pending.content, '来自微信的图片');
    assert.match(pending.media_url, /^\/api\/file\/[0-9a-f-]+\?t=[0-9a-f-]+$/, '存的是可长期直读的 /api/file 地址');
    const files = await db.prepare('SELECT COUNT(*) AS n FROM files').first();
    assert.equal(files.n, 1, '二进制必须进 files 表');
    assert.equal(puts.length, 1, '二进制必须进 R2');
    assert.equal(puts[0].type, 'image/png');
    assert.match(puts[0].key, /^uploads\/1\//);
    assert.equal(puts[0].size, PNG_BYTES.length);
    const send = st.calls.find(c => c.url.endsWith('/sendmessage'));
    assert.ok(send, '必须回一条消息');
    const reply = send.body.msg.item_list[0].text_item.text;
    assert.match(reply, /记录/, '要告诉用户怎么确认');
    assert.ok(!/已存入/.test(reply), '没确认就不能说已经存好');
    assert.equal(send.body.msg.context_token, 'CTX-IMG');
});

integration('ClawBot - 图 + 文字时配文成为待存正文，AES 加密的图先解密再入库', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const puts = [];
    const keyBytes = new Uint8Array(16).fill(0x5c);
    const cipher = await encryptBytes(PNG_BYTES, keyBytes);
    const item = imageMessage();
    item.item_list = [
        { type: 1, msg_id: 'CAP-1', text_item: { text: '今晚的月亮' } },
        { type: 2, msg_id: 'ENC-1', image_item: { aeskey: Buffer.from(keyBytes).toString('hex'), media: 'https://cdn.example/secret.bin' } }
    ];
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-ENC', msgs: [item] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } }),
        'cdn.example/secret.bin': () => ({ bytes: cipher })
    });
    await pollClawAccounts(mediaEnv(db, puts), db, st.impl, { budgetMs: 0 });

    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '未确认前不得落库');
    const pending = await db.prepare('SELECT content FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    assert.equal(pending.content, '今晚的月亮', '配文优先于默认文案');
    assert.equal(puts[0].size, PNG_BYTES.length, '进 R2 的必须是解密后的明文长度');
    assert.equal(puts[0].type, 'image/png');
});

integration('ClawBot - ECB 加密（线上真实形态）的微信图片先解密进待存位', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const puts = [];
    const keyBytes = new Uint8Array(16).fill(0x4e);
    const cipher = encryptEcbBytes(PNG_BYTES, keyBytes);
    const item = imageMessage();
    item.item_list = [{
        type: 2,
        msg_id: 'ECB-1',
        image_item: {
            aeskey: Buffer.from(keyBytes).toString('hex'),
            media: {
                full_url: 'https://cdn.example/ecb-real.bin',
                aes_key: Buffer.from(keyBytes).toString('base64'),
                encrypt_query_param: 'EQP'
            }
        }
    }];
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-ECB', msgs: [item] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } }),
        'ecb-real.bin': () => ({ bytes: cipher })
    });
    await pollClawAccounts(mediaEnv(db, puts), db, st.impl, { budgetMs: 0 });

    const pending = await db.prepare('SELECT content, media_url FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    assert.ok(pending, 'ECB 密文解出来后必须进待存位');
    assert.equal(pending.content, '来自微信的图片');
    assert.match(pending.media_url, /^\/api\/file\//);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '未确认前不得落库');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].size, PNG_BYTES.length, '进 R2 的必须是解密后的明文长度');
    assert.equal(puts[0].type, 'image/png');
    const reply = st.calls.find(c => c.url.endsWith('/sendmessage')).body.msg.item_list[0].text_item.text;
    assert.match(reply, /记录/);
    assert.ok(!/已存入/.test(reply), '没确认就不能说已存');
});

integration('ClawBot - 原图取不到时如实告知，不写任何数据', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const puts = [];
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-404', msgs: [imageMessage()] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } }),
        'cdn.example/photo.png': () => ({ status: 404, json: {} })
    });
    await pollClawAccounts(mediaEnv(db, puts), db, st.impl, { budgetMs: 0 });

    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '取不到图就不能落库');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM files').first()).n, 0);
    assert.equal(puts.length, 0);
    const send = st.calls.find(c => c.url.endsWith('/sendmessage'));
    assert.match(send.body.msg.item_list[0].text_item.text, /拿不到原图/);
    assert.ok(!/已存入/.test(send.body.msg.item_list[0].text_item.text), '失败时绝不能宣称保存');
});

integration('ClawBot - 既无文字也无图片的消息静默丢弃（语音等仍不支持）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const msg = imageMessage();
    msg.item_list = [{ type: 3, msg_id: 'VOICE-1', voice_item: { duration: 3 } }];
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-VOICE', msgs: [msg] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });

    assert.equal(st.calls.filter(c => c.url.endsWith('/sendmessage')).length, 0, '不支持的类型不该回复');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_chat_turns').first()).n, 0);
});

integration('Bot - 重置对话只清上下文，不动档案与花园记录', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await buildBotReply({}, db, 1, '记住：我喜欢雨天');
    await buildBotReply({}, db, 1, '记录：明天买牛奶');
    assert.ok((await loadChatContext(db, 1)).length > 0);

    assert.match(await buildBotReply({}, db, 1, '重置对话'), /清空/);
    assert.equal((await loadChatContext(db, 1)).length, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_chat_turns WHERE is_deleted = 0').first()).n, 0);
    assert.ok((await db.prepare('SELECT COUNT(*) AS n FROM bot_chat_turns').first()).n > 0, '重置必须软删，行还在');
    assert.equal((await listProfile(db, 1)).length, 1, '档案不受影响');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 1, '花园记录不受影响');
});

integration('Bot - 提示词带人格边界、档案与最近上下文（旧→新）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await buildBotReply({}, db, 1, '记住：我习惯晚上写周记');
    await buildBotReply({}, db, 1, '最近有点累');

    let messages = null;
    const env = { AI: { run: async (model, opts) => { messages = opts.messages; return { response: '我在听。' }; } } };
    assert.equal(await buildBotReply(env, db, 1, '在吗'), '我在听。');
    assert.ok(messages, '必须真的调用模型');
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /关于我/, '必须注入个人档案块');
    assert.match(messages[0].content, /晚上写周记/);
    assert.match(messages[0].content, /东八区/, '必须给模型时间锚点');
    assert.match(messages[0].content, /不是存储工具/, '人格边界必须进提示词');
    assert.equal(messages[messages.length - 1].content, '在吗');
    const roles = messages.slice(1, -1).map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant'], '上下文按旧→新注入，实际：' + JSON.stringify(roles));
});
/** 应用内档案接口的请求替身：与网关一样把 URL、方法、JSON body 交给处理器 */
function profileCall(method, path, body) {
    const init = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return new Request('https://chillin.example' + path, init);
}

integration('Bot - 应用内档案接口支持查看/新增/编辑/遗忘，删除全部走软删', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const call = (method, path, body) => handleBotProfileApi(profileCall(method, path, body), {}, new URL('https://chillin.example' + path), db, 1);

    let res = await call('POST', '/api/bot/profile', { content: '我不吃香菜' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, duplicate: false });

    res = await call('POST', '/api/bot/profile', { content: '我不吃香菜' });
    assert.equal((await res.json()).duplicate, true, '内容重复只提示、不重复入库');
    assert.equal((await listProfile(db, 1)).length, 1);

    res = await call('GET', '/api/bot/profile');
    const list = await res.json();
    assert.equal(list.items.length, 1);
    assert.equal(list.maxItems, PROFILE_MAX_ITEMS);
    assert.equal(list.itemMaxChars, 240);
    assert.equal(list.items[0].content, '我不吃香菜');

    const id = list.items[0].id;
    res = await call('PUT', '/api/bot/profile/' + id, { content: '我不吃香菜和葱' });
    assert.equal(res.status, 200);
    assert.deepEqual((await listProfile(db, 1)).map((it) => it.content), ['我不吃香菜和葱']);

    res = await call('DELETE', '/api/bot/profile/' + id);
    assert.equal(res.status, 200);
    assert.equal((await listProfile(db, 1)).length, 0);
    const row = await db.prepare('SELECT is_deleted FROM bot_profile WHERE id = ?1').bind(id).first();
    assert.equal(row.is_deleted, 1, '应用内删除也必须是软删，行还在');
    assert.deepEqual(await forgetProfileById(db, 1, 'abc'), { removed: 0 }, '非法 id 直接拒绝');

    res = await call('DELETE', '/api/bot/profile/' + id);
    assert.equal(res.status, 404, '已遗忘的条目再删应报不存在');
    res = await call('POST', '/api/bot/profile', { content: '' });
    assert.equal(res.status, 400, '空内容拒绝写入');
    res = await call('PUT', '/api/bot/profile/999999', { content: '改一条不存在的' });
    assert.equal(res.status, 404);
    res = await call('GET', '/api/bot/profile/nope');
    assert.equal(res.status, 404, '前缀下未定义的路径一律 404');
});

integration('Bot - 档案接口跨用户隔离：改不动也删不掉别人的条目', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);
    const call = (user, method, path, body) => handleBotProfileApi(profileCall(method, path, body), {}, new URL('https://chillin.example' + path), db, user);
    await call(1, 'POST', '/api/bot/profile', { content: '我在写一本小说' });
    const mine = (await (await call(1, 'GET', '/api/bot/profile')).json()).items;
    assert.equal(mine.length, 1);

    assert.equal((await (await call(2, 'GET', '/api/bot/profile')).json()).items.length, 0, '档案按用户隔离');
    assert.equal((await call(2, 'PUT', '/api/bot/profile/' + mine[0].id, { content: '被篡改' })).status, 404);
    assert.equal((await call(2, 'DELETE', '/api/bot/profile/' + mine[0].id)).status, 404);
    assert.equal((await call(2, 'POST', '/api/bot/profile/clear')).status, 200, '清空只作用于自己');
    assert.equal((await listProfile(db, 1))[0].content, '我在写一本小说', '别人的档案毫发无伤');
});

integration('Bot - 档案到 24 条上限后拒绝新增，绝不写进库却读不出来', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    for (let i = 1; i <= PROFILE_MAX_ITEMS; i++) await addProfileItem(db, 1, '偏好 ' + i);
    assert.equal((await listProfile(db, 1)).length, PROFILE_MAX_ITEMS);

    const full = await addProfileItem(db, 1, '第 25 条');
    assert.equal(full.ok, false);
    assert.equal(full.full, true, '必须显式报告满了，不能静默写入');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_profile').first()).n, PROFILE_MAX_ITEMS);
    assert.match(await buildBotReply({}, db, 1, '记住：第 25 条'), /最多记 24 条/);

    const res = await handleBotProfileApi(profileCall('POST', '/api/bot/profile', { content: '第 25 条' }), {}, new URL('https://chillin.example/api/bot/profile'), db, 1);
    assert.equal(res.status, 409);
    assert.equal((await updateProfileItem(db, 1, 1, '')).ok, false, '空内容不算一次合法编辑');
});

integration('Bot - 网关把 /api/bot/profile 挂在登录态之后（未登录 401）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const res = await api.fetch(new Request('https://chillin.example/api/bot/profile'), { DB: db }, ctx);
    assert.equal(res.status, 401);
});

/** 看图环境：R2 替身 + 一把可用的视觉密钥（AI 绑定照旧一调就炸，描述只走 VISION_API_KEY 的兼容端点） */
const VISION_ROUTE = 'vision.example/v1/chat/completions';

function visionEnv(db, puts, overrides = {}) {
    return {
        ...mediaEnv(db, puts),
        VISION_API_KEY: 'sk-test-vision',
        VISION_API_BASE: 'https://vision.example/v1',
        ...overrides
    };
}

test('ClawBot - 看图：取回并压平描述、超长截断、没密钥不发请求、报错与违规都只当没描述', async () => {
    const env = { VISION_API_KEY: 'sk-x', VISION_API_BASE: 'https://vision.example/v1' };
    const ok = stubFetch({ [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '  一只黑猫\n蹲在窗台上  ' } }] } }) });
    assert.equal(await describeClawImageContent(env, PNG_BYTES, 'image/png', ok.impl), '一只黑猫 蹲在窗台上');
    assert.equal(ok.calls.length, 1);
    assert.equal(ok.calls[0].body.model, 'deepseek-chat', '默认走 deepseek-chat（flash 的思考会吃光 max_tokens）');
    assert.equal(ok.calls[0].init.headers.Authorization, 'Bearer sk-x');
    assert.match(ok.calls[0].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

    const long = stubFetch({ [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '猫'.repeat(400) } }] } }) });
    assert.equal((await describeClawImageContent(env, PNG_BYTES, 'image/png', long.impl)).length, 120, '描述必须截断到 120 字');

    const noKey = stubFetch({ [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '不该被调用' } }] } }) });
    assert.equal(await describeClawImageContent({}, PNG_BYTES, 'image/png', noKey.impl), '', '没有密钥就一字不取');
    assert.equal(noKey.calls.length, 0, '没有密钥绝不发请求');

    const bad = stubFetch({ [VISION_ROUTE]: () => ({ status: 500, json: {} }) });
    assert.equal(await describeClawImageContent(env, PNG_BYTES, 'image/png', bad.impl), '', '模型报错只当没有描述');

    const empty = stubFetch({ [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '   ' } }] } }) });
    assert.equal(await describeClawImageContent(env, PNG_BYTES, 'image/png', empty.impl), '');

    const boom = async () => { throw new Error('network down'); };
    assert.equal(await describeClawImageContent(env, PNG_BYTES, 'image/png', boom), '', '网络异常必须吞掉，不能把存图一起拖下水');

    const blocked = stubFetch({ [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '这是赌博网站' } }] } }) });
    assert.equal(await describeClawImageContent(env, PNG_BYTES, 'image/png', blocked.impl), '', '硬违规描述必须丢掉');

    const soft = stubFetch({ [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '加微信看更多' } }] } }) });
    assert.equal(await describeClawImageContent(env, PNG_BYTES, 'image/png', soft.impl), '****看更多', '软违规词沿用既有替换策略');
});

integration('ClawBot - 图 + 配文时先把描述说给用户，回「记录」才落库', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const puts = [];
    const msg = imageMessage();
    msg.item_list = [
        { type: 1, msg_id: 'CAP-VIS', text_item: { text: '今晚的月亮' } },
        { type: 2, msg_id: 'IMG-VIS', image_item: { aeskey: '', media: 'https://cdn.example/photo.png' } }
    ];
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-VIS', msgs: [msg] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } }),
        'cdn.example/photo.png': () => ({ bytes: PNG_BYTES }),
        [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '窗台上蹲着一只黑猫' } }] } })
    });
    await pollClawAccounts(visionEnv(db, puts), db, st.impl, { budgetMs: 0 });

    const pending = await db.prepare('SELECT content, media_url FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    assert.equal(pending.content, '今晚的月亮\n\n窗台上蹲着一只黑猫', '描述与配文一起进待存位');
    assert.match(pending.media_url, /^\/api\/file\//);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '未确认前不得落库');
    const send = st.calls.find(c => c.url.endsWith('/sendmessage'));
    const reply = send.body.msg.item_list[0].text_item.text;
    assert.match(reply, /我看到：窗台上蹲着一只黑猫/, '回信要把看到的内容说给用户');
    assert.match(reply, /记录/, '要告诉用户怎么确认');
    assert.ok(!/已存入/.test(reply), '没确认就不能说已存');
    assert.equal(send.body.msg.context_token, 'CTX-IMG');

    // 回一句「记录」才真的落库；确认后待存位作废，再说一次不会重复入库
    assert.match(await buildBotReply({}, db, 1, '记录'), /已存入/);
    const feed = await db.prepare('SELECT content, type, media_url FROM quick_feeds WHERE user_id = 1').first();
    assert.equal(feed.content, '今晚的月亮\n\n窗台上蹲着一只黑猫');
    assert.equal(feed.type, 'image');
    assert.equal(feed.media_url, pending.media_url, '存的还是同一张图');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media WHERE is_deleted = 0').first()).n, 0, '确认后待存位要作废');
    assert.match(await buildBotReply({}, db, 1, '记录'), /没有等着存的图片/, '再确认一次要如实说明');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 1, '不能重复入库');
});

integration('ClawBot - 看图失败绝不连坐：图片仍暂存，回信也不编造描述', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const puts = [];
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-NOVIS', msgs: [imageMessage()] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } }),
        'cdn.example/photo.png': () => ({ bytes: PNG_BYTES }),
        [VISION_ROUTE]: () => ({ status: 503, json: {} })
    });
    await pollClawAccounts(visionEnv(db, puts), db, st.impl, { budgetMs: 0 });

    const pending = await db.prepare('SELECT content FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    assert.equal(pending.content, '来自微信的图片', '拿不到描述也要照常暂存');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0);
    assert.equal(puts.length, 1, '二进制照样进 R2');
    const reply = st.calls.find(c => c.url.endsWith('/sendmessage')).body.msg.item_list[0].text_item.text;
    assert.match(reply, /记录/);
    assert.ok(!/我看到/.test(reply), '没有描述就不能编一个');
    assert.ok(!/已存入/.test(reply), '没确认就不能说已存');
});

integration('Bot - 待存图片过期后「记录」不会翻旧账，也不会写库', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await savePendingMedia(db, 1, '/api/file/old-img?t=tok', '两个小时前那张图');
    await db.prepare("UPDATE bot_pending_media SET created_at = datetime('now', '+8 hours', '-2 hours') WHERE user_id = 1").run();

    assert.match(await buildBotReply({}, db, 1, '记录'), /没有等着存的图片/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '过期图绝不能落库');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media WHERE is_deleted = 0').first()).n, 1, '过期行仍在，只是读不到');
});

integration('Bot - 「记录：内容」仍然直达随手记，不被待存确认抢走', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await savePendingMedia(db, 1, '/api/file/pending-img?t=tok', '一张还没确认的图');

    assert.match(await buildBotReply({}, db, 1, '记录：明天买牛奶'), /已存入/);
    const feed = await db.prepare('SELECT content FROM quick_feeds WHERE user_id = 1').first();
    assert.equal(feed.content, '明天买牛奶', '带内容的记录不能被待存图抢走');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media WHERE is_deleted = 0').first()).n, 1, '待存图仍在等确认');
});
