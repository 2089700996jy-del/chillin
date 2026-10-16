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

const { decodeBuffer, rebuildBookText } = await import('../public/js/reader.js');

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
import { createTestDb, seedUser, sqliteAvailable } from './fake-d1.mjs';

const { handleGetReaderProgress, handlePostReaderProgress } = await import('../workers/src/garden-resources.js');
const integration = sqliteAvailable ? test : test.skip;

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
