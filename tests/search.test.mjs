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
    assert.match(search, /if \(!el && typeof actions\.ensureItemRendered === 'function'\)/, 'jumpToElement 查不到元素时必须先问列表要渲染窗口，否则长列表下的搜索跳转静默失效');
    assert.match(search, /if \(actions\.ensureItemRendered\(selector\)\) el = document\.querySelector\(selector\)/, '扩窗口后必须重新查询一次选择器（否则拿到的是旧 DOM 的 null）');
    assert.match(feeds, /actions\.ensureItemRendered = ensureFeedRendered/, 'feeds.js 必须把 ensureFeedRendered 注册进 actions 注册表');
    assert.match(feeds, /feedsVisibleCount = Math\.ceil\(\(index \+ 1\) \/ FEEDS_PAGE_SIZE\) \* FEEDS_PAGE_SIZE/, '扩窗口必须按整页对齐（否则数目零散、状态难以推理）');
    assert.match(fs.readFileSync(new URL('../public/js/actions.js', import.meta.url), 'utf8'), /ensureItemRendered: null/, 'actions.js 注册表必须声明 ensureItemRendered 占位');
});
