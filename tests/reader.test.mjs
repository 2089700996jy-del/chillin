import test from 'node:test';
import assert from 'node:assert/strict';

// Node.js test environment mock for browser globals
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}
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
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
    };
}

const { decodeBuffer, rebuildBookText, cloudProgressTs, shouldAcceptCloudProgress, shouldPushLocalProgress, pullCloudProgressForCurrentBook, showReaderSyncDiagnostic } = await import('../public/js/reader.js');

test('Reader - decodeBuffer prioritizes UTF-8 and avoids GBK mojibake on Chinese text', () => {
    const originalText = '这是一个标准 UTF-8 编码的中文长篇小说章节测试。时间的流逝在开始工作后变得惊人的快。周一到周五仿佛被压缩成了一天。';
    const utf8Buffer = new TextEncoder().encode(originalText);

    const decoded = decodeBuffer(utf8Buffer);
    assert.equal(decoded, originalText, 'UTF-8 text must decode perfectly without turning into GBK mojibake');
    assert.equal(decoded.includes('杩欐'), false, 'Must not contain GBK mojibake artifacts');
});

test('Reader - decodeBuffer falls back to GBK for legacy encoded files', () => {
    // GBK encoded bytes for "中文小说测试章节，这是一段测试文本"
    const gbkBuffer = Buffer.from([
        0xd6, 0xd0, 0xce, 0xc4, 0xd0, 0xa1, 0xcb, 0xb5, 0xb2, 0xe2, 0xca, 0xd4, 0xd5, 0xc2, 0xbd, 0xda,
        0xa3, 0xac, 0xd5, 0xe2, 0xca, 0xc7, 0xd2, 0xbb, 0xb6, 0xce, 0xb2, 0xe2, 0xca, 0xd4, 0xce, 0xc4, 0xb1, 0xbe
    ]);

    const decoded = decodeBuffer(gbkBuffer);
    assert.ok(decoded.includes('中文') || decoded.includes('测试'), `GBK text should be decoded properly, got: ${decoded}`);
});
// ── 阅读进度接口（P4 写入保护） ──
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';

const { handleGetReaderProgress, handlePostReaderProgress } = await import('../workers/src/garden-resources.js');
const integration = sqliteTest;

const progressPost = (body) => new Request('https://x/api/reader/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

integration('Reader progress - 写入后可读回，且保留 client_ts', async () => {
    const db = createTestDb();
    await seedUser(db, 9);

    const res = await handlePostReaderProgress(progressPost({
        book_key: '测试书::3', book_title: '测试书', chapter_index: 5, chapter_title: '第五章', scroll_percentage: 42, client_ts: 1000
    }), db, 9);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).applied, true);

    const list = await (await handleGetReaderProgress(db, 9)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].chapter_index, 5);
    assert.equal(list[0].client_ts, 1000);
});

integration('Reader progress - 更旧的写入被拒绝，不会把进度拉回（P4）', async () => {
    const db = createTestDb();
    await seedUser(db, 9);
    await handlePostReaderProgress(progressPost({
        book_key: '测试书::3', book_title: '测试书', chapter_index: 120, scroll_percentage: 80, client_ts: 2000
    }), db, 9);

    // 落后设备（client_ts 更小）的写入必须被拒：这正是以前会把进度拉回旧位置的场景
    const stale = await (await handlePostReaderProgress(progressPost({
        book_key: '测试书::3', book_title: '测试书', chapter_index: 3, scroll_percentage: 0, client_ts: 1000
    }), db, 9)).json();
    assert.equal(stale.applied, false, '更旧的写入必须被拒绝');
    assert.equal((await (await handleGetReaderProgress(db, 9)).json())[0].chapter_index, 120);

    // 同一时间戳仍允许写入（>= 语义，保证同一次进度重推不会互相阻塞）
    const same = await (await handlePostReaderProgress(progressPost({
        book_key: '测试书::3', book_title: '测试书', chapter_index: 121, scroll_percentage: 0, client_ts: 2000
    }), db, 9)).json();
    assert.equal(same.applied, true);
});

