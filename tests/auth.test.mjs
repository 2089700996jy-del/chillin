import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, sqliteTest } from './fake-d1.mjs';
import { rateLimitBuckets } from '../workers/src/security-network.js';
import { hashPassword, PBKDF2_ITERATIONS } from '../workers/src/security-crypto.js';
import {
    handleRegister,
    handleLogin,
    handleRefreshSession,
    handleListSessions,
    handleRevokeSession,
    handleLogoutAll,
    handleChangePassword,
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
    assert.match(after.password_hash, /^pbkdf2\$600000\$/);

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

integration('Auth - 旧的 10 万次哈希在登录成功后就地升级到当前迭代数', async () => {
    rateLimitBuckets.clear();
    assert.equal(PBKDF2_ITERATIONS, 600000, '当前标准是 OWASP 2023 的 60 万次');
    const db = createTestDb();
    const oldHash = await hashPassword('passw0rd1', 100000);
    assert.match(oldHash, /^pbkdf2\$100000\$/);
    await db.prepare('INSERT INTO users (username, password_hash) VALUES (?1, ?2)')
        .bind('legacy', oldHash).run();

    const login = await handleLogin(
        jsonRequest('https://x/api/auth/login', { username: 'legacy', password: 'passw0rd1' }), env, db
    );
    assert.equal(login.status, 200);

    const row = await db.prepare('SELECT password_hash FROM users WHERE username = ?1').bind('legacy').first();
    assert.match(row.password_hash, /^pbkdf2\$600000\$/, '登录成功后应透明升级到 60 万次');
    assert.equal((await handleLogin(
        jsonRequest('https://x/api/auth/login', { username: 'legacy', password: 'passw0rd1' }), env, db
    )).status, 200, '升级后旧密码仍可登录');
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
