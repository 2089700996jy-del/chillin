#!/usr/bin/env node
/**
 * 完整备份工具的可复用底座：
 *   - 清单格式 / 路径校验 / SHA-256
 *   - 备份目录完整性校验（D1 快照 + R2 对象）
 *
 * 不给 CLI 加副作用，tests 可以直接 import 这里的纯函数。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export const BACKUP_FORMAT = 'chillin-full-backup-v1';
export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_HASH_NAME = 'manifest.json.sha256';
export const HASH_ALGORITHM = 'sha256';

/** R2 键只允许站点自己生成的安全字符，避免恢复时拼进 shell 参数。 */
export function assertSafeR2Key(key) {
    const s = String(key || '');
    if (!s || s.length > 512) throw new Error('R2 对象键为空或过长');
    if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error('R2 对象键含控制字符');
    if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) throw new Error('R2 对象键不能是绝对路径');
    if (s.split('/').some((part) => part === '..' || part === '.')) throw new Error('R2 对象键不能包含 . 或 ..');
    if (!/^[A-Za-z0-9._\-\/]+$/.test(s)) throw new Error('R2 对象键含不安全字符：' + s);
    return s;
}

/** 把清单里的相对路径安全地落到备份根目录内（防止 ../../ 越界）。 */
export function safeResolve(root, relative) {
    const base = path.resolve(root);
    const rel = String(relative || '').replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error('清单路径必须是相对路径');
    const full = path.resolve(base, rel);
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    if (full !== base && !full.startsWith(prefix)) throw new Error('清单路径越出备份目录：' + relative);
    return full;
}

export function toManifestPath(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}

