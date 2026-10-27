import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
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
import { handleExport } from '../workers/src/garden-export.js';
import { scanAndAudit } from '../workers/src/audit.js';
import { isOwnedRecord } from '../workers/src/garden-shared.js';

// node:sqlite 需要 Node >= 22.5；旧版本上这些集成用例跳过（CI 同时跑 20/22）
const integration = sqliteTest;

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

integration('Garden sync - overlapping cursor recovers rows with the same second timestamp', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const sharedTs = '2026-10-16 12:00:05';
    await db.prepare(`INSERT INTO quick_feeds (id, user_id, content, type, created_at, updated_at, is_deleted)
        VALUES (1, 1, 'first row', 'text', ?1, ?1, 0)`).bind(sharedTs).run();

    const initial = await (await handleSyncPull(new URL('https://x/api/sync/pull'), db, 1)).json();
    assert.equal(initial.feeds.length, 1);
    const cursor = initial.feeds[0].updated_at;

    await db.prepare(`INSERT INTO quick_feeds (id, user_id, content, type, created_at, updated_at, is_deleted)
        VALUES (2, 1, 'late row with matching timestamp', 'text', ?1, ?1, 0)`).bind(sharedTs).run();
    const strictAfter = await (await handleSyncPull(new URL(`https://x/api/sync/pull?since_feeds=${encodeURIComponent(cursor)}`), db, 1)).json();
    assert.equal(strictAfter.feeds.length, 0, 'strictly-greater query misses a late row tied at the cursor');

    const overlapCursor = '2026-10-16 12:00:04';
    const recovered = await (await handleSyncPull(new URL(`https://x/api/sync/pull?since_feeds=${encodeURIComponent(overlapCursor)}`), db, 1)).json();
    assert.equal(recovered.feeds.length, 2, 'one-second overlap returns the tied rows for client-side merge');
});
integration('Garden sync - batch pushes > 100 statements safely with D1 chunking', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    // 1. 验证 FakeD1 本身严格拦截超额单次 batch 调用
    const overflowStmts = Array.from({ length: 105 }, () => db.prepare('SELECT 1'));
    await assert.rejects(
        () => db.batch(overflowStmts),
        /D1_ERROR: Batch size too large/
    );

    // 2. 验证 handleSyncBatch 在面对 120 条数据时自动切片并全部入库成功
    const bulkFeeds = Array.from({ length: 120 }, (_, i) => ({
        id: 5000 + i,
        content: `批量测试随手记 #${i}`,
        type: 'idea',
        tags: ['#测试']
    }));

    const res = await handleSyncBatch(jsonRequest('https://x/api/sync/batch', {
        weeklies: [],
        notes: [],
        bookmarks: [],
        feeds: bulkFeeds,
        prompts: []
    }), db, 1);

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 120);

    // 3. 验证聚合拉取全部 120 条生效
    const pulled = await (await handleSyncPull(new URL('https://x/api/sync/pull'), db, 1)).json();
    assert.equal(pulled.feeds.length, 120);
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


integration('Sync batch - 超过单种资源条数上限时拒绝（防超大请求）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const many = Array.from({ length: 201 }, (_, i) => ({ id: 'w' + i, title: 't' + i, content: 'c' }));
    const res = await handleSyncBatch(jsonRequest('https://x/api/sync/batch', { weeklies: many }), db, 1);
    assert.equal(res.status, 413);
});

integration('Sync batch - 单条记录体积过大时拒绝', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const huge = { id: 'w1', title: 'big', content: 'x'.repeat(201 * 1024) };
    const res = await handleSyncBatch(jsonRequest('https://x/api/sync/batch', { weeklies: [huge] }), db, 1);
    assert.equal(res.status, 413);
});

integration('Sync batch - 非法 JSON 与非对象载荷返回 400', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const bad = new Request('https://x/api/sync/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    assert.equal((await handleSyncBatch(bad, db, 1)).status, 400);
    assert.equal((await handleSyncBatch(jsonRequest('https://x/api/sync/batch', [1, 2, 3]), db, 1)).status, 400);
});
integration('CRUD - 请求体超过 512KB 时返回 413（不再直接 request.json()）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const req = new Request('https://x/api/weeklies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x'.repeat(600 * 1024) })
    });
    assert.equal((await handlePostWeekly(req, db, 1)).status, 413);
});

