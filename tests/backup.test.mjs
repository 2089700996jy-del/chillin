import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { BACKUP_FORMAT, MANIFEST_HASH_NAME, MANIFEST_NAME, assertSafeR2Key, safeResolve, sha256File, sha256Text, verifyBackup } from '../scripts/backup-kit.mjs';
import { exportD1Full, resetD1Database } from '../scripts/d1-export.mjs';

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

const {
    crc32,
    createZip,
    buildBackupFiles,
    buildFullBackupFiles,
    recordBackupSuccess,
    getLastBackupMeta,
    getBackupGuardSettings,
    setBackupGuardSettings,
    computeBackupGuardStatus,
    STORAGE_KEY_LAST_BACKUP,
    STORAGE_KEY_GUARD_INTERVAL
} = await import('../public/js/backup.js');
const { handleBackupEmail } = await import('../workers/src/garden-sync.js');

const { rateLimitBuckets } = await import('../workers/src/security-network.js');
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
    rateLimitBuckets.clear();
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
    rateLimitBuckets.clear();
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

test('Backup Guard - records metadata and retrieves last backup info', () => {
    localStorage.clear();
    state.notesDatabase = [{ id: 1 }, { id: 2 }];
    state.database = [{ id: 1 }];
    state.feedsDatabase = [{ id: 1 }, { id: 2 }, { id: 3 }];
    state.bookmarksDatabase = [{ id: 1 }];

    const meta = recordBackupSuccess('download');
    assert.ok(meta);
    assert.equal(meta.method, 'download');
    assert.equal(meta.notesCount, 2);
    assert.equal(meta.weekliesCount, 1);
    assert.equal(meta.feedsCount, 3);
    assert.equal(meta.bookmarksCount, 1);

    const saved = getLastBackupMeta();
    assert.ok(saved);
    assert.equal(saved.method, 'download');
    assert.equal(saved.notesCount, 2);
});

test('Backup Guard - get and set guard interval settings', () => {
    localStorage.clear();
    // Default is 14 days
    assert.equal(getBackupGuardSettings(), 14);

    setBackupGuardSettings(7);
    assert.equal(getBackupGuardSettings(), 7);

    setBackupGuardSettings(30);
    assert.equal(getBackupGuardSettings(), 30);

    setBackupGuardSettings(0);
    assert.equal(getBackupGuardSettings(), 0);
});

test('Backup Guard - computeBackupGuardStatus handles all states accurately', () => {
    localStorage.clear();
    const now = 1728189600000; // Fixed timestamp

    // 1. Never backed up
    setBackupGuardSettings(14);
    const sNone = computeBackupGuardStatus(now);
    assert.equal(sNone.status, 'none');
    assert.equal(sNone.isOverdue, true);
    assert.equal(sNone.badgeClass, 'status-warn');
    assert.equal(sNone.badgeText, '建议备份');

    // 2. Disabled
    setBackupGuardSettings(0);
    const sDisabled = computeBackupGuardStatus(now);
    assert.equal(sDisabled.status, 'disabled');
    assert.equal(sDisabled.isOverdue, false);
    assert.equal(sDisabled.badgeClass, 'status-none');
    assert.equal(sDisabled.badgeText, '已关闭');

    // 3. Protected (backed up 3 days ago, interval 14 days)
    setBackupGuardSettings(14);
    localStorage.setItem(STORAGE_KEY_LAST_BACKUP, JSON.stringify({
        timestamp: now - 3 * 86400000,
        method: 'download'
    }));
    const sProtected = computeBackupGuardStatus(now);
    assert.equal(sProtected.status, 'protected');
    assert.equal(sProtected.isOverdue, false);
    assert.equal(sProtected.badgeClass, 'status-ok');
    assert.equal(sProtected.badgeText, '已守护');
    assert.equal(sProtected.daysSince, 3);

    // 4. Overdue (backed up 20 days ago, interval 14 days)
    localStorage.setItem(STORAGE_KEY_LAST_BACKUP, JSON.stringify({
        timestamp: now - 20 * 86400000,
        method: 'email'
    }));
    const sOverdue = computeBackupGuardStatus(now);
    assert.equal(sOverdue.status, 'overdue');
    assert.equal(sOverdue.isOverdue, true);
    assert.equal(sOverdue.badgeClass, 'status-warn');
    assert.equal(sOverdue.badgeText, '建议备份');
    assert.equal(sOverdue.daysSince, 20);
});
test('Backup - 备份邮件请求体超过 12MB 上限时返回 413', async () => {
    rateLimitBuckets.clear();
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{}')); c.close(); } });
    const req = new Request('https://x/api/backup/email', {
        method: 'POST', body: stream, duplex: 'half',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '99999999' }
    });
    const res = await handleBackupEmail(req, { RESEND_API_KEY: 'test' }, 1);
    assert.equal(res.status, 413);
});

