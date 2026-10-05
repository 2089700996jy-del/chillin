import test from 'node:test';
import assert from 'node:assert/strict';

// Node.js test environment mock for browser globals
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}
if (typeof globalThis.location === 'undefined') {
    globalThis.location = { hostname: 'localhost', origin: 'http://localhost' };
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
        querySelectorAll: () => []
    };
}

const { crc32, createZip, buildBackupFiles } = await import('../public/js/backup.js');
const { handleBackupEmail } = await import('../workers/src/garden-sync.js');
const { state } = await import('../public/js/state.js');

test('Backup - crc32 calculates standard IEEE 802.3 checksums', () => {
    const textEncoder = new TextEncoder();
    // Standard test vector: "123456789" -> 0xCBF43926 (3421780262)
    const buf = textEncoder.encode('123456789');
    const result = crc32(buf);
    assert.equal(result, 3421780262);
});

test('Backup - createZip generates valid PKZIP structure', () => {
    const files = [
        { name: 'hello.txt', data: 'Hello World' },
        { name: 'notes/test.md', data: '# Title\n\nContent' }
    ];
    const zipBytes = createZip(files);
    assert.ok(zipBytes instanceof Uint8Array);
    assert.ok(zipBytes.length > 50);

    // Verify Local File Header Signature: 0x04034b50 (PK\x03\x04)
    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50);

    // Verify Central Directory Signature exists: 0x02014b50
    let hasCentralDir = false;
    for (let i = 0; i < zipBytes.length - 4; i++) {
        if (zipBytes[i] === 0x50 && zipBytes[i + 1] === 0x4b && zipBytes[i + 2] === 0x01 && zipBytes[i + 3] === 0x02) {
            hasCentralDir = true;
            break;
        }
    }
    assert.ok(hasCentralDir, 'ZIP must contain Central Directory structure');

    // Verify End of Central Directory Signature: 0x06054b50 (PK\x05\x06)
    let hasEOCD = false;
    for (let i = 0; i < zipBytes.length - 4; i++) {
        if (zipBytes[i] === 0x50 && zipBytes[i + 1] === 0x4b && zipBytes[i + 2] === 0x05 && zipBytes[i + 3] === 0x06) {
            hasEOCD = true;
            break;
        }
    }
    assert.ok(hasEOCD, 'ZIP must contain End of Central Directory structure');
});

test('Backup - buildBackupFiles bundles notes, weeklies, feeds, bookmarks, prompts and JSON', () => {
    state.notesDatabase = [{ id: 'note-1', title: 'Vue与原生', content: '原生无构建规范', date: '2026-10-01' }];
    state.database = [{ id: 'weekly-1', title: '第一周周记', summary: '生活记录', date: '2026-10-02' }];
    state.feedsDatabase = [{ id: 'feed-1', content: '今天天气不错', created_at: '2026-10-03 10:00' }];
    state.bookmarksDatabase = [{ id: 'bm-1', title: 'MDN', url: 'https://developer.mozilla.org' }];
    state.promptsDatabase = [{ id: 'pm-1', title: '润色大师', content: '帮我润色文本' }];

    const files = buildBackupFiles();
    assert.ok(Array.isArray(files));
    assert.ok(files.some((f) => f.name.startsWith('notes/')));
    assert.ok(files.some((f) => f.name.startsWith('weeklies/')));
    assert.ok(files.some((f) => f.name === 'feeds/feeds.md'));
    assert.ok(files.some((f) => f.name === 'bookmarks/bookmarks.md'));
    assert.ok(files.some((f) => f.name === 'bookmarks/bookmarks.html'));
    assert.ok(files.some((f) => f.name === 'prompts/prompts.md'));
    assert.ok(files.some((f) => f.name === 'chillin-full-backup.json'));

    const jsonFile = files.find((f) => f.name === 'chillin-full-backup.json');
    const parsed = JSON.parse(jsonFile.data);
    assert.equal(parsed.notes.length, 1);
    assert.equal(parsed.weeklies.length, 1);
});

test('Backup - handleBackupEmail returns NO_RESEND_KEY when env is missing key', async () => {
    const request = new Request('http://localhost/api/backup/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com', zipBase64: 'UEsDBBQAAAAIA...' })
    });
    const env = {}; // No RESEND_API_KEY
    const res = await handleBackupEmail(request, env, 1);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.code, 'NO_RESEND_KEY');
});

test('Backup - handleBackupEmail sends email via Resend when configured', async () => {
    let fetchCalled = false;
    let requestPayload = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        if (String(url).includes('api.resend.com')) {
            fetchCalled = true;
            requestPayload = JSON.parse(opts.body);
            return new Response(JSON.stringify({ id: 'resend-123' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch(url, opts);
    };

    try {
        const request = new Request('http://localhost/api/backup/email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'test@example.com',
                zipBase64: 'UEsDBBQAAAAIAAA=',
                filename: 'chillin-test.zip',
                stats: { notesCount: 5, weekliesCount: 2 }
            })
        });
        const env = { RESEND_API_KEY: 're_test_123' };
        const res = await handleBackupEmail(request, env, 1);
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.equal(json.success, true);
        assert.ok(fetchCalled);
        assert.equal(requestPayload.to[0], 'test@example.com');
        assert.equal(requestPayload.attachments[0].filename, 'chillin-test.zip');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
