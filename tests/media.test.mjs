import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteAvailable } from './fake-d1.mjs';
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
    const row = await db.prepare('SELECT r2_key, size, data, access_token, user_id, mime_type FROM files WHERE id = ?1').bind(fileId).first();
    return { fileId, token: url.searchParams.get('t'), row };
}

test('Media - upload writes bytes to R2 and keeps only metadata in D1', { skip: !sqliteAvailable }, async () => {
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
});

test('Media - file view streams the R2 object with its content type and ETag', { skip: !sqliteAvailable }, async () => {
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

test('Media - file view rejects a wrong access token', { skip: !sqliteAvailable }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);
    const r2 = new FakeR2();
    const { fileId } = await seedImage({ MEDIA: r2 }, db, 7);

    const res = await handleFileView(fileId, new Request(`https://chillin.test/api/file/${fileId}?t=forged`), { MEDIA: r2 }, db, async () => null);
    assert.equal(res.status, 403);
});

test('Media - file view answers Range requests with 206 and Content-Range', { skip: !sqliteAvailable }, async () => {
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

test('Media - legacy D1 blobs keep working before the migration script runs', { skip: !sqliteAvailable }, async () => {
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

test('Media - upload falls back to D1 when no R2 binding exists', { skip: !sqliteAvailable }, async () => {
    const db = createTestDb();
    await seedUser(db, 7);

    const { row } = await seedImage({}, db, 7);
    assert.equal(row.r2_key, null);
    assert.ok(row.data, 'without R2 the bytes must still land in D1');
});

test('Media - upload rejects a payload whose magic number is not an image', { skip: !sqliteAvailable }, async () => {
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

test('Media - backup retention is a no-op without an R2 binding', async () => {
    const result = await pruneOldBackups({});
    assert.deepEqual(result, { scanned: 0, deleted: 0 });
});
