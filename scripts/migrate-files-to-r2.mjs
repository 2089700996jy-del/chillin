#!/usr/bin/env node
/**
 * 存量图片从 D1 BLOB 搬迁到 R2（P0 配套的一次性维护脚本）。
 *
 * 用法：node scripts/migrate-files-to-r2.mjs [--dry-run] [--clear-data] [--bucket chillin-media]
 *
 * 流程：
 *   1. 读出所有「还没有 r2_key」的图片行（远端 D1，用 hex(data) 取出二进制）
 *   2. 逐行上传到 R2 的 uploads/<user_id>/<id>（与 Worker 新上传的键保持一致）
 *   3. 回填 files.r2_key / files.size，此后读取自动走 R2
 *   4. 全部成功后可加 --clear-data，把 D1 里的 BLOB 清空，真正给库瘦身
 *
 * 幂等：只挑选 r2_key 为空的行，中断后直接重跑即可，已迁移的行会被跳过。
 * 迁移期间线上读取仍可用：Worker 对 r2_key 为空的行继续回落到 D1 BLOB。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const dryRun = argv.includes('--dry-run');
const clearData = argv.includes('--clear-data');
const bucketFlag = argv.indexOf('--bucket');
const bucket = bucketFlag !== -1 && argv[bucketFlag + 1] ? argv[bucketFlag + 1] : (process.env.CHILLIN_R2_BUCKET || 'chillin-media');
const binding = process.env.CHILLIN_D1_BINDING || 'DB';

/**
 * Windows 下必须借 shell 才能解析 npx，但 shell 会按空格把参数再拆一遍
 * （SQL 会被拆成 "SELECT it," "id," 这样的碎片），所以参数要自己加引号。
 */
function quoteArg(value) {
    const s = String(value);
    return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

/**
 * R2 的传输端点是 *.r2.cloudflarestorage.com：实测本地 HTTP 代理会把它拦成
 * "fetch failed"，因此给子进程补一条 NO_PROXY 绕过（不影响其它请求）。
 */
function r2FriendlyEnv() {
    const extra = '.r2.cloudflarestorage.com,cloudflarestorage.com';
    const merge = (v) => (v ? v + ',' + extra : extra);
    return { ...process.env, NO_PROXY: merge(process.env.NO_PROXY), no_proxy: merge(process.env.no_proxy) };
}

/** 统一走 npx wrangler 调用 wrangler CLI */
function wrangler(args, { capture = true } = {}) {
    return execFileSync('npx', ['wrangler', ...args].map(quoteArg), {
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        shell: process.platform === 'win32',
        env: r2FriendlyEnv(),
        maxBuffer: 512 * 1024 * 1024
    });
}

/**
 * 本地网络/代理偶发抽风（表现为 wrangler 报 "fetch failed"），
 * 检索与上传都重试几次，避免几分钟的迁移被一次抖动打断。
 * 上传是幂等的（同一对象键、同一字节），重试安全。
 */
function wranglerWithRetry(args, options = {}, attempts = 3) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            return wrangler(args, options);
        } catch (err) {
            lastErr = err;
            if (i === attempts) break;
            const pauseMs = i * 2000;
            console.warn(`[r2-migrate] 第 ${i}/${attempts} 次调用失败，${pauseMs / 1000}s 后重试：${String(err.message).split('\n')[0]}`);
            // 同步等待：脚本主体是同步流程，这里不引入 async 复杂度
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
        }
    }
    throw lastErr;
}

/** wrangler 会在 JSON 前面打警告行，这里剥掉 ANSI 与前置噪音后取 JSON */
function parseWranglerJson(raw) {
    const clean = String(raw).replace(/\u001b\[[0-9;]*m/g, '');
    const start = clean.search(/[[{]/);
    if (start === -1) throw new Error('未找到 JSON 输出：' + clean.slice(0, 200));
    const parsed = JSON.parse(clean.slice(start));
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return (first && first.results) || [];
}

const SELECT_PENDING = 'SELECT id, user_id, mime_type, length(data) AS bytes, hex(data) AS hex FROM files WHERE r2_key IS NULL AND data IS NOT NULL';

console.log('[r2-migrate] 查询待迁移图片…');
const rows = parseWranglerJson(
    wranglerWithRetry(['d1', 'execute', binding, '--remote', '--json', '--command', SELECT_PENDING])
).filter((r) => r && r.id && r.hex);

if (!rows.length) {
    console.log('[r2-migrate] 没有待迁移的图片，收工。');
    process.exit(0);
}

const totalBytes = rows.reduce((sum, r) => sum + Buffer.byteLength(r.hex, 'hex'), 0);
console.log(`[r2-migrate] 待迁移 ${rows.length} 张图片，合计 ${(totalBytes / 1024).toFixed(1)} KB`);
if (dryRun) {
    for (const r of rows) {
        console.log(`[dry-run] 将上传 uploads/${r.user_id ?? 0}/${r.id} (${r.mime_type}, ${r.bytes} B)`);
    }
    console.log(clearData ? '[dry-run] 之后会清空 D1 中的 BLOB' : '[dry-run] 不清空 D1 BLOB（如需清空请加 --clear-data）');
    process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chillin-r2-migrate-'));
const tmpFile = path.join(tmpDir, 'blob.bin');
let done = 0;

try {
    for (const row of rows) {
        const bytes = Buffer.from(row.hex, 'hex');
        if (Number(row.bytes) && bytes.length !== Number(row.bytes)) {
            throw new Error(`图片 ${row.id} 的 hex 长度异常（期望 ${row.bytes}，实际 ${bytes.length}），已中止`);
        }
        const objectKey = `uploads/${row.user_id ?? 0}/${row.id}`;
        fs.writeFileSync(tmpFile, bytes);
        wranglerWithRetry(['r2', 'object', 'put', `${bucket}/${objectKey}`,
            '--file', tmpFile,
            '--content-type', row.mime_type || 'application/octet-stream',
            '--remote'], { capture: false });
        // 回填元数据：此后 handleFileView 会优先从 R2 读取
        wranglerWithRetry(['d1', 'execute', binding, '--remote', '--command',
            `UPDATE files SET r2_key = '${objectKey}', size = ${bytes.length} WHERE id = '${row.id}'`]);
        done++;
        console.log(`[r2-migrate] ${done}/${rows.length} 已迁移 ${row.id} → ${objectKey} (${(bytes.length / 1024).toFixed(1)} KB)`);
    }
} finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (clearData) {
    console.log('[r2-migrate] 清空已迁移行的 D1 BLOB…');
    wrangler(['d1', 'execute', binding, '--remote', '--command',
        'UPDATE files SET data = NULL WHERE r2_key IS NOT NULL']);
    console.log('[r2-migrate] D1 BLOB 已清空（可用 VACUUM 回收空间，可选）。');
}

console.log(`[r2-migrate] 完成：${done}/${rows.length} 张图片已落到 R2（桶 ${bucket}）。`);
