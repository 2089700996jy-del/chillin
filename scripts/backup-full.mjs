#!/usr/bin/env node
/**
 * 完整灾难恢复备份：D1 SQL 快照 + R2 图片/书籍对象 + 可校验清单。
 *
 * 用法：
 *   npm run backup:full                 # 远端 D1 + R2，整个备份目录留在 backups/full-*
 *   npm run backup:full -- --no-r2      # 只导 D1/清单，不下载 R2（离线/磁盘紧张时）
 *   npm run backup:full -- --no-upload  # 不把 D1/清单副本推到 R2
 *   npm run backup:full -- --local      # 本地 dev 库与本地 R2（演练）
 *
 * 目录结构：
 *   backups/full-<stamp>/manifest.json
 *   backups/full-<stamp>/chillin-d1.sql.gz
 *   backups/full-<stamp>/r2/uploads/...、r2/books/...
 *
 * R2 对象清单来自 D1 的 files / reader_books 元数据，并逐对象下载、计算 SHA-256。
 * 图片与书籍正文不进 D1 快照；没有下载 R2 时清单会明确标 not-downloaded，不假装完整。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
    BACKUP_FORMAT, MANIFEST_NAME, MANIFEST_HASH_NAME,
    assertSafeR2Key, safeResolve, sha256File, sha256Text, verifyBackup
} from './backup-kit.mjs';
import { createWrangler, exportD1Full, queryD1Json } from './d1-export.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const local = flag('--local');
const withR2 = !flag('--no-r2');
const upload = !flag('--no-upload') && !local;
const keep = Math.max(1, Number(value('--keep', '14')) || 14);
const r2Concurrency = Math.max(1, Math.min(8, Number(value('--r2-concurrency', '4')) || 4));
const binding = process.env.CHILLIN_D1_BINDING || 'DB';
const bucket = process.env.CHILLIN_R2_BUCKET || 'chillin-media';
const target = local ? '--local' : '--remote';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const wrangler = createWrangler(root);

const R2_QUERY = "SELECT 'image' AS category, id, r2_key, mime_type, COALESCE(size, 0) AS size "
    + 'FROM files WHERE r2_key IS NOT NULL AND r2_key != \'\' '
    + 'UNION ALL '
    + "SELECT 'book' AS category, CAST(id AS TEXT) AS id, r2_key, 'text/plain' AS mime_type, COALESCE(size, 0) AS size "
    + 'FROM reader_books WHERE r2_key IS NOT NULL AND r2_key != \'\' AND is_deleted = 0';

async function downloadR2Object(baseDir, key, rel) {
    const dest = safeResolve(baseDir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
        wrangler(['r2', 'object', 'get', bucket + '/' + key, target, '--file', dest]);
        const stat = await fsp.stat(dest);
        return { size: stat.size, sha256: await sha256File(dest), status: 'ok' };
    } catch (err) {
        try { await fsp.unlink(dest); } catch (_) { /* ignore */ }
        return { size: 0, sha256: '', status: 'missing', error: String(err && err.message || err).split('\n')[0] };
    }
}

async function uploadFile(key, file, contentType) {
    try {
        wrangler(['r2', 'object', 'put', bucket + '/' + key, '--file', file,
            '--content-type', contentType, target]);
        console.log('[backup] uploaded → R2 ' + bucket + '/' + key);
    } catch (err) {
        console.warn('[backup] R2 upload skipped (' + key + '): ' + String(err && err.message || err).split('\n')[0]);
    }
}

