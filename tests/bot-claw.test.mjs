import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import api from '../workers/api.js';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import {
    ilinkUin,
    ilinkHeaders,
    ilinkBase,
    ilinkRedirectBase,
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
import { describeClawImageContent, analyzeClawImages, isDeepVisionQuestion } from '../workers/src/bot-vision.js';
import { maybeClawImageFollowUp } from '../workers/src/bot-image-flow.js';
import { callCustomLlmWithMessages } from '../workers/src/llm.js';
import { CLAW_CRON, runScheduled } from '../workers/src/maintenance.js';
import {
    parseRecordCommand,
    parseBookmarkCommand,
    parsePromptCommand,
    parseRememberCommand,
    parseForgetCommand,
    normalizeCommandText,
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
import {
    listPreferences,
    loadPreferencePrompt,
    detectFeedbackPreference,
    handleBotPreferencesApi,
    PREF_MAX_ITEMS
} from '../workers/src/bot-preferences.js';
import {
    extractFirstUrl,
    isAllowedOutboundUrl,
    parseXiaoyuzhouUrl,
    parseXiaoyuzhouPage,
    LINK_DESC_MAX_CHARS,
    handleClawLinkMessage,
    buildManualLinkCard,
    readerEndpoint,
    parseReaderMetadata,
    LINK_HTML_MAX_BYTES,
    LINK_READER_DEFAULT_URL,
    xiaoyuzhouHostOf
} from '../workers/src/bot-links.js';

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
                if (r.response) return r.response;
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

test('ClawBot - 扫码重定向主机只接受微信 HTTPS 域名', () => {
    assert.equal(ilinkRedirectBase('ilink2.weixin.qq.com'), 'https://ilink2.weixin.qq.com');
    assert.equal(ilinkRedirectBase('https://ilink2.weixin.qq.com/'), 'https://ilink2.weixin.qq.com');
    assert.equal(ilinkRedirectBase('https://weixin.qq.com'), 'https://weixin.qq.com');
    assert.equal(ilinkRedirectBase('evil.example'), '');
    assert.equal(ilinkRedirectBase('http://ilink2.weixin.qq.com'), '');
    assert.equal(ilinkRedirectBase('https://ilink2.weixin.qq.com/path'), '');
    assert.equal(ilinkRedirectBase('https://ilink2.weixin.qq.com@evil.example'), '');
    assert.equal(ilinkRedirectBase(''), '');
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

integration('ClawBot - scaned_but_redirect 先持久化新主机，再在新主机完成确认', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const redirectBase = 'https://ilink2.weixin.qq.com';
    const st = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-REDIRECT', qrcode_img_content: 'https://x/qr.png' } }),
        '/ilink/bot/get_qrcode_status': (u) => u.startsWith(redirectBase)
            ? { json: { status: 'confirmed', bot_token: 'BOT-R', baseurl: redirectBase, ilink_bot_id: 'bot-r@im.bot', ilink_user_id: 'owner@im.wechat' } }
            : { json: { status: 'scaned_but_redirect', redirect_host: 'ilink2.weixin.qq.com' } }
    });
    await startClawLogin({}, db, 1, st.impl);
    const redirected = await checkClawLogin({}, db, 1, st.impl);
    assert.equal(redirected.status, 'scaned_but_redirect');
    assert.match(redirected.message, /切换微信节点/);
    let row = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row.status, 'pending');
    assert.equal(row.baseurl, redirectBase, '重定向主机必须落库，下一次 check 才会去新主机');
    assert.equal(row.qrcode, 'QR-REDIRECT');
    assert.ok(st.calls[0].url.startsWith(OFFICIAL), '第一次仍从官方主机开始');
    assert.ok(st.calls[1].url.startsWith(OFFICIAL), '第一次状态查询仍走官方主机');

    const bound = await checkClawLogin({}, db, 1, st.impl);
    assert.equal(bound.bound, true);
    assert.equal(bound.ilinkBotId, 'bot-r@im.bot');
    assert.equal(JSON.stringify(bound).includes('BOT-R'), false);
    assert.ok(st.calls[2].url.startsWith(redirectBase), '确认前必须先去 redirect_host 轮询');
    row = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row.status, 'bound');
    assert.equal(row.baseurl, redirectBase);
});

integration('ClawBot - binded_redirect 清掉二维码并给出明确提示，不假装绑定', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const st = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-BOUNDED' } }),
        '/ilink/bot/get_qrcode_status': () => ({ json: { status: 'binded_redirect' } })
    });
    await startClawLogin({}, db, 1, st.impl);
    const out = await checkClawLogin({}, db, 1, st.impl);
    assert.equal(out.bound, false);
    assert.equal(out.status, 'binded_redirect');
    assert.match(out.message, /绑定过其他 ClawBot 实例/);
    const row = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row.status, 'error');
    assert.equal(row.qrcode, '', '终态必须清二维码，否则界面会一直等待');
    assert.match(row.last_error, /绑定过其他 ClawBot 实例/);

    const res = await handleClawApi(
        new Request('https://chillin.example/api/bot/claw/status'), {},
        new URL('https://chillin.example/api/bot/claw/status'), db, 1
    );
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.match(body.lastError, /绑定过其他 ClawBot 实例/);
});

integration('ClawBot - need_verifycode / verify_code_blocked / 未知状态都不再无限等待', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    let nextStatus = 'need_verifycode';
    const st = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-VERIFY-' + nextStatus } }),
        '/ilink/bot/get_qrcode_status': () => ({ json: { status: nextStatus } })
    });

    for (const expected of ['need_verifycode', 'verify_code_blocked']) {
        nextStatus = expected;
        await startClawLogin({}, db, 1, st.impl);
        const out = await checkClawLogin({}, db, 1, st.impl);
        assert.equal(out.status, expected);
        assert.ok(out.message && out.message.length > 0, expected + ' 必须有可展示的提示');
        const row = await db.prepare('SELECT status, qrcode FROM bot_claw_accounts WHERE user_id = 1').first();
        assert.equal(row.status, 'error');
        assert.equal(row.qrcode, '');
    }

    nextStatus = 'some_future_status';
    await startClawLogin({}, db, 1, st.impl);
    const unknown = await checkClawLogin({}, db, 1, st.impl);
    assert.equal(unknown.status, 'error');
    assert.match(unknown.message, /未知扫码状态/);
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
    assert.equal(row.ilink_bot_id, '', '解绑后不应继续保留上一台机器人的身份');
    assert.equal(row.ilink_user_id, '', '解绑后不应继续保留微信侧身份');
    assert.equal(Number(row.bound_at_ms), 0, '解绑后绑定时刻应清零');
});

integration('ClawBot - 已绑定时拒绝重新取二维码，旧令牌不被清空', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const before = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();

    const res = await handleClawApi(
        new Request('https://chillin.example/api/bot/claw/qrcode', { method: 'POST' }),
        {}, new URL('https://chillin.example/api/bot/claw/qrcode'), db, 1
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /先解绑/);

    const after = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(after.status, 'bound');
    assert.equal(after.bot_token, before.bot_token, '拒绝请求时不得动现有令牌');
    assert.equal(after.qrcode, before.qrcode);
});

integration('ClawBot - 解绑后可重新扫码绑定（软删行必须复活）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    await unbindClaw(db, 1);

    const st = stubFetch({
        '/ilink/bot/get_bot_qrcode': () => ({ json: { qrcode: 'QR-AGAIN', qrcode_img_content: 'https://x/qr2.png' } }),
        '/ilink/bot/get_qrcode_status': () => ({
            json: {
                status: 'confirmed', bot_token: 'TOKEN-2', baseurl: OFFICIAL,
                ilink_bot_id: 'bot2@im.bot', ilink_user_id: 'owner2@im.wechat'
            }
        })
    });

    const started = await startClawLogin({}, db, 1, st.impl);
    assert.equal(started.qrcode, 'QR-AGAIN');
    const pending = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(pending.is_deleted, 0, '重新绑定必须先复活软删行，否则 check 永远查不到它');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.bot_token, '', '生成新二维码时不得沿用旧令牌');

    const bound = await checkClawLogin({}, db, 1, st.impl);
    assert.equal(bound.bound, true, '复活后的 pending 行必须能完成确认');
    const row = await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = 1').first();
    assert.equal(row.is_deleted, 0);
    assert.equal(row.status, 'bound');
    assert.equal(row.bot_token, 'TOKEN-2');
    assert.equal(row.ilink_bot_id, 'bot2@im.bot');
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

