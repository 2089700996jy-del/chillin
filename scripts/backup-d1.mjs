#!/usr/bin/env node
/**
 * D1 备份导出。
 *
 * 用法：npm run backup [-- --keep 30]
 *   - 调用 wrangler d1 export --remote 导出远端库存为 SQL
 *   - gzip 压缩后存入 backups/（已在 .gitignore 中，绝不入库）
 *   - 默认保留最近 14 份快照，超出即清理
 *
 * 建议用系统计划任务每天跑一次：
 *   Windows: schtasks /create /tn "Chillin D1 Backup" /tr "cmd /c cd /d E:\Chillin && npm run backup" /sc daily /st 03:30
 *   或 GitHub Actions（需在仓库 Secrets 配置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binding = process.env.CHILLIN_D1_BINDING || 'DB';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const keepFlag = argv.indexOf('--keep');
const keep = keepFlag !== -1 && Number(argv[keepFlag + 1]) > 0 ? Number(argv[keepFlag + 1]) : 14;

const outDir = path.join(root, 'backups');
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rawFile = path.join(outDir, `chillin-d1-${stamp}.sql`);

console.log(`[backup] exporting ${binding} (remote) → ${path.relative(root, rawFile)}`);
execFileSync('npx', ['wrangler', 'd1', 'export', binding, '--remote', '--output', rawFile], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
});

if (!fs.existsSync(rawFile)) {
    console.error('[backup] export produced no file');
    process.exit(1);
}

const sql = fs.readFileSync(rawFile);
const gzFile = `${rawFile}.gz`;
fs.writeFileSync(gzFile, zlib.gzipSync(sql, { level: 9 }));
fs.unlinkSync(rawFile);
console.log(`[backup] wrote ${path.relative(root, gzFile)} (${(fs.statSync(gzFile).size / 1024).toFixed(1)} KB)`);

const snapshots = fs.readdirSync(outDir)
    .filter((f) => f.startsWith('chillin-d1-') && f.endsWith('.sql.gz'))
    .sort();
const excess = snapshots.length - keep;
if (excess > 0) {
    for (const f of snapshots.slice(0, excess)) {
        fs.unlinkSync(path.join(outDir, f));
        console.log(`[backup] pruned ${f}`);
    }
}
console.log(`[backup] done — ${Math.min(snapshots.length, keep)} snapshot(s) kept (keep=${keep})`);