integration('Audit - 违规内容改软删墓碑，重复扫描不重复隔离（堵住「复活—删除」循环）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    // 命中 UGC_VIOLATION_RE 的笔记（关键词：加微信 / 刷单 / 兼职日结）
    await db.prepare(
        "INSERT INTO notes (id, title, content, date, user_id, updated_at) VALUES (9001, '正常标题', '加微信 刷单 兼职日结', '2026-10-01', 1, '2026-10-01 10:00:00')"
    ).run();

    const first = await scanAndAudit(db, 1);
    assert.equal(first.quarantined, 1);

    // 行必须仍然存在（墓碑），物理删除会让客户端下次 sync/batch 把它原样写回
    const row = await db.prepare('SELECT is_deleted, updated_at FROM notes WHERE id = 9001').first();
    assert.ok(row, '违规行应保留为墓碑，而不是被物理删除');
    assert.equal(Number(row.is_deleted), 1, '违规行应打上软删标记');
    assert.notEqual(row.updated_at, '2026-10-01 10:00:00', 'tombstone 必须推进 updated_at 才能被增量拉取下发');

    // 重复扫描：已隔离的行不再被命中，隔离区与审计日志都不再增长
    const second = await scanAndAudit(db, 1);
    assert.equal(second.quarantined, 0, '已隔离的行不应被重复隔离');
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM ugc_quarantine').first()).c), 1);
    // 时间基准：隔离区记录的 created_at 必须落在东八区（曾依赖 SQLite 的 UTC 默认值）
    const quarantined = await db.prepare(
        "SELECT created_at, datetime('now', '+8 hours', '-2 minutes') AS lo, datetime('now', '+8 hours', '+2 minutes') AS hi FROM ugc_quarantine LIMIT 1"
    ).first();
    assert.ok(
        quarantined.created_at >= quarantined.lo && quarantined.created_at <= quarantined.hi,
        'ugc_quarantine.created_at 必须是东八区时间，实际为 ' + quarantined.created_at
    );
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM audit_log').first()).c), 1);

    // 墓碑对增量同步可见：客户端据此移除本地副本
    const pullUrl = new URL('https://x/api/sync/pull');
    pullUrl.searchParams.set('since', '2026-09-30 00:00:00');
    const pull = await (await handleSyncPull(pullUrl, db, 1)).json();
    assert.ok(pull.notes.some((n) => n.id === 9001 && n.is_deleted === true), '增量拉取应下发墓碑');
});

test('TestInfra - 缺 node:sqlite 时集成用例带可读原因跳过（不静默消失）', async () => {
    const { sqliteAvailable, sqliteSkip } = await import('./fake-d1.mjs');
    if (sqliteAvailable) {
        assert.equal(sqliteSkip, false, '有 node:sqlite 时不应跳过任何用例');
    } else {
        assert.match(String(sqliteSkip), /node:sqlite 需要 Node/, '跳过原因必须说明是运行环境问题，否则 CI 的 Node 20 腿全绿却说不清');
    }
});

integration('Garden CRUD - 覆盖写保留 created_at（REPLACE → UPSERT 回归）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    await handlePostWeekly(
        jsonRequest('https://x/api/weeklies', { id: 2001, category: '生活', title: '老文章', summary: '', date: '2026-01-01' }),
        db, 1
    );
    // 模拟历史数据：created_at 是一个很久以前的时间
    await db.prepare("UPDATE weeklies SET created_at = '2020-01-01 00:00:00' WHERE id = 2001").run();

    const again = await handlePostWeekly(
        jsonRequest('https://x/api/weeklies', { id: 2001, category: '生活', title: '改了标题', summary: '', date: '2026-01-02' }),
        db, 1
    );
    assert.equal(again.status, 201);

    const row = await db.prepare('SELECT title, created_at FROM weeklies WHERE id = 2001').first();
    assert.equal(row.title, '改了标题', '内容应被覆盖为最新值');
    assert.equal(row.created_at, '2020-01-01 00:00:00', 'created_at 必须保留原值（INSERT OR REPLACE 会把它重置为当前时间）');
});