export async function sha256File(file) {
    const hash = createHash(HASH_ALGORITHM);
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

export function sha256Text(text) {
    return createHash(HASH_ALGORITHM).update(String(text)).digest('hex');
}

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export async function readManifest(fileOrDir) {
    const manifestPath = (await fsp.stat(fileOrDir)).isDirectory()
        ? path.join(fileOrDir, MANIFEST_NAME)
        : fileOrDir;
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
}

/**
 * 校验一份完整备份。
 * strict=true：R2 对象必须全部下载在本地（可用于真正恢复）。
 * strict=false：允许 manifest 里标记 not-downloaded 的对象，只验证已存在的文件。
 */
export async function verifyBackup(fileOrDir, options = {}) {
    const strict = options.strict !== false;
    const errors = [];
    const warnings = [];
    let manifest;
    let root;
    try {
        const stat = await fsp.stat(fileOrDir);
        root = stat.isDirectory() ? path.resolve(fileOrDir) : path.dirname(path.resolve(fileOrDir));
        manifest = await readManifest(fileOrDir);
    } catch (err) {
        return { ok: false, root: path.resolve(String(fileOrDir || '.')), manifest: null, errors: ['读不到清单：' + err.message], warnings, stats: {} };
    }

    if (!manifest || manifest.format !== BACKUP_FORMAT) errors.push('清单 format 不是 ' + BACKUP_FORMAT);
    if (!manifest.createdAt || Number.isNaN(Date.parse(manifest.createdAt))) errors.push('清单缺少有效的 createdAt');

    const d1 = manifest.d1;
    let sqlText = '';
    let d1Size = 0;
    if (!d1 || !d1.file) {
        errors.push('清单缺少 d1.file');
    } else {
        try {
            const file = safeResolve(root, d1.file);
            const stat = await fsp.stat(file);
            d1Size = stat.size;
            if (Number(d1.size) !== stat.size) errors.push('D1 快照大小不符：manifest=' + d1.size + ' actual=' + stat.size);
            if (d1.sha256) {
                const actual = await sha256File(file);
                if (actual !== d1.sha256) errors.push('D1 快照 SHA-256 不符');
            } else {
                errors.push('D1 快照缺少 sha256');
            }
            const raw = await fsp.readFile(file);
            try {
                sqlText = /\.gz$/i.test(file) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
            } catch (err) {
                errors.push('D1 快照 gzip 解压失败：' + err.message);
            }
            if (sqlText && !/CREATE\s+TABLE/i.test(sqlText)) errors.push('D1 快照里没有 CREATE TABLE，可能不是完整导出');
            if (d1.sqlSha256 && sqlText) {
                const actual = sha256Text(sqlText);
                if (actual !== d1.sqlSha256) errors.push('D1 解压后的 SQL SHA-256 不符');
            }
        } catch (err) {
            errors.push('D1 快照不可读：' + err.message);
        }
    }

    const r2 = manifest.r2 || {};
    const objects = Array.isArray(r2.objects) ? r2.objects : [];
    if (!Array.isArray(r2.objects)) errors.push('清单缺少 r2.objects 数组');
    const seen = new Set();
    let bytes = 0;
    let okCount = 0;
    let skippedCount = 0;
    for (const [i, item] of objects.entries()) {
        const label = 'r2.objects[' + i + ']';
        if (!item || typeof item !== 'object') { errors.push(label + ' 不是对象'); continue; }
        let key;
        try { key = assertSafeR2Key(item.key); } catch (err) { errors.push(label + '：' + err.message); continue; }
        if (seen.has(key)) { errors.push('R2 对象重复：' + key); continue; }
        seen.add(key);
        const status = item.status || 'ok';
        if (status === 'not-downloaded') {
            skippedCount++;
            if (strict) errors.push('R2 对象未下载：' + key);
            continue;
        }
        if (status !== 'ok') { errors.push('R2 对象不可用（' + status + '）：' + key); continue; }
        const rel = item.path || ('r2/' + key);
        let file;
        try { file = safeResolve(root, rel); } catch (err) { errors.push(label + '：' + err.message); continue; }
        try {
            const stat = await fsp.stat(file);
            if (!stat.isFile()) { errors.push('R2 对象不是文件：' + rel); continue; }
            if (Number(item.size) !== stat.size) errors.push('R2 对象大小不符：' + key + ' manifest=' + item.size + ' actual=' + stat.size);
            if (item.expectedSize != null && Number(item.expectedSize) > 0 && Number(item.expectedSize) !== stat.size) {
                errors.push('R2 对象与 D1 记录的大小不一致：' + key);
            }
            if (!item.sha256) errors.push('R2 对象缺少 sha256：' + key);
            else {
                const actual = await sha256File(file);
                if (actual !== item.sha256) errors.push('R2 对象 SHA-256 不符：' + key);
            }
            bytes += stat.size;
            okCount++;
        } catch (err) {
            errors.push('R2 对象不可读：' + key + ' (' + err.message + ')');
        }
    }

    const totals = r2.totals || {};
    if (Number(totals.objects) !== objects.length) errors.push('r2.totals.objects 与清单不一致');
    if (Number(totals.bytes) !== objects.reduce((sum, item) => sum + (Number(item.size) || 0), 0)) {
        errors.push('r2.totals.bytes 与清单不一致');
    }

    let manifestHashVerified = false;
    try {
        const hashFile = path.join(root, MANIFEST_HASH_NAME);
        const expected = (await fsp.readFile(hashFile, 'utf8')).trim();
        const actual = await sha256File(path.join(root, MANIFEST_NAME));
        if (expected !== actual) errors.push('manifest.json.sha256 不符');
        else manifestHashVerified = true;
    } catch (_) {
        warnings.push('没有 manifest.json.sha256，跳过清单自校验');
    }

    return {
        ok: errors.length === 0,
        root,
        manifest,
        errors,
        warnings,
        stats: {
            d1Bytes: d1Size,
            d1SqlBytes: Buffer.byteLength(sqlText),
            r2Objects: objects.length,
            r2Bytes: bytes,
            r2Verified: okCount,
            r2Skipped: skippedCount,
            manifestHashVerified
        }
    };
}
