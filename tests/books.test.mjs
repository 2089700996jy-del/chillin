import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteSkip } from './fake-d1.mjs';
import { FakeR2 } from './fake-r2.mjs';

const { handleListReaderBooks, handlePutReaderBook, handleGetReaderBook, handleDeleteReaderBook } =
    await import('../workers/src/garden-books.js');

const BOOK_KEY = '测试小说::3';
const BOOK_TEXT = '第一章 起风了\n正文内容一\n第二章 落雨\n正文内容二\n第三章 天晴\n正文内容三';

function putRequest(text, { key = BOOK_KEY, title = '测试小说', author = '某作者', chapters = 3, force = false } = {}) {
    const params = new URLSearchParams({ key, title, author, chapters: String(chapters) });
    if (force) params.set('force', '1');
    return new Request('https://chillin.test/api/reader/books?' + params.toString(), { method: 'POST', body: text });
}

test('Reader books - upload keeps the text in R2 and the metadata in D1', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 3);
    const r2 = new FakeR2();

    const res = await handlePutReaderBook(putRequest(BOOK_TEXT), { MEDIA: r2 }, db, 3);
    assert.equal(res.status, 200);
    const putBody = await res.json();
    assert.equal(putBody.ok, true);
    assert.equal(putBody.book_key, BOOK_KEY);
    assert.ok(putBody.size > 0);
    assert.ok(typeof putBody.updated_at === 'string' && putBody.updated_at.length > 0, '上传接口应返回 updated_at 供多端比对版本');

    const row = await db.prepare('SELECT book_key, title, author, total_chapters, size, r2_key, is_deleted FROM reader_books').first();
    assert.equal(row.book_key, BOOK_KEY);
    assert.equal(row.total_chapters, 3);
    assert.equal(row.is_deleted, 0);
    assert.match(row.r2_key, /^books\/3\/[0-9a-f]{64}\.txt$/, 'object key must be a hashed, filesystem-safe path');
    assert.equal(Buffer.from(r2.store.get(row.r2_key).bytes).toString('utf8'), BOOK_TEXT);
});

test('Reader books - list, download and delete round-trip', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 3);
    const r2 = new FakeR2();
    await handlePutReaderBook(putRequest(BOOK_TEXT), { MEDIA: r2 }, db, 3);

    const listed = await (await handleListReaderBooks(db, 3)).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].book_key, BOOK_KEY);
    assert.equal(listed[0].title, '测试小说');

    const download = await handleGetReaderBook(encodeURIComponent(BOOK_KEY), { MEDIA: r2 }, db, 3);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('Content-Type'), /text\/plain/);
    assert.match(download.headers.get('Cache-Control') || '', /no-cache|no-store/, '下载书籍正文不得长缓存，防止重传修改后备用机拿旧缓存');
    assert.equal(await download.text(), BOOK_TEXT);

    const deleted = await handleDeleteReaderBook(encodeURIComponent(BOOK_KEY), { MEDIA: r2 }, db, 3);
    assert.equal(deleted.status, 200);

    const after = await (await handleListReaderBooks(db, 3)).json();
    assert.equal(after.length, 0, 'soft-deleted books must disappear from the shelf');
    assert.equal(r2.store.size, 0, 'the R2 object must be reclaimed on delete');
    assert.equal((await handleGetReaderBook(encodeURIComponent(BOOK_KEY), { MEDIA: r2 }, db, 3)).status, 404);
});

test('Reader books - one user can never read another user\'s book', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 3);
    await seedUser(db, 4);
    const r2 = new FakeR2();
    await handlePutReaderBook(putRequest(BOOK_TEXT), { MEDIA: r2 }, db, 3);

    const other = await (await handleListReaderBooks(db, 4)).json();
    assert.equal(other.length, 0);
    assert.equal((await handleGetReaderBook(encodeURIComponent(BOOK_KEY), { MEDIA: r2 }, db, 4)).status, 404);
    // 别人的指纹不能通过删除接口把书删掉，且必须明确返回 403 拒绝
    const delOther = await handleDeleteReaderBook(encodeURIComponent(BOOK_KEY), { MEDIA: r2 }, db, 4);
    assert.equal(delOther.status, 403, '越权删除他人书籍应返回 403');
    const stillThere = await (await handleListReaderBooks(db, 3)).json();
    assert.equal(stillThere.length, 1);
});

