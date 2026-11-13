import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, sqliteTest } from './fake-d1.mjs';
import { rateLimitBuckets } from '../workers/src/security-network.js';
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS } from '../workers/src/security-crypto.js';
import {
    handleRegister,
    handleLogin,
    handleRefreshSession,
    handleListSessions,
    handleRevokeSession,
    handleLogoutAll,
    handleChangePassword,
    handlePushSubscribe,
    tokenHash,
} from '../workers/src/auth.js';

const integration = sqliteTest;
const env = { ALLOW_REGISTRATION: 'true', PROXY_SHARED_SECRET: 'test-secret' };

// 每个请求给一个独立来源 IP：注册限流是 5 次/小时（内存桶跨用例共享），
// 固定 IP 会让后面新增的用例莫名吃到 429。
let ipSeq = 0;
const jsonRequest = (url, body) => new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.9.0.${++ipSeq}` },
    body: JSON.stringify(body),
});
const cookieRequest = (url, token, method = 'GET') => new Request(url, {
    method,
    headers: { Cookie: `chillin_session=${token}` },
});
const sessionRows = async (db) => (await db.prepare('SELECT token, user_id, created_at, last_seen_at FROM sessions').all()).results;

integration('Auth - register stores a hashed session and login verifies PBKDF2', async () => {
    const db = createTestDb();

    const registered = await handleRegister(jsonRequest('https://x/api/auth/register', { username: 'tester', password: 'passw0rd1' }), env, db);
    assert.equal(registered.status, 201);
    const account = await registered.json();

    const rows = await sessionRows(db);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token, account.token, 'the raw token must never be persisted');
    assert.equal(rows[0].token, await tokenHash(account.token));
    assert.ok(rows[0].last_seen_at, 'last_seen_at is recorded for the device list');

    // 时间基准：新建账号的 created_at 必须落在东八区（曾依赖 SQLite 的 UTC 默认值）
    const accountRow = await db.prepare(
        "SELECT created_at, datetime('now', '+8 hours', '-2 minutes') AS lo, datetime('now', '+8 hours', '+2 minutes') AS hi FROM users WHERE id = ?1"
    ).bind(account.userId).first();
    assert.ok(
        accountRow.created_at >= accountRow.lo && accountRow.created_at <= accountRow.hi,
        'users.created_at 必须是东八区时间，实际为 ' + accountRow.created_at
    );

    const login = await handleLogin(jsonRequest('https://x/api/auth/login', { username: 'tester', password: 'passw0rd1' }), env, db);
    assert.equal(login.status, 200);
    assert.equal((await sessionRows(db)).length, 2);

    const wrong = await handleLogin(jsonRequest('https://x/api/auth/login', { username: 'tester', password: 'not-the-password' }), env, db);
    assert.equal(wrong.status, 401);
    assert.equal((await sessionRows(db)).length, 2, 'a failed login must not create a session');
});

integration('Auth - push subscription is deduped by device id', async () => {
    const db = createTestDb();
    const registered = await handleRegister(jsonRequest('https://x/api/auth/register', { username: 'pushuser', password: 'passw0rd1' }), env, db);
    const { token } = await registered.json();
    const subscribe = (body) => new Request('https://x/api/push/subscribe', {
        method: 'POST',
        headers: { Cookie: 'chillin_session=' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const sub = (endpoint, deviceId) => ({ endpoint, keys: { p256dh: 'key', auth: 'auth' }, device_id: deviceId });

    assert.equal((await handlePushSubscribe(subscribe(sub('https://push.example/a', 'device-1')), db)).status, 200);
    assert.equal((await handlePushSubscribe(subscribe(sub('https://push.example/b', 'device-1')), db)).status, 200);
    let rows = (await db.prepare('SELECT endpoint, device_id FROM push_subscriptions WHERE user_id = (SELECT user_id FROM sessions)').all()).results;
    assert.equal(rows.length, 1, '同一设备换 endpoint 不能留下两条');
    assert.equal(rows[0].endpoint, 'https://push.example/b');

    assert.equal((await handlePushSubscribe(subscribe(sub('https://push.example/c', 'device-2')), db)).status, 200);
    rows = (await db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = (SELECT user_id FROM sessions) ORDER BY endpoint').all()).results;
    assert.equal(rows.length, 2, '不同设备仍各自保留一条');
});

integration('Push - notifyAgentUser 按 device_id 严格消抖，同一设备绝不多发', async () => {
    const db = createTestDb();
    const registered = await handleRegister(jsonRequest('https://x/api/auth/register', { username: 'pushtester', password: 'passw0rd1' }), env, db);
    const { userId } = await registered.json();

    const { notifyAgentUser } = await import('../workers/src/agent-approvals.js');

    await db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_id, created_at, updated_at) VALUES (?1, 'https://push.example/dev1', 'k1', 'a1', 'device-alpha', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").bind(userId).run();
    await db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?1, 'https://push.example/old-orphan', 'k2', 'a2', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").bind(userId).run();

    const webPush = (await import('web-push')).default;
    const vapidKeys = webPush.generateVAPIDKeys();
    const pushEnv = {
        ...env,
        VAPID_PUBLIC_KEY: vapidKeys.publicKey,
        VAPID_PRIVATE_KEY: vapidKeys.privateKey
    };

    let pushCalls = 0;
    const origSend = webPush.sendNotification;
    webPush.sendNotification = async () => {
        pushCalls += 1;
        return { statusCode: 201 };
    };

    try {
        const res = await notifyAgentUser(pushEnv, db, userId, { title: '测试推送', body: '测试内容', tag: 'test-tag' });
        assert.equal(pushCalls, 1, '同一用户的多条订阅被 deviceMap 消抖，只向有效设备推送 1 条');
        assert.equal(res.sent, 1);
    } finally {
        webPush.sendNotification = origSend;
    }
});

integration('Auth - refresh rotates the cookie session, and devices can be listed and revoked', async () => {
    const db = createTestDb();
    const registered = await handleRegister(jsonRequest('https://x/api/auth/register', { username: 'tester', password: 'passw0rd1' }), env, db);
    const { userId, token } = await registered.json();

    // Cookie 客户端：轮换令牌，旧行立即吊销
    const refreshed = await handleRefreshSession(cookieRequest('https://x/api/auth/refresh', token, 'POST'), env, db, userId);
    assert.equal(refreshed.status, 200);
    const setCookie = refreshed.headers.get('Set-Cookie') || '';
    const rotated = (setCookie.match(/chillin_session=([^;]+)/) || [])[1];
    assert.ok(rotated && rotated !== token, 'refresh must rotate the cookie token');
    assert.match(setCookie, /HttpOnly/);
    const rowsAfterRotate = await sessionRows(db);
    assert.equal(rowsAfterRotate.length, 1);
    assert.equal(rowsAfterRotate[0].token, await tokenHash(rotated));

    // 旧令牌已失效
    const stale = await handleListSessions(cookieRequest('https://x/api/auth/sessions', token), db, userId);
    const staleList = await stale.json();
    assert.equal(staleList.every((s) => !s.current), true, 'the revoked token must not be marked current');

    const list = await (await handleListSessions(cookieRequest('https://x/api/auth/sessions', rotated), db, userId)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].current, true);
    assert.ok(list[0].device.length > 0 && list[0].id.length === 64);

    const revoked = await (await handleRevokeSession(new Request('https://x/'), db, userId, list[0].id)).json();
    assert.equal(revoked.revoked, 1);
    assert.equal((await sessionRows(db)).length, 0);

    // Test revoking legacy UUID session (e.g. unknown device created in older version)
    const legacyUuid = 'c7a8b6e5-4d2f-4a3b-9e1c-5f8d2e3a4b5c';
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
        .bind(legacyUuid, userId, Date.now() + 100000).run();
    const revokedLegacy = await (await handleRevokeSession(new Request('https://x/'), db, userId, legacyUuid)).json();
    assert.equal(revokedLegacy.revoked, 1);
    assert.equal((await sessionRows(db)).length, 0);
});

integration('Auth - logout-all revokes every session of the account only', async () => {
    const db = createTestDb();
    const first = await handleRegister(jsonRequest('https://x/api/auth/register', { username: 'one', password: 'passw0rd1' }), env, db);
    const second = await handleRegister(jsonRequest('https://x/api/auth/register', { username: 'two', password: 'passw0rd1' }), env, db);
    const a = await first.json();
    const b = await second.json();
    await handleLogin(jsonRequest('https://x/api/auth/login', { username: 'one', password: 'passw0rd1' }), env, db);
    assert.equal((await sessionRows(db)).length, 3);

    const res = await (await handleLogoutAll(cookieRequest('https://x/api/auth/logout-all', a.token, 'POST'), db, a.userId)).json();
    assert.equal(res.revoked, 2, 'only the first account sessions are revoked');

    const remaining = await sessionRows(db);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].token, await tokenHash(b.token));
});
const passwordRequest = (token, body) => new Request('https://x/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `chillin_session=${token}` },
    body: JSON.stringify(body),
});

integration('Auth - 修改密码校验旧密码、重哈希并只保留当前会话', async () => {
    rateLimitBuckets.clear(); // 内存限流桶跨用例共享，按 userId 计数
    const db = createTestDb();
    const registered = await handleRegister(
        jsonRequest('https://x/api/auth/register', { username: 'tester', password: 'passw0rd1' }),
        env, db
    );
    const { userId, token } = await registered.json();
    assert.equal((await handleLogin(
        jsonRequest('https://x/api/auth/login', { username: 'tester', password: 'passw0rd1' }), env, db
    )).status, 200);
    assert.equal((await sessionRows(db)).length, 2);

    const before = await db.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(userId).first();

    // 旧密码输错：400（不是 401，避免前端把它当登录过期直接登出），且不吊销任何会话
    const wrong = await handleChangePassword(
        passwordRequest(token, { currentPassword: 'not-the-password', newPassword: 'newpassw0rd9' }),
        db, userId
    );
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /当前密码/);
    assert.equal((await sessionRows(db)).length, 2, '失败的改密不能吊销会话');
    const unchanged = await db.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(userId).first();
    assert.equal(unchanged.password_hash, before.password_hash);

    const ok = await handleChangePassword(
        passwordRequest(token, { currentPassword: 'passw0rd1', newPassword: 'newpassw0rd9' }),
        db, userId
    );
    assert.equal(ok.status, 200);
    const result = await ok.json();
    assert.equal(result.success, true);
    assert.equal(result.revokedSessions, 1);

    // 只留下发起改密的这个会话
    const sessions = await sessionRows(db);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].token, await tokenHash(token));

    const after = await db.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(userId).first();
    assert.notEqual(after.password_hash, before.password_hash);
    assert.match(after.password_hash, /^pbkdf2\$100000\$/);

    // 旧密码立刻失效，新密码可以登录
    assert.equal((await handleLogin(
        jsonRequest('https://x/api/auth/login', { username: 'tester', password: 'passw0rd1' }), env, db
    )).status, 401);
    assert.equal((await handleLogin(
        jsonRequest('https://x/api/auth/login', { username: 'tester', password: 'newpassw0rd9' }), env, db
    )).status, 200);
});

integration('Auth - 修改密码拒绝弱密码、相同密码与空字段', async () => {
    rateLimitBuckets.clear();
    const db = createTestDb();
    const registered = await handleRegister(
        jsonRequest('https://x/api/auth/register', { username: 'tester', password: 'passw0rd1' }),
        env, db
    );
    const { userId, token } = await registered.json();
    const before = await db.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(userId).first();

    const cases = [
        [{ currentPassword: 'passw0rd1', newPassword: 'short' }, /至少 8 位/],
        [{ currentPassword: 'passw0rd1', newPassword: 'onlyletters' }, /字母和数字/],
        [{ currentPassword: 'passw0rd1', newPassword: 'passw0rd1' }, /不能与当前密码相同/],
        [{ currentPassword: '', newPassword: 'newpassw0rd9' }, /当前密码/]
    ];
    for (const [body, pattern] of cases) {
        const res = await handleChangePassword(passwordRequest(token, body), db, userId);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match((await res.json()).error, pattern);
    }

    const after = await db.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(userId).first();
    assert.equal(after.password_hash, before.password_hash, '被拒绝的改密不能写库');
    assert.equal((await sessionRows(db)).length, 1);
});

integration('Auth - 注册请求体超过 8KB 上限时返回 413', async () => {
    const db = createTestDb();
    const req = new Request('https://x/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x'.repeat(9000), password: 'y' })
    });
    assert.equal((await handleRegister(req, env, db)).status, 413);
});

integration('Auth - 旧的 5 万次哈希在登录成功后就地升级到当前迭代数', async () => {
    rateLimitBuckets.clear();
    assert.equal(PBKDF2_ITERATIONS, 100000, 'Cloudflare Workers WebCrypto 的 PBKDF2 上限是 10 万次');
    const db = createTestDb();
    const oldHash = await hashPassword('passw0rd1', 50000);
    assert.match(oldHash, /^pbkdf2\$50000\$/);
    await db.prepare('INSERT INTO users (username, password_hash) VALUES (?1, ?2)')
        .bind('legacy', oldHash).run();

    const login = await handleLogin(
        jsonRequest('https://x/api/auth/login', { username: 'legacy', password: 'passw0rd1' }), env, db
    );
    assert.equal(login.status, 200);

    const row = await db.prepare('SELECT password_hash FROM users WHERE username = ?1').bind('legacy').first();
    assert.match(row.password_hash, /^pbkdf2\$100000\$/, '登录成功后应透明升级到 10 万次');
    assert.equal((await handleLogin(
        jsonRequest('https://x/api/auth/login', { username: 'legacy', password: 'passw0rd1' }), env, db
    )).status, 200, '升级后旧密码仍可登录');

    // 旧版曾写入 60 万次哈希；边缘 WebCrypto 无法计算，必须安全拒绝而不是抛错。
    const overCap = await verifyPassword('passw0rd1', 'pbkdf2$600000$00$00');
    assert.deepEqual(overCap, { valid: false, upgrade: false });
});


test('Auth - 推送订阅上传失败不再静默成功', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../public/js/auth.js', import.meta.url), 'utf8');

    const uploadBody = /async function sendSubscriptionToServer\(subscription\) \{([\s\S]*?)\n\}/.exec(src);
    assert.ok(uploadBody, '必须保留独立的订阅上传函数');
    assert.doesNotMatch(uploadBody[1], /catch/, '订阅上传失败不能被 sendSubscriptionToServer 内部吞掉');
    assert.match(uploadBody[1], /await apiRequest\(/, '上传函数应只负责请求，错误交给调用方处理');
    assert.match(src, /rememberPushServerState\('failed'\)/, '失败必须记录为待同步状态');
    assert.match(src, /重试同步/, '失败后状态区要给出可重试的按钮文案');
    assert.match(src, /syncPushSubscription\(existingSub\)/, '已存在的浏览器订阅也要重新同步，不能只提示成功');
    assert.match(src, /syncPushSubscription\(subscription\)/, '新订阅必须等服务器确认后才提示成功');
});

test('Auth ClawBot - 扫码等待中切后台暂停定时器，切回前台未过期恢复轮询，已过期触发失效', async () => {
    // 准备浏览器全局环境 Mock（若尚未初始化）
    if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
    if (typeof globalThis.localStorage === 'undefined') {
        const store = new Map();
        globalThis.localStorage = {
            getItem: (k) => store.get(k) || null,
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
            clear: () => store.clear()
        };
    }
    if (typeof globalThis.location === 'undefined') {
        globalThis.location = { hostname: 'localhost', origin: 'http://localhost', protocol: 'http:' };
    }
    const domEls = {
        'bot-claw-title': { textContent: '' },
        'bot-claw-hint': { textContent: '' },
        'btn-bot-claw-bind': { hidden: false, disabled: false, textContent: '' },
        'btn-bot-claw-unbind': { hidden: true },
        'bot-claw-qr': { hidden: false },
        'bot-claw-qr-img': { removeAttribute: () => {}, onerror: null },
        'bot-claw-qr-hint': { textContent: '' },
        'bot-claw-qr-note': { hidden: true, textContent: '' },
        'btn-bot-claw-cancel': { hidden: false }
    };
    let visibilityState = 'visible';
    let visibilityHandler = null;
    globalThis.document = {
        get visibilityState() { return visibilityState; },
        getElementById: (id) => domEls[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: (event, handler) => {
            if (event === 'visibilitychange') visibilityHandler = handler;
        }
    };

    const {
        handleBotClawVisibilityChange,
        isBotClawWaitingForScan,
        startBotClawPolling,
        stopBotClawPolling,
        _setBotClawTestState,
        _getBotClawTestState
    } = await import('../public/js/auth.js');

    // 1. 初始化等待扫码状态：有效期 60 秒
    _setBotClawTestState({
        clawExpiresAt: Date.now() + 60000,
        clawScanStartedAt: Date.now(),
        clawCheckInFlight: false,
        clawLastCheckAt: 0
    });
    domEls['bot-claw-qr'].hidden = false;
    assert.equal(isBotClawWaitingForScan(), true, '二维码处于未隐藏且有过期时间时应处于等待扫码状态');

    startBotClawPolling();
    const state1 = _getBotClawTestState();
    assert.ok(state1.clawPollTimer, '启动轮询后定时器句柄必须有效');

    // 2. 切到后台（hidden）：用户切换至微信准备扫码，定时器暂停以省电/省流量，但上下文与二维码完整保留
    visibilityState = 'hidden';
    handleBotClawVisibilityChange();
    const state2 = _getBotClawTestState();
    assert.equal(state2.clawPollTimer, 0, '切后台必须清除定时器句柄，防止无意义后台空转');
    assert.ok(state2.clawExpiresAt > 0, '切后台绝对不能销毁二维码有效时间');
    assert.equal(domEls['bot-claw-qr'].hidden, false, '切后台二维码 DOM 必须保留');
    assert.equal(isBotClawWaitingForScan(), true, '切后台期间扫码等待标记依然有效');

    // 3. 切回前台（visible）且未过期：立即恢复定时器，并直接打上最新 check 时间戳触发核验
    visibilityState = 'visible';
    handleBotClawVisibilityChange();
    const state3 = _getBotClawTestState();
    assert.ok(state3.clawPollTimer, '切回前台必须恢复轮询定时器');
    assert.ok(state3.clawLastCheckAt > 0, '切回前台必须立即记录最新核查时间');

    stopBotClawPolling();

    // 4. 切回前台（visible）但已超时过期：触发失效逻辑，隐藏二维码并提示过期
    _setBotClawTestState({
        clawExpiresAt: Date.now() - 5000,
        clawScanStartedAt: Date.now() - 60000
    });
    handleBotClawVisibilityChange();
    assert.equal(domEls['bot-claw-qr'].hidden, true, '超时切回前台必须隐藏二维码');
    assert.match(domEls['bot-claw-title'].textContent, /已过期|超时/, '超时切回前台标题必须提示过期');
    assert.equal(isBotClawWaitingForScan(), false, '已过期状态不再被判定为等待扫码');

    stopBotClawPolling();
});
