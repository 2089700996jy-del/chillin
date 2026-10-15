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

const { decodeBuffer } = await import('../public/js/reader.js');

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