integration('Reader progress - 未带 client_ts 的旧前端仍可写入（回落到服务端时间）', async () => {
    const db = createTestDb();
    await seedUser(db, 9);
    await handlePostReaderProgress(progressPost({
        book_key: '测试书::3', book_title: '测试书', chapter_index: 10, scroll_percentage: 0, client_ts: 5000
    }), db, 9);

    const legacy = await (await handlePostReaderProgress(progressPost({
        book_key: '测试书::3', book_title: '测试书', chapter_index: 11, scroll_percentage: 3
    }), db, 9)).json();
    assert.equal(legacy.applied, true, '未升级的客户端不能写不进去');
    assert.ok(legacy.client_ts > 5000, '应回落到服务端当前时间戳');
});

integration('Reader progress - 参数校验、百分比夹紧与跨用户隔离', async () => {
    const db = createTestDb();
    await seedUser(db, 9);
    await seedUser(db, 10);

    assert.equal((await handlePostReaderProgress(progressPost({ book_key: '', book_title: '书' }), db, 9)).status, 400);
    assert.equal((await handlePostReaderProgress(progressPost({ book_key: '书::1' }), db, 9)).status, 400);

    const clamped = await (await handlePostReaderProgress(progressPost({
        book_key: '书::1', book_title: '书', chapter_index: 0, scroll_percentage: 250, client_ts: 1
    }), db, 9)).json();
    assert.equal(clamped.scroll_percentage, 100, '超过 100 必须夹到 100');

    assert.deepEqual(await (await handleGetReaderProgress(db, 10)).json(), [], '不能读到别人的进度');
});
test('Reader - rebuildBookText 按章节顺序重组正文并保留章名行', () => {
    const chapters = [
        { index: 1, title: '第2章 乙', content: '正文乙' },
        { index: 0, title: '第1章 甲', content: '正文甲' },
    ];
    const text = rebuildBookText(chapters);
    assert.equal(text, '第1章 甲\n正文甲\n第2章 乙\n正文乙', '必须按 index 排序后再拼接');
    // 章名行必须保留：补传到云端、换设备下载后仍要能被重新识别成同样多的章节
    assert.equal((text.match(/^第\d+章/gm) || []).length, 2);
});

test('Reader - rebuildBookText 容忍缺字段、乱序与空输入', () => {
    assert.equal(rebuildBookText([]), '');
    assert.equal(rebuildBookText(null), '');
    assert.equal(rebuildBookText([{ index: 0, content: '无标题正文' }]), '无标题正文');
    assert.equal((rebuildBookText([{ title: '第1章' }, { title: '第2章' }]) || '').trim(), '第1章\n\n第2章', '正文缺失时不能抛错');
});

test('Reader - 沉浸阅读模式（Zen Mode）样式与双击切换接线', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const css = await fs.readFile(path.join(process.cwd(), 'public', 'style.css'), 'utf8');
    const readerSrc = await fs.readFile(path.join(process.cwd(), 'public', 'js', 'reader.js'), 'utf8');
    assert.match(css, /#view-reader-book\.zen-mode\s+\.reader-nav-bottom/, 'style.css 应定义沉浸模式隐藏底栏');
    assert.match(readerSrc, /reader-content-area[\s\S]*?dblclick/, 'reader.js 应绑定双击沉浸模式切换');
});

test('Reader Progress Sync - 新设备（无本地进度）必须采纳云端进度且不反向覆写', () => {
    const cloud = { book_key: 'test::100', chapter_index: 25, scroll_percentage: 60, client_ts: 1700000000000 };
    assert.equal(shouldAcceptCloudProgress(null, cloud), true, '未读过书籍的新设备应采纳云端进度');
    assert.equal(shouldAcceptCloudProgress({ chapterIdx: 0, scrollPct: 0, timestamp: 0 }, cloud), true, '本地时间戳为0应采纳云端进度');
    assert.equal(shouldPushLocalProgress(null, cloud), false, '新设备无本地有效进度不应回推覆写云端');
    assert.equal(shouldPushLocalProgress({ chapterIdx: 0, scrollPct: 0, timestamp: 0 }, cloud), false, '本地无有效时间戳不应回推覆写云端');

    // 云端在第一章有微量阅读百分比（如 3%），新设备也应采纳
    const cloudEarly = { book_key: 'test::100', chapter_index: 0, scroll_percentage: 3, client_ts: 1700000000000 };
    assert.equal(shouldAcceptCloudProgress(null, cloudEarly), true, '第一章早期进度也应被新设备采纳');
});

