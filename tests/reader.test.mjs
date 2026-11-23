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

const {
    decodeBuffer,
    rebuildBookText,
    cloudProgressTs,
    shouldAcceptCloudProgress,
    shouldPushLocalProgress,
    pullCloudProgressForCurrentBook,
    showReaderSyncDiagnostic,
    parseChapters,
    extractChapterContent,
    findChapterIndexByTitle,
    findCloudProgressForBook
} = await import('../public/js/reader.js');

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

test('Reader Parser - 多分卷长篇（如《宿命之环》）正确按卷分组，排除正文散落词，不产生0字节虚假章节', () => {
    const text = `
前言 本书的前言内容，具有一定长度以测试前言识别。

第一卷 梦魇
第一章 外乡人
这是第一章的内容。第一部分是尝试暗杀；第三部分是另一段诡异的舞蹈。
第二天清晨，阳光明媚。

第二章 调查
这是第二章的内容。

第二卷 逐光者
第一章 新的旅程
第二卷第一章内容。

尾声
全书完。
`;
    const chapters = parseChapters(text);
    assert.equal(chapters.length, 5);
    assert.equal(chapters[0].title, '前言 / 序幕');
    assert.equal(chapters[1].title, '第一章 外乡人');
    assert.equal(chapters[1].groupTitle, '第一卷 梦魇');
    assert.equal(chapters[2].title, '第二章 调查');
    assert.equal(chapters[2].groupTitle, '第一卷 梦魇');
    assert.equal(chapters[3].title, '第一章 新的旅程');
    assert.equal(chapters[3].groupTitle, '第二卷 逐光者');
    assert.equal(chapters[4].title, '尾声');

    // 验证正文不包含虚假章节或分卷标题渗漏
    const ch2Content = extractChapterContent(text, chapters[2]);
    assert.equal(ch2Content.includes('第二卷 逐光者'), false, '分卷标题严禁渗入上一章末尾');
    assert.equal(ch2Content, '这是第二章的内容。');
});

test('Reader Parser - CRLF 与 LF 混合文本切章偏移绝对稳定，章节正文无分卷渗漏', () => {
    // 混合换行符 \r\n 与 \n
    const mixedText = '第一卷 启程\r\n第一章 出发\n第一章第一行\r\n第一章第二行\n第二章 抵达\r\n第二章内容';
    const chapters = parseChapters(mixedText);
    assert.ok(chapters.length >= 2);
    const ch1Content = extractChapterContent(mixedText, chapters[0]);
    assert.ok(ch1Content.includes('第一章第一行'));
    assert.ok(ch1Content.includes('第一章第二行'));
    assert.equal(ch1Content.includes('第二章 抵达'), false);

    // 验证 rebuildBookText 保留分卷信息
    const rebuilt = rebuildBookText(chapters.map((c, i) => ({ ...c, index: i, content: extractChapterContent(mixedText, c) })));
    assert.ok(rebuilt.includes('第一卷 启程'), 'rebuildBookText 必须保留分卷信息以便云端同步');
});

