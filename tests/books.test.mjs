import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteSkip } from './fake-d1.mjs';
import { FakeR2 } from './fake-r2.mjs';

const { handleListReaderBooks, handlePutReaderBook, handleGetReaderBook, handleDeleteReaderBook } =
    await import('../workers/src/garden-books.js');

const BOOK_KEY = '测试小说::3';
const BOOK_TEXT = '第一章 起风了\n正文内容一\n第二章 落雨\n正文内容二\n第三章 天晴\n正文内容三';

function putRequest(text, { key = BOOK_KEY, title = '测试小说', author = '某作者', chapters = 3 } = {}) {
    const params = new URLSearchParams({ key, title, author, chapters: String(chapters) });
    return new Request('https://chillin.test/api/reader/books?' + params.toString(), { method: 'POST', body: text });
}

test('Reader books - upload keeps the text in R2 and the metadata in D1', { skip: sqliteSkip }, async () => {
    const db = createTestDb();
    await seedUser(db, 3);
    const r2 = new FakeR2();

    const res = await handlePutReaderBook(putRequest(BOOK_TEXT), { MEDIA: r2 }, db, 3);
    assert.equal(res.status, 200);

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
    // 别人的指纹不能通过删除接口把书删掉
    await handleDeleteReaderBook(encodeURIComponent(BOOK_KEY), { MEDIA: r2 }, db, 4);
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
