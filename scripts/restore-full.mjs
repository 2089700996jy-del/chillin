#!/usr/bin/env node
/**
 * 一键恢复一份完整备份：先校验清单/哈希，再按 R2 → D1 顺序写回。
 *
 * 用法：
 *   npm run restore:full -- backups/full-<stamp> --local            # 本地演练，不碰生产
 *   npm run restore:full -- backups/full-<stamp> --yes              # 远端生产，必须显式确认
 *   npm run restore:full -- backups/full-<stamp> --dry-run --local   # 只校验和打印计划
 *
 * 设计取舍：先恢复 R2 再恢复 D1。D1 一旦恢复，元数据就会立即指向 R2 键；
 * 如果反过来，D1 恢复成功但 R2 中途失败，用户会看到一批 404 图片/书籍。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeR2Key, readManifest, safeResolve, verifyBackup } from './backup-kit.mjs';
import { createWrangler, resetD1Database } from './d1-export.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const fileArg = argv.find((a) => !a.startsWith('--'));
const local = argv.includes('--local');
const confirmed = argv.includes('--yes');
const dryRun = argv.includes('--dry-run');
const skipR2 = argv.includes('--skip-r2');
const skipD1 = argv.includes('--skip-d1');
const allowIncomplete = argv.includes('--allow-incomplete');
const resetD1 = !argv.includes('--no-reset');

if (!fileArg) {
    console.error('用法：npm run restore:full -- <backups/full-<时间戳>> [--local] [--yes] [--dry-run]');
    process.exit(1);
}
if (!fs.existsSync(fileArg)) {
    console.error('[restore-full] 找不到备份：' + fileArg);
    process.exit(1);
}
if (!local && !dryRun && !confirmed) {
    console.error('[restore-full] 目标是远端生产库/R2，会覆盖现有对象；确认无误请追加 --yes。');
    process.exit(1);
}

function wrangler(args) {
    const env = { ...process.env };
    const bypass = '.r2.cloudflarestorage.com,cloudflarestorage.com';
    env.NO_PROXY = env.NO_PROXY ? env.NO_PROXY + ',' + bypass : bypass;
    env.no_proxy = env.no_proxy ? env.no_proxy + ',' + bypass : bypass;
    return execFileSync('npx', ['wrangler', ...args], {
        cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32'
    });
}

async function main() {
    let manifest;
    try {
        manifest = await readManifest(fileArg);
    } catch (err) {
        console.error('[restore-full] 读不到清单：' + err.message);
        process.exit(1);
    }
    if (manifest.complete === false && !allowIncomplete) {
        console.error('[restore-full] 清单标记为不完整（可能缺 R2 对象），拒绝恢复；确需演练请加 --allow-incomplete。');
        process.exit(1);
    }

    const check = await verifyBackup(fileArg, { strict: !allowIncomplete });
    if (!check.ok) {
        console.error('[restore-full] 校验失败，未写入任何数据：\n- ' + check.errors.join('\n- '));
        process.exit(1);
    }
    const backupRoot = check.root;
    const d1Binding = String(manifest.d1.binding || 'DB');
    if (!/^[A-Za-z0-9_]+$/.test(d1Binding)) throw new Error('清单里的 D1 binding 不合法');
    const bucket = String((manifest.r2 && manifest.r2.bucket) || '');
    if (bucket && !/^[A-Za-z0-9._-]+$/.test(bucket)) throw new Error('清单里的 R2 bucket 不合法');
    const d1File = safeResolve(backupRoot, manifest.d1.file);
    const r2Objects = (manifest.r2 && manifest.r2.objects) || [];
    console.log('[restore-full] 校验通过：D1 ' + (manifest.d1.size / 1024).toFixed(1)
        + ' KB，R2 ' + r2Objects.length + ' 个对象 / ' + (manifest.r2.totals.bytes / 1024 / 1024).toFixed(1) + ' MB');
    console.log('[restore-full] 目标：' + (local ? '本地 dev' : '远端生产') + (dryRun ? '（dry-run，不写入）' : '')
        + '；顺序：' + (skipR2 ? '跳过 R2' : 'R2') + ' → ' + (skipD1 ? '跳过 D1' : 'D1')
        + '；D1 恢复前' + (skipD1 || !resetD1 ? '不清理旧表' : '会先清空业务表（可加 --no-reset 保留）'));

    if (dryRun) {
        for (const item of r2Objects.slice(0, 5)) console.log('  R2 ' + item.key + ' (' + item.size + ' bytes)');
        if (r2Objects.length > 5) console.log('  … 其余 ' + (r2Objects.length - 5) + ' 个对象');
        console.log('[restore-full] dry-run 完成，没有写入任何数据。');
        return;
    }
    if (skipR2 && skipD1) {
        console.error('[restore-full] --skip-r2 与 --skip-d1 不能同时使用');
        process.exit(1);
    }

    if (!skipR2) {
        if (!bucket) throw new Error('清单缺少 r2.bucket');
        const restorable = r2Objects.filter((row) => (row.status || 'ok') === 'ok');
        let done = 0;
        for (const item of restorable) {
            const key = assertSafeR2Key(item.key);
            const file = safeResolve(backupRoot, item.path || ('r2/' + key));
            wrangler(['r2', 'object', 'put', bucket + '/' + key, '--file', file,
                '--content-type', item.mime || 'application/octet-stream', local ? '--local' : '--remote']);
            done++;
            if (done % 20 === 0 || done === restorable.length) {
                console.log('[restore-full] R2 ' + done + '/' + restorable.length);
            }
        }
    }

    if (!skipD1) {
        if (resetD1) {
            const run = createWrangler(root);
            const dropped = resetD1Database(run, d1Binding, local ? '--local' : '--remote');
            console.log('[restore-full] D1 已清理 ' + dropped + ' 张旧表，开始导入备份。');
        }
        const script = path.join(root, 'scripts', 'restore-d1.mjs');
        const args = [script, d1File];
        if (local) args.push('--local'); else args.push('--yes');
        execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    }
    console.log('[restore-full] 完成。建议再跑一次 npm run backup:verify -- ' + path.relative(root, backupRoot));
}

main().catch((err) => {
    console.error('[restore-full] failed: ' + (err && err.stack || err));
    process.exit(1);
});
