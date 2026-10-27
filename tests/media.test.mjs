import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteSkip } from './fake-d1.mjs';
import { FakeR2 } from './fake-r2.mjs';

const { handleUpload, handleFileView, pruneOldBackups } = await import('../workers/src/garden-media.js');

// 12 字节 PNG 魔数（sniffImageMime 要求至少 12 字节）
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function uploadRequest(bytes, { name = 'pic.png', type = 'image/png' } = {}) {
    const form = new FormData();
    form.append('file', new File([bytes], name, { type }));
    return new Request('https://chillin.test/api/upload', { method: 'POST', body: form });
}

/** 上传一张图，返回 { fileId, token, row } */
async function seedImage(env, db, userId, bytes = PNG) {
    const res = await handleUpload(uploadRequest(bytes), env, db, userId);
    assert.equal(res.status, 201);
    const [item] = await res.json();
    const url = new URL('https://chillin.test' + item.src);
    const fileId = url.pathname.split('/').pop();
    const row = await db.prepare("SELECT r2_key, size, data, access_token, user_id, mime_type, created_at, datetime('now', '+8 hours', '-2 minutes') AS lo, datetime('now', '+8 hours', '+2 minutes') AS hi FROM files WHERE id = ?1").bind(fileId).first();
    return { fileId, token: url.searchParams.get('t'), row };
}

test('Media - upload writes bytes to R2 and keeps only metadata in D1', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);
    const r2 = new FakeR2();

    const { fileId, token, row } = await seedImage({ MEDIA: r2 }, db, 7);

    assert.equal(row.data, null, 'D1 must no longer hold the image bytes');
    assert.equal(row.r2_key, `uploads/7/${fileId}`);
    assert.equal(row.size, PNG.length);
    assert.equal(row.mime_type, 'image/png');
    assert.equal(r2.store.has(row.r2_key), true, 'R2 must hold the object');
    assert.deepEqual([...r2.store.get(row.r2_key).bytes], [...PNG]);
    assert.ok(token && token.length > 10, 'a random access token must be issued');
    // 时间基准：新建文件的 created_at 必须落在东八区（曾依赖 SQLite 的 UTC 默认值）
    assert.ok(
        row.created_at >= row.lo && row.created_at <= row.hi,
        'files.created_at 必须是东八区时间，实际为 ' + row.created_at
    );
});

test('Media - file view streams the R2 object with its content type and ETag', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);
    const r2 = new FakeR2();
    const { fileId, token } = await seedImage({ MEDIA: r2 }, db, 7);

    const res = await handleFileView(fileId, new Request(`https://chillin.test/api/file/${fileId}?t=${token}`), { MEDIA: r2 }, db, async () => null);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/png');
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    assert.ok(res.headers.get('ETag'), 'ETag is required for conditional caching');
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG]);
});

test('Media - file view rejects a wrong access token', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);
    const r2 = new FakeR2();
    const { fileId } = await seedImage({ MEDIA: r2 }, db, 7);

    const res = await handleFileView(fileId, new Request(`https://chillin.test/api/file/${fileId}?t=forged`), { MEDIA: r2 }, db, async () => null);
    assert.equal(res.status, 403);
});

test('Media - file view answers Range requests with 206 and Content-Range', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);
    const r2 = new FakeR2();
    const { fileId, token } = await seedImage({ MEDIA: r2 }, db, 7);

    const req = new Request(`https://chillin.test/api/file/${fileId}?t=${token}`, { headers: { Range: 'bytes=2-5' } });
    const res = await handleFileView(fileId, req, { MEDIA: r2 }, db, async () => null);

    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), `bytes 2-5/${PNG.length}`);
    assert.equal(res.headers.get('Content-Length'), '4');
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG.slice(2, 6)]);
});

test('Media - legacy D1 blobs keep working before the migration script runs', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);
    const r2 = new FakeR2();
    // 模拟迁移前的历史行：只有 D1 BLOB，没有 r2_key
    await db.prepare('INSERT INTO files (id, mime_type, data, access_token, user_id) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind('legacy-1', 'image/png', PNG, 'tok-legacy', 7).run();

    const res = await handleFileView('legacy-1', new Request('https://chillin.test/api/file/legacy-1?t=tok-legacy'), { MEDIA: r2 }, db, async () => null);
    assert.equal(res.status, 200);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG]);
});

test('Media - upload falls back to D1 when no R2 binding exists', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);

    const { row } = await seedImage({}, db, 7);
    assert.equal(row.r2_key, null);
    assert.ok(row.data, 'without R2 the bytes must still land in D1');
});

test('Media - upload rejects a payload whose magic number is not an image', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);
    const r2 = new FakeR2();

    const res = await handleUpload(uploadRequest(new TextEncoder().encode('not an image at all'), { name: 'evil.png', type: 'image/png' }), { MEDIA: r2 }, db, 7);
    assert.equal(res.status, 400);
    assert.equal(r2.store.size, 0, 'nothing may be written to R2 when validation fails');
});

test('Media - backup retention keeps the newest snapshots and drops expired ones', async () => {
    const r2 = new FakeR2();
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
        const key = `backups/chillin-d1-${i}.sql.gz`;
        await r2.put(key, 'snapshot');
        r2.store.get(key).uploaded = new Date(Date.now() - (i + 1) * 40 * day);
    }

    const result = await pruneOldBackups({ MEDIA: r2 });

    assert.equal(result.scanned, 5);
    assert.equal(result.deleted, 2, 'only the two oldest may expire; the newest three are always kept');
    assert.equal(r2.store.has('backups/chillin-d1-0.sql.gz'), true);
    assert.equal(r2.store.has('backups/chillin-d1-3.sql.gz'), false);
});

test('Media - backup retention 翻完所有分页（不被 R2 单页上限截断而误保/误删）', async () => {
    const r2 = new FakeR2({ pageLimit: 2 });
    const day = 24 * 60 * 60 * 1000;
    // 6 份快照，key 字典序 = 时间顺序（与真实备份命名一致），最旧的在第一页
    for (let i = 0; i < 6; i++) {
        const key = `backups/chillin-d1-${i}.sql.gz`;
        await r2.put(key, 'snapshot');
        r2.store.get(key).uploaded = new Date(Date.now() - (6 - i + 30) * day);
    }

    const result = await pruneOldBackups({ MEDIA: r2 });

    assert.equal(result.scanned, 6, '必须翻完全部分页，而不是只看第一页');
    assert.equal(result.deleted, 3, '超过 30 天且不在最新 3 份内的快照才应删除');
    for (const i of [3, 4, 5]) {
        assert.equal(r2.store.has(`backups/chillin-d1-${i}.sql.gz`), true, `最新快照 ${i} 必须保留`);
    }
    for (const i of [0, 1, 2]) {
        assert.equal(r2.store.has(`backups/chillin-d1-${i}.sql.gz`), false, `过期快照 ${i} 必须删除`);
    }
});

test('Media - backup retention is a no-op without an R2 binding', async () => {
    const result = await pruneOldBackups({});
    assert.deepEqual(result, { scanned: 0, deleted: 0 });
});