integration('ClawBot - defer 交给 waitUntil 后台处理，轮询先返回再主动回推', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-DEFER', msgs: [clawMessage()] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    const tasks = [];
    await pollClawAccounts({ DB: db }, db, st.impl, {
        budgetMs: 0,
        defer: (task) => tasks.push(task)
    });
    assert.equal(tasks.length, 1, '一批消息必须注册一个 waitUntil 任务');
    await Promise.all(tasks);
    const send = st.calls.find(c => c.url.endsWith('/sendmessage'));
    assert.ok(send, '后台跑完后必须用主动发送接口回推');
    const turns = await db.prepare('SELECT COUNT(*) AS n FROM bot_chat_turns').first();
    assert.equal(turns.n, 2, '后台处理仍要落对话上下文');
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

integration('ClawBot - 瞬时 5xx 不丢整分钟的收信窗口：退避后接着拉，消息当轮就回', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const inbound = clawMessage();
    let round = 0;
    const st = stubFetch({
        '/ilink/bot/getupdates': () => {
            round++;
            // 第一轮模拟 iLink 520/503 这类瞬时错误，第二轮才把消息交出来
            if (round === 1) return { status: 503, json: {} };
            return { json: { ret: 0, get_updates_buf: 'CURSOR-R', msgs: [inbound] } };
        },
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    // errorBackoffMs 把退避压到 5ms，用例不真等 1 秒；budgetMs 模拟本次调用剩下的时间
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 250, errorBackoffMs: 5 });

    const polls = st.calls.filter(c => c.url.endsWith('/getupdates')).length;
    assert.ok(polls >= 2, '一次 5xx 之后必须在同一分钟内接着拉，而不是把整个窗口丢掉：' + polls);
    const send = st.calls.find(c => c.url.endsWith('/sendmessage'));
    assert.ok(send, '第二轮拉到的消息必须当轮就回信');
    const turns = await db.prepare('SELECT COUNT(*) AS n FROM bot_chat_turns').first();
    assert.equal(turns.n, 2, '消息被正常处理并留下对话上下文');
});

integration('ClawBot - scheduled 按 cron 分流：每分钟只轮询，小时维护不碰长轮询', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    assert.equal(CLAW_CRON, '* * * * *');

    const original = globalThis.fetch;
    const poll = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-9', msgs: [clawMessage()] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } })
    });
    const tasks = [];
    try {
        globalThis.fetch = poll.impl;
        await runScheduled({ DB: db }, { cron: CLAW_CRON }, { budgetMs: 0 }, { waitUntil: (task) => tasks.push(task) });
        assert.equal(tasks.length, 1, '网关必须把消息批次交给 ctx.waitUntil');
        await Promise.all(tasks);
    } finally { globalThis.fetch = original; }
    assert.equal(poll.calls.filter(c => c.url.endsWith('/getupdates')).length, 1, '单测把预算压到 0，只应有一轮长轮询');
    assert.ok(poll.calls.some(c => c.url.endsWith('/sendmessage')), 'waitUntil 任务跑完后必须主动回推');

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

// ── 朋友式助手：意图分流、个人档案与对话上下文 ──────────────────────────────

test('Bot - 记录/记住/忘记只认显式写法，含糊语气一律不判为写入', () => {
    assert.equal(parseRecordCommand('记录：今晚手冲咖啡，水温 92 度'), '今晚手冲咖啡，水温 92 度');
    assert.equal(parseRecordCommand('记一下 明天买牛奶'), '明天买牛奶');
    assert.equal(parseRecordCommand('记录一下今天开会被夸了'), '今天开会被夸了');
    assert.equal(parseRecordCommand('帮我记录：周四复诊'), '周四复诊');
    assert.equal(parseRecordCommand('今天天气不错'), null);
    assert.equal(parseRecordCommand('记录了这件事'), null, '叙述句不是指令');

    assert.equal(parseBookmarkCommand('收藏：Figma https://www.figma.com'), 'Figma https://www.figma.com');
    assert.equal(parseBookmarkCommand('帮我收藏一下 https://example.com/a'), 'https://example.com/a');
    assert.equal(parseBookmarkCommand('我收藏了这篇文章'), null, '叙述句不触发写入');
    assert.equal(parsePromptCommand('提示词：代码审查 | 请审查以下代码'), '代码审查 | 请审查以下代码');
    assert.equal(parsePromptCommand('提示词 怎么写'), null, '提问不是写入指令');

    assert.equal(parseRememberCommand('记住：我不吃香菜'), '我不吃香菜');
    assert.equal(parseRememberCommand('记住我不吃香菜'), '我不吃香菜');
    assert.equal(parseRememberCommand('记住'), null, '没有内容不写档案');
    assert.equal(parseRememberCommand('我记得你说过'), null);

    assert.deepEqual(parseForgetCommand('忘记 香菜'), { all: false, keyword: '香菜' });
    assert.deepEqual(parseForgetCommand('清空档案'), { all: true, keyword: '' });
    assert.equal(parseForgetCommand('忘了吧'), null, '「忘了吧」是语气词，不是遗忘指令');

    // 微信里转发/粘贴出来的内容常整句被引号、书名号或句号包着：
    // 2026-10-21 真机上「记录：<链接>」。就是这样被漏判、丢给模型编了一句「存好了 ✅」
    assert.equal(
        parseRecordCommand('「记录：https://www.xiaoyuzhoufm.com/episode/5e4a8c49418a84a046bb4fe2」。'),
        'https://www.xiaoyuzhoufm.com/episode/5e4a8c49418a84a046bb4fe2'
    );
    assert.equal(parseRecordCommand('“记录：明天买牛奶”'), '明天买牛奶');
    assert.equal(parseRecordCommand('《记录：他说「好的」》'), '他说「好的」', '剥掉最外层书名号，里面的引号不动');
    assert.equal(parseRememberCommand('「记住：我不吃香菜」'), '我不吃香菜');
    assert.deepEqual(parseForgetCommand('【忘记 香菜】'), { all: false, keyword: '香菜' });
    assert.equal(parseRecordCommand('随手记录一下今天的会议内容'), null, '剥包裹符不等于放宽到随便匹配');
    assert.equal(normalizeCommandText('  「重置对话」。  '), '重置对话');
    assert.equal(normalizeCommandText('记录：他说「好的」'), '记录：他说「好的」', '没收尾包裹符就不剥，正文里的引号原样留着');
});

test('Bot - 自己写了标题的「记录：<标题> <链接>」也能做成真卡片（零出站兜底）', () => {
    const url = 'https://www.xiaoyuzhoufm.com/episode/5e4a8c49418a84a046bb4fe2';
    const card = buildManualLinkCard('Ep204 未来生活指南｜刘德华给我发微信 ' + url);
    assert.equal(card.url, url);
    assert.equal(card.meta.title, 'Ep204 未来生活指南｜刘德华给我发微信');
    assert.equal(card.meta.platform, '小宇宙');
    assert.equal(card.meta.icon, '🎧');
    assert.equal(card.meta.cover, '', '抓不到封面就不编一个');
    assert.equal(buildManualLinkCard(url), null, '只有链接交回默认的「域名当标题」卡片');
    assert.equal(buildManualLinkCard('记录一下今天的会议'), null, '没有链接就不是链接卡片');
    const other = buildManualLinkCard('一篇好文章 https://example.com/a');
    assert.equal(other.meta.title, '一篇好文章');
    assert.equal(other.meta.platform, undefined, '非小宇宙域名不硬贴平台标签');
    assert.equal(buildManualLinkCard('x'.repeat(200) + ' ' + url).meta.title.length, 120, '标题按上限截断');
});

test('Bot - 帮助文案不再宣称「直接发文字存入随手记」', () => {
    assert.ok(!/直接发文字/.test(BOT_HELP_TEXT), '意图反转后帮助文案必须改写');
    assert.match(BOT_HELP_TEXT, /记录：/);
    assert.match(BOT_HELP_TEXT, /收藏：/);
    assert.match(BOT_HELP_TEXT, /提示词：/);
    assert.match(BOT_HELP_TEXT, /我的收藏/);
    assert.match(BOT_HELP_TEXT, /删提示词/);
    assert.match(BOT_HELP_TEXT, /重置对话/);
});