test('Reader books - re-importing the same fingerprint updates instead of duplicating', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 3);
    const r2 = new FakeR2();
    await handlePutReaderBook(putRequest(BOOK_TEXT), { MEDIA: r2 }, db, 3);

    const shorter = '第一章 只有一章';
    await handlePutReaderBook(putRequest(shorter, { chapters: 1 }), { MEDIA: r2 }, db, 3);

    const rows = await db.prepare('SELECT COUNT(*) AS n, MAX(total_chapters) AS chapters FROM reader_books').first();
    assert.equal(rows.n, 1, 'the same book_key must upsert');
    assert.equal(rows.chapters, 1);
    assert.equal(r2.store.size, 1);
});

test('Reader books - empty payload and missing R2 binding are rejected', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 3);
    const r2 = new FakeR2();

    assert.equal((await handlePutReaderBook(putRequest('   '), { MEDIA: r2 }, db, 3)).status, 400);
    assert.equal((await handlePutReaderBook(putRequest(BOOK_TEXT), {}, db, 3)).status, 503);
    assert.equal(r2.store.size, 0);
});
test('Reader books - 删除书籍时一并清掉云端阅读进度（P3）', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 3);
    const r2 = new FakeR2();
    await handlePutReaderBook(putRequest(BOOK_TEXT), { MEDIA: r2 }, db, 3);
    await db.prepare('INSERT INTO reader_progress (user_id, book_key, book_title, chapter_index, scroll_percentage, client_ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(3, BOOK_KEY, '测试小说', 2, 50, 1000).run();

    const res = await handleDeleteReaderBook(encodeURIComponent(BOOK_KEY), { MEDIA: r2 }, db, 3);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).progress_deleted, 1, '应连带删除该书的阅读进度');

    const left = await db.prepare('SELECT COUNT(*) AS n FROM reader_progress WHERE user_id = ?1').bind(3).first();
    assert.equal(left.n, 0, '书删了，进度不该留在库里');
});

test('Reader books - 云端删除后禁止多设备自动补传幽灵复活，带 force=1 显式导入才允许复活', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 3);
    const r2 = new FakeR2();
    await handlePutReaderBook(putRequest(BOOK_TEXT), { MEDIA: r2 }, db, 3);

    // 1. 在设备 A 删除书籍
    const delRes = await handleDeleteReaderBook(encodeURIComponent(BOOK_KEY), { MEDIA: r2 }, db, 3);
    assert.equal(delRes.status, 200);

    // 2. 带 include_deleted 能查到墓碑
    const listWithDeleted = await (await handleListReaderBooks(db, 3, new URL('https://chillin.test/api/reader/books?include_deleted=1'))).json();
    assert.equal(listWithDeleted.length, 1);
    assert.equal(listWithDeleted[0].is_deleted, 1, '墓碑行必须能够被客户端感知');

    // 3. 设备 B 尝试自动补传（不带 force=1）被 409 拦截
    const autoBackfillRes = await handlePutReaderBook(putRequest(BOOK_TEXT, { force: false }), { MEDIA: r2 }, db, 3);
    assert.equal(autoBackfillRes.status, 409, '自动补传已被软删书籍必须拒绝');
    const autoBackfillBody = await autoBackfillRes.json();
    assert.equal(autoBackfillBody.deleted, true);

    const checkStillDeleted = await db.prepare('SELECT is_deleted FROM reader_books WHERE book_key = ?1').bind(BOOK_KEY).first();
    assert.equal(checkStillDeleted.is_deleted, 1, '书籍在 D1 中依然保持删除状态，未被复活');

    // 4. 用户手动显式重新导入（带 force=1）允许复活
    const manualImportRes = await handlePutReaderBook(putRequest(BOOK_TEXT, { force: true }), { MEDIA: r2 }, db, 3);
    assert.equal(manualImportRes.status, 200, '用户手动导入允许复活');

    const checkRevived = await db.prepare('SELECT is_deleted FROM reader_books WHERE book_key = ?1').bind(BOOK_KEY).first();
    assert.equal(checkRevived.is_deleted, 0, '显式导入后书籍状态成功复活');
});
