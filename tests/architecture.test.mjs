import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Architecture - the Worker gateway stays a thin router (300-line red line)', async () => {
    const source = await fs.readFile(path.join(root, 'workers', 'api.js'), 'utf8');
    const lines = source.split('\n').length;

    assert.ok(
        lines <= 300,
        `workers/api.js is ${lines} lines - AGENTS.md caps the gateway at 300. Move domain logic into workers/src/.`
    );

    // 网关只应编排，不应直接实现领域逻辑：确认各子域模块都被引用
    for (const mod of ['security', 'auth', 'garden-shared', 'garden-media', 'garden-resources', 'garden-sync', 'garden-echo', 'ai', 'bot-claw', 'maintenance']) {
        assert.ok(
            source.includes(`./src/${mod}.js`),
            `workers/api.js should route through ./src/${mod}.js`
        );
    }

    // 编排层下沉后，定时任务的分发必须由 maintenance 统一引用各执行模块
    const maintenance = await fs.readFile(path.join(root, 'workers', 'src', 'maintenance.js'), 'utf8');
    for (const mod of ['audit', 'auth', 'security-network', 'garden-media', 'bot-claw']) {
        assert.ok(
            maintenance.includes(`./${mod}.js`),
            `workers/src/maintenance.js should orchestrate ./src/${mod}.js`
        );
    }
});

test('Architecture - no domain module grows past 500 lines', async () => {
    const dir = path.join(root, 'workers', 'src');
    for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.js'))) {
        const text = await fs.readFile(path.join(dir, file), 'utf8');
        const count = text.split('\n').length;
        assert.ok(count <= 500, `workers/src/${file} is ${count} lines - split it before it becomes another 999-line garden.js`);
    }
});

test('Architecture - domain modules stay out of the gateway entry file', async () => {
    const source = await fs.readFile(path.join(root, 'workers', 'api.js'), 'utf8');
    // 网关里不应出现 SQL 或 LLM 供应商细节（按代码库的大写 SQL 约定匹配，避免误伤注释散文）
    assert.ok(!/\bINSERT INTO\b|\bDELETE FROM\b|\bUPDATE\s+\w+\s+SET\b|\bSELECT\b[\s\S]{0,80}?\bFROM\b/.test(source), 'gateway must not contain SQL statements');
    assert.ok(!/deepseek|api\.deepseek/i.test(source), 'gateway must not talk to the LLM provider directly');
});

test('Architecture - the gateway exposes a public health probe', async () => {
    const source = await fs.readFile(path.join(root, 'workers', 'api.js'), 'utf8');
    assert.match(source, /\/api\/health/, 'expected a /api/health route');
    // 健康检查必须留在鉴权闸门之前，且不泄露业务数据
    const healthIndex = source.indexOf("'/api/health'");
    const gateIndex = source.indexOf('鉴权闸门');
    assert.ok(healthIndex !== -1 && gateIndex !== -1 && healthIndex < gateIndex, 'health must be a public route');
    assert.ok(!/health[\s\S]{0,400}?FROM (weeklies|notes|quick_feeds|users)/.test(source), 'health must not query business tables');
});

test('Architecture - frontend modules have valid imports and no undeclared function calls', async () => {
    const jsDir = path.join(root, 'public', 'js');
    const files = (await fs.readdir(jsDir)).filter((f) => f.endsWith('.js'));
    const allModulePaths = [...files.map((f) => path.join(jsDir, f)), path.join(root, 'public', 'app.js')];

    const allExports = new Set();
    for (const f of allModulePaths) {
        const content = await fs.readFile(f, 'utf8');
        for (const m of content.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+([a-zA-Z0-9_$]+)/g)) {
            allExports.add(m[1]);
        }
        for (const eb of content.matchAll(/export\s*\{([^}]+)\}/g)) {
            for (const item of eb[1].split(',')) {
                const name = item.trim().split(/\s+as\s+/)[0].trim();
                if (name) allExports.add(name);
            }
        }
    }

    for (const f of allModulePaths) {
        const rawContent = await fs.readFile(f, 'utf8');
        // Strip comments and string literals so words in prose/templates aren't mistaken for function calls
        const content = rawContent
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*/g, '')
            .replace(/'(?:\\.|[^'\\])*'/g, "''")
            .replace(/"(?:\\.|[^"\\])*"/g, '""');
        const rel = path.relative(root, f).replace(/\\/g, '/');
        for (const exp of allExports) {
            const callRegex = new RegExp(`\\b${exp}\\s*\\(`, 'g');
            let match;
            while ((match = callRegex.exec(content)) !== null) {
                const idx = match.index;
                if (idx > 0 && content[idx - 1] === '.') continue;
                const isImported = new RegExp(`import\\s*\\{[^}]*\\b${exp}\\b[^}]*\\}`).test(content);
                const isDynamicImported = new RegExp(`\\b${exp}\\b[^;\\n]*=\\s*(?:await\\s+)?import\\(`).test(content);
                const isDeclared = new RegExp(`(?:function|const|let|var)\\s+${exp}\\b`).test(content);
                assert.ok(
                    isImported || isDynamicImported || isDeclared,
                    `Frontend file ${rel} calls "${exp}()" without importing or declaring it!`
                );
            }
        }
    }
});