test('Bot - 来源脚注按需触发：只有索要依据的问法才算', () => {
    assert.equal(wantsEvidence('今天有点累'), false, '普通聊天不追问来源');
    assert.equal(wantsEvidence('记录：今天读了半小时书'), false);
    assert.equal(wantsEvidence('这个依据是什么'), true);
    assert.equal(wantsEvidence('你怎么知道我上周在读那本书'), true);
    assert.equal(wantsEvidence('说说来源'), true);
    assert.equal(wantsEvidence('刚才那些是哪查的'), true, '用户自己的说法必须认');
    assert.equal(wantsEvidence('这条消息怎么来的'), true);
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

integration('Bot - 普通闲聊不注入「未检索到记忆」的检索失败指令', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    let messages = null;
    const env = { AI: { run: async (model, opts) => { messages = opts.messages; return { response: '又咋了，今天碰上什么破事了？' }; } } };

    const reply = await buildBotReply(env, db, 1, '今天上班烦死了');
    assert.equal(reply, '又咋了，今天碰上什么破事了？');
    assert.ok(messages, '必须真的调用模型');
    assert.ok(!/未检索到/.test(messages[0].content), '闲聊没有记忆命中时，不能把「请告知没找到」塞进系统提示词');
    assert.ok(!/【花园记忆片段（历史事实/.test(messages[0].content), '没有命中时不要凭空注入记忆块');

    // 有旧记录，但「嗯」没有主题词：也不能把最近 5 条当成聊天素材硬塞进去
    await db.prepare(
        "INSERT INTO quick_feeds (id, user_id, content, created_at, updated_at, is_deleted) VALUES (?1, 1, ?2, datetime('now','+8 hours'), datetime('now','+8 hours'), 0)"
    ).bind(1799000000099, '上周在读《人类简史》，读到农业革命那一章').run();
    assert.equal(await buildBotReply(env, db, 1, '嗯'), '又咋了，今天碰上什么破事了？');
    assert.ok(!/【花园记忆片段（历史事实/.test(messages[0].content), '没有主题词的短句不能自动翻最近记录');
});

integration('Bot - 聊天模型无输出时用自然故障兜底，不推销记录', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    // 没有任何模型可用：走 runChat 的兜底分支，而不是把失败包装成欢迎语
    const reply = await buildBotReply({}, db, 1, '今天有点累');
    assert.equal(reply, '我刚刚没接上这句，你再发一下？');
    assert.ok(!/记录|花园|想聊什么/.test(reply), '故障兜底不能把聊天引向随手记');
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

integration('Bot - 联网答案默认不带来源，追问时才给出处且不再出站', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const env = {
        SEARCH_API_KEY: 'search-key',
        AI: { run: async () => ({ response: '10 月 25 日周日主场迎战雄鹿。' }) }
    };
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({
            results: [{
                title: '费城 76 人赛程', url: 'https://sports.example/sixers',
                summary: '10月25日周日，主场迎战雄鹿', site_name: 'sports.example', date: '2026-10-23'
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        const plain = await buildBotReply(env, db, 1, '查一下这周周六周日 NBA 有没有 76 人的比赛');
        assert.match(plain, /雄鹿/, '结论照常给，实际：' + plain);
        assert.ok(!plain.includes('来源：'), '默认回复不许附出处，实际：' + plain);
        assert.ok(!plain.includes('sports.example'), '默认回复连链接都不给');
        assert.equal(calls, 1, '这一次真的出站了');

        const asked = await buildBotReply(env, db, 1, '这个依据是什么');
        assert.match(asked, /sports\.example/, '追问时必须给出处，实际：' + asked);
        assert.equal(calls, 1, '追问走上下文里的出处，不许再出站一次');

        const again = await buildBotReply(env, db, 1, '刚才那些是哪查的');
        assert.match(again, /sports\.example/, '换个问法也要认，实际：' + again);
        assert.equal(calls, 1, '追问永不触发出站');
    } finally {
        globalThis.fetch = original;
    }
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

integration('Bot - 被引号包着的「记录：<链接>」也真的落库（2026-10-21 真机漏记的回归）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const url = 'https://www.xiaoyuzhoufm.com/episode/5e4a8c49418a84a046bb4fe2';

    const reply = await buildBotReply({}, db, 1, '「记录：' + url + '」。');
    assert.match(reply, /已存入\*\*随手记\*\*/, '必须如实回报存入，实际：' + reply);
    assert.ok(!/存好了/.test(reply), '不能只丢一句无法核对的「存好了」');

    const feed = await db.prepare('SELECT content, type FROM quick_feeds').first();
    assert.equal(feed.content, url);
    assert.equal(feed.type, 'link', '裸链接按链接存');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 1);
});

integration('Bot - 「记录：<标题> <链接>」落成带标题的链接卡片（抓不到元数据时的手写兜底）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const url = 'https://www.xiaoyuzhoufm.com/episode/6a76ebabc4079d62c57f3b74';

    const reply = await buildBotReply({}, db, 1, '记录：Ep204 未来生活指南 ' + url);
    assert.match(reply, /已存入\*\*随手记\*\*/);
    const feed = await db.prepare('SELECT content, type, summary, media_url FROM quick_feeds').first();
    assert.equal(feed.type, 'link');
    assert.equal(feed.content, 'Ep204 未来生活指南 ' + url, '正文保留原文，标题照样能被检索到');
    const meta = JSON.parse(feed.summary);
    assert.equal(meta.title, 'Ep204 未来生活指南');
    assert.equal(meta.platform, '小宇宙');
    assert.ok(!feed.media_url, '没有封面就不写 media_url');
});

integration('Bot - 管家指令：收藏与提示词分别落库，格式不对时不乱写', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    const bookmarkReply = await buildBotReply({}, db, 1, '收藏：Figma https://www.figma.com/file/abc 设计协作工具');
    assert.match(bookmarkReply, /已存入\*\*收藏\*\*/);
    let bookmark = await db.prepare('SELECT type, title, url, description FROM bookmarks WHERE user_id = 1').first();
    assert.equal(bookmark.type, '🌐 网站');
    assert.equal(bookmark.title, 'Figma');
    assert.equal(bookmark.url, 'https://www.figma.com/file/abc');
    assert.equal(bookmark.description, '设计协作工具');

    await buildBotReply({}, db, 1, '收藏：[工具] Figma 设计 https://www.figma.com/file/def');
    bookmark = await db.prepare('SELECT type, title FROM bookmarks WHERE url = ?1').bind('https://www.figma.com/file/def').first();
    assert.equal(bookmark.type, '🛠️ 工具');
    assert.equal(bookmark.title, 'Figma 设计');

    await buildBotReply({}, db, 1, '收藏：https://example.com/article');
    bookmark = await db.prepare('SELECT title FROM bookmarks WHERE url = ?1').bind('https://example.com/article').first();
    assert.equal(bookmark.title, 'example.com', '只有链接时用域名当标题');

    const invalidBookmark = await buildBotReply({}, db, 1, '收藏：只有文字没有链接');
    assert.match(invalidBookmark, /链接/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bookmarks').first()).n, 3, '无效收藏不能落库');

    const promptReply = await buildBotReply({}, db, 1, '提示词：[开发/代码] 代码审查 | 请审查以下代码并指出风险');
    assert.match(promptReply, /已存入\*\*提示词\*\*/);
    const prompt = await db.prepare('SELECT title, project, scene, content FROM prompts WHERE user_id = 1').first();
    assert.equal(prompt.title, '代码审查');
    assert.equal(prompt.project, '开发');
    assert.equal(prompt.scene, '代码');
    assert.equal(prompt.content, '请审查以下代码并指出风险');

    await buildBotReply({}, db, 1, '提示词：周报\n请写一份本周总结');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM prompts').first()).n, 2, '换行格式也能识别');

    const invalidPrompt = await buildBotReply({}, db, 1, '提示词：只有标题');
    assert.match(invalidPrompt, /正文/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM prompts').first()).n, 2, '缺正文不能落库');
});

integration('Bot - 管家列表/删除：先确认、可取消，确认后才软删', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    await buildBotReply({}, db, 1, '收藏：Figma https://www.figma.com/file/manage');
    const bookmark = await db.prepare('SELECT id, title FROM bookmarks WHERE user_id = 1').first();
    const list = await buildBotReply({}, db, 1, '我的收藏');
    assert.match(list, new RegExp('#' + bookmark.id));
    assert.match(list, /Figma/);

    const preview = await buildBotReply({}, db, 1, '删收藏 ' + bookmark.id);
    assert.match(preview, /确认删除/);
    assert.equal((await db.prepare('SELECT is_deleted FROM bookmarks WHERE id = ?1').bind(bookmark.id).first()).is_deleted, 0, '预览阶段绝不能软删');

    const cancelled = await buildBotReply({}, db, 1, '取消');
    assert.match(cancelled, /取消了/);
    assert.equal((await db.prepare('SELECT is_deleted FROM bookmarks WHERE id = ?1').bind(bookmark.id).first()).is_deleted, 0);

    await buildBotReply({}, db, 1, '删收藏 ' + bookmark.id);
    await db.prepare('UPDATE bot_pending_actions SET created_at_ms = ?1 WHERE user_id = 1 AND is_deleted = 0')
        .bind(Date.now() - 11 * 60 * 1000).run();
    const expired = await buildBotReply({}, db, 1, '确认');
    assert.match(expired, /过期/);
    assert.equal((await db.prepare('SELECT is_deleted FROM bookmarks WHERE id = ?1').bind(bookmark.id).first()).is_deleted, 0);

    await buildBotReply({}, db, 1, '删收藏 ' + bookmark.id);
    const wrongConfirm = await buildBotReply({}, db, 1, '确认修改');
    assert.match(wrongConfirm, /待确认的是删除/);
    assert.equal((await db.prepare('SELECT is_deleted FROM bookmarks WHERE id = ?1').bind(bookmark.id).first()).is_deleted, 0);

    const confirmed = await buildBotReply({}, db, 1, '确认');
    assert.match(confirmed, /已删除收藏/);
    assert.equal((await db.prepare('SELECT is_deleted FROM bookmarks WHERE id = ?1').bind(bookmark.id).first()).is_deleted, 1);
    assert.match(await buildBotReply({}, db, 1, '我的收藏'), /还是空的/);

    await buildBotReply({}, db, 1, '提示词：代码审查 | 请审查以下代码');
    const prompt = await db.prepare('SELECT id FROM prompts WHERE user_id = 1').first();
    assert.match(await buildBotReply({}, db, 1, '删提示词 ' + prompt.id), /确认删除/);
    assert.match(await buildBotReply({}, db, 1, '确认'), /已删除提示词/);
    assert.equal((await db.prepare('SELECT is_deleted FROM prompts WHERE id = ?1').bind(prompt.id).first()).is_deleted, 1);
});

integration('Bot - 管家编辑：先预览、确认后更新，不认识字段不乱写', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    await buildBotReply({}, db, 1, '收藏：Figma https://www.figma.com/file/edit');
    let bookmark = await db.prepare('SELECT id, type, title, description FROM bookmarks WHERE user_id = 1').first();
    const bookmarkId = bookmark.id;
    const preview = await buildBotReply({}, db, 1, '改收藏 ' + bookmarkId + ' 标题=Figma 新版 | 描述=新的备注');
    assert.match(preview, /改后/);
    assert.equal((await db.prepare('SELECT title, description FROM bookmarks WHERE id = ?1').bind(bookmarkId).first()).title, 'Figma', '预览阶段不能落库');

    await buildBotReply({}, db, 1, '确认');
    bookmark = await db.prepare('SELECT type, title, description FROM bookmarks WHERE id = ?1').bind(bookmarkId).first();
    assert.equal(bookmark.title, 'Figma 新版');
    assert.equal(bookmark.description, '新的备注');
    assert.equal(bookmark.type, '🌐 网站', '没改分类时保留原分类');

    await buildBotReply({}, db, 1, '提示词：[开发/代码] 代码审查 | 请审查以下代码');
    let prompt = await db.prepare('SELECT id, title, scene, content FROM prompts WHERE user_id = 1').first();
    const promptId = prompt.id;
    await buildBotReply({}, db, 1, '改提示词 ' + promptId + ' 标题=代码评审 | 正文=请评审 | 以下代码 | 场景=代码');
    prompt = await db.prepare('SELECT title, scene, content FROM prompts WHERE id = ?1').bind(promptId).first();
    assert.equal(prompt.title, '代码审查', '预览阶段不能落库');

    await buildBotReply({}, db, 1, '确认');
    prompt = await db.prepare('SELECT title, scene, content FROM prompts WHERE id = ?1').bind(promptId).first();
    assert.equal(prompt.title, '代码评审');
    assert.equal(prompt.scene, '代码');
    assert.equal(prompt.content, '请评审 | 以下代码', '正文里的竖线不能被字段分隔吞掉');
    assert.match(await buildBotReply({}, db, 1, '我的提示词'), /代码评审/);

    const bad = await buildBotReply({}, db, 1, '改收藏 ' + bookmarkId + ' 分类=不存在');
    assert.match(bad, /分类不认识/);
    assert.equal((await db.prepare('SELECT title FROM bookmarks WHERE id = ?1').bind(bookmarkId).first()).title, 'Figma 新版');
});

integration('Bot - 交流偏好：反馈先确认再记，取消不写，并注入聊天提示词', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    const preview = await buildBotReply({}, db, 1, '偏好 日常聊天：更自然，不要过度共情');
    assert.match(preview, /确认/);
    assert.equal((await listPreferences(db, 1)).length, 0, '预览阶段不能落库');

    await buildBotReply({}, db, 1, '确认');
    let items = await listPreferences(db, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].pref_key, 'tone');
    assert.equal(items[0].source, 'explicit');

    const feedback = await buildBotReply({}, db, 1, '这句话太啰嗦了');
    assert.match(feedback, /回复长度/);
    assert.equal((await listPreferences(db, 1)).length, 1, '反馈也要先确认');
    await buildBotReply({}, db, 1, '确认');
    items = await listPreferences(db, 1);
    assert.equal(items.length, 2);
    assert.equal(items.find(it => it.pref_key === 'length').content, '更简洁，少铺垫，直接说重点');

    await buildBotReply({}, db, 1, '太官方了');
    await buildBotReply({}, db, 1, '取消');
    assert.equal((await listPreferences(db, 1)).length, 2, '取消后一条都不能多');

    const block = await loadPreferencePrompt(db, 1);
    assert.match(block, /日常聊天/);
    assert.match(block, /更自然/);
    assert.match(block, /回复长度/);
    assert.equal(detectFeedbackPreference('太官方了').key, 'tone');
    assert.equal(detectFeedbackPreference('这句话太啰嗦').key, 'length');
    assert.equal(detectFeedbackPreference('不用安慰我，直接说你的看法').key, 'opinion');
    assert.equal(detectFeedbackPreference('这个分析不错，以后可以这样回答').key, 'analysis');
    assert.equal(detectFeedbackPreference('别每次给方案').key, 'proactive');

    let messages = null;
    const env = { AI: { run: async (model, opts) => { messages = opts.messages; return { response: '在。' }; } } };
    assert.equal(await buildBotReply(env, db, 1, '在吗'), '在。');
    assert.match(messages[0].content, /交流偏好/, '偏好块必须注入聊天提示词');
    assert.match(messages[0].content, /更自然/, '偏好内容必须进提示词');

    const delPreview = await buildBotReply({}, db, 1, '忘记偏好 更自然');
    assert.match(delPreview, /要删掉 1 条/);
    assert.equal((await listPreferences(db, 1)).length, 2, '删除预览不能先删');
    await buildBotReply({}, db, 1, '确认');
    assert.equal((await listPreferences(db, 1)).length, 1);
    const soft = await db.prepare('SELECT is_deleted FROM bot_preferences WHERE pref_key = ?1 AND user_id = 1 ORDER BY id DESC LIMIT 1').bind('tone').first();
    assert.equal(soft.is_deleted, 1, '偏好删除只能软删');
    assert.match(await buildBotReply({}, db, 1, '忘记偏好'), /要删哪条/, '光杆忘记偏好不能被档案遗忘指令抢走');
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
            put: async (key, buf, opts) => {
                const copy = new Uint8Array(buf);
                puts.push({ key, size: copy.byteLength, type: opts.httpMetadata.contentType, bytes: copy });
            },
            get: async (key) => {
                const hit = puts.find(p => p.key === key);
                if (!hit) return null;
                return { arrayBuffer: async () => hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength) };
            }
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
    assert.match(messages[0].content, /你自己没有写入能力/, '人格边界必须进提示词：不许自称已保存');
    assert.match(messages[0].content, /记录：<内容>/, '必须把指令通道的真实能力列给它，否则它会答「我没有写入能力」');
    assert.match(messages[0].content, /到点必达/, '主动开口与定点提醒的边界要说清：指令里的提醒不受日限约束');
    // v2.5.176：聊天不再默认「先共情」，也不再用 150 字上限；改为按语境判断回应方式
    assert.match(messages[0].content, /不要每次都先共情/, '必须允许自然接话，不能每句都先共情');
    assert.match(messages[0].content, /不要机械限制长度/, '简单话题可短、复杂话题可展开，不能一刀切 150 字');
    assert.match(messages[0].content, /普通聊天默认只聊天/, '闲聊不能被自动当成记录任务');
    assert.match(messages[0].content, /不要总说「根据我对你的了解」/, '熟悉感要自然用上记忆，不能反复强调「我了解你」');
    assert.ok(!/先接住对方的情绪/.test(messages[0].content), '旧的强制共情规则不能残留');
    assert.ok(!/150 字以内/.test(messages[0].content), '旧的固定篇幅限制不能残留');
    assert.equal(messages[messages.length - 1].content, '在吗');
    const roles = messages.slice(1, -1).map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant'], '上下文按旧→新注入，实际：' + JSON.stringify(roles));
});
integration('ClawBot - 成功拉到信就擦掉历史 last_error，并把 last_poll_at 走到这一轮', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    await db.prepare("UPDATE bot_claw_accounts SET last_error = 'getupdates http 520', last_poll_at = '2000-01-01 00:00:00' WHERE id = 1").run();
    const st = stubFetch({ '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: '', msgs: [] } }) });
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });

    let row = await db.prepare('SELECT last_error, last_poll_at FROM bot_claw_accounts WHERE id = 1').first();
    assert.equal(String(row.last_error || ''), '', '成功这一轮要擦掉旧错误，否则界面永远停在「通道已死」');
    assert.notEqual(row.last_poll_at, '2000-01-01 00:00:00', '游标没变也要刷新 last_poll_at——它表示最近一次成功轮询');

    // 再挂一次错误、再成功一次：擦除要能反复发生，而不是只赔一次
    await db.prepare("UPDATE bot_claw_accounts SET last_error = 'getupdates http 503' WHERE id = 1").run();
    await pollClawAccounts({ DB: db }, db, st.impl, { budgetMs: 0 });
    row = await db.prepare('SELECT last_error FROM bot_claw_accounts WHERE id = 1').first();
    assert.equal(String(row.last_error || ''), '', '反复失败后成功都要擦干净');
});