test('Backup - 服务端导出并入 ZIP，离线时降级并写明原因', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = state.authToken;
    const originalCookie = state.cookieSession;
    try {
        state.authToken = 'test-token';
        state.cookieSession = false;
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            return new Response(JSON.stringify({ format: 'chillin-export-v1', counts: { notes: 2 } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        };

        const files = await buildFullBackupFiles();
        const server = files.find((f) => f.name === 'chillin-server-backup.json');
        const readme = files.find((f) => f.name === 'README.md');
        assert.ok(server, '应包含服务端导出 JSON');
        assert.equal(JSON.parse(server.data).format, 'chillin-export-v1');
        assert.match(readme.data, /chillin-server-backup\.json/);
        assert.match(readme.data, /不在包里的内容/);
        assert.ok(files.some((f) => f.name === 'chillin-full-backup.json'), '本地全量 JSON 仍要保留');

        // 未登录/离线：不发请求，README 说明降级原因
        state.authToken = '';
        state.cookieSession = false;
        calls = 0;
        const offline = await buildFullBackupFiles();
        assert.equal(calls, 0, '未登录时不应请求导出接口');
        assert.ok(!offline.some((f) => f.name === 'chillin-server-backup.json'));
        assert.match(offline.find((f) => f.name === 'README.md').data, /本次未包含服务端数据/);
    } finally {
        globalThis.fetch = originalFetch;
        state.authToken = originalToken;
        state.cookieSession = originalCookie;
    }
});

test('Backup - 备份邮件同一用户每小时最多 3 封，第 4 封返回 429', async () => {
    rateLimitBuckets.clear();
    const make = () => new Request('http://localhost/api/backup/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com', zipBase64: 'UEsDBBQ=' })
    });
    for (let i = 0; i < 3; i++) {
        assert.equal((await handleBackupEmail(make(), {}, 42)).status, 200, '第 ' + (i + 1) + ' 封应放行');
    }
    const blocked = await handleBackupEmail(make(), {}, 42);
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /频繁/);
});