test('Architecture - 前端首屏体积守住预算（防无声膨胀）', async () => {
    // 背景：项目坚持零构建、直开，但此前没有任何体积约束——
    // 加一个 30KB 的库只需一次提交，没人会注意到首次加载变慢。
    // 预算按当前实测值留出余量；上调预算必须是一次有意识的改动（改这里并说明原因）。
    const zlib = await import('node:zlib');
    const gzipSize = async (p) => zlib.gzipSync(await fs.readFile(p)).length;

    const BUDGET = {
        jsTotalGzip: 160 * 1024,   // 当前实测 134.8 KB
        cssTotalGzip: 48 * 1024,   // 当前实测 35.9 KB
        singleFileGzip: 20 * 1024  // 当前最大是 public/js/reader.js 13.6 KB
    };

    const jsFiles = [];
    const cssFiles = [];
    const walk = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(p);
            else if (entry.name.endsWith('.js')) jsFiles.push(p);
            else if (entry.name.endsWith('.css')) cssFiles.push(p);
        }
    };
    await walk(path.join(root, 'public'));

    const sizes = await Promise.all(jsFiles.map(async (p) => ({ p, g: await gzipSize(p) })));
    const jsTotal = sizes.reduce((sum, x) => sum + x.g, 0);
    const cssTotal = (await Promise.all(cssFiles.map((p) => gzipSize(p)))).reduce((sum, n) => sum + n, 0);
    const kb = (n) => (n / 1024).toFixed(1) + ' KB';

    assert.ok(
        jsTotal <= BUDGET.jsTotalGzip,
        `JS 合计 ${kb(jsTotal)} 越过预算 ${kb(BUDGET.jsTotalGzip)}——新体积请先确认值得，再同步上调预算`
    );
    assert.ok(
        cssTotal <= BUDGET.cssTotalGzip,
        `CSS 合计 ${kb(cssTotal)} 越过预算 ${kb(BUDGET.cssTotalGzip)}`
    );
    for (const { p, g } of sizes) {
        const rel = path.relative(root, p).split(path.sep).join('/');
        assert.ok(
            g <= BUDGET.singleFileGzip,
            `${rel} 单文件 ${kb(g)} 超过 ${kb(BUDGET.singleFileGzip)}——考虑拆分或懒加载`
        );
    }
});

test('Architecture - 笔记列表按批渲染，且搜索能定位分页外的笔记', async () => {
    const notes = await fs.readFile(path.join(root, 'public', 'js', 'notes.js'), 'utf8');
    assert.match(notes, /const NOTES_PAGE_SIZE = 60;/, '笔记每批 60 条，和随手记的 100 条分开调');
    assert.match(notes, /allNotes\.slice\(0, notesVisibleCount\)/, '渲染必须只取当前窗口，不能全量塞 DOM');
    assert.match(notes, /new IntersectionObserver/, '滚到底要自动续载');
    assert.match(notes, /actions\.ensureNoteRendered = ensureNoteRendered/, '搜索跳转需要把目标笔记纳入渲染窗口');

    const search = await fs.readFile(path.join(root, 'public', 'js', 'search.js'), 'utf8');
    assert.match(search, /actions\.ensureNoteRendered/, '搜索跳转必须优先按笔记类型扩窗，不能只依赖 feeds 的 ensureItemRendered');
});