integration('Bot - 光杆「记住」直接要内容，不再答「我没有写入能力」', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const reply = await buildBotReply({}, db, 1, '记住');
    assert.match(reply, /记住：<内容>/, '要说清正确发法');
    assert.ok(!/没有写入能力/.test(reply), '不能把自己答成没有写入能力');
    assert.equal((await listProfile(db, 1)).length, 0, '没带内容就什么都不写');
});

integration('Bot - 定点提醒：解析成真实时刻并落库，回执写清「我理解的时间」', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);

    const reply = await buildBotReply({}, db, 1, '等会6点30记得提醒我给电动牙刷充电');
    assert.match(reply, /已记下/, '要给出明确回执：' + reply);
    assert.match(reply, /06:30/, '回执里必须写清我理解的时间，用户看到不对可以立刻取消：' + reply);
    assert.match(reply, /给电动牙刷充电/, '时间词与触发词都要从内容里剥掉：' + reply);

    const row = await db.prepare('SELECT text, status, fire_at_ms FROM bot_reminders WHERE user_id = 1').first();
    assert.equal(row.status, 'pending');
    assert.equal(row.text, '给电动牙刷充电');
    assert.ok(Number(row.fire_at_ms) > Date.now(), '必须是未来时刻');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '设提醒不是记录，绝不能落成随手记');

    // 只说「提醒我」却没说几点：反问一轮，不落库
    const asked = await buildBotReply({}, db, 1, '记得提醒我给电动牙刷充电');
    assert.match(asked, /几点/, '缺时刻要反问：' + asked);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_reminders').first()).n, 1, '没解析出时刻就不能写库');
    assert.equal((await listProfile(db, 1)).length, 0);
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

