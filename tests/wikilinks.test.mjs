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
    parseWikilinksToHtml,
    extractWikilinks,
    extractBacklinkSnippet,
    findBacklinks,
    WIKILINK_REGEX
} = await import('../public/js/wikilinks.js');

const { markdownToHtml } = await import('../public/js/utils.js');
const { state } = await import('../public/js/state.js');

test('Wikilinks - parseWikilinksToHtml converts [[title]] into interactive pill', () => {
    const raw = '今天在读 [[三体]] 这本书。';
    const html = parseWikilinksToHtml(raw);
    assert.ok(html.includes('data-wikilink="三体"'));
    assert.ok(html.includes('<span class="wikilink-label">三体</span>'));
    assert.ok(html.includes('<span class="wikilink-icon">🔗</span>'));
});

test('Wikilinks - parseWikilinksToHtml handles alias syntax [[target|alias]]', () => {
    const raw = '参考我的另一篇文章：[[2024-10-01-回顾|十月生活总结]]。';
    const html = parseWikilinksToHtml(raw);
    assert.ok(html.includes('data-wikilink="2024-10-01-回顾"'));
    assert.ok(html.includes('<span class="wikilink-label">十月生活总结</span>'));
});

test('Wikilinks - parseWikilinksToHtml defends against XSS in target and label', () => {
    const raw = '[[<script>alert("xss")</script>|恶搞&测试]]';
    const html = parseWikilinksToHtml(raw);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&amp;'));
});

test('Wikilinks - extractWikilinks extracts unique titles and trims whitespace', () => {
    const text = '提到 [[人工智能]]，又提到 [[机器学习]]，最后再次提到 [[ 人工智能 ]]。';
    const list = extractWikilinks(text);
    assert.deepStrictEqual(list, ['人工智能', '机器学习']);
});

test('Wikilinks - extractBacklinkSnippet produces context with highlighted mark', () => {
    const content = '在很长的一段正文前置内容之后，我们讨论了 [[数字花园]] 的构建哲学，随后又写了许多总结。';
    const snippet = extractBacklinkSnippet(content, '数字花园', 20);
    assert.ok(snippet.includes('<mark>数字花园</mark>'));
    assert.ok(snippet.includes('构建哲学'));
});

test('Wikilinks - findBacklinks finds referencing notes, weeklies and feeds with case-insensitivity', () => {
    state.notesDatabase = [
        { id: 101, title: '深度学习导论', content: '参考之前写的 [[Transformer]] 架构解析。', date: '2026-10-01' },
        { id: 102, title: 'Transformer', content: '核心自注意力机制。', date: '2026-10-02' }
    ];
    state.database = [
        { id: 201, title: '第 42 周：AI 突破', content: '这一周深入探索了 [[transformer]]。', date: '2026-10-03' }
    ];
    state.feedsDatabase = [
        { id: 301, content: '随手记：复习 [[TRANSFORMER]] 的残差连接。', created_at: '2026-10-03 14:00' }
    ];

    // Search for references to "Transformer", excluding self (id 102, type 'note')
    const backlinks = findBacklinks('Transformer', 102, 'note');
    assert.strictEqual(backlinks.length, 3);
    assert.strictEqual(backlinks[0].type, 'note');
    assert.strictEqual(backlinks[0].id, 101);
    assert.strictEqual(backlinks[1].type, 'weekly');
    assert.strictEqual(backlinks[1].id, 201);
    assert.strictEqual(backlinks[2].type, 'feed');
    assert.strictEqual(backlinks[2].id, 301);
});

test('Wikilinks - markdownToHtml renders wikilinks alongside markdown formatting', () => {
    const md = '### 章节目录\n* 核心要点：**重点关注** [[系统架构]]\n* 补充阅读：`code`';
    const html = markdownToHtml(md);
    assert.ok(html.includes('<h3>章节目录</h3>'));
    assert.ok(html.includes('<strong>重点关注</strong>'));
    assert.ok(html.includes('data-wikilink="系统架构"'));
    assert.ok(html.includes('<code>code</code>'));
});