test('Reader Progress Sync - 跨端章节标题智能对齐、书名模糊匹配与向前翻看同步', () => {
    const chapters = [
        { index: 0, title: '引子' },
        { index: 1, title: '第一卷 梦魇·第一章 外乡人' },
        { index: 2, title: '第一百八十五章 画的力量' },
        { index: 3, title: '第一百八十六章 占卜' },
    ];

    // 1. 跨版本章节序号漂移对齐：旧版序号为 451，但章节名是「第一百八十五章 画的力量」，智能对齐至 2
    const resolvedIdx = findChapterIndexByTitle(chapters, '第一百八十五章 画的力量', 451);
    assert.equal(resolvedIdx, 2, '标题匹配成功时应修正偏移索引');

    // 2. 带符号/空格的标题模糊对齐
    assert.equal(findChapterIndexByTitle(chapters, '【第一百八十五章】画的力量', 451), 2);

    // 3. 书名模糊匹配（章节总数在不同解析器版本下略有不同：1191 vs 1159）
    const cloudList = [
        { book_key: '宿命之环::1191', book_title: '宿命之环', chapter_index: 451, chapter_title: '第一百八十五章 画的力量' }
    ];
    const localBook = { title: '宿命之环', totalChapters: 1159 };
    const matchedCloud = findCloudProgressForBook(cloudList, localBook);
    assert.ok(matchedCloud, '不同版本章节数的同名书应能匹配云端进度');
    assert.equal(matchedCloud.chapter_index, 451);

    // 4. 往前翻看进度同步（重新阅读前序章节时，时间戳更新应能顺利推送到云端）
    const localTurnedBack = { chapterIdx: 10, scrollPct: 20, timestamp: 2000 };
    const cloudAhead = { book_key: 'b::1', chapter_index: 451, scroll_percentage: 80, client_ts: 1000 };
    assert.equal(shouldPushLocalProgress(localTurnedBack, cloudAhead), true, '本地时间戳更新且用户往前翻看时必须推送到云端');
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

    // ── 统一 IndexedDB 存储层 (chillin_db v2) 与历史数据库平滑迁移 ──
    const dbModule = await import('../public/js/db.js');
    const apiModule = await import('../public/js/api.js');

    // 1. API facade 与 db.js 统一函数导出校验
    for (const fn of ['readerDbPut', 'readerDbGet', 'readerDbGetAll', 'readerDbDelete', 'openDatabase']) {
        assert.equal(typeof dbModule[fn], 'function', `db.js 必须导出 ${fn}`);
        assert.equal(typeof apiModule[fn], 'function', `api.js 必须重导出 ${fn}`);
    }

    // 2. reader.js 移除了本地独立 chillin_reader_db 模板代码
    assert.doesNotMatch(readerSrc, /const\s+DB_NAME\s*=\s*['"]chillin_reader_db['"]/, 'reader.js 应移除本地 chillin_reader_db 定义');
    assert.doesNotMatch(readerSrc, /function\s+openReaderDB\s*\(/, 'reader.js 应移除本地 openReaderDB 模板代码');
    assert.doesNotMatch(readerSrc, /function\s+rdbPut\s*\(/, 'reader.js 应移除本地 rdbPut 模板代码');
    assert.match(readerSrc, /import\s*\{[^}]*readerDbPut[^}]*\}\s*from\s*['"]\.\/db\.js['"]/, 'reader.js 应从 db.js 引入 readerDb* 系列统一操作');

    // 3. Mock IndexedDB 验证 chillin_db v2 结构创建与 CRUD
    function createMockIndexedDB() {
        const databases = new Map();
        return {
            _databases: databases,
            databases: async () => Array.from(databases.entries()).map(([name, db]) => ({ name, version: db.version })),
            deleteDatabase: (name) => {
                databases.delete(name);
                const req = { onsuccess: null, onerror: null };
                setTimeout(() => { if (req.onsuccess) req.onsuccess({ target: req }); }, 0);
                return req;
            },
            open: (name, version) => {
                const req = { result: null, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null };
                setTimeout(() => {
                    let dbRecord = databases.get(name);
                    const oldVersion = dbRecord ? dbRecord.version : 0;
                    const newVersion = version !== undefined ? version : (oldVersion || 1);
                    if (!dbRecord) {
                        dbRecord = { version: newVersion, stores: new Map() };
                        databases.set(name, dbRecord);
                    }
                    const dbObj = {
                        name,
                        version: dbRecord.version,
                        objectStoreNames: {
                            contains: (sName) => dbRecord.stores.has(sName),
                            get length() { return dbRecord.stores.size; }
                        },
                        createObjectStore: (sName, options = {}) => {
                            const store = { keyPath: options.keyPath || null, data: new Map() };
                            dbRecord.stores.set(sName, store);
                            return store;
                        },
                        transaction: (storeNames, mode) => {
                            let aborted = false;
                            const tx = {
                                mode,
                                oncomplete: null,
                                onerror: null,
                                abort: () => { aborted = true; },
                                objectStore: (sName) => {
                                    const storeRecord = dbRecord.stores.get(sName);
                                    if (!storeRecord) throw new Error(`Store not found: ${sName}`);
                                    return {
                                        put: (val, key) => {
                                            const actualKey = storeRecord.keyPath ? val[storeRecord.keyPath] : key;
                                            storeRecord.data.set(actualKey, val);
                                            const r = { onsuccess: null, onerror: null, result: actualKey };
                                            setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
                                            return r;
                                        },
                                        get: (key) => {
                                            const res = storeRecord.data.get(key);
                                            const r = { onsuccess: null, onerror: null, result: res !== undefined ? res : undefined };
                                            setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
                                            return r;
                                        },
                                        getAll: () => {
                                            const r = { onsuccess: null, onerror: null, result: undefined, error: null };
                                            if (storeRecord._failGetAll) {
                                                const err = new Error(`Failed to getAll books from old reader db: simulated error in ${sName}`);
                                                r.error = err;
                                                setTimeout(() => {
                                                    if (r.onerror) r.onerror({ target: r, error: err });
                                                    if (tx.onerror) tx.onerror({ target: tx, error: err });
                                                }, 0);
                                                return r;
                                            }
                                            const res = Array.from(storeRecord.data.values());
                                            r.result = res;
                                            setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
                                            return r;
                                        },
                                        delete: (key) => {
                                            storeRecord.data.delete(key);
                                            const r = { onsuccess: null, onerror: null };
                                            setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
                                            return r;
                                        }
                                    };
                                }
                            };
                            setTimeout(() => { if (!aborted && tx.oncomplete) tx.oncomplete(); }, 0);
                            return tx;
                        },
                        close: () => {}
                    };
                    req.result = dbObj;
                    if (newVersion > oldVersion) {
                        dbRecord.version = newVersion;
                        dbObj.version = newVersion;
                        let aborted = false;
                        const upgradeTx = { abort: () => { aborted = true; databases.delete(name); } };
                        req.transaction = upgradeTx;
                        if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion, newVersion });
                        if (aborted) { if (req.onerror) req.onerror({ target: req }); return; }
                    }
                    if (req.onsuccess) req.onsuccess({ target: req });
                }, 0);
                return req;
            }
        };
    }

    try {
        const mockIDB = createMockIndexedDB();
        globalThis.indexedDB = mockIDB;
        dbModule._resetDbPromiseForTest();

        const db = await dbModule.openDatabase();
        assert.ok(db, 'openDatabase 应返回可用 db 实例');
        assert.equal(db.version, 2, 'chillin_db 应提升至版本 2');
        assert.equal(db.objectStoreNames.contains('books'), true, 'onupgradeneeded 应创建 books store');
        assert.equal(db.objectStoreNames.contains('chapters'), true, 'onupgradeneeded 应创建 chapters store');
        assert.equal(db.objectStoreNames.contains('garden_store'), true, 'onupgradeneeded 应保留 garden_store');

        // 测试 CRUD 统一操作
        await dbModule.readerDbPut('books', { id: 'book_test_1', title: '三体', author: '刘慈欣', totalChapters: 3 });
        const book = await dbModule.readerDbGet('books', 'book_test_1');
        assert.equal(book.title, '三体');
        assert.equal(book.author, '刘慈欣');

        await dbModule.readerDbPut('chapters', { id: 'book_test_1_0', bookId: 'book_test_1', index: 0, title: '科学边界' });
        const ch = await dbModule.readerDbGet('chapters', 'book_test_1_0');
        assert.equal(ch.title, '科学边界');

        const allBooks = await dbModule.readerDbGetAll('books');
        assert.equal(allBooks.length, 1);

        await dbModule.readerDbDelete('books', 'book_test_1');
        const deletedBook = await dbModule.readerDbGet('books', 'book_test_1');
        assert.equal(deletedBook, undefined);

        // 4. 历史 chillin_reader_db 平滑迁移测试
        dbModule._resetDbPromiseForTest();
        const freshMock = createMockIndexedDB();
        globalThis.indexedDB = freshMock;

        // 预置旧库数据
        const oldBooks = new Map([['legacy_1', { id: 'legacy_1', title: '百年孤独', author: '马尔克斯' }]]);
        const oldChapters = new Map([['legacy_1_0', { id: 'legacy_1_0', bookId: 'legacy_1', title: '第一章' }]]);
        freshMock._databases.set('chillin_reader_db', {
            version: 1,
            stores: new Map([
                ['books', { keyPath: 'id', data: oldBooks }],
                ['chapters', { keyPath: 'id', data: oldChapters }]
            ])
        });
        if (typeof localStorage !== 'undefined') localStorage.removeItem('_reader_db_migrated');

        // 打开新库触发自动迁移
        const migratedDb = await dbModule.openDatabase();
        assert.ok(migratedDb);

        const migratedBooks = await dbModule.readerDbGetAll('books');
        assert.equal(migratedBooks.length, 1);
        assert.equal(migratedBooks[0].title, '百年孤独');

        const migratedChapter = await dbModule.readerDbGet('chapters', 'legacy_1_0');
        assert.equal(migratedChapter.title, '第一章');

        // 验证旧库被清理
        assert.equal(freshMock._databases.has('chillin_reader_db'), false, '迁移后历史旧库 chillin_reader_db 应被安全清理');

        // 5. 关键安全防线：旧库读取失败时中止迁移、保留旧库并拒绝写入已完成标记
        dbModule._resetDbPromiseForTest();
        const failMock = createMockIndexedDB();
        globalThis.indexedDB = failMock;

        const failBooksStore = {
            keyPath: 'id',
            data: new Map([['legacy_fail_1', { id: 'legacy_fail_1', title: '重要历史孤本' }]]),
            _failGetAll: true // 模拟旧库读取失败
        };
        const failChaptersStore = {
            keyPath: 'id',
            data: new Map([['legacy_fail_1_0', { id: 'legacy_fail_1_0', bookId: 'legacy_fail_1', title: '绝版第一章' }]])
        };
        failMock._databases.set('chillin_reader_db', {
            version: 1,
            stores: new Map([
                ['books', failBooksStore],
                ['chapters', failChaptersStore]
            ])
        });
        if (typeof localStorage !== 'undefined') localStorage.removeItem('_reader_db_migrated');

        // 打开目标库
        const targetDbForFailTest = await dbModule.openDatabase();
        assert.ok(targetDbForFailTest);

        // 直接触发迁移，必须抛出拒绝异常
        await assert.rejects(
            dbModule.migrateOldReaderDb(targetDbForFailTest),
            /Failed to getAll books/,
            '旧库读取失败时 migrateOldReaderDb 必须抛出异常拒绝迁移'
        );

        // 验证旧数据库完全保留，未被误删
        assert.equal(failMock._databases.has('chillin_reader_db'), true, '旧库读取失败时，chillin_reader_db 必须被完整保留，严禁删除');
        assert.equal(localStorage.getItem('_reader_db_migrated'), null, '旧库读取失败时，绝对不可在 localStorage 标记迁移完成');

        // 验证目标库中未误写入迁移标记
        const migratedFlagInStore = await dbModule.idbGet('_reader_db_migrated');
        assert.ok(!migratedFlagInStore, '旧库读取失败时，目标 store 中绝对不可写入迁移完成标记');
    } finally {
        delete globalThis.indexedDB;
        dbModule._resetDbPromiseForTest();
        if (typeof localStorage !== 'undefined') localStorage.removeItem('_reader_db_migrated');
    }
});