integration('Bot - 交流偏好接口跨用户隔离，编辑与删除都走软删', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);
    const call = (user, method, path, body) => handleBotPreferencesApi(profileCall(method, path, body), {}, new URL('https://chillin.example' + path), db, user);

    let res = await call(1, 'POST', '/api/bot/preferences', { key: 'tone', content: '更自然，别像客服' });
    assert.equal(res.status, 200);
    res = await call(1, 'POST', '/api/bot/preferences', { key: 'length', content: '短一点' });
    assert.equal(res.status, 200);
    let data = await (await call(1, 'GET', '/api/bot/preferences')).json();
    assert.equal(data.items.length, 2);
    assert.equal(data.maxItems, PREF_MAX_ITEMS);
    assert.equal(data.items[0].label, '日常聊天');

    const toneId = data.items.find(it => it.pref_key === 'tone').id;
    res = await call(2, 'GET', '/api/bot/preferences');
    assert.equal((await res.json()).items.length, 0, '偏好按用户隔离');
    assert.equal((await call(2, 'PUT', '/api/bot/preferences/' + toneId, { content: '被篡改' })).status, 404);
    assert.equal((await call(2, 'DELETE', '/api/bot/preferences/' + toneId)).status, 404);

    res = await call(1, 'PUT', '/api/bot/preferences/' + toneId, { content: '自然一点，不用客套' });
    assert.equal(res.status, 200);
    data = await (await call(1, 'GET', '/api/bot/preferences')).json();
    assert.equal(data.items.find(it => it.id === toneId).content, '自然一点，不用客套');

    res = await call(1, 'DELETE', '/api/bot/preferences/' + toneId);
    assert.equal(res.status, 200);
    const soft = await db.prepare('SELECT is_deleted FROM bot_preferences WHERE id = ?1').bind(toneId).first();
    assert.equal(soft.is_deleted, 1, '接口删除必须软删');
    assert.equal((await call(1, 'DELETE', '/api/bot/preferences/' + toneId)).status, 404);

    res = await call(1, 'POST', '/api/bot/preferences', { key: '不存在', content: 'x' });
    assert.equal(res.status, 400, '不认识的类别拒绝写入');
    res = await call(1, 'POST', '/api/bot/preferences', { key: 'custom', content: '' });
    assert.equal(res.status, 400, '空内容拒绝写入');
    res = await call(1, 'POST', '/api/bot/preferences/clear');
    assert.equal(res.status, 200);
    assert.equal((await (await call(1, 'GET', '/api/bot/preferences')).json()).items.length, 0);
    assert.equal((await (await call(2, 'GET', '/api/bot/preferences')).json()).items.length, 0);
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
    const pref = await api.fetch(new Request('https://chillin.example/api/bot/preferences'), { DB: db }, ctx);
    assert.equal(pref.status, 401, '交流偏好也必须在登录态之后');
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
    assert.equal(ok.calls[0].body.model, 'deepseek-flash', '默认走 V4.1 Flash（VISION_MODEL 可覆盖）');
    assert.equal(ok.calls[0].body.thinking.type, 'disabled', '识图必须关闭 thinking，避免拖慢 8 秒超时与挤占 max_tokens');
    assert.equal(ok.calls[0].body.temperature, 0.2);
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

    assert.equal(isDeepVisionQuestion('今晚的月亮'), false, '普通配文默认快速识图');
    assert.equal(isDeepVisionQuestion('这几张截图里面有什么共同的问题？'), true, '多图关系问题走深度看图');
    assert.equal(isDeepVisionQuestion('快速看一下这张图'), false, '用户明确要快时仍走快速');
    const fastMany = stubFetch({ [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '一张截图' } }] } }) });
    const fastText = await analyzeClawImages(env, [{ bytes: PNG_BYTES, mime: 'image/png' }, { bytes: PNG_BYTES, mime: 'image/png' }], { mode: 'fast', fetchImpl: fastMany.impl });
    assert.equal(fastMany.calls.length, 2, '快速多图逐张并行，不把多图硬塞进一次慢调用');
    assert.match(fastText, /^1\. 一张截图/);
    const deep = stubFetch({ [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '两张截图都在报同一个登录错误。' } }] } }) });
    const deepText = await analyzeClawImages(env, [{ bytes: PNG_BYTES, mime: 'image/png' }, { bytes: PNG_BYTES, mime: 'image/png' }], {
        mode: 'deep', question: '这两张有什么共同问题？', fetchImpl: deep.impl
    });
    assert.equal(deep.calls.length, 1, '深度看图把多张图放在同一次请求里，模型才能比较关系');
    assert.equal(deep.calls[0].body.messages[0].content.filter(c => c.type === 'image_url').length, 2);
    assert.equal(deep.calls[0].body.max_tokens, 1200);
    assert.match(deep.calls[0].body.messages[0].content[0].text, /共同问题/);
    assert.match(deepText, /同一个登录错误/);
});

test('Bot - 文字聊天默认走 deepseek-flash，并显式关闭 thinking', async () => {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), { status: 200 });
    };
    try {
        const reply = await callCustomLlmWithMessages(
            { LLM_API_KEY: 'sk-test', LLM_API_BASE: 'https://api.deepseek.com/v1' },
            [{ role: 'user', content: '在吗' }]
        );
        assert.equal(reply, '好');
        assert.equal(calls[0].body.model, 'deepseek-flash', 'model 名必须是 flash；带日期的是版本名');
        assert.equal(calls[0].body.thinking.type, 'disabled', '闲聊默认不思考，避免首字延迟');
        assert.equal(calls[0].body.temperature, 0.7);
    } finally {
        globalThis.fetch = realFetch;
    }
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
    assert.match(reply, /^窗台上蹲着一只黑猫/, '回信直接把看到的内容说给用户，不加「我看到：」前缀');
    assert.ok(!/我看到/.test(reply), '不要「我看到：」前缀');
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
    assert.match(await buildBotReply({}, db, 1, '记录'), /没有等着存的东西/, '再确认一次要如实说明');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 1, '不能重复入库');
});

integration('ClawBot - 一条消息多张图先快速逐张看，再凭连续图追问走深度看图并逐张保存', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedAccount(db);
    const puts = [];
    const msg = imageMessage();
    msg.item_list = [
        { type: 2, msg_id: 'IMG-A', image_item: { aeskey: '', media: 'https://cdn.example/a.png' } },
        { type: 2, msg_id: 'IMG-B', image_item: { aeskey: '', media: 'https://cdn.example/b.png' } }
    ];
    const st = stubFetch({
        '/ilink/bot/getupdates': () => ({ json: { ret: 0, get_updates_buf: 'CURSOR-MULTI', msgs: [msg] } }),
        '/ilink/bot/sendmessage': () => ({ json: { ret: 0 } }),
        'cdn.example/a.png': () => ({ bytes: PNG_BYTES }),
        'cdn.example/b.png': () => ({ bytes: PNG_BYTES }),
        [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '一张截图' } }] } })
    });
    await pollClawAccounts(visionEnv(db, puts), db, st.impl, { budgetMs: 0 });

    assert.equal(puts.length, 2, '一条消息里的两张图都要进 R2');
    const visionCalls = st.calls.filter(c => c.url.includes(VISION_ROUTE));
    assert.equal(visionCalls.length, 2, '快速模式逐张看图，不能只处理第一张');
    const pending = await db.prepare('SELECT media_url, media_urls FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    const batch = JSON.parse(pending.media_urls);
    assert.equal(batch.items.length, 2, '待存位要记住整批图');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '未确认前不得落库');

    const deep = stubFetch({
        [VISION_ROUTE]: () => ({ json: { choices: [{ message: { content: '两张截图都在报同一个登录错误。' } }] } })
    });
    const answer = await maybeClawImageFollowUp(visionEnv(db, puts), db, 1, '这两张截图里面有什么共同的问题？', deep.impl);
    assert.match(answer, /同一个登录错误/, '连续图追问要能带上两张图做深度分析');
    const deepCall = deep.calls.find(c => c.url.includes(VISION_ROUTE));
    assert.equal(deepCall.body.messages[0].content.filter(c => c.type === 'image_url').length, 2, '追问要把整批图一起交给模型');
    assert.match(deepCall.body.messages[0].content[0].text, /共同的问题/, '用户问题必须进入提示词');

    assert.match(await buildBotReply({}, db, 1, '记录'), /已存入/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 2, '回「记录」后两张图各存一条');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media WHERE is_deleted = 0').first()).n, 0, '确认后整批待存位作废');
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

    assert.match(await buildBotReply({}, db, 1, '记录'), /没有等着存的东西/);
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

