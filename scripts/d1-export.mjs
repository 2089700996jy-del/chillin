/**
 * D1 全量导出（兼容 FTS5 虚表）。
 *
 * wrangler d1 export 在库里有 FTS5 虚表时会直接报
 * "cannot export databases with virtual tables (like FTS5)"。
 * 这里改用「sqlite_master 取 schema + 逐个真实表 --no-schema 导数据」：
 *   - schema 包含普通表、索引、视图、触发器和 memory_fts 虚表；
 *   - 数据跳过 memory_fts 及其 shadow 表，恢复时由 0034 的触发器重建索引；
 *   - 不导 _cf_KV 等 D1 内部表之外的东西。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createWrangler(cwd) {
    // 直接跑本地 wrangler 的 JS 入口：不经过 cmd.exe，SQL 里的 < > ' " 不会被 shell 解释。
    const bin = path.join(cwd, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const localBin = fs.existsSync(bin);
    return (args, capture = false) => {
        const env = { ...process.env };
        const bypass = '.r2.cloudflarestorage.com,cloudflarestorage.com';
        env.NO_PROXY = env.NO_PROXY ? env.NO_PROXY + ',' + bypass : bypass;
        env.no_proxy = env.no_proxy ? env.no_proxy + ',' + bypass : bypass;
        const command = localBin ? process.execPath : 'npx';
        const commandArgs = localBin ? [bin, ...args] : ['wrangler', ...args];
        return execFileSync(command, commandArgs, {
            cwd,
            env,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
            shell: !localBin && process.platform === 'win32'
        });
    };
}

export function queryD1Json(run, binding, target, sql) {
    const out = run(['d1', 'execute', binding, target, '--json', '--command', sql], true);
    const parsed = JSON.parse(out);
    const rows = parsed && parsed[0] && parsed[0].results;
    if (!Array.isArray(rows)) throw new Error('D1 查询没有返回 results');
    return rows;
}

const SCHEMA_QUERY = "SELECT type, name, sql FROM sqlite_master "
    + "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
    + "AND name NOT LIKE 'memory_fts_%' AND name != '_cf_KV' "
    + "ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'view' THEN 3 WHEN 'trigger' THEN 4 ELSE 5 END, name";

const DATA_TABLES_QUERY = "SELECT name FROM sqlite_master WHERE type = 'table' "
    + "AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' AND name NOT LIKE 'memory_fts_%' "
    + "AND UPPER(sql) NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name";

/** 恢复前清空业务表（保留 D1 内部 _cf_KV / sqlite_*），让完整备份可以覆盖非空库。 */
export function resetD1Database(run, binding, target) {
    const rows = queryD1Json(run, binding, target,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY name");
    const names = rows.map((row) => String(row.name || ''))
        .filter((name) => name && name !== '_cf_KV' && !name.startsWith('sqlite_'));
    if (!names.length) return 0;
    const shadows = names.filter((name) => name.startsWith('memory_fts_'));
    const virtuals = names.filter((name) => name === 'memory_fts');
    const others = names.filter((name) => !shadows.includes(name) && !virtuals.includes(name));
    const ordered = [...shadows, ...others, ...virtuals];
    const sql = 'PRAGMA foreign_keys=OFF;\n'
        + ordered.map((name) => 'DROP TABLE IF EXISTS "' + name.replace(/"/g, '""') + '";').join('\n')
        + '\n';
    const tmp = path.join(os.tmpdir(), 'chillin-d1-reset-' + Date.now() + '-' + process.pid + '.sql');
    try {
        fs.writeFileSync(tmp, sql);
        run(['d1', 'execute', binding, target, '--file', tmp, '--yes']);
        return ordered.length;
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
}

/** 把远端/本地 D1 导出成可恢复 SQL：schema + 真实表数据。 */
export function exportD1Full({ run, binding, target, output }) {
    const schemaRows = queryD1Json(run, binding, target, SCHEMA_QUERY);
    const tableRows = queryD1Json(run, binding, target, DATA_TABLES_QUERY);
    const tables = tableRows.map((row) => row.name).filter(Boolean);
    if (!tables.length) throw new Error('D1 里没有可导出的真实表');

    const schema = schemaRows
        .map((row) => String(row.sql || '').trim())
        .filter(Boolean)
        .map((sql) => sql.endsWith(';') ? sql : sql + ';')
        .join('\n');
    if (!/CREATE\s+TABLE/i.test(schema)) throw new Error('D1 schema 导出为空');

    const tmp = path.join(os.tmpdir(), 'chillin-d1-data-' + Date.now() + '-' + process.pid + '.sql');
    try {
        const args = ['d1', 'export', binding, target, '--no-schema', '--skip-confirmation', '--output', tmp];
        for (const table of tables) args.push('--table', table);
        run(args);
        const data = fs.readFileSync(tmp, 'utf8');
        const sql = 'PRAGMA defer_foreign_keys=TRUE;\n' + schema + '\n' + data;
        fs.writeFileSync(output, sql);
        return { sql, tables };
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
}