async function main() {
    const dir = path.join(root, 'backups', 'full-' + stamp);
    await fsp.mkdir(dir, { recursive: true });

    // 1) D1 全量 SQL 快照
    const rawD1 = path.join(dir, '.chillin-d1.sql');
    const d1File = path.join(dir, 'chillin-d1.sql.gz');
    console.log('[backup] D1 export (' + (local ? 'local' : 'remote') + ') …');
    exportD1Full({ run: wrangler, binding, target, output: rawD1 });
    if (!fs.existsSync(rawD1)) throw new Error('D1 export 没有生成文件');
    const sql = await fsp.readFile(rawD1);
    await fsp.writeFile(d1File, zlib.gzipSync(sql, { level: 9 }));
    await fsp.unlink(rawD1);
    const d1Sha = await sha256File(d1File);
    const d1Stat = await fsp.stat(d1File);
    const sqlText = sql.toString('utf8');
    const tables = [...sqlText.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["'\x60]?([A-Za-z0-9_]+)/gi)]
        .map((m) => m[1]).filter((name, i, all) => all.indexOf(name) === i).sort();
    console.log('[backup] D1 wrote ' + path.relative(root, d1File) + ' (' + (d1Stat.size / 1024).toFixed(1) + ' KB)');

    // 2) 从 D1 元数据列出所有业务 R2 对象
    const rows = queryD1Json(wrangler, binding, target, R2_QUERY);
    const objects = new Array(rows.length);
    let missing = 0;
    let cursor = 0;
    async function downloadWorker() {
        while (true) {
            const index = cursor++;
            if (index >= rows.length) return;
            const row = rows[index];
            let key;
            try { key = assertSafeR2Key(row.r2_key); } catch (err) {
                console.warn('[backup] skip unsafe R2 key: ' + err.message);
                missing++;
                continue;
            }
            const rel = 'r2/' + key;
            let item = {
                key,
                category: row.category === 'book' ? 'book' : 'image',
                expectedSize: Number(row.size) || 0,
                mime: String(row.mime_type || 'application/octet-stream')
            };
            if (withR2) {
                const downloaded = await downloadR2Object(dir, key, rel);
                item = { ...item, ...downloaded, path: rel };
                if (downloaded.status !== 'ok') missing++;
                console.log('[backup] R2 ' + (downloaded.status === 'ok' ? 'ok' : 'MISSING') + ' ' + key
                    + (downloaded.status === 'ok' ? ' (' + (downloaded.size / 1024).toFixed(1) + ' KB)' : ''));
            } else {
                item = { ...item, status: 'not-downloaded', size: 0, sha256: '', path: null };
            }
            objects[index] = item;
        }
    }
    const workerCount = withR2 ? Math.min(r2Concurrency, Math.max(1, rows.length)) : 1;
    await Promise.all(Array.from({ length: workerCount }, () => downloadWorker()));
    const presentObjects = objects.filter(Boolean);

    // 3) 清单：D1 + R2 每个对象的 size/sha256 + 统计
    const manifest = {
        format: BACKUP_FORMAT,
        createdAt: new Date().toISOString(),
        appVersion: JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')).version,
        target: local ? 'local' : 'remote',
        complete: withR2 && missing === 0,
        hashAlgorithm: 'sha256',
        d1: {
            binding,
            file: 'chillin-d1.sql.gz',
            size: d1Stat.size,
            sha256: d1Sha,
            sqlBytes: sql.length,
            sqlSha256: sha256Text(sqlText),
            tables,
            migrations: (await fsp.readdir(path.join(root, 'migrations'))).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
        },
        r2: {
            bucket,
            objects: presentObjects,
            totals: {
                objects: presentObjects.length,
                bytes: presentObjects.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
            },
            excludes: ['backups/ 下的历史备份快照不复备份，避免自我引用']
        },
        restore: {
            command: 'npm run restore:full -- ' + path.relative(root, dir) + (local ? ' --local' : ' --yes')
        },
        notes: withR2
            ? ['R2 对象逐个下载并计算 SHA-256；清单与 D1 快照默认再上传一份到 R2。']
            : ['本次未下载 R2 对象（--no-r2）；manifest 只记录元数据，不能直接用于恢复。']
    };
    const manifestPath = path.join(dir, MANIFEST_NAME);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await fsp.writeFile(path.join(dir, MANIFEST_HASH_NAME), (await sha256File(manifestPath)) + '\n');

    // 4) 自校验；缺对象/哈希不符必须让 CI/计划任务看见
    const check = await verifyBackup(dir, { strict: withR2 });
    if (!check.ok) {
        console.error('[backup] manifest verification failed:\n- ' + check.errors.join('\n- '));
        process.exitCode = 1;
    }
    console.log('[backup] manifest: ' + path.relative(root, manifestPath)
        + ' objects=' + presentObjects.length + ' bytes=' + manifest.r2.totals.bytes + ' complete=' + manifest.complete);

    // 5) 云端副本（只传 D1 + 清单；R2 二进制已在源桶，恢复包目录请另存离线介质）
    if (upload) {
        const prefix = 'backups/full/' + stamp + '/';
        await uploadFile(prefix + 'chillin-d1.sql.gz', d1File, 'application/gzip');
        await uploadFile(prefix + MANIFEST_NAME, manifestPath, 'application/json');
        await uploadFile(prefix + MANIFEST_HASH_NAME, path.join(dir, MANIFEST_HASH_NAME), 'text/plain');
    }

    // 6) 本地保留最近 keep 份完整备份
    const all = (await fsp.readdir(path.join(root, 'backups')))
        .filter((name) => name.startsWith('full-')).sort();
    const excess = all.length - keep;
    for (const name of all.slice(0, Math.max(0, excess))) {
        if (path.join(root, 'backups', name) === dir) continue;
        await fsp.rm(path.join(root, 'backups', name), { recursive: true, force: true });
        console.log('[backup] pruned ' + name);
    }
    return check;
}

main().catch((err) => {
    console.error('[backup] failed: ' + (err && err.stack || err));
    process.exit(1);
});
