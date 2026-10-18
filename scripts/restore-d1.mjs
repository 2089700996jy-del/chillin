#!/usr/bin/env node
/**
 * D1 备份恢复。
 *
 * 用法：npm run restore -- <backups/chillin-d1-<时间戳>.sql.gz> [--local] [--yes]
 *   - backup-d1.mjs 只保留 gzip 快照（裸 .sql 导出后即删除），这里负责解压再执行；
 *   - 默认目标是**远端生产库**，会覆盖现有数据，所以必须显式追加 --yes；
 *     本地库（wrangler dev）用 --local，无需 --yes；
 *   - 解压出的 .sql 写在系统临时目录，执行完立即删除。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const binding = process.env.CHILLIN_D1_BINDING || 'DB';
const argv = process.argv.slice(2).filter((a) => a !== '--');
const file = argv.find((a) => !a.startsWith('--'));
const local = argv.includes('--local');
const confirmed = argv.includes('--yes');

if (!file) {
    console.error('用法：npm run restore -- <backups/chillin-d1-<时间戳>.sql.gz> [--local] [--yes]');
    process.exit(1);
}
if (!fs.existsSync(file)) {
    console.error(`[restore] 找不到快照：${file}`);
    process.exit(1);
}
if (!local && !confirmed) {
    console.error('[restore] 目标是远端生产库，执行会覆盖现有数据；确认无误请追加 --yes。');
    process.exit(1);
}

const raw = fs.readFileSync(file);
let sql;
try {
    sql = zlib.gunzipSync(raw);
} catch (_) {
    // 兼容手工保留的裸 .sql：不是 gzip 就按原文处理
    sql = raw;
}

const tmpFile = path.join(os.tmpdir(), `chillin-restore-${Date.now()}.sql`);
fs.writeFileSync(tmpFile, sql);
console.log(`[restore] ${local ? 'local' : 'remote'} ← ${file}（${(sql.length / 1024).toFixed(1)} KB）`);
try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', binding, local ? '--local' : '--remote', '--file', tmpFile], {
        stdio: 'inherit',
        shell: process.platform === 'win32'
    });
} finally {
    fs.unlinkSync(tmpFile);
}
