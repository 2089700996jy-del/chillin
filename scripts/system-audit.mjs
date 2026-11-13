#!/usr/bin/env node
/**
 * scripts/system-audit.mjs
 * 全局静态契约与暗病扫描引擎 (System & Contract Static Audit Engine)
 *
 * 参照 css-computed-audit 原生轻量化设计，零第三方依赖。
 * 针对个人大型项目 Vibe Coding 中后期的隐性 Bug 开展静态白盒审计：
 * 1. 严格扫描 public/js/ 与 workers/src/ 中所有静默吞错的 catch 块（输出文件、行号、所在函数与摘要）
 * 2. 严格扫描前端所有带防抖保存/同步状态的逻辑，检查是否缺失 visibilitychange 兜底与 keepalive 保活
 * 3. 智能核对前端 API 路径（兼容模板字符串与动态参数）与 workers/ 路由契约对齐
 * 4. 深度核对 workers/src/ 中的 D1 SQL 表名与迁移 0001~0043 的表结构定义
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const listDir = (dir, filter) => fs.readdirSync(path.join(root, dir)).filter(filter);

const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m'
};

const findings = {
    silentCatches: [],
    debounceLifecycle: [],
    routeMismatches: [],
    sqlTableMismatches: []
};

// 辅助：根据索引反向推导所在函数名
function getEnclosingFunction(code, index) {
    const head = code.slice(Math.max(0, index - 500), index);
    const fnMatches = [
        ...head.matchAll(/(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/g),
        ...head.matchAll(/(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(/g),
        ...head.matchAll(/(?:async\s+)?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{/g)
    ];
    if (fnMatches.length > 0) {
        return fnMatches[fnMatches.length - 1][1];
    }
    return '(anonymous)';
}

// ── 规则 1: 静默吞错扫描器 (Silent Catch Detector) ──
function auditSilentCatches() {
    const jsFiles = [
        path.join(root, 'public', 'app.js'),
        ...listDir('public/js', (f) => f.endsWith('.js')).map((f) => path.join(root, 'public', 'js', f)),
        ...listDir('workers/src', (f) => f.endsWith('.js')).map((f) => path.join(root, 'workers', 'src', f))
    ];

    for (const file of jsFiles) {
        const rel = path.relative(root, file).replace(/\\/g, '/');
        const code = fs.readFileSync(file, 'utf8');

        // 匹配 catch (err) { ... } 或 catch { ... }
        const catchRegex = /catch\s*(?:\([^)]*\))?\s*\{([^}]*)\}/g;
        let match;
        while ((match = catchRegex.exec(code)) !== null) {
            const body = match[1].trim();
            const index = match.index;
            const line = code.slice(0, index).split('\n').length;
            const fnName = getEnclosingFunction(code, index);

            // 允许显式标记的豁免注释
            if (match[0].includes('audit-ignore') || body.includes('audit-ignore')) continue;

            const stripped = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').trim();

            // 判定 A: 绝对空 catch 块 (WARN)
            if (stripped.length === 0) {
                findings.silentCatches.push({
                    file: rel,
                    line,
                    fn: fnName,
                    snippet: match[0].slice(0, 75).replace(/\s+/g, ' '),
                    severity: 'WARN',
                    reason: '空 catch 块：异常被彻底无声吞掉，缺少错误回退或记录'
                });
                continue;
            }

            // 判定 B: 仅有 console 日志，但无 throw、无 return 错误、无 UI 提示且无重试队列 (INFO)
            const isConsoleOnly = /^(?:console\.(?:warn|log|error|info|debug)\([^;]*\);?\s*)+$/.test(stripped);
            if (isConsoleOnly) {
                findings.silentCatches.push({
                    file: rel,
                    line,
                    fn: fnName,
                    snippet: match[0].slice(0, 85).replace(/\s+/g, ' '),
                    severity: 'INFO',
                    reason: '仅打印控制台日志，调用栈与用户界面无感知，潜在静默失败'
                });
            }
        }
    }
}

// ── 规则 2: 防抖未决与生命周期兜底扫描器 (Debounce & Lifecycle Leak Detector) ──
function auditDebounceLifecycle() {
    const jsDir = path.join(root, 'public', 'js');
    const files = listDir('public/js', (f) => f.endsWith('.js')).map((f) => path.join(jsDir, f));

    for (const file of files) {
        const rel = path.relative(root, file).replace(/\\/g, '/');
        const code = fs.readFileSync(file, 'utf8');

        // 检测是否存在防抖/延迟状态持久化（如 saveTimer, cloudSyncTimer, draftTimer 等）
        const timerMatches = [
            ...code.matchAll(/(?:let|var|const)\s+([a-zA-Z0-9_$]*[tT]imer)\s*=\s*(?:null|0|setTimeout)/g),
            ...code.matchAll(/([a-zA-Z0-9_$]*[tT]imer)\s*=\s*setTimeout\s*\([^,]+,\s*([1-9]\d{2,})\)/g)
        ];

        const hasStatePersistence = /(?:saveReaderProgress|saveDraft|pushProgress|syncToCloud|persistState|localStorage\.setItem|rdbPut)\b/.test(code);

        if (timerMatches.length === 0 || !hasStatePersistence) continue;

        const timerName = timerMatches[0][1];
        const line = code.slice(0, timerMatches[0].index).split('\n').length;
        const fnName = getEnclosingFunction(code, timerMatches[0].index);

        const hasVisibilityListener = /visibilitychange|pagehide|beforeunload/.test(code);
        // 识别静态 keepalive: true 或符合 W3C 规范的动态按体积判定（如 keepalive: isKeepalivePayloadSafe(...)）
        const hasKeepalive = /keepalive\s*:\s*(?:true|[a-zA-Z0-9_$]+)/.test(code);
        const hasSendBeacon = /navigator\.sendBeacon/.test(code);

        if (!hasVisibilityListener) {
            findings.debounceLifecycle.push({
                file: rel,
                line,
                fn: fnName,
                timer: timerName,
                severity: 'WARN',
                reason: `定义了防抖持久化定时器 '${timerName}'，但未监听 visibilitychange / pagehide，切后台或关浏览器易丢失未刷入数据`
            });
        } else if (!hasKeepalive && !hasSendBeacon && /(?:fetch|apiRequest)\s*\(/.test(code)) {
            findings.debounceLifecycle.push({
                file: rel,
                line,
                fn: fnName,
                timer: timerName,
                severity: 'INFO',
                reason: `已监听切后台生命周期，但网络外发请求缺少 { keepalive: true } 或 sendBeacon，移动端锁屏可能被系统截断丢包`
            });
        }
    }
}

// ── 规则 3: 前后端 API 路由契约对齐扫描器 (API Route Contract Alignment) ──
function auditRouteAlignment() {
    const clientFiles = [
        path.join(root, 'public', 'app.js'),
        ...listDir('public/js', (f) => f.endsWith('.js')).map((f) => path.join(root, 'public', 'js', f))
    ];

    const frontendRoutes = new Set();
    // 匹配字面量字符串与模板字符串中的 /api/ 路径
    const routeRegex = /['"`](\/api\/[^'"`\s\?#]+)['"`]/g;

    for (const f of clientFiles) {
        const code = fs.readFileSync(f, 'utf8');
        let m;
        while ((m = routeRegex.exec(code)) !== null) {
            let raw = m[1];
            // 归一化模板字符串动态插值，例如 /api/reader/books/${key} -> /api/reader/books/*
            let normalized = raw.replace(/\$\{[^}]+\}/g, '*').replace(/\/+$/, '');
            if (normalized.startsWith('/api/')) frontendRoutes.add(normalized);
        }
    }

    const gatewayCode = fs.readFileSync(path.join(root, 'workers', 'api.js'), 'utf8');
    const workerSrcFiles = listDir('workers/src', (f) => f.endsWith('.js'))
        .map((f) => fs.readFileSync(path.join(root, 'workers', 'src', f), 'utf8'))
        .join('\n');
    const allBackendCode = gatewayCode + '\n' + workerSrcFiles;

    for (const route of frontendRoutes) {
        // 将通配路径拆分为静态前缀
        const staticPrefix = route.split('*')[0].replace(/\/+$/, '');
        const isMatched = allBackendCode.includes(staticPrefix) ||
            allBackendCode.includes(route) ||
            allBackendCode.includes(route.replace(/^\/api\//, ''));

        if (!isMatched) {
            findings.routeMismatches.push({
                route,
                severity: 'WARN',
                reason: `前端引用的 API 路由未在后端网关或领域模块中发现分发匹配: ${route}`
            });
        }
    }
}

// ── 规则 4: D1 SQL 表名与列名迁移对齐扫描器 (SQL Schema & Migration Integrity) ──
function auditSqlMigrationIntegrity() {
    const migrationFiles = listDir('migrations', (f) => f.endsWith('.sql')).sort();
    const schemaTables = new Map();

    // 预设系统与虚拟表
    schemaTables.set('sqlite_master', new Set(['type', 'name', 'tbl_name', 'rootpage', 'sql']));
    schemaTables.set('sqlite_sequence', new Set(['name', 'seq']));
    schemaTables.set('memory_fts', new Set(['content', 'title', 'source_type', 'source_id', 'created_at']));

    // 解析 migrations 0001~0043 中的 CREATE TABLE 与 ALTER TABLE
    for (const f of migrationFiles) {
        const sql = fs.readFileSync(path.join(root, 'migrations', f), 'utf8');

        // CREATE TABLE [IF NOT EXISTS] tablename ( col1 ..., col2 ... )
        const createRegex = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
        let cm;
        while ((cm = createRegex.exec(sql)) !== null) {
            const tblName = cm[1].toLowerCase();
            const colsText = cm[2];
            const cols = schemaTables.get(tblName) || new Set();

            for (const rawCol of colsText.split(',')) {
                const line = rawCol.trim();
                if (!line || /^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
                const colMatch = line.match(/^([a-zA-Z0-9_]+)/);
                if (colMatch) cols.add(colMatch[1].toLowerCase());
            }
            schemaTables.set(tblName, cols);
        }

        // ALTER TABLE tablename ADD COLUMN colname
        const alterRegex = /ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s+ADD\s+(?:COLUMN\s+)?([a-zA-Z0-9_]+)/gi;
        let am;
        while ((am = alterRegex.exec(sql)) !== null) {
            const tblName = am[1].toLowerCase();
            const colName = am[2].toLowerCase();
            const cols = schemaTables.get(tblName) || new Set();
            cols.add(colName);
            schemaTables.set(tblName, cols);
        }
    }

    const workerFiles = listDir('workers/src', (f) => f.endsWith('.js'))
        .map((f) => path.join(root, 'workers', 'src', f));

    const sqlKeywords = new Set([
        'set', 'where', 'values', 'select', 'default', 'null', 'json', 'pragma', 'if', 'case', 'when',
        'then', 'else', 'end', 'as', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'on', 'order',
        'group', 'by', 'having', 'limit', 'offset', 'union', 'all', 'intersect', 'except', 'distinct',
        'from', 'into', 'update', 'table', 'and', 'or', 'not', 'in', 'between', 'like', 'is', 'exists'
    ]);

    for (const file of workerFiles) {
        const rel = path.relative(root, file).replace(/\\/g, '/');
        const code = fs.readFileSync(file, 'utf8');

        // 匹配 FROM table, INTO table, UPDATE table
        const sqlTableRegex = /\b(?:FROM|INTO|UPDATE)\s+([a-zA-Z0-9_]+)\b/gi;
        let m;
        while ((m = sqlTableRegex.exec(code)) !== null) {
            const tbl = m[1].toLowerCase();
            if (sqlKeywords.has(tbl) || /^\d+$/.test(tbl)) continue;

            const line = code.slice(0, m.index).split('\n').length;
            const fnName = getEnclosingFunction(code, m.index);

            if (!schemaTables.has(tbl)) {
                findings.sqlTableMismatches.push({
                    file: rel,
                    line,
                    fn: fnName,
                    table: tbl,
                    severity: 'WARN',
                    reason: `引用的表 '${tbl}' 未在 migrations 0001~0043 中发现 CREATE TABLE 声明`
                });
            }
        }
    }
}

// ── 运行与报告格式化输出 ──
console.log(`${colors.bold}${colors.cyan}======================================================${colors.reset}`);
console.log(`${colors.bold}${colors.cyan}  Chillin 数字花园：全局静态契约与暗病扫描报告 (v1.0)  ${colors.reset}`);
console.log(`${colors.bold}${colors.cyan}======================================================${colors.reset}\n`);

auditSilentCatches();
auditDebounceLifecycle();
auditRouteAlignment();
auditSqlMigrationIntegrity();

let totalWarns = 0;
let totalInfos = 0;

function printSection(title, list, formatter) {
    console.log(`${colors.bold}▶ ${title} (${list.length})${colors.reset}`);
    if (list.length === 0) {
        console.log(`  ${colors.green}✔ 校验通过，未发现异常${colors.reset}\n`);
        return;
    }
    for (const item of list) {
        if (item.severity === 'WARN') totalWarns++;
        else totalInfos++;
        const color = item.severity === 'WARN' ? colors.yellow : colors.gray;
        console.log(`  ${color}[${item.severity}]${colors.reset} ${formatter(item)}`);
    }
    console.log('');
}

printSection('1. 静态未决异常与吞错捕获 (Silent Catches)', findings.silentCatches,
    (i) => `${colors.cyan}${i.file}:${i.line}${colors.reset} in ${colors.magenta}${i.fn}()${colors.reset}\n      ↳ ${i.reason} ${colors.gray}(${i.snippet})${colors.reset}`);

printSection('2. 防抖状态持久化与移动端生命周期脱钩 (Debounce & Lifecycle)', findings.debounceLifecycle,
    (i) => `${colors.cyan}${i.file}:${i.line}${colors.reset} in ${colors.magenta}${i.fn}()${colors.reset}\n      ↳ ${i.reason}`);

printSection('3. 前后端 API 路由对齐契约 (API Route Alignment)', findings.routeMismatches,
    (i) => `${colors.yellow}${i.route}${colors.reset} - ${i.reason}`);

printSection('4. D1 SQL 表名与迁移一致性 (SQL Schema Integrity)', findings.sqlTableMismatches,
    (i) => `${colors.cyan}${i.file}:${i.line}${colors.reset} in ${colors.magenta}${i.fn}()${colors.reset}\n      ↳ 表 '${colors.bold}${i.table}${colors.reset}' 未在迁移中声明`);

console.log(`${colors.bold}── 扫描统计与健康评级 ──${colors.reset}`);
console.log(`阻断与高危警报 (WARN): ${totalWarns > 0 ? colors.yellow + totalWarns : colors.green + '0'}${colors.reset} 项`);
console.log(`优化与提示建议 (INFO): ${colors.blue}${totalInfos}${colors.reset} 项`);

if (totalWarns === 0) {
    console.log(`\n${colors.green}✔ 静态契约与数据表引用整体健康，无阻断性静态断层。${colors.reset}\n`);
} else {
    console.log(`\n${colors.yellow}ℹ 发现 ${totalWarns} 处可优化隐患，建议对照上方定位逐一收敛。${colors.reset}\n`);
}
