import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, sqliteAvailable } from './fake-d1.mjs';
import { FakeR2 } from './fake-r2.mjs';
import { handleRegister } from '../workers/src/auth.js';
import api from '../workers/api.js';

/**
 * 网关级集成用例：走真实的 workers/api.js 路由表 + 真实会话 Cookie，
 * 覆盖 R2 相关的路由接线（单元测试只验领域函数，接错路由它们测不出来）。
 */
const integration = sqliteAvailable ? test : test.skip;
const env = { ALLOW_REGISTRATION: 'true', PROXY_SHARED_SECRET: 'test-secret' };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const BOOK_KEY = '网关测试书::2';
const BOOK_TEXT = '第一章 甲\n正文甲\n第二章 乙\n正文乙';

async function signIn(db, username = 'router-user') {
    const res = await handleRegister(new Request('https://x/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'passw0rd1' })
    }), env, db);
    assert.equal(res.status, 201, 'registration should create the account');
    return (await res.json()).token;
}

function call(db, r2, path, { method = 'GET', token = '', body, headers = {} } = {}) {
    const h = new Headers(headers);
    if (token) h.set('Cookie', `chillin_session=${token}`);
    return api.fetch(new Request('https://x' + path, { method, headers: h, body }), { ...env, DB: db, MEDIA: r2 }, {});
}

integration('Router - reader books endpoints are wired through the gateway', async () => {
    const db = createTestDb();
    const r2 = new FakeR2();
    const token = await signIn(db);

    // 未登录会被鉴权闸门拦下（证明路由落在闸门之后而不是 404）
    assert.equal((await call(db, r2, '/api/reader/books')).status, 401);

    const empty = await call(db, r2, '/api/reader/books', { token });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), []);

    const params = new URLSearchParams({ key: BOOK_KEY, title: '网关测试书', author: '作者', chapters: '2' });
    const upload = await call(db, r2, '/api/reader/books?' + params.toString(), {
        method: 'POST', token, body: BOOK_TEXT, headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
    assert.equal(upload.status, 200);

    const listed = await (await call(db, r2, '/api/reader/books', { token })).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].book_key, BOOK_KEY);

    const download = await call(db, r2, '/api/reader/books/' + encodeURIComponent(BOOK_KEY), { token });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), BOOK_TEXT);

    const removed = await call(db, r2, '/api/reader/books/' + encodeURIComponent(BOOK_KEY), { method: 'DELETE', token });
    assert.equal(removed.status, 200);
    assert.deepEqual(await (await call(db, r2, '/api/reader/books', { token })).json(), []);
    assert.equal(r2.store.size, 0);
});

integration('Router - image upload and token-guarded delivery work end to end', async () => {
    const db = createTestDb();
    const r2 = new FakeR2();
    const token = await signIn(db, 'uploader');

    const form = new FormData();
    form.append('file', new File([PNG], 'pic.png', { type: 'image/png' }));
    const uploaded = await call(db, r2, '/api/upload', { method: 'POST', token, body: form });
    assert.equal(uploaded.status, 201);
    const [{ src }] = await uploaded.json();
    assert.match(src, /^\/api\/file\/[0-9a-f-]{36}\?t=/);

    // 带令牌直读（公开路由，不需要会话）
    const image = await call(db, r2, src);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('Content-Type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [...PNG]);

    // 令牌不对必须拒绝
    assert.equal((await call(db, r2, src.split('?')[0] + '?t=forged')).status, 403);
});

integration('Router - unknown reader-book sub-paths stay 404', async () => {
    const db = createTestDb();
    const r2 = new FakeR2();
    const token = await signIn(db, 'prober');

    assert.equal((await call(db, r2, '/api/reader/books/', { token })).status, 404);
    assert.equal((await call(db, r2, '/api/reader/books-x', { token })).status, 404);
});