/* ---------- 小宇宙链接速览（v2.5.132） ---------- */

const LZ_EPISODE = 'https://www.xiaoyuzhoufm.com/episode/6a76ebabc4079d62c57f3b74';
const LZ_ROUTE = 'xiaoyuzhoufm.com/episode/';
const LZ_COVER = 'image.xyzcdn.net/cover-abc';
const LZ_HTML = '<!doctype html><html><head>'
    + '<title>Ep204 未来生活指南｜刘德华给我发微信 - 基本无害 Mostly Harmless | 小宇宙 - 听播客，上小宇宙</title>'
    + '<meta property="og:title" content="Ep204 未来生活指南｜刘德华给我发微信">'
    + '<meta property="og:image" content="https://image.xyzcdn.net/cover-abc">'
    + '</head><body><script>window.__DATA__ = {"duration":6592,"pid":"5eae66d1418a84a046472b4d"};</script></body></html>';

test('Bot - 小宇宙链接只认白名单域名，标题与播客名从 og 与页面标题里取', () => {
    assert.equal(extractFirstUrl('看这个 ' + LZ_EPISODE + '。'), LZ_EPISODE, '中文句号不该被当成链接的一部分');
    assert.equal(extractFirstUrl('没有链接'), '');
    const parsed = parseXiaoyuzhouPage(LZ_HTML);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.title, 'Ep204 未来生活指南｜刘德华给我发微信');
    assert.equal(parsed.description, '基本无害 Mostly Harmless', '页面没有详情时退回播客名，不再给时长');
    assert.equal(parsed.cover, 'https://image.xyzcdn.net/cover-abc');
    assert.deepEqual(parseXiaoyuzhouUrl(LZ_EPISODE), { kind: 'episode', id: '6a76ebabc4079d62c57f3b74', url: LZ_EPISODE });
    assert.equal(parseXiaoyuzhouUrl('https://example.com/episode/6a76ebabc4079d62c57f3b74'), null, '只认小宇宙域名');
    assert.equal(isAllowedOutboundUrl(LZ_EPISODE), true);
    assert.equal(isAllowedOutboundUrl('http://www.xiaoyuzhoufm.com/episode/6a76ebabc4079d62c57f3b74'), false, '非 https 一律拒绝');
    assert.equal(isAllowedOutboundUrl('https://xiaoyuzhoufm.com.evil.example/episode/6a76ebabc4079d62c57f3b74'), false, '后缀伪造要拦住');
    assert.equal(isAllowedOutboundUrl('https://www.xiaoyuzhoufm.com:8443/episode/6a76ebabc4079d62c57f3b74'), false, '非 443 端口拒绝');
    assert.equal(isAllowedOutboundUrl('https://user@evil.example/?u=xiaoyuzhoufm.com'), false, '带 userinfo 拒绝');
    assert.equal(isAllowedOutboundUrl('https://127.0.0.1/episode/6a76ebabc4079d62c57f3b74'), false, 'IP 字面量拒绝');
    assert.equal(isAllowedOutboundUrl('https://image.xyzcdn.net/a.jpg', { image: true }), true, '图床只对图片通道开放');
    assert.equal(isAllowedOutboundUrl('https://image.xyzcdn.net/a.jpg'), false);
});

test('Bot - 播客页取简介、不抠单集时长；站点模板尾巴不冒充播客名', () => {
    const podcastHtml = '<!doctype html><html><head>'
        + '<meta property="og:title" content="基本无害 Mostly Harmless">'
        + '<meta name="description" property="og:description" content="基本无害是一档没有固定主题和形式，\n用不客观不中立甚至也不坚定的眼光进行人间观察的播客节目。">'
        + '<meta property="og:image" content="https://image.xyzcdn.net/pod-cover">'
        + '</head><body><script>window.__DATA__ = [{"duration":4396},{"duration":3000}];</script></body></html>';
    const pod = parseXiaoyuzhouPage(podcastHtml, { kind: 'podcast' });
    assert.equal(pod.ok, true);
    assert.equal(pod.title, '基本无害 Mostly Harmless');
    assert.match(pod.description, /^基本无害是一档没有固定主题和形式， 用不客观不中立/, 'og:description 的换行要压平');
    assert.ok(!/1:13:16/.test(pod.description), '播客页里的单集时长绝不能按到这个播客头上');
    assert.equal(pod.cover, 'https://image.xyzcdn.net/pod-cover');
    assert.equal(parseXiaoyuzhouUrl('https://www.xiaoyuzhoufm.com/podcast/5eae66d1418a84a046472b4d').kind, 'podcast');
    assert.equal(parseXiaoyuzhouUrl('http://www.xiaoyuzhoufm.com/episode/6a76ebabc4079d62c57f3b74'), null, 'http 不算可抓链接');
    assert.equal(xiaoyuzhouHostOf('http://www.xiaoyuzhoufm.com/episode/6a76ebabc4079d62c57f3b74'), 'www.xiaoyuzhoufm.com', '域名认得出，才能给出「只读 https」的提示');
    assert.equal(xiaoyuzhouHostOf('https://evil.example/episode/6a76ebabc4079d62c57f3b74'), '');
    const template = parseXiaoyuzhouPage(LZ_HTML.replace('基本无害 Mostly Harmless | 小宇宙', '小宇宙 | 小宇宙'));
    assert.equal(template.description, '', '站点模板文案不能冒充播客名，详情与播客名都没有就留空');
});

test('Bot - 页面自带 __NEXT_DATA__ 时优先用结构化字段，坏 JSON 不炸', () => {
    const episodeData = { props: { pageProps: { episode: {
        title: 'Ep204 结构化标题',
        duration: 6592,
        image: { picUrl: 'https://image.xyzcdn.net/next-ep.jpg' },
        podcast: { title: '基本无害 Mostly Harmless' },
        description: '节目简介'
    } } } };
    const episodeHtml = '<html><head><title>Ep999 og 标题 - 模板 | 小宇宙</title>'
        + '<meta property="og:title" content="og 标题">'
        + '<meta property="og:image" content="https://image.xyzcdn.net/og.jpg"></head>'
        + '<body><script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(episodeData) + '</script></body></html>';
    const ep = parseXiaoyuzhouPage(episodeHtml);
    assert.equal(ep.title, 'Ep204 结构化标题', 'SSR 数据块比 og 优先');
    assert.equal(ep.description, '节目简介', '单集详情取结构化 description，不再拼时长');
    assert.equal(ep.cover, 'https://image.xyzcdn.net/next-ep.jpg', '封面同样优先用结构化字段');

    const podcastData = { props: { pageProps: { podcast: {
        title: '结构化播客名', description: '结构化播客简介',
        image: { picUrl: 'https://image.xyzcdn.net/next-pod.jpg' }
    } } } };
    const podcastHtml = '<html><head><title>模板 | 小宇宙</title>'
        + '<meta property="og:description" content="og 简介"></head>'
        + '<body><script id="__NEXT_DATA__">' + JSON.stringify(podcastData) + '</script></body></html>';
    const pod = parseXiaoyuzhouPage(podcastHtml, { kind: 'podcast' });
    assert.equal(pod.title, '结构化播客名');
    assert.equal(pod.description, '结构化播客简介');
    assert.equal(pod.cover, 'https://image.xyzcdn.net/next-pod.jpg');

    const broken = parseXiaoyuzhouPage(LZ_HTML.replace('</head>', '<script id="__NEXT_DATA__">{ 坏掉的 JSON</script></head>'));
    assert.equal(broken.ok, true, '坏 JSON 不能炸，要回落 og');
    assert.equal(broken.title, 'Ep204 未来生活指南｜刘德华给我发微信');
    assert.equal(broken.description, '基本无害 Mostly Harmless');
});

