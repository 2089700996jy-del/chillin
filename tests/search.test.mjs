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
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
    };
}

const { highlightMatches } = await import('../js/search.js');

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
