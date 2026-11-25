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
    parseReaderTimestampMs,
    shouldAcceptCloudProgress,
    shouldPushLocalProgress,
    pullCloudProgressForCurrentBook,
    showReaderSyncDiagnostic,
    parseChapters,
    extractChapterContent,
    findChapterIndexByTitle,
    findCloudProgressForBook,
    findMatchingCloudBook,
    isCloudBookNewer,
    computeMigratedProgress
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

// ── 对抗性审查（Adversarial Review）极端边界与攻防用例 ──

test('Reader Adversarial 1: 极大规模文本 (2,500章 / 20MB) 解析与切章内存与耗时对抗测试', () => {
    const chapterCount = 2500;
    const parts = [];
    parts.push('书名：对抗性测试史诗巨著\r\n作者：DeepMind Tester\r\n\r\n');

    let currentVolume = 1;
    for (let i = 1; i <= chapterCount; i++) {
        if (i === 1 || i % 250 === 1) {
            parts.push(`\r\n第${currentVolume}卷 诸神纪元\r\n\r\n`);
            currentVolume++;
        }
        parts.push(`第${i}章 混沌之眼${i}\r\n`);
        const bodyParagraph = '这是第' + i + '章的正文内容，包含各种标点符号、换行符和段落。\n第一段讲述深渊中的秘密。\r\n第二段讲述天穹上的星辰与命运。\r\n\r\n';
        parts.push(bodyParagraph.repeat(5));
    }

    const hugeText = parts.join('');
    assert.ok(hugeText.length > 500000, `文本规模: ${hugeText.length} 字符`);

    // 1. 解析章节计时：必须在 1500ms 内完成，不得发生栈溢出或内存崩溃
    const t0 = performance.now();
    const chapters = parseChapters(hugeText);
    const parseDuration = performance.now() - t0;

    assert.equal(chapters.length, chapterCount + 1, `期望切出 1章前言 + ${chapterCount}章正文，实际切出 ${chapters.length} 章`);
    assert.equal(chapters[0].title, '前言 / 序幕');
    assert.equal(chapters[1].title, '第1章 混沌之眼1');
    assert.ok(parseDuration < 1500, `解析 2500 章耗时过长: ${parseDuration.toFixed(2)}ms`);

    // 2. 切章正文提取计时 (模拟 saveBookToLocalDB 批量写入前的提取循环)
    // 之前的老代码在该循环中每次 replace 产生 28GB 内存 churn 导致崩溃
    // 本次优化后应当在 < 500ms 完成全部 2500 章切片
    const tExtract = performance.now();
    for (let i = 0; i < chapters.length; i++) {
        const content = extractChapterContent(hugeText, chapters[i]);
        if (i === 1) {
            assert.ok(content.includes('第一段讲述深渊中的秘密'));
            assert.equal(content.startsWith('第1章 混沌之眼1'), false, '正文不应以本章标题行开头');
        }
        if (i === 250) {
            assert.equal(content.includes('第2卷 诸神纪元'), false, '分卷标题严禁渗入上一章正文');
        }
    }
    const extractDuration = performance.now() - tExtract;
    assert.ok(extractDuration < 500, `2500 次 extractChapterContent 耗时过长: ${extractDuration.toFixed(2)}ms (必须 < 500ms)`);
});

test('Reader Adversarial 2: 畸形、脏数据与极端边界切章对抗测试', () => {
    // 1. 空输入 / 非字符串
    assert.deepEqual(parseChapters(''), []);
    assert.deepEqual(parseChapters(null), []);
    assert.deepEqual(parseChapters(undefined), []);
    assert.equal(extractChapterContent('', null), '');

    // 2. 没有任何章节标题的纯正文 (如无章散文或短篇)
    const monolithic = '从前有一座山，山上有座庙，庙里有个老和尚在讲故事。\n故事很长很长。';
    const monoChapters = parseChapters(monolithic);
    assert.equal(monoChapters.length, 1);
    assert.equal(monoChapters[0].title, '全文');
    assert.equal(extractChapterContent(monolithic, monoChapters[0]), monolithic);

    // 3. 只有分卷没有章节的奇葩文本
    const onlyVolumes = '第一卷 混沌初开\r\n天地玄黄，宇宙洪荒。\r\n第二卷 日月盈昃\r\n金生丽水，玉出昆冈。';
    const volChapters = parseChapters(onlyVolumes);
    assert.ok(volChapters.length >= 1);

    // 4. 正文段落包含类似章节关键词（如“这一部分的第1章并不存在”），不应被误判为章节
    const proseText = '第1章 引言\n今天我们在讨论第2章的结构。\n实际上，第3节内容非常重要，包含“第4章”这个词汇但它不是章节。\n第2章 真正的第二章\n正文结束。';
    const proseParsed = parseChapters(proseText);
    assert.equal(proseParsed.length, 2, '正文中的“第4章”词汇不应被误判为章节');
    assert.equal(proseParsed[0].title, '第1章 引言');
    assert.equal(proseParsed[1].title, '第2章 真正的第二章');
});