test('Bot - 单集卡片给的是详情，不是时长（v2.5.140）', () => {
    const withDetail = { props: { pageProps: { episode: {
        title: 'vol.611 真·菜刀达人｜害！我和中华小当家，就差这把刀！',
        duration: 5397,
        description: '本期主播：六兽、阿铖 00:38 这期阿铖痛失原名？？？ 03:06 刀匠学徒老张的师傅竟然是新国作的老师？',
        image: { picUrl: 'https://image.xyzcdn.net/ep.jpg' },
        podcast: { title: '无聊斋' }
    } } } };
    const html = '<html><head><title>vol.611 - 无聊斋 | 小宇宙</title></head><body>'
        + '<script id="__NEXT_DATA__">' + JSON.stringify(withDetail) + '</script></body></html>';
    const card = parseXiaoyuzhouPage(html);
    assert.equal(card.title, 'vol.611 真·菜刀达人｜害！我和中华小当家，就差这把刀！');
    assert.match(card.description, /^本期主播：六兽、阿铖/, '详情用 episode.description');
    assert.ok(!/1:29:57/.test(card.description), '详情里不能混进时长');
    assert.equal(card.cover, 'https://image.xyzcdn.net/ep.jpg');

    const shownotesOnly = { props: { pageProps: { episode: {
        title: '只有 shownotes 的单集',
        shownotes: '<p><span>第一段</span></p><p><a class="timestamp">00:38</a> <span>&amp; 第二段</span></p>',
        podcast: { title: '无聊斋' }
    } } } };
    const html2 = '<html><head><title>只有 shownotes - 无聊斋 | 小宇宙</title></head><body>'
        + '<script id="__NEXT_DATA__">' + JSON.stringify(shownotesOnly) + '</script></body></html>';
    assert.equal(parseXiaoyuzhouPage(html2).description, '第一段 00:38 & 第二段', 'shownotes 详情要去标签、解实体');

    const long = { props: { pageProps: { episode: { title: 'T', description: '详'.repeat(400), podcast: { title: 'P' } } } } };
    const html3 = '<html><head><title>T - P | 小宇宙</title></head><body><script id="__NEXT_DATA__">' + JSON.stringify(long) + '</script></body></html>';
    const clamped = parseXiaoyuzhouPage(html3).description;
    assert.equal(clamped.length, LINK_DESC_MAX_CHARS, '过长的详情要截断');
    assert.ok(clamped.endsWith('…'), '截断要留省略号');
});

integration('Bot - http 的小宇宙链接不沉默：说明只读 https，且一次都不出站', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const puts = [];
    const st = stubFetch({});
    const original = globalThis.fetch;
    globalThis.fetch = st.impl;
    try {
        const reply = await buildBotReply(visionEnv(db, puts), db, 1, 'http://www.xiaoyuzhoufm.com/episode/6a76ebabc4079d62c57f3b74');
        assert.match(reply, /只会读 https/, '要如实说是协议的问题');
        assert.match(reply, /记录：/, '要给「原样存」的兜底路径');
        assert.equal(st.calls.length, 0, 'http 链接一次都不许出站');
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media WHERE is_deleted = 0').first()).n, 0, '不占待存位');
    } finally {
        globalThis.fetch = original;
    }
});

integration('Bot - 小宇宙链接先给速览，回「记录」才落成带卡片的随手记', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const puts = [];
    const st = stubFetch({
        [LZ_ROUTE]: () => ({ bytes: LZ_HTML, status: 200 }),
        [LZ_COVER]: () => ({ bytes: PNG_BYTES, status: 200 })
    });
    const reply = await handleClawLinkMessage(visionEnv(db, puts), db, 1, '这个不错 ' + LZ_EPISODE, st.impl);
    assert.match(reply, /Ep204 未来生活指南/, '回信要给标题');
    assert.match(reply, /基本无害 Mostly Harmless/, '页面没有详情时回信退回播客名（不再给时长）');
    assert.match(reply, /记录/, '要告诉用户怎么确认');
    assert.ok(!/已存入/.test(reply), '没确认就不能说已存');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '未确认前不得落库');

    const pending = await db.prepare('SELECT content, media_url, summary FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    assert.equal(pending.content, '这个不错' + '\n' + LZ_EPISODE, '配文与原始链接一起进待存位');
    assert.match(pending.media_url, /^\/api\/file\//, '封面转存 R2 后写自家地址');
    const meta = JSON.parse(pending.summary);
    assert.equal(meta.platform, '小宇宙');
    assert.equal(meta.icon, '🎧');
    assert.equal(meta.cover, pending.media_url, '卡片封面用转存后的地址');
    assert.ok(puts.length >= 1, '封面二进制进 R2');

    assert.match(await buildBotReply({}, db, 1, '记录'), /已存入/);
    const feed = await db.prepare('SELECT content, type, summary, media_url FROM quick_feeds WHERE user_id = 1').first();
    assert.equal(feed.type, 'link', '链接记录要用 link 类型');
    assert.equal(feed.summary, pending.summary, '卡片 JSON 原样进 summary，前端据此渲染富链接卡片');
    assert.ok(feed.content.includes(LZ_EPISODE), '正文保留原始链接');
    assert.equal(feed.media_url, pending.media_url);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media WHERE is_deleted = 0').first()).n, 0, '确认后待存位要作废');
    assert.match(await buildBotReply({}, db, 1, '记录'), /没有等着存的东西/, '再确认一次要如实说明');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 1, '不能重复入库');
});

integration('Bot - 聊天入口遇小宇宙链接走速览，其它链接一次都不出站', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const puts = [];
    const st = stubFetch({
        [LZ_ROUTE]: () => ({ bytes: LZ_HTML, status: 200 }),
        [LZ_COVER]: () => ({ bytes: PNG_BYTES, status: 200 })
    });
    const original = globalThis.fetch;
    globalThis.fetch = st.impl;
    try {
        const reply = await buildBotReply(visionEnv(db, puts), db, 1, LZ_EPISODE);
        assert.match(reply, /Ep204 未来生活指南/, '聊天入口也要走速览');
        st.calls.length = 0;
        await buildBotReply(visionEnv(db, puts), db, 1, 'https://evil.example/episode/6a76ebabc4079d62c57f3b74');
        assert.equal(st.calls.length, 0, '白名单之外的域名一次都不许出站');
    } finally {
        globalThis.fetch = original;
    }
});

integration('Bot - 小宇宙页面抓不到时不占坑，并给出「记录：链接」兜底', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const down = stubFetch({ [LZ_ROUTE]: () => ({ status: 503 }) });
    const reply = await handleClawLinkMessage({}, db, 1, LZ_EPISODE, down.impl);
    assert.match(reply, /读不到内容/, '失败要如实说');
    assert.ok(reply.includes('记录：' + LZ_EPISODE), '给出原样保存的兜底路径');
    assert.match(reply, /记录：<标题>/, '拿不到标题时告诉她怎么自己补一个');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media').first()).n, 0, '抓不到就不该占坑');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0);

    const huge = stubFetch({ [LZ_ROUTE]: () => ({ bytes: new Uint8Array(LINK_HTML_MAX_BYTES + 1) }) });
    const oversized = await handleClawLinkMessage({}, db, 1, LZ_EPISODE, huge.impl);
    assert.match(oversized, /内容过大/, '超过体积上限直接放弃');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media').first()).n, 0);
});

integration('Bot - 小宇宙页面重定向到白名单之外时立刻停下，不跟过去', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const st = stubFetch({
        [LZ_ROUTE]: () => ({ response: new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } }) })
    });
    const reply = await handleClawLinkMessage({}, db, 1, LZ_EPISODE, st.impl);
    assert.match(reply, /读不到内容/);
    assert.equal(st.calls.length, 1, '第二跳就该被拦下');
    assert.ok(st.calls[0].init.redirect === 'manual', '必须手动跟重定向才能逐跳复核域名');
});

/* ---------- 第三方读取服务代读（v2.5.137，方案 B） ---------- */

const LZ_READER = 'r.jina.ai';
const LZ_READER_HTML = '<!doctype html><html><head>'
    + '<title>Ep204 代读标题 - 基本无害 Mostly Harmless | 小宇宙 - 听播客，上小宇宙</title>'
    + '<meta property="og:image" content="https://image.xyzcdn.net/cover-abc">'
    + '</head><body><script>window.__DATA__ = {"duration":6592};</script></body></html>';

test('Bot - 读取服务地址两种拼法，JSON 元数据只认白名单封面', () => {
    assert.equal(readerEndpoint('https://r.jina.ai', LZ_EPISODE), 'https://r.jina.ai/' + LZ_EPISODE);
    assert.equal(readerEndpoint('https://r.jina.ai/', LZ_EPISODE), 'https://r.jina.ai/' + LZ_EPISODE, '尾斜杠不该拼成双斜杠');
    assert.equal(readerEndpoint('https://api.microlink.io/?url=', LZ_EPISODE), 'https://api.microlink.io/?url=' + encodeURIComponent(LZ_EPISODE), '带 ? 的走查询参数形式');
    assert.equal(readerEndpoint(LINK_READER_DEFAULT_URL, LZ_EPISODE), LINK_READER_DEFAULT_URL + '/' + LZ_EPISODE);
    assert.equal(readerEndpoint('http://r.jina.ai', LZ_EPISODE), '', '只认 https');
    assert.equal(readerEndpoint('https://user:pass@r.jina.ai', LZ_EPISODE), '', '带 userinfo 拒绝');
    assert.equal(readerEndpoint('https://r.jina.ai', ''), '');
    const json = JSON.stringify({ status: 'success', data: { title: '  Ep204 代读  ', description: '基本无害\n· 1:49:52', image: { url: 'https://image.xyzcdn.net/cover-abc' } } });
    assert.deepEqual(parseReaderMetadata(json), { ok: true, title: 'Ep204 代读', html: '', description: '基本无害 · 1:49:52', cover: 'https://image.xyzcdn.net/cover-abc' });
    const jinaJson = JSON.stringify({ code: 200, status: 20000, data: { title: 'Ep204 JSON 标题', description: '听《基本无害》上小宇宙。', html: LZ_READER_HTML } });
    assert.equal(parseReaderMetadata(jinaJson).html, LZ_READER_HTML, 'Jina 形状的 JSON 里正文在 data.html，要留给页面解析器');
    assert.equal(parseReaderMetadata(JSON.stringify({ data: { title: 'T', content: '{"a":1}' } })).html, '', '看起来不像 HTML 的 content 不认');
    assert.equal(parseReaderMetadata(JSON.stringify({ data: { title: '', description: 'x' } })), null, '没有标题就当没读出');
    assert.equal(parseReaderMetadata(JSON.stringify({ data: { title: 'T', image: { url: 'https://evil.example/x.jpg' } } })).cover, '', '不在图床白名单的封面一律丢掉');
    assert.equal(parseReaderMetadata('<html><title>T</title></html>'), null, 'HTML 交回页面解析器');
    assert.equal(parseReaderMetadata('{坏 JSON'), null);
});

