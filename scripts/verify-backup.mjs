#!/usr/bin/env node
/**
 * 校验完整备份（D1 SQL + R2 每个对象的 size/SHA-256）。
 * 可用于计划任务、GitHub Actions 或恢复前手动检查。
 *
 * 用法：
 *   npm run backup:verify -- backups/full-<stamp>
 *   npm run backup:verify -- backups/full-<stamp> --json
 *   npm run backup:verify -- backups/full-<stamp> --allow-incomplete   # --no-r2 的清单
 */
import path from 'node:path';
import { verifyBackup, formatBytes } from './backup-kit.mjs';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const target = argv.find((a) => !a.startsWith('--'));
const json = argv.includes('--json');
const allowIncomplete = argv.includes('--allow-incomplete');

if (!target) {
    console.error('用法：npm run backup:verify -- <backups/full-<时间戳>> [--json] [--allow-incomplete]');
    process.exit(1);
}

const result = await verifyBackup(path.resolve(target), { strict: !allowIncomplete });
if (json) {
    console.log(JSON.stringify({ ok: result.ok, root: result.root, errors: result.errors, warnings: result.warnings, stats: result.stats }, null, 2));
} else {
    console.log('[verify] ' + (result.ok ? 'OK' : 'FAILED') + ' ' + result.root);
    console.log('[verify] D1=' + formatBytes(result.stats.d1Bytes || 0)
        + ' R2=' + (result.stats.r2Objects || 0) + ' 个 / ' + formatBytes(result.stats.r2Bytes || 0)
        + '（已校验 ' + (result.stats.r2Verified || 0) + '，跳过 ' + (result.stats.r2Skipped || 0) + '）');
    for (const warning of result.warnings || []) console.warn('[verify] warning: ' + warning);
    for (const error of (result.errors || []).slice(0, 30)) console.error('[verify] error: ' + error);
    if ((result.errors || []).length > 30) console.error('[verify] … 还有 ' + (result.errors.length - 30) + ' 条错误');
}
process.exit(result.ok ? 0 : 1);
