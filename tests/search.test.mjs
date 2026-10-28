import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
// feeds.js 的模块图会经 api.js → auth.js 读到 window.location（配置解析），缺了会抛 protocol of undefined
if (typeof globalThis.location === 'undefined') {
    globalThis.location = { protocol: 'https:', hostname: 'chillin.local', host: 'chillin.local', origin: 'https://chillin.local', href: 'https://chillin.local/' };
}
if (typeof globalThis.navigator === 'undefined') {
    globalThis.navigator = { onLine: true, userAgent: 'node-test', serviceWorker: null };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
    };
}

const { highlightMatches } = await import('../public/js/search.js');

test('Search - highlightMatches wraps matched keywords in mark tags', () => {
    const raw = '在数字花园中探索算法与深度学习的奥秘';
    const highlighted = highlightMatches(raw, '算法');
    assert.strictEqual(
        highlighted,
        '在数字花园中探索<mark class="search-highlight">算法</mark>与深度学习的奥秘'
    );
});

test('Search - highlightMatches performs case-insensitive matching and escapes HTML', () => {
    const raw = 'Learn JavaScript & <script>alert(1)</script>';
    const highlighted = highlightMatches(raw, 'javascript');
    assert.strictEqual(
        highlighted,
        'Learn <mark class="search-highlight">JavaScript</mark> &amp; &lt;script&gt;alert(1)&lt;/script&gt;'
    );
});

test('Search - highlightMatches handles empty query or text gracefully', () => {
    assert.strictEqual(highlightMatches('', 'test'), '');
    assert.strictEqual(highlightMatches('Hello World', ''), 'Hello World');
    assert.strictEqual(highlightMatches(null, 'test'), '');
});