integration('Garden Sync - 重复推送保留 created_at（REPLACE → UPSERT 回归）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const push = (body) => handleSyncBatch(jsonRequest('https://x/api/sync/batch', body), db, 1);

    await push({ feeds: [{ id: 3001, content: '第一条', created_at: '2019-05-05 08:00:00' }] });
    assert.equal((await db.prepare('SELECT created_at FROM quick_feeds WHERE id = 3001').first()).created_at, '2019-05-05 08:00:00');

    // 第二次推送不带 created_at：旧实现（REPLACE）会把它重置为当前时间
    await push({ feeds: [{ id: 3001, content: '改过的内容' }] });
    const after = await db.prepare('SELECT content, created_at FROM quick_feeds WHERE id = 3001').first();
    assert.equal(after.content, '改过的内容', '内容应更新');
    assert.equal(after.created_at, '2019-05-05 08:00:00', 'created_at 必须保留原值');
});

integration('Garden CRUD - 新建记录写入东八区 created_at（与 updated_at 同口径，不再走 UTC 默认值）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    // 不传 id：走 INSERT 分支，created_at 由 SQL 显式写入
    await handlePostNote(jsonRequest('https://x/api/notes', { title: '口径一致性', content: '正文', date: '2026-10-18' }), db, 1);
    const note = await db.prepare("SELECT created_at, updated_at FROM notes WHERE title = '口径一致性'").first();
    // 同一语句里两个 datetime('now','+8 hours') 必然相等；若 created_at 退回 UTC 默认值，
    // 它会比 updated_at 整整早 8 小时，这条断言就是回归哨兵。
    assert.equal(note.created_at, note.updated_at, 'created_at 与 updated_at 必须同为东八区口径');
});

integration('Migration 0023 - 存量 weeklies/notes/bookmarks 的 UTC created_at 被平移为东八区', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    // 4001：API 直建路径的历史行——created_at 恰好比 updated_at 早 8 小时（UTC 默认值指纹）
    await db.prepare(
        "INSERT INTO weeklies (id, category, title, summary, date, user_id, created_at, updated_at) VALUES (4001, '生活', '历史周记', '', '2026-10-18', 1, '2026-10-17 18:00:00', '2026-10-18 02:00:00')"
    ).run();
    // 4002：sync/batch 推送路径的历史行——created_at 与 updated_at 本来就是同一 CST 口径。
    // 远端实测 21 行里有 19 行属此类；盲移 +8 会把它们改错，这条断言就是防误伤的哨兵。
    await db.prepare(
        "INSERT INTO weeklies (id, category, title, summary, date, user_id, created_at, updated_at) VALUES (4002, '生活', '已对齐周记', '', '2026-10-18', 1, '2026-10-18 02:00:00', '2026-10-18 02:00:00')"
    ).run();

    // createTestDb 只在空库上跑过迁移，这里重放 0023 的语句以验证它对存量数据的语义
    const sql = fs.readFileSync(new URL('../migrations/0023_created_at_cst.sql', import.meta.url), 'utf8');
    const replay = () => {
        for (const stmt of sql.split(';')) {
            const trimmed = stmt.trim();
            if (trimmed) db.db.exec(trimmed);
        }
    };
    replay();

    const row = await db.prepare('SELECT created_at, updated_at FROM weeklies WHERE id = 4001').first();
    assert.equal(row.created_at, '2026-10-18 02:00:00', 'UTC created_at 应被平移为东八区');
    assert.equal(row.updated_at, '2026-10-18 02:00:00', 'updated_at 不应被改动');

    const aligned = await db.prepare('SELECT created_at FROM weeklies WHERE id = 4002').first();
    assert.equal(aligned.created_at, '2026-10-18 02:00:00', '已是 CST 的行不得再 +8（远端 21 行里 19 行属此类）');

    // 迁移应天然幂等：平移后 created_at == updated_at，重跑不再命中
    replay();
    const again = await db.prepare('SELECT created_at FROM weeklies WHERE id = 4001').first();
    assert.equal(again.created_at, '2026-10-18 02:00:00', '重放迁移不得再次平移');
});

