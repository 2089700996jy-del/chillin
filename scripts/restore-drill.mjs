#!/usr/bin/env node
/**
 * 独立环境恢复演练：不连 Cloudflare，生成一份最小备份，
 * 在临时目录里校验、复制、再校验，并跑一次 restore:full --dry-run。
 *
 * 定期在 CI 跑这个脚本，保证「清单格式 / 哈希 / 路径安全 / 恢复入口」不会在无声中腐烂。
 * 真正的生产恢复仍应每季度人工把一份 full-* 包恢复到 staging D1/R2 后抽查。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BACKUP_FORMAT, MANIFEST_NAME, MANIFEST_HASH_NAME, sha256File, sha256Text, verifyBackup } from './backup-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function createFixture(dir) {
    await fsp.mkdir(path.join(dir, 'r2', 'uploads', '0'), { recursive: true });
    const d1Text = 'CREATE TABLE drill_notes (id INTEGER PRIMARY KEY, body TEXT);\n'
        + "INSERT INTO drill_notes (body) VALUES ('restore me');\n";
    const d1File = path.join(dir, 'chillin-d1.sql.gz');
    await fsp.writeFile(d1File, zlib.gzipSync(Buffer.from(d1Text), { level: 9 }));
    const d1Stat = await fsp.stat(d1File);
    const r2File = path.join(dir, 'r2', 'uploads', '0', 'drill.txt');
    await fsp.writeFile(r2File, 'hello from r2\n');
    const r2Stat = await fsp.stat(r2File);
    const r2Sha = await sha256File(r2File);
    const manifest = {
        format: BACKUP_FORMAT,
        createdAt: new Date().toISOString(),
        appVersion: 'drill',
        target: 'local',
        complete: true,
        hashAlgorithm: 'sha256',
        d1: {
            binding: 'DB',
            file: 'chillin-d1.sql.gz',
            size: d1Stat.size,
            sha256: await sha256File(d1File),
            sqlBytes: Buffer.byteLength(d1Text),
            sqlSha256: sha256Text(d1Text),
            tables: ['drill_notes'],
            migrations: []
        },
        r2: {
            bucket: 'chillin-media',
            objects: [{
                key: 'uploads/0/drill.txt',
                category: 'image',
                id: 'drill',
                expectedSize: r2Stat.size,
                mime: 'text/plain',
                path: 'r2/uploads/0/drill.txt',
                size: r2Stat.size,
                sha256: r2Sha,
                status: 'ok'
            }],
            totals: { objects: 1, bytes: r2Stat.size },
            excludes: []
        },
        restore: { command: 'drill' },
        notes: []
    };
    const manifestPath = path.join(dir, MANIFEST_NAME);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await fsp.writeFile(path.join(dir, MANIFEST_HASH_NAME), (await sha256File(manifestPath)) + '\n');
    return dir;
}

async function main() {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'chillin-restore-drill-'));
    try {
        const source = await createFixture(path.join(tmp, 'source'));
        const first = await verifyBackup(source, { strict: true });
        if (!first.ok) throw new Error('fixture 自校验失败：' + first.errors.join('；'));

        // 模拟「独立环境」：只搬备份包，不共享原目录，再校验一次
        const restored = path.join(tmp, 'isolated', 'full-drill');
        await fsp.mkdir(path.dirname(restored), { recursive: true });
        await fsp.cp(source, restored, { recursive: true });
        const second = await verifyBackup(restored, { strict: true });
        if (!second.ok) throw new Error('隔离目录校验失败：' + second.errors.join('；'));

        // 损坏一个字节，验证会明确失败，而不是静默通过
        const victim = path.join(restored, 'r2', 'uploads', '0', 'drill.txt');
        const bytes = await fsp.readFile(victim);
        bytes[0] = bytes[0] ^ 0xff;
        await fsp.writeFile(victim, bytes);
        const broken = await verifyBackup(restored, { strict: true });
        if (broken.ok) throw new Error('篡改后的备份居然校验通过');

        // 恢复入口至少要在 dry-run 下跑通（不写 D1/R2）
        const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'restore-full.mjs'), source, '--dry-run', '--local'], {
            cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        if (!out.includes('dry-run 完成')) throw new Error('restore:full --dry-run 没有完成');

        console.log('[drill] ok — fixture verified, isolated copy verified, corruption rejected, restore dry-run ok');
    } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error('[drill] failed: ' + (err && err.stack || err));
    process.exit(1);
});