test('Backup - 备份邮件支持收件人白名单并净化附件文件名', async () => {
    rateLimitBuckets.clear();
    const originalFetch = globalThis.fetch;
    let payload = null;
    globalThis.fetch = async (url, opts) => {
        payload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ id: 'ok' }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    };
    try {
        const req = (body) => new Request('http://localhost/api/backup/email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const env = { RESEND_API_KEY: 're_test', BACKUP_EMAIL_ALLOWLIST: 'me@example.com' };

        const denied = await handleBackupEmail(req({ email: 'other@example.com', zipBase64: 'UEsDBBQ=' }), env, 43);
        assert.equal(denied.status, 403, '白名单之外的收件人必须拒绝');

        // 大小写不敏感；文件名里的 ../ 与引号必须被净化
        const allowed = await handleBackupEmail(req({
            email: 'ME@example.com', zipBase64: 'UEsDBBQ=', filename: '../evil".zip'
        }), env, 44);
        assert.equal(allowed.status, 200);
        assert.equal(payload.attachments[0].filename, '.._evil_.zip');
        assert.ok(!payload.attachments[0].filename.includes('/'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

async function makeFullBackupFixture(root) {
    await fs.mkdir(path.join(root, 'r2', 'uploads', '1'), { recursive: true });
    const sql = 'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);\n'
        + "INSERT INTO notes (title) VALUES ('backup verify');\n";
    await fs.writeFile(path.join(root, 'chillin-d1.sql.gz'), zlib.gzipSync(Buffer.from(sql)));
    await fs.writeFile(path.join(root, 'r2', 'uploads', '1', 'a.txt'), 'image bytes');
    const d1 = await fs.stat(path.join(root, 'chillin-d1.sql.gz'));
    const object = await fs.stat(path.join(root, 'r2', 'uploads', '1', 'a.txt'));
    const manifest = {
        format: BACKUP_FORMAT,
        createdAt: new Date().toISOString(),
        appVersion: 'test',
        target: 'local',
        complete: true,
        hashAlgorithm: 'sha256',
        d1: {
            file: 'chillin-d1.sql.gz', size: d1.size, sha256: await sha256File(path.join(root, 'chillin-d1.sql.gz')),
            sqlSha256: sha256Text(sql), tables: ['notes'], migrations: []
        },
        r2: {
            bucket: 'chillin-media',
            objects: [{
                key: 'uploads/1/a.txt', category: 'image', expectedSize: object.size,
                mime: 'text/plain', path: 'r2/uploads/1/a.txt', size: object.size,
                sha256: await sha256File(path.join(root, 'r2', 'uploads', '1', 'a.txt')), status: 'ok'
            }],
            totals: { objects: 1, bytes: object.size }
        }
    };
    await fs.writeFile(path.join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(root, MANIFEST_HASH_NAME), (await sha256File(path.join(root, MANIFEST_NAME))) + '\n');
    return manifest;
}

test('Backup - 完整清单校验 D1 与每个 R2 对象的大小和 SHA-256', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chillin-full-backup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await makeFullBackupFixture(root);
    const ok = await verifyBackup(root);
    assert.equal(ok.ok, true, ok.errors.join('; '));
    assert.equal(ok.stats.r2Objects, 1);
    assert.equal(ok.stats.r2Verified, 1);
    assert.equal(ok.stats.manifestHashVerified, true);

    await fs.appendFile(path.join(root, 'r2', 'uploads', '1', 'a.txt'), 'tampered');
    const broken = await verifyBackup(root);
    assert.equal(broken.ok, false);
    assert.ok(broken.errors.some((e) => /SHA-256|大小/.test(e)));
});

test('Backup - 清单路径与 R2 键拒绝目录穿越', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chillin-full-path-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    assert.throws(() => safeResolve(root, '../outside'), /越出/);
    assert.throws(() => assertSafeR2Key('uploads/../secret'), /不能包含/);
    assert.throws(() => assertSafeR2Key('/etc/passwd'), /绝对路径/);
});

test('Backup - D1 恢复前清空旧表：保留内部表，先删 FTS shadow 再删虚表', async () => {
    let resetSql = '';
    const run = (args) => {
        if (args[0] === 'd1' && args[1] === 'execute' && args.includes('--command')) {
            return JSON.stringify([{ results: [
                { name: 'notes' },
                { name: '_cf_KV' },
                { name: 'memory_fts' },
                { name: 'memory_fts_data' },
                { name: 'd1_migrations' }
            ] }]);
        }
        if (args[0] === 'd1' && args[1] === 'execute' && args.includes('--file')) {
            resetSql = fsSync.readFileSync(args[args.indexOf('--file') + 1], 'utf8');
            return '';
        }
        throw new Error('unexpected command: ' + args.join(' '));
    };
    const dropped = resetD1Database(run, 'DB', '--remote');
    assert.equal(dropped, 4);
    assert.match(resetSql, /PRAGMA foreign_keys=OFF/);
    assert.ok(!/_cf_KV/.test(resetSql), '不能删除 D1 内部 _cf_KV');
    assert.ok(resetSql.indexOf('memory_fts_data') < resetSql.indexOf('"memory_fts"'), '先删 shadow 再删虚表');
    assert.match(resetSql, /DROP TABLE IF EXISTS "d1_migrations"/);
});

test('Backup - D1 导出兼容 FTS5：schema 含虚表/触发器，数据只导真实表', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chillin-d1-export-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'dump.sql');
    const seen = [];
    const run = (args) => {
        seen.push(args);
        const command = args.includes('--command') ? args[args.indexOf('--command') + 1] : '';
        if (args[0] === 'd1' && args[1] === 'execute' && /SELECT type/.test(command)) {
            return JSON.stringify([{ results: [
                { type: 'table', name: 'notes', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY);' },
                { type: 'table', name: 'memory_fts', sql: 'CREATE VIRTUAL TABLE memory_fts USING fts5(title);' },
                { type: 'trigger', name: 'trg_notes', sql: 'CREATE TRIGGER trg_notes AFTER INSERT ON notes BEGIN SELECT 1; END;' }
            ] }]);
        }
        if (args[0] === 'd1' && args[1] === 'execute' && /SELECT name/.test(command)) {
            return JSON.stringify([{ results: [{ name: 'notes' }] }]);
        }
        if (args[0] === 'd1' && args[1] === 'export') {
            const idx = args.indexOf('--output');
            fsSync.writeFileSync(args[idx + 1], 'INSERT INTO "notes" VALUES(1);\n');
            return '';
        }
        throw new Error('unexpected command: ' + args.join(' '));
    };

    const result = exportD1Full({ run, binding: 'DB', target: '--remote', output: out });
    const sql = await fs.readFile(out, 'utf8');
    assert.deepEqual(result.tables, ['notes']);
    assert.match(sql, /CREATE VIRTUAL TABLE memory_fts/);
    assert.match(sql, /CREATE TRIGGER trg_notes/);
    assert.match(sql, /INSERT INTO "notes"/);
    assert.ok(!/memory_fts_data/.test(sql), 'FTS shadow 表不能进入数据导出');
    assert.ok(seen.some((args) => args.includes('--no-schema')));
});