integration('Migration 0031 - quick_feeds 重建后默认值走东八区，存量行逐列搬迁不丢', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    // 3001：普通存量行（远端 quick_feeds 的真实形态：字段齐全、时间为 CST）
    await db.prepare(
        "INSERT INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted) VALUES (3001, 1, '存量随手记', 'text', NULL, NULL, NULL, '2026-10-23 08:30:00', '2026-10-23 08:30:00', 0)"
    ).run();
    // 3002：链接卡片 + 已软删的墓碑行，重建最容易在这类行上丢字段
    await db.prepare(
        "INSERT INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted) VALUES (3002, 1, '小宇宙单集', 'link', 'https://x.example/e/1', '单集摘要', '[\"播客\",\"科技\"]', '2026-10-22 21:05:00', '2026-10-22 21:05:00', 1)"
    ).run();

    // createTestDb 只在空库上跑过迁移，这里重放 0031 以验证它对存量数据的语义
    const sql = fs.readFileSync(new URL('../migrations/0031_quick_feeds_cst_default.sql', import.meta.url), 'utf8');
    const replay = () => {
        for (const stmt of sql.split(';')) {
            const trimmed = stmt.trim();
            if (trimmed) db.db.exec(trimmed);
        }
    };
    replay();

    const kept = await db.prepare('SELECT * FROM quick_feeds WHERE id = 3001').first();
    assert.equal(kept.content, '存量随手记');
    assert.equal(kept.created_at, '2026-10-23 08:30:00', '存量 created_at 不得被加减时间');
    assert.equal(kept.updated_at, '2026-10-23 08:30:00');
    assert.equal(kept.is_deleted, 0);

    const card = await db.prepare('SELECT type, media_url, summary, tags, is_deleted FROM quick_feeds WHERE id = 3002').first();
    // node:sqlite 返回的是 null 原型对象，assert/strict 的 deepEqual 会连原型一起比，必须先展开
    assert.deepEqual(
        { ...card },
        { type: 'link', media_url: 'https://x.example/e/1', summary: '单集摘要', tags: '["播客","科技"]', is_deleted: 1 },
        '重建必须逐列保留，墓碑行也不例外'
    );

    // 默认值现在是东八区：省略 created_at 时落「此刻（东八区）」而不是 UTC
    await db.prepare("INSERT INTO quick_feeds (user_id, content, type, is_deleted) VALUES (1, '默认值探针', 'text', 0)").run();
    const probe = await db.prepare("SELECT created_at FROM quick_feeds WHERE content = '默认值探针'").first();
    const drift = Math.abs(Date.now() - Date.parse(String(probe.created_at).replace(' ', 'T') + '+08:00'));
    assert.ok(drift < 120000, '省略 created_at 必须落东八区此刻：' + probe.created_at);

    // 三个索引都要在重建后回来（少了索引，热力图与增量拉取会全表扫）
    const idx = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'quick_feeds'").all())
        .results.map((r) => r.name);
    for (const name of ['idx_quick_feeds_user_id', 'idx_quick_feeds_updated_at', 'idx_quick_feeds_is_deleted']) {
        assert.ok(idx.includes(name), '重建后缺少索引 ' + name + '：' + idx.join(', '));
    }

    // 重放必须安全：不复制行、不改时间
    replay();
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM quick_feeds').first()).n, 3, '重放不得复制出行');
    assert.equal(
        (await db.prepare('SELECT created_at FROM quick_feeds WHERE id = 3001').first()).created_at,
        '2026-10-23 08:30:00',
        '重放不得再动存量时间'
    );
});