// 说明：这两条用例放在 search 套件里，是因为它已经搭好了 localStorage / document 的浏览器 mock，
// 而 feeds.js 的模块图（state.js / api.js）在导入期就会读 localStorage。
test('Feeds - 紧凑行判定（A1）与自动续载兜底（B2）', async () => {
    const feeds = await import('../public/js/feeds.js');
    assert.equal(typeof feeds.shouldRenderCompactFeed, 'function', 'feeds.js 必须导出 shouldRenderCompactFeed（注意：整个 feeds.js 写在 initFeeds 函数体里，函数体内 export 会让整份模块解析失败）');
    // 纯文字短碎片 → 紧凑
    assert.equal(feeds.shouldRenderCompactFeed({ content: '吃饭' }, '', '吃饭'), true);
    assert.equal(feeds.shouldRenderCompactFeed({ content: 'x' }, '', '一'.repeat(60)), true, '恰好 60 字仍算紧凑');
    assert.equal(feeds.shouldRenderCompactFeed({ content: 'x' }, '', '一'.repeat(61)), false, '超过 60 字保持原密度');
    assert.equal(feeds.shouldRenderCompactFeed({ content: 'x', media_url: 'https://x/y.png' }, '', 'x'), false, '带图的卡片必须保持原密度');
    assert.equal(feeds.shouldRenderCompactFeed({ content: 'x' }, '<div class="rich-link-card"></div>', 'x'), false, '带链接速览的卡片必须保持原密度');
    assert.equal(feeds.shouldRenderCompactFeed({ content: 'x' }, '', '   '), true, '空白正文按 0 字算');
    const src = (await import('node:fs')).readFileSync(new URL('../public/js/feeds.js', import.meta.url), 'utf8');
    assert.match(src, /new IntersectionObserver\([\s\S]*?\{ rootMargin: '600px 0px' \}/, '自动续载必须在哨兵进入视口前 600px 就预取，否则滚到底会看到空白等待');
    assert.match(src, /if \(typeof IntersectionObserver !== 'function'\) return;/, '必须保留无 IntersectionObserver 时的兜底（不 return 的话旧浏览器会抛错、整个列表渲染不出来）');
    assert.match(src, /more\.addEventListener\('click', loadMoreFeeds\)/, '兜底按钮必须仍然可点（loadMoreFeeds 同时服务观察器与手动点击）');
});

test('Search - 跳转失联修复（C3）：分页列表之外的条目必须先扩渲染窗口', async () => {
    // 背景：随手记首屏只渲染 100 条，搜索命中的条目若在窗口之外，
    // 旧的 document.querySelector(selector) 什么也查不到，于是「点了搜索结果是静默什么都不发生」。
    const fs = await import('node:fs');
    const search = fs.readFileSync(new URL('../public/js/search.js', import.meta.url), 'utf8');
    const feeds = fs.readFileSync(new URL('../public/js/feeds.js', import.meta.url), 'utf8');
    assert.match(search, /actions\.ensureNoteRendered\(selector\)/, 'jumpToElement 查不到元素时必须先问笔记列表要渲染窗口');
    assert.match(search, /actions\.ensureItemRendered\(selector\)/, 'jumpToElement 也要继续兼容随手记的 ensureItemRendered');
    assert.match(search, /if \(ensured\) el = document\.querySelector\(selector\)/, '扩窗口后必须重新查询一次选择器（否则拿到的是旧 DOM 的 null）');
    assert.match(feeds, /actions\.ensureItemRendered = ensureFeedRendered/, 'feeds.js 必须把 ensureFeedRendered 注册进 actions 注册表');
    assert.match(feeds, /feedsVisibleCount = Math\.ceil\(\(index \+ 1\) \/ FEEDS_PAGE_SIZE\) \* FEEDS_PAGE_SIZE/, '扩窗口必须按整页对齐（否则数目零散、状态难以推理）');
    assert.match(fs.readFileSync(new URL('../public/js/actions.js', import.meta.url), 'utf8'), /ensureItemRendered: null/, 'actions.js 注册表必须声明 ensureItemRendered 占位');
});

test('Timeline - 年/月过滤只认合法日期，且月份必须依附年份', async () => {
    const { parseYearMonth, filterItemsByYearMonth, decodeCssEscapedId } = await import('../public/js/utils.js');
    assert.equal(decodeCssEscapedId('\\34 '), '4', 'CSS.escape("4") 的结果必须还原为 4，否则搜索跳转找不到记录');
    assert.equal(decodeCssEscapedId('abc'), 'abc');
    assert.deepEqual(parseYearMonth('2026-10-27 09:00:00'), { year: '2026', month: '10' });
    assert.deepEqual(parseYearMonth('2026-01-01'), { year: '2026', month: '01' });
    assert.equal(parseYearMonth('2026-13-01'), null, '13 月必须判非法');
    assert.equal(parseYearMonth('not-a-date'), null);
    assert.equal(parseYearMonth(''), null);

    const items = [
        { id: 1, date: '2026-10-01' },
        { id: 2, date: '2026-10-27 09:00:00' },
        { id: 3, date: '2026-09-30' },
        { id: 4, date: '2025-10-01' },
        { id: 5, date: '没有日期' },
    ];
    const getDate = (item) => item.date;
    assert.deepEqual(filterItemsByYearMonth(items, getDate).map((x) => x.id), [1, 2, 3, 4, 5], '全部时间不过滤任何条目');
    assert.deepEqual(filterItemsByYearMonth(items, getDate, '2026', 'all').map((x) => x.id), [1, 2, 3]);
    assert.deepEqual(filterItemsByYearMonth(items, getDate, '2026', '10').map((x) => x.id), [1, 2]);
    assert.deepEqual(filterItemsByYearMonth(items, getDate, '2025', '10').map((x) => x.id), [4]);
    assert.deepEqual(filterItemsByYearMonth(items, getDate, 'all', '10').map((x) => x.id), [], '只选月份不选年份时不能越过年份语义');
    assert.deepEqual(filterItemsByYearMonth([], getDate, '2026').map((x) => x.id), []);
});

test('Timeline - 周记/随手记筛选条接线，筛选变化会复位分页窗口', async () => {
    const fs = await import('node:fs');
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const weeklies = fs.readFileSync(new URL('../public/js/weeklies.js', import.meta.url), 'utf8');
    const feeds = fs.readFileSync(new URL('../public/js/feeds.js', import.meta.url), 'utf8');
    const search = fs.readFileSync(new URL('../public/js/search.js', import.meta.url), 'utf8');
    const actions = fs.readFileSync(new URL('../public/js/actions.js', import.meta.url), 'utf8');
    const sync = fs.readFileSync(new URL('../public/js/sync.js', import.meta.url), 'utf8');

    assert.match(html, /id="weekly-date-filter"/, '周记必须有独立的年/月筛选条');
    assert.match(html, /id="weekly-load-more-container"/, '周记的加载更多必须有独立的整宽容器，不能被多列画廊切开');
    assert.match(weeklies, /WEEKLY_PAGE_SIZE = 60/, '周记首屏应只渲染一批，而不是全量');
    assert.match(weeklies, /weeklyLoadMoreContainer/, '加载更多按钮要挂到独立容器');
    assert.match(sync, /PULL_PAGE_SIZE = 100/, '聚合拉取必须有明确的每页上限');
    assert.match(sync, /cursor_' \+ spec\.resource/, '客户端必须把服务端游标带回下一页');
    assert.match(sync, /cursors\[spec.resource\] = 'done'/, '已完成的资源要标记 done，避免下一页从头重复拉');
    assert.match(html, /id="feeds-date-filter"/, '随手记必须有独立的年/月筛选条');
    assert.match(weeklies, /mountDateFilter\(document\.getElementById\('weekly-date-filter'\)/, '周记筛选条必须接到共享过滤器');
    assert.match(weeklies, /weeklyFilter\?\.update\(state\.database\)/, '每次渲染都要把最新数据交给筛选器重建年份计数');
    assert.match(feeds, /mountDateFilter\(document\.getElementById\('feeds-date-filter'\)/, '随手记筛选条必须接到共享过滤器');
    assert.match(feeds, /feedsVisibleCount = FEEDS_PAGE_SIZE;\n\s*renderFeeds\(\);/, '切换年月后必须复位到首屏 100 条，避免沿用旧窗口');
    assert.match(feeds, /filterChanged/, '搜索跳转遇到被筛选藏起来的条目时要先复位筛选再重查');
    assert.match(search, /ensureWeeklyRendered/, '周记被年月筛选后，搜索跳转仍必须能展开目标');
    assert.match(actions, /ensureWeeklyRendered: null/, 'actions 注册表必须声明周记的扩窗口占位');
});

test('Search - 输入防抖 120ms，Enter 立即 flush', () => {
    const src = fs.readFileSync(path.join(root, 'public/js/search.js'), 'utf8');
    assert.match(src, /const SEARCH_DEBOUNCE_MS = 120;/, '搜索防抖必须有一个明确的毫秒常量');
    assert.match(src, /clearTimeout\(searchDebounceTimer\)/, '连续输入必须取消上一次定时器');
    assert.match(src, /searchDebounceTimer = setTimeout\(/, '输入应走 setTimeout，而不是每个按键同步全量扫描');
    assert.match(src, /if \(searchDebounceTimer\) \{[\s\S]*?renderGlobalSearchResults/, 'Enter 必须先 flush 挂起的搜索，否则会选中上一条结果');
});