test('Reader Progress Sync - 跨设备多端对齐：时间戳更新者胜', () => {
    const localStale = { chapterIdx: 5, scrollPct: 10, timestamp: 1000 };
    const cloudNewer = { book_key: 'test::100', chapter_index: 18, scroll_percentage: 45, client_ts: 2000 };
    assert.equal(shouldAcceptCloudProgress(localStale, cloudNewer), true, '云端时间戳更新时应采纳');
    assert.equal(shouldPushLocalProgress(localStale, cloudNewer), false, '本地旧进度不应回推');

    // 离线读后设备（本地时间戳更新且进度更靠前）应回推云端
    const localNewer = { chapterIdx: 30, scrollPct: 80, timestamp: 3000 };
    const cloudStale = { book_key: 'test::100', chapter_index: 18, scroll_percentage: 45, client_ts: 2000 };
    assert.equal(shouldAcceptCloudProgress(localNewer, cloudStale), false, '本地更新时不采纳旧云端进度');
    assert.equal(shouldPushLocalProgress(localNewer, cloudStale), true, '本地较新且靠前应回推云端');
});

test('Reader Progress Sync - 打开书籍与关闭退出不会毒化时间戳导致覆盖云端', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const readerSrc = await fs.readFile(path.join(process.cwd(), 'public', 'js', 'reader.js'), 'utf8');

    // 打开书时禁止记录新进度与禁止触发云端推送
    assert.match(readerSrc, /loadChapterContent\(currentChapterIdx,\s*\{\s*recordProgress:\s*false\s*\}\)/, 'openReaderBook 初次渲染章节时不应记录进度');

    // 仅在会话 dirty 时退出才保存与推送
    assert.match(readerSrc, /if\s*\(readerSessionDirty\s*&&\s*currentBookId/, 'clearReaderSession 必须仅在 readerSessionDirty 时才保存与同步');

    // 定时器推送必须检查 readerSessionDirty
    assert.match(readerSrc, /if\s*\(!readerSessionDirty\s*\|\|\s*!currentBookId/, 'scheduleCloudProgressSync 必须检查 readerSessionDirty');

    // 滚动比例与还原必须基于可滚动高度 (scrollHeight - clientHeight)
    assert.match(readerSrc, /maxScroll\s*=\s*Math\.max\(0,\s*area\.scrollHeight\s*-\s*area\.clientHeight\)/, '还原滚动位置必须使用 maxScroll');
});

test('Reader Progress Sync - 切回前台 visibilitychange 自动拉取云端最新进度与冲突对齐', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const readerSrc = await fs.readFile(path.join(process.cwd(), 'public', 'js', 'reader.js'), 'utf8');

    assert.equal(typeof pullCloudProgressForCurrentBook, 'function', 'pullCloudProgressForCurrentBook 必须是导出函数');
    assert.match(readerSrc, /visibilitychange[\s\S]*?document\.visibilityState\s*===\s*['"]visible['"][\s\S]*?pullCloudProgressForCurrentBook/, '切回前台时必须自动触发拉取云端最新进度');

    // 多端冲突解决规则：远端时间戳更新时采纳并跳转，本地旧进度不应反向覆盖
    const local = { chapterIdx: 2, scrollPct: 20, timestamp: 1700000000000 };
    const remoteNewer = { book_key: 'b::1', chapter_index: 8, scroll_percentage: 50, client_ts: 1700000500000 };
    assert.equal(shouldAcceptCloudProgress(local, remoteNewer), true, '云端时间戳更新且章节更后必须采纳');
    assert.equal(shouldPushLocalProgress(local, remoteNewer), false, '本地旧进度禁止覆盖云端新进度');
});

test('Reader Progress Sync - 状态栏 #reader-sync-status-text 诊断工具绑定与可视化比对', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const readerSrc = await fs.readFile(path.join(process.cwd(), 'public', 'js', 'reader.js'), 'utf8');

    assert.equal(typeof showReaderSyncDiagnostic, 'function', 'showReaderSyncDiagnostic 必须是导出函数');
    assert.match(readerSrc, /reader-sync-status-text[\s\S]*?showReaderSyncDiagnostic/, '必须为状态栏文字绑定诊断弹窗点击事件');
    assert.match(readerSrc, /reader-sync-info[\s\S]*?showReaderSyncDiagnostic/, '必须为状态栏容器绑定诊断弹窗点击事件');

    const diag = await showReaderSyncDiagnostic();
    assert.ok(diag && typeof diag === 'object', '诊断函数必须返回结构化诊断对象');
    assert.ok('queueCount' in diag, '诊断对象必须包含重试队列统计');
});
