import test from 'node:test';
import assert from 'node:assert/strict';
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
import { CLAW_CRON, runScheduled } from '../workers/src/maintenance.js';

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

integration('ClawBot - 长轮询把消息落成随手记并回复，游标同时持久化', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-1', msgs: [clawMessage()] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });

    const feed = await db.prepare('SELECT content, type FROM quick_feeds').first();
    assert.equal(feed.content, '今晚手冲咖啡，水温 92 度');
    assert.equal(feed.type, 'text');

    const row = await db.prepare('SELECT cursor, last_poll_at FROM bot_claw_accounts WHERE id = 1').first();
    assert.equal(row.cursor, 'CURSOR-1');
    assert.ok(row.last_poll_at, '必须记录轮询时间');

    assert.equal(st.calls[0].url, OFFICIAL + '/ilink/bot/getupdates');
    assert.equal(st.calls[0].body.get_updates_buf, 'CURSOR-0');
    const send = st.calls.find(c => c.url.endsWith('/sendmessage'));
    assert.ok(send, '必须回一条消息');
    assert.equal(send.body.msg.context_token, 'CTX-1');
    assert.equal(send.body.msg.to_user_id, 'owner@im.wechat');
    assert.match(send.body.msg.item_list[0].text_item.text, /随手记/);
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

    const count = await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first();
    assert.equal(count.n, 1);
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
    const feed = await db.prepare('SELECT content FROM quick_feeds').first();
    assert.equal(feed.content, '今晚手冲咖啡，水温 92 度');
    assert.equal(st.calls.filter(c => c.url.endsWith('/sendmessage')).length, 1, '同一条消息同一调用内只回一次');

    // 预算为 0 时必须只拉一轮，循环不能空转
    st.calls.length = 0;
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });
    assert.equal(st.calls.filter(c => c.url.endsWith('/getupdates')).length, 1);
});
