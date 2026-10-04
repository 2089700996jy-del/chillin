import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteAvailable } from './fake-d1.mjs';
import {
    handlePostWeekly,
    handleGetWeeklies,
    handlePutWeekly,
    handleDeleteWeekly,
    handlePostNote,
    handlePostBookmark,
    handlePostPrompt,
    handlePostFeed,
    handleGetFeeds,
    handleGetReaderProgress,
    handlePostReaderProgress
} from '../workers/src/garden-resources.js';
import { handleSyncPull, handleSyncBatch, handleHeatmap } from '../workers/src/garden-sync.js';

// node:sqlite 需要 Node >= 22.5；旧版本上这些集成用例跳过（CI 同时跑 20/22）
const integration = sqliteAvailable ? test : test.skip;

const jsonRequest = (url, body, method = 'POST') => new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

integration('Garden CRUD - weekly lifecycle, ownership and soft-delete tombstone', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);

    const created = await handlePostWeekly(
        jsonRequest('https://x/api/weeklies', { id: 1001, category: '生活', title: '第一篇', summary: '摘要', date: '2026-10-01' }),
        db, 1
    );
    assert.equal(created.status, 201);
    assert.equal((await created.json()).id, 1001);

    const list = await (await handleGetWeeklies(new URL('https://x/api/weeklies'), db, 1)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, '第一篇');

    // 另一个用户看不到、也改不动
    assert.equal((await (await handleGetWeeklies(new URL('https://x/api/weeklies'), db, 2)).json()).length, 0);
    const foreign = await handlePostWeekly(
        jsonRequest('https://x/api/weeklies', { id: 1001, category: '生活', title: '篡改', summary: '', date: '2026-10-01' }),
        db, 2
    );
    assert.equal(foreign.status, 403);

    // 更新
    const updated = await handlePutWeekly(1001, jsonRequest('https://x/api/weeklies/1001', { category: '生活', title: '改过', summary: 's2', date: '2026-10-02' }, 'PUT'), db, 1);
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).title, '改过');

    // 软删后：列表为空，但行还在（墓碑），且不允许被覆盖
    await handleDeleteWeekly(1001, db, 1);
    assert.equal((await (await handleGetWeeklies(new URL('https://x/api/weeklies'), db, 1)).json()).length, 0);
    const resurrect = await handlePostWeekly(
        jsonRequest('https://x/api/weeklies', { id: 1001, category: '生活', title: '复活', summary: '', date: '2026-10-03' }),
        db, 1
    );
    assert.equal(resurrect.status, 409);
});

integration('Garden sync - pull returns rows, batch push applies deltas and tombstones', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    await handlePostFeed(jsonRequest('https://x/api/feeds', { id: 2001, content: '第一条随手记', tags: ['#技术'] }), db, 1);

    const pulled = await (await handleSyncPull(new URL('https://x/api/sync/pull'), db, 1)).json();
    assert.equal(pulled.feeds.length, 1);

    const batch = await handleSyncBatch(jsonRequest('https://x/api/sync/batch', {
        weeklies: [{ id: 3001, category: '工作', title: '批量', summary: '', date: '2026-10-02' }],
        notes: [], bookmarks: [], feeds: [], prompts: [],
    }), db, 1);
    assert.equal(batch.status, 200);

    const afterBatch = await (await handleSyncPull(new URL('https://x/api/sync/pull'), db, 1)).json();
    assert.equal(afterBatch.weeklies.length, 1);

    // 已软删的 id 不允许通过批量接口复活
    await handleDeleteWeekly(3001, db, 1);
    await handleSyncBatch(jsonRequest('https://x/api/sync/batch', {
        weeklies: [{ id: 3001, category: '工作', title: '复活尝试', summary: '', date: '2026-10-02' }],
        notes: [], bookmarks: [], feeds: [], prompts: [],
    }), db, 1);
    const final = await (await handleSyncPull(new URL('https://x/api/sync/pull'), db, 1)).json();
    assert.equal(final.weeklies.filter((w) => w.id === 3001 && !w.is_deleted).length, 0);
});