test('Reader Adversarial 3: 云端与本地章节进度对齐对抗测试（脏序号/脏标题/越界/特殊字符）', () => {
    const chapters = [
        { index: 0, title: '序章 迷雾笼罩的城市' },
        { index: 1, title: '第一章 猎魔人与旅馆' },
        { index: 2, title: '第二章 <script>alert("xss")</script>' },
        { index: 3, title: '第三章 命运的骰子 🎲 投出“大成功”' },
        { index: 4, title: '第一百八十五章 画的力量（附录）' }
    ];

    // 1. 负数与非法序号输入容错
    assert.equal(findChapterIndexByTitle(chapters, '不存在的章节', -99), 0, '非法负数序号应回落至 0');
    assert.equal(findChapterIndexByTitle(chapters, '不存在的章节', 'not-a-number'), 0, 'NaN 序号应回落至 0');

    // 2. 远超最大章节数的越界序号
    assert.equal(findChapterIndexByTitle(chapters, '不存在的章节', 99999), 4, '超限序号应安全夹紧在最后一章');

    // 3. XSS 与特殊字符标题匹配
    const xssIdx = findChapterIndexByTitle(chapters, '第二章 <script>alert("xss")</script>', 99);
    assert.equal(xssIdx, 2, '包含HTML特殊字符的标题应准确匹配');

    // 4. Emoji 与中文双引号标题匹配
    const emojiIdx = findChapterIndexByTitle(chapters, '第三章 命运的骰子 🎲 投出“大成功”', 0);
    assert.equal(emojiIdx, 3, '包含Emoji与复杂标点的标题应准确匹配');

    // 5. 跨端书名匹配容错（带括号、书名号、不同章节总数）
    const cloudProgressList = [
        { book_key: '宿命之环::1191', book_title: '《宿命之环》', chapter_index: 451, chapter_title: '第一百八十五章 画的力量' }
    ];
    const localBook = { title: '宿命之环', totalChapters: 1159 };
    const matched = findCloudProgressForBook(cloudProgressList, localBook);
    assert.ok(matched, '带书名号的同名书应正常匹配');
    assert.equal(matched.chapter_index, 451);
});

test('Reader Adversarial 4: 正文重组 rebuildBookText 对抗测试（乱序/缺损/空正文/回车符突变）', () => {
    // 乱序、包含 null/undefined、乱序 index 的章节数据
    const corruptedChapters = [
        { index: 3, title: '第3章 终局', content: '第三章正文\r\n带有CRLF' },
        { index: 0, title: '第0章 序幕', content: '序幕正文\n带有LF' },
        null,
        { index: 1, title: '第1章 旅途', content: '' }, // 空正文
        { index: 2, title: '', content: '第二章无标题正文' }, // 缺标题
    ];

    const rebuilt = rebuildBookText(corruptedChapters);
    assert.ok(rebuilt.includes('第0章 序幕'));
    assert.ok(rebuilt.includes('第1章 旅途'));
    assert.ok(rebuilt.includes('第三章正文'));
    assert.ok(rebuilt.includes('第二章无标题正文'));

    // 验证重组后换行符统一为标准 LF
    assert.equal(rebuilt.includes('\r'), false, 'rebuildBookText 必须消除任何残存的 \\r 确保跨端传输一致');
});

test('Reader Adversarial 5: 双向进度同步冲撞矩阵对抗测试（向前翻阅/新旧时间戳/多端并发）', () => {
    // 场景 A: 本地是在前台刚刚阅读完并向前翻看 (timestamp 最新，chapterIdx 较小)
    const localRecent = { chapterIdx: 15, scrollPct: 10, timestamp: 50000 };
    const cloudStale = { book_key: 'b::1', chapter_index: 200, scroll_percentage: 90, client_ts: 40000 };
    assert.equal(shouldPushLocalProgress(localRecent, cloudStale), true, '本地时间更新且向前翻看必须胜出推送到云端');
    assert.equal(shouldAcceptCloudProgress(localRecent, cloudStale), false, '本地时间更新时决不能被旧云端进度覆盖');

    // 场景 B: 云端是由另一台设备刚刚推送的最新进度 (client_ts 最新)
    const localOld = { chapterIdx: 15, scrollPct: 10, timestamp: 30000 };
    const cloudNew = { book_key: 'b::1', chapter_index: 18, scroll_percentage: 50, client_ts: 45000 };
    assert.equal(shouldAcceptCloudProgress(localOld, cloudNew), true, '云端时间戳更新时本地必须采纳');
    assert.equal(shouldPushLocalProgress(localOld, cloudNew), false, '本地旧进度决不能反向覆盖云端最新');

    // 场景 C: 云端没有 client_ts（老服务端版本兼容），但 server update_time 更近
    const cloudLegacy = { book_key: 'b::1', chapter_index: 50, scroll_percentage: 0, updated_at: '2026-11-23 12:00:00' };
    const localVeryOld = { chapterIdx: 10, scrollPct: 0, timestamp: 1000 };
    assert.equal(shouldAcceptCloudProgress(localVeryOld, cloudLegacy), true, '老云端数据缺失 client_ts 时必须依赖服务端时间对齐');
});

