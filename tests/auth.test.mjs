import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, sqliteAvailable } from './fake-d1.mjs';
import {
    handleRegister,
    handleLogin,
    handleRefreshSession,
    handleListSessions,
    handleRevokeSession,
    handleLogoutAll,
    tokenHash,
} from '../workers/src/auth.js';

const integration = sqliteAvailable ? test : test.skip;
const env = { ALLOW_REGISTRATION: 'true', PROXY_SHARED_SECRET: 'test-secret' };

const jsonRequest = (url, body) => new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