test('时间基准 - 迁移文件的 created_at/updated_at 默认值不得再引入 UTC', async () => {
    // SQLite 的 datetime('now') 与 CURRENT_TIMESTAMP 都是 UTC，而本项目约定东八区。
    // 两条底线：
    //   1) 新增表不许用 UTC 默认值；历史表进白名单（代码已显式写 CST，列默认值还欠着）；
    //   2) 白名单只许缩小 —— 被重建过的表必须移出白名单，改为断言「最后一次定义已是东八区」。
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const LEGACY_UTC_TABLES = new Set([
        // 注意：白名单按「当前 schema 里真实存在的表名」记。0020 用「建 files_r2 → 改名回 files」重建过 files，
        // 所以这里只有 files，没有那个只存在于迁移过程中的临时名 files_r2（下面的断言会强制白名单项都能在 migrations/ 里找到定义）。
        'audit_log', 'bookmarks', 'echo_cards', 'files', 'notes',
        'push_subscriptions', 'reader_progress', 'ugc_quarantine', 'users', 'weeklies'
    ]);
    // 已被后续迁移重建为东八区的表（0031 重建了 quick_feeds）。它从白名单里毕业，
    // 换来更强的断言：必须真的出现过第二次定义，且最后一次是东八区。
    const REBUILT_CST_TABLES = new Set(['quick_feeds']);
    const isUtc = (def) => def.toUpperCase().includes('CURRENT_TIMESTAMP')
        || (def.includes("datetime('now')") && !def.includes('+8 hours'));

    const dir = path.join(root, 'migrations');
    /** table -> 按文件顺序排列的时间列默认值定义 */
    const definitions = new Map();
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        const sql = fs.readFileSync(path.join(dir, name), 'utf8');
        let table = null;
        for (const raw of sql.split('\n')) {
            const line = raw.trim();
            const upper = line.toUpperCase();
            if (upper.startsWith('CREATE TABLE')) {
                table = ((line.replace(/IF NOT EXISTS/i, '').split(/[\s(]+/)[2] || '')).replace(/["'\u0060]/g, '');
            } else if (upper.startsWith('ALTER TABLE')) {
                // `ALTER TABLE a RENAME TO b` 是「重建表」迁移的标准收尾：把 a 名下的定义转到 b，
                // 否则 quick_feeds 这类重建表在解析器眼里永远只有旧的一次 UTC 定义。
                const rename = line.match(/ALTER\s+TABLE\s+["'\u0060]?([\w]+)["'\u0060]?\s+RENAME\s+TO\s+["'\u0060]?([\w]+)["'\u0060]?/i);
                if (rename) {
                    const moved = definitions.get(rename[1]) || [];
                    definitions.set(rename[2], (definitions.get(rename[2]) || []).concat(moved));
                    definitions.delete(rename[1]);
                    table = rename[2];
                } else {
                    table = ((line.split(/[\s]+/)[2] || '')).replace(/["'\u0060]/g, '');
                }
            }
            if (!table || !/^(created_at|updated_at)/i.test(line)) continue;
            const at = upper.indexOf('DEFAULT');
            if (at === -1) continue;
            const def = line.slice(at + 7).replace(/,$/, '').trim();
            if (!definitions.has(table)) definitions.set(table, []);
            definitions.get(table).push({ file: name, column: line.split(/[\s]+/)[0], def, utc: isUtc(def) });
        }
    }

    const offenders = [];
    for (const [table, defs] of definitions) {
        const last = defs[defs.length - 1];
        for (const d of defs) {
            if (!d.utc) continue;
            if (LEGACY_UTC_TABLES.has(table)) continue;
            // 重建过的表：旧定义允许带 UTC，但最后一次定义必须已改成东八区（下面单独断言）
            if (REBUILT_CST_TABLES.has(table) && !last.utc) continue;
            offenders.push(d.file + ' → ' + table + '.' + d.column + ' DEFAULT ' + d.def);
        }
    }
    assert.equal(
        offenders.length,
        0,
        '新迁移给时间列用了 UTC 默认值（datetime(\'now\') / CURRENT_TIMESTAMP 都是 UTC，本项目用 +8 hours）：\n' + offenders.join('\n')
    );

    for (const table of REBUILT_CST_TABLES) {
        assert.ok(!LEGACY_UTC_TABLES.has(table), table + ' 不能同时待在「已重建」与「历史豁免」两个集合里');
        const defs = definitions.get(table) || [];
        assert.ok(defs.length > 1, table + ' 声称已重建，但 migrations/ 里只有一次定义：' + defs.map((d) => d.file).join(', '));
        assert.equal(
            defs[defs.length - 1].utc,
            false,
            table + ' 的最后一次定义仍是 UTC 默认值：' + defs[defs.length - 1].file + ' → ' + defs[defs.length - 1].def
        );
    }
    for (const table of LEGACY_UTC_TABLES) {
        assert.ok(definitions.has(table), '白名单中的 ' + table + ' 在 migrations/ 里找不到时间列定义，应删掉这一项');
    }
});

integration('Security - 表名助手对未知表名 fail-closed（SQL 标识符不能靠调用方自觉）', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    for (const bad of ['weeklies; DROP TABLE users', 'sqlite_master', 'notes WHERE 1=1 --']) {
        await assert.rejects(
            () => isOwnedRecord(db, bad, 1, 1),
            /unknown table/,
            '表名必须走白名单；把请求里的字符串拼进 SQL 就是注入：' + bad
        );
    }

    assert.equal(await isOwnedRecord(db, 'notes', null, 1), true, '白名单内的表照常工作（id 为空视为新建）');
    const other = await db.prepare("INSERT INTO notes (id, title, content, date, user_id) VALUES (77, 't', 'c', '2026-10-18', 2)").run();
    assert.equal(await isOwnedRecord(db, 'notes', 77, 1), false, '已存在的他人记录必须判为无权限');
});

integration('Garden export - 覆盖 D1 专属数据且不泄露凭据或越权数据', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);

    await handlePostNote(jsonRequest('https://x/api/notes', { title: '导出验证', content: '正文', date: '2026-10-20' }), db, 1);
    await handlePostNote(jsonRequest('https://x/api/notes', { title: '别人的笔记', content: '不该出现', date: '2026-10-20' }), db, 2);

    await db.prepare("INSERT INTO echo_cards (user_id, title, summary, topic, related_feed_ids) VALUES (1,'回响','摘要','成长','[1]')").run();
    await db.prepare("INSERT INTO reader_progress (user_id, book_key, book_title, chapter_index, chapter_title, scroll_percentage) VALUES (1,'book-1','长夜',3,'第三章',42)").run();
    await db.prepare("INSERT INTO reader_books (user_id, book_key, title, author, total_chapters, size, r2_key) VALUES (1,'book-1','长夜','某人',12,2048,'books/1/x.txt')").run();
    await db.prepare("INSERT INTO health_daily (user_id, date, steps, sleep_min, source) VALUES (1,'2026-10-24',8000,420,'manual')").run();
    await db.prepare("INSERT INTO bot_profile (user_id, label, content) VALUES (1,'饮食','不吃香菜')").run();
    await db.prepare("INSERT INTO bot_reminders (user_id, text, fire_at_ms) VALUES (1,'喝水', 1700000000000)").run();
    await db.prepare("INSERT INTO bot_claw_accounts (user_id, status, bot_token, cursor, outreach_enabled) VALUES (1,'bound','SECRET_BOT_TOKEN','SECRET_CURSOR',1)").run();

    const res = await handleExport(db, 1);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const data = await res.json();

    assert.equal(data.format, 'chillin-export-v1');
    assert.equal(data.counts.notes, 1);
    assert.equal(data.notes[0].title, '导出验证');
    assert.equal(data.counts.echoCards, 1);
    assert.equal(data.counts.readerProgress, 1);
    assert.equal(data.reader.progress[0].bookKey, 'book-1');
    assert.equal(data.reader.books[0].title, '长夜');
    assert.equal(data.reader.books[0].contentInR2, true);
    assert.equal(data.counts.healthDays, 1);
    assert.equal(data.health[0].steps, 8000);
    assert.equal(data.bot.profile[0].content, '不吃香菜');
    assert.equal(data.bot.reminders[0].text, '喝水');
    assert.equal(data.bot.claw.status, 'bound');
    assert.equal(data.bot.outreachEnabled, true);
    assert.equal(data.omissions.length, 2);

    const raw = JSON.stringify(data);
    assert.ok(!raw.includes('SECRET_BOT_TOKEN'), '访问令牌不得进入导出');
    assert.ok(!raw.includes('SECRET_CURSOR'), '轮询游标不得进入导出');
    assert.ok(!raw.includes('别人的笔记'), '导出必须按用户隔离');
});