integration('Garden stats - heatmap aggregates across resources for one user only', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);
    await handlePostFeed(jsonRequest('https://x/api/feeds', { id: 4001, content: '用户一', created_at: '2026-10-01 09:00:00' }), db, 1);
    await handlePostFeed(jsonRequest('https://x/api/feeds', { id: 4002, content: '用户二', created_at: '2026-10-01 09:00:00' }), db, 2);

    const heatmap = await (await handleHeatmap(db, 1)).json();
    const total = heatmap.reduce((n, row) => n + row.count, 0);
    assert.equal(total, 1);
    assert.equal((await (await handleGetFeeds(new URL('https://x/api/feeds'), db, 1)).json()).length, 1);
});

integration('Garden reader progress - upsert, user isolation and progress sync', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);

    // 初始查询应为空
    const initial = await (await handleGetReaderProgress(db, 1)).json();
    assert.equal(initial.length, 0);

    // 用户 1 保存进度
    const saved = await handlePostReaderProgress(
        jsonRequest('https://x/api/reader/progress', {
            book_key: 'santi::85',
            book_title: '三体',
            chapter_index: 3,
            chapter_title: '第4章 科学边界',
            scroll_percentage: 42
        }),
        db, 1
    );
    assert.equal(saved.status, 200);

    // 用户 1 读取进度
    const list1 = await (await handleGetReaderProgress(db, 1)).json();
    assert.equal(list1.length, 1);
    assert.equal(list1[0].book_key, 'santi::85');
    assert.equal(list1[0].chapter_index, 3);
    assert.equal(list1[0].scroll_percentage, 42);

    // 用户 2 相互隔离，看不到用户 1 的进度
    const list2 = await (await handleGetReaderProgress(db, 2)).json();
    assert.equal(list2.length, 0);

    // 用户 1 更新同一本书的进度（触发 ON CONFLICT DO UPDATE）
    await handlePostReaderProgress(
        jsonRequest('https://x/api/reader/progress', {
            book_key: 'santi::85',
            book_title: '三体',
            chapter_index: 5,
            chapter_title: '第6章 射手与农场主',
            scroll_percentage: 88
        }),
        db, 1
    );
    const updatedList1 = await (await handleGetReaderProgress(db, 1)).json();
    assert.equal(updatedList1.length, 1);
    assert.equal(updatedList1[0].chapter_index, 5);
    assert.equal(updatedList1[0].scroll_percentage, 88);
});

integration('Garden CRUD - autoincrement ID generation when ID is omitted', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    const createdWeekly = await handlePostWeekly(
        jsonRequest('https://x/api/weeklies', { category: '工作', title: '自增周记', summary: '自动ID', date: '2026-10-02' }),
        db, 1
    );
    assert.equal(createdWeekly.status, 201);
    const weeklyJson = await createdWeekly.json();
    assert.ok(weeklyJson.id > 0, 'should return positive autoincrement ID for weekly');
    assert.equal(weeklyJson.title, '自增周记');

    const createdNote = await handlePostNote(
        jsonRequest('https://x/api/notes', { title: '自增笔记', content: '内容', date: '2026-10-02' }),
        db, 1
    );
    assert.equal(createdNote.status, 201);
    assert.ok((await createdNote.json()).id > 0);

    const createdBm = await handlePostBookmark(
        jsonRequest('https://x/api/bookmarks', { type: '🌐 网站', title: '自增收藏', url: 'https://example.com' }),
        db, 1
    );
    assert.equal(createdBm.status, 201);
    assert.ok((await createdBm.json()).id > 0);

    const createdPrompt = await handlePostPrompt(
        jsonRequest('https://x/api/prompts', { title: '自增提示词', project: '测试', scene: '开发', content: '提示词内容' }),
        db, 1
    );
    assert.equal(createdPrompt.status, 201);
    assert.ok((await createdPrompt.json()).id > 0);
});