test('Reader Adversarial 6: 历史遗留《宿命之环》旧数据（分卷名作为独立伪章节）动态分卷识别对抗测试', async () => {
    const { reVolume } = await import('../public/js/reader.js');

    // 模拟老版本 IndexedDB 中《宿命之环》的数据：
    // 第0条是 "第一卷 梦魇" (伪章节，正文为空)
    // 第1条是 "第一章 外乡人"
    // 第2条是 "第二章 调查"
    // 第3条是 "第二卷 逐光者" (伪章节，正文为空)
    // 第4条是 "第一章 新的旅程"
    const legacyMetas = [
        { index: 0, title: '第一卷 梦魇', content: '' },
        { index: 1, title: '第一章 外乡人', content: '第一章正文' },
        { index: 2, title: '第二章 调查', content: '第二章正文' },
        { index: 3, title: '第二卷 逐光者', content: '' },
        { index: 4, title: '第一章 新的旅程', content: '新的旅程正文' }
    ];

    // 1. 验证 reVolume 精准识别分卷标题伪章节
    assert.equal(reVolume.test(legacyMetas[0].title.trim()), true);
    assert.equal(reVolume.test(legacyMetas[1].title.trim()), false);
    assert.equal(reVolume.test(legacyMetas[3].title.trim()), true);
    assert.equal(reVolume.test(legacyMetas[4].title.trim()), false);

    // 2. 模拟 buildChapterTree 中的动态分组逻辑（零 DB 修改，纯运行时构建）
    const groups = [];
    let currentVolTitle = '序幕 / 起始';
    let currentGroup = { id: 'rg-0', title: currentVolTitle, chapters: [] };
    groups.push(currentGroup);
    let volIdx = 0;

    legacyMetas.forEach((ch, idx) => {
        const title = (ch.title || '').trim();
        if (reVolume.test(title)) {
            volIdx++;
            currentVolTitle = title;
            currentGroup = { id: 'rg-' + volIdx, title: currentVolTitle, chapters: [] };
            groups.push(currentGroup);
            return;
        }
        currentGroup.chapters.push({
            title: ch.title,
            idx: idx,
            id: ch.index,
            volumeTitle: currentVolTitle
        });
    });
    if (groups.length > 1 && groups[0].chapters.length === 0) {
        groups.shift();
    }

    // 验证分卷分组结果
    assert.equal(groups.length, 2, '两卷必须对应两个分组');
    assert.equal(groups[0].title, '第一卷 梦魇');
    assert.equal(groups[0].chapters.length, 2, '第一卷包含2章真实正文');
    assert.equal(groups[0].chapters[0].title, '第一章 外乡人');
    assert.equal(groups[0].chapters[0].idx, 1, '真实章节保持原始索引映射');
    assert.equal(groups[1].title, '第二卷 逐光者');
    assert.equal(groups[1].chapters.length, 1);
    assert.equal(groups[1].chapters[0].title, '第一章 新的旅程');
    assert.equal(groups[1].chapters[0].idx, 4);
});