integration('Bot - 直连被出口封时用配置好的读取服务代读（方案 B）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const puts = [];
    const st = stubFetch({
        [LZ_READER]: () => ({ bytes: LZ_READER_HTML, status: 200 }),
        [LZ_ROUTE]: () => ({ status: 403 }),
        [LZ_COVER]: () => ({ bytes: PNG_BYTES, status: 200 })
    });
    const env = visionEnv(db, puts, { LINK_READER_API_KEY: 'rk-1' });
    const reply = await handleClawLinkMessage(env, db, 1, '这个不错 ' + LZ_EPISODE, st.impl);
    assert.match(reply, /Ep204 代读标题/, '代读拿到的标题要进回信');
    assert.match(reply, /基本无害 Mostly Harmless/, '代读的页面照样解析出播客名');
    assert.match(reply, /记录/, '仍然要她回「记录」才落库');
    assert.equal(st.calls.length, 3, '直连 403 → 代读 → 封面转存，一共三次');
    assert.equal(st.calls[0].url, LZ_EPISODE, '先直连');
    assert.equal(st.calls[1].url, 'https://r.jina.ai/' + LZ_EPISODE, '再用读取服务代读');
    assert.equal(st.calls[1].init.headers.Authorization, 'Bearer rk-1');
    assert.equal(st.calls[1].init.headers['X-Return-Format'], 'html');
    assert.equal(st.calls[1].init.headers.Accept, 'text/html', '只请求 HTML——Accept 带上 application/json 时 Jina 会回 JSON，而 JSON 里没有封面字段');
    const pending = await db.prepare('SELECT media_url, summary FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    assert.match(pending.media_url, /^\/api\/file\//, '代读拿到的封面同样要转存 R2');
    assert.equal(JSON.parse(pending.summary).title, 'Ep204 代读标题');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0);
});

integration('Bot - 代读回的是 Jina 形状 JSON 时，从 data.html 里照样拿到封面与播客名（v2.5.138）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const puts = [];
    const jinaJson = JSON.stringify({ code: 200, status: 20000, data: { title: 'vol.19 JSON 标题', description: '听《谐星聊天会》上小宇宙。', html: LZ_READER_HTML } });
    const st = stubFetch({
        [LZ_READER]: () => ({ bytes: jinaJson, status: 200 }),
        [LZ_ROUTE]: () => ({ status: 403 }),
        [LZ_COVER]: () => ({ bytes: PNG_BYTES, status: 200 })
    });
    const reply = await handleClawLinkMessage(visionEnv(db, puts, { LINK_READER_API_KEY: 'rk-1' }), db, 1, LZ_EPISODE, st.impl);
    assert.match(reply, /Ep204 代读标题/, '正文优先用内嵌 HTML 解析，而不是 JSON 里那个干标题');
    assert.match(reply, /基本无害 Mostly Harmless/, 'HTML 里才有播客名');
    const pending = await db.prepare('SELECT media_url, summary FROM bot_pending_media WHERE user_id = 1 AND is_deleted = 0').first();
    assert.match(pending.media_url, /^\/api\/file\//, '封面照样要转存 R2——线上 v2.5.137 缺封面的根因就是没走 HTML');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0, '还是回「记录」才落库');
});

integration('Bot - 没配读取服务就绝不代读，失败原因如实带回', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const st = stubFetch({ [LZ_READER]: () => ({ bytes: LZ_READER_HTML, status: 200 }), [LZ_ROUTE]: () => ({ status: 403 }) });
    const reply = await handleClawLinkMessage(visionEnv(db, []), db, 1, LZ_EPISODE, st.impl);
    assert.match(reply, /HTTP 403/, '如实说出口被封，不假装');
    assert.equal(st.calls.length, 1, '没配 key 时一次都不许多发');
});

integration('Bot - 读取服务返回 Microlink 形状的 JSON 也出卡片，额度用尽时两段原因都给', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const puts = [];
    const st = stubFetch({
        'api.microlink.io': () => ({ json: { status: 'success', data: { title: 'Ep204 Microlink 标题', description: '基本无害 · 1:49:52', image: { url: 'https://image.xyzcdn.net/cover-abc' } } } }),
        [LZ_ROUTE]: () => ({ status: 403 }),
        [LZ_COVER]: () => ({ bytes: PNG_BYTES, status: 200 })
    });
    const env = visionEnv(db, puts, { LINK_READER_API_KEY: 'mk-1', LINK_READER_URL: 'https://api.microlink.io/?url=' });
    const reply = await handleClawLinkMessage(env, db, 1, LZ_EPISODE, st.impl);
    assert.match(reply, /Ep204 Microlink 标题/);
    assert.equal(st.calls[1].url, 'https://api.microlink.io/?url=' + encodeURIComponent(LZ_EPISODE));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 0);
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media').first()).n;

    const dead = stubFetch({ [LZ_READER]: () => ({ status: 429 }), [LZ_ROUTE]: () => ({ status: 403 }) });
    const failed = await handleClawLinkMessage(visionEnv(db, puts, { LINK_READER_API_KEY: 'rk-1' }), db, 1, LZ_EPISODE, dead.impl);
    assert.match(failed, /HTTP 403/);
    assert.match(failed, /读取服务 HTTP 429/, '两段失败都要说清楚，线上才分得清是出口封还是额度尽');
    assert.match(failed, /记录：<标题>/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bot_pending_media').first()).n, before, '失败不占新待存位');
});

test('ClawBot - 应用内二维码绑定/解绑卡片接齐四个端点，关闭弹层会停轮询', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const auth = fs.readFileSync(new URL('../public/js/auth.js', import.meta.url), 'utf8');
    const api = fs.readFileSync(new URL('../workers/api.js', import.meta.url), 'utf8');
    const maintenance = fs.readFileSync(new URL('../workers/src/maintenance.js', import.meta.url), 'utf8');

    for (const id of ['bot-claw-title', 'bot-claw-hint', 'btn-bot-claw-bind', 'btn-bot-claw-unbind', 'bot-claw-qr', 'bot-claw-qr-img', 'bot-claw-qr-hint', 'btn-bot-claw-cancel']) {
        assert.ok(html.includes('id="' + id + '"'), 'index.html 缺少绑定卡片节点 #' + id);
    }
    assert.match(html, /referrerpolicy="no-referrer"/, '二维码图片必须不带 Referer，避免 CDN 拒绝');

    assert.ok(auth.includes("apiRequest('/api/bot/claw/status')"), '打开设置时必须读取绑定状态');
    assert.ok(auth.includes("apiRequest('/api/bot/claw/qrcode', { method: 'POST' })"), '绑定按钮必须申请二维码');
    assert.ok(auth.includes("apiRequest('/api/bot/claw/check', { method: 'POST' })"), '展示二维码后必须轮询扫码状态');
    assert.ok(auth.includes("apiRequest('/api/bot/claw', { method: 'DELETE' })"), '解绑必须走 DELETE 端点');
    assert.ok(auth.includes('data:image'), '二维码地址必须支持 data:image 兜底');
    assert.ok(auth.includes('stopBotClawPolling'), '关闭弹层/取消时必须能停掉轮询');
    assert.match(auth, /MutationObserver/, '弹层关闭要靠 class 变化停轮询');
    assert.ok(auth.includes('确认后自动完成绑定'), '扫码后要告诉用户去手机上确认');
    assert.match(auth, /二维码进入刷新窗口/, '倒计时到 0 不能直接判过期，要继续问服务端');
    assert.match(auth, /CLAW_SCAN_MAX_MS/, '本地只做超时兜底');
    assert.match(auth, /scaned_but_redirect/, '前端要知道扫码重定向不是终态');
    assert.match(auth, /binded_redirect/, '前端要展示已绑定其他实例的明确提示');
    assert.match(auth, /need_verifycode/, '前端要展示需要配对码的明确提示');
    assert.match(api, /runScheduled\(env, event, undefined, ctx\)/, 'scheduled 入口必须把 ctx 传下去');
    assert.match(maintenance, /ctx\.waitUntil/, '重活必须转交 waitUntil');
});