test('Reader Adversarial 7: 云端书目 updated_at / size / 章节数跨端比对与进度迁移', async () => {
    // 1. parseReaderTimestampMs 解析 CST 与非法输入
    const cstTs = parseReaderTimestampMs('2026-11-25 09:30:00');
    assert.equal(cstTs, Date.UTC(2026, 10, 25, 1, 30, 0), '东八区时间应准确转为 UTC 毫秒');
    assert.equal(parseReaderTimestampMs('invalid-date'), 0);
    assert.equal(parseReaderTimestampMs(null), 0);
    assert.equal(parseReaderTimestampMs(-5), 0);

    // 2. findMatchingCloudBook：精确匹配优先，章数变化时按书名（含书名号）匹配最新活跃副本，跳过软删墓碑
    const cloudList = [
        { book_key: '三体::1', title: '三体', total_chapters: 1, updated_at: '2026-11-24 10:00:00', is_deleted: 1 },
        { book_key: '三体::30', title: '《三体》', total_chapters: 30, size: 120000, updated_at: '2026-11-25 08:00:00', is_deleted: 0 },
        { book_key: '三体::38', title: '三体', total_chapters: 38, size: 150000, updated_at: '2026-11-25 09:00:00', is_deleted: 0 }
    ];
    const legacyIphoneBook = { id: 'b1', bookKey: '三体::1', title: '三体', totalChapters: 1, createdAt: Date.UTC(2026, 10, 24, 2, 0, 0) };
    const matchedByTitle = findMatchingCloudBook(legacyIphoneBook, cloudList);
    assert.ok(matchedByTitle);
    assert.equal(matchedByTitle.book_key, '三体::38', '旧 key 被软删或变更时应匹配最新活跃的云端副本');

    // 3. isCloudBookNewer 判定矩阵
    const upToDateBook = {
        bookKey: '三体::38',
        title: '三体',
        totalChapters: 38,
        cloudSize: 150000,
        cloudUpdatedAt: '2026-11-25 09:00:00',
        createdAt: Date.UTC(2026, 10, 25, 1, 0, 0)
    };
    assert.equal(isCloudBookNewer(upToDateBook, cloudList[2]), false, '版本、大小、章数一致时不误报更新');

    // 同秒修改导致 size 变化（哪怕 updated_at 秒级相同）也必须检测出更新
    assert.equal(
        isCloudBookNewer(upToDateBook, { ...cloudList[2], size: 150420 }),
        true,
        '同一秒内重传导致 size 变化必须触发更新提示'
    );

    // 云端时间戳更新（size 恰好相同）
    assert.equal(
        isCloudBookNewer(upToDateBook, { ...cloudList[2], updated_at: '2026-11-25 09:00:05' }),
        true,
        '云端 updated_at 更晚必须触发更新提示'
    );

    // 历史本地旧书（无 cloudUpdatedAt/cloudSize）刚在主设备上传（2秒后）不应误报；备用机昨天下载则应提示更新
    const justUploadedLegacy = {
        bookKey: '三体::38',
        title: '三体',
        totalChapters: 38,
        createdAt: parseReaderTimestampMs('2026-11-25 09:00:00') - 2000
    };
    assert.equal(isCloudBookNewer(justUploadedLegacy, cloudList[2]), false, '主设备刚上传完不应对自己误报云端有更新');

    const yesterdayBackupLegacy = {
        bookKey: '三体::38',
        title: '三体',
        totalChapters: 38,
        createdAt: parseReaderTimestampMs('2026-11-24 09:00:00')
    };
    assert.equal(isCloudBookNewer(yesterdayBackupLegacy, cloudList[2]), true, '备用机昨天缓存的老副本应感知到今天的云端更新');
    assert.equal(isCloudBookNewer(yesterdayBackupLegacy, { ...cloudList[2], is_deleted: 1 }), false, '已软删书目不得提示更新');

    // 4. computeMigratedProgress：重新切章后按章节标题精准保留进度
    const oldChapters = [
        { index: 0, title: '第一章 起风' },
        { index: 1, title: '第二章 暗涌' }
    ];
    const newChapters = [
        { index: 0, title: '前言 / 序幕' },
        { index: 1, title: '第一章 起风' },
        { index: 2, title: '第二章 暗涌' }
    ];
    const migrated = computeMigratedProgress({ chapterIdx: 1, scrollPct: 65, timestamp: 123456 }, oldChapters, newChapters);
    assert.deepEqual(migrated, { chapterIdx: 2, scrollPct: 65, timestamp: 123456 }, '新增序幕导致序号顺移时应按章节标题对齐到新索引');
    assert.equal(computeMigratedProgress(null, oldChapters, newChapters), null);

    // 5. 契约检查：downloadBookFromCloud 绕过 iOS HTTP 缓存且具备防同毫秒 ID 碰撞保护
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const readerSrc = await fs.readFile(path.join(process.cwd(), 'public', 'js', 'reader.js'), 'utf8');
    assert.match(readerSrc, /cache:\s*['"]no-store['"]/, 'downloadBookFromCloud 必须传 cache: no-store 防 iOS 缓存旧正文');
    assert.match(readerSrc, /avoidBookId/, '替换本地书籍时必须传 avoidBookId 防同毫秒 ID 碰撞被误删');
    assert.match(readerSrc, /btn-reader-resplit/, 'reader.js 必须绑定侧栏重新切章按钮');
});
