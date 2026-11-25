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
    for (const mod of ['security', 'auth', 'garden-media', 'garden-resources', 'garden-sync', 'garden-echo', 'ai', 'bot-claw', 'maintenance']) {
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

test('Architecture - reader/upload/prompts/agent-goals 走路由级动态 import，首屏不静态引入', async () => {
    const app = await fs.readFile(path.join(root, 'public', 'app.js'), 'utf8');
    for (const name of ['reader', 'upload', 'prompts', 'agent-goals']) {
        assert.doesNotMatch(
            app,
            new RegExp("from ['\"]\\./js/" + name + "\\.js['\"]"),
            '首屏 app.js 不得静态 import ' + name + '.js（应走 feature-loader）'
        );
    }
    assert.match(app, /feature-loader\.js/, 'app.js 必须通过 feature-loader 接入懒加载');
    assert.match(app, /loadFeature\(feature\)/, '首击兜底应显式加载对应 feature');

    const loader = await fs.readFile(path.join(root, 'public', 'js', 'feature-loader.js'), 'utf8');
    assert.match(loader, /from\s+['"]\.\/version\.js['"]/, 'feature-loader 必须引入 version.js 获取版本号');
    for (const name of ['reader', 'upload', 'prompts', 'agent-goals']) {
        assert.ok(
            loader.includes("import(`./" + name + ".js${versionQuery}`)") || loader.includes("import('./" + name + ".js')"),
            'feature-loader 缺少 ' + name + ' 的动态 import'
        );
    }
    assert.ok(loader.includes('import(`./reader.js${versionQuery}`)'), 'reader.js 动态加载必须带版本参数防 iOS 命中旧缓存');
    assert.match(loader, /const pending = new Map\(\)/, '并发导航必须复用同一个加载 Promise');
    assert.match(loader, /pending\.delete\(name\)/, '加载失败要允许重试');

    const router = await fs.readFile(path.join(root, 'public', 'js', 'router.js'), 'utf8');
    for (const name of ['reader', 'prompts', 'upload', 'agent-goals']) {
        assert.match(router, new RegExp("loadFeature\\('" + name + "'\\)"), 'router 没有按路由加载 ' + name);
    }
});

test('Architecture - 前端首屏体积守住预算（防无声膨胀）', async () => {
    // 背景：项目坚持零构建、直开。设置总体积预算防止无节制膨胀；
    // 废除单文件 20KB 死线，允许模块高内聚与详尽错误处理；总 JS 上限设为 260 KB 软上限。
    const zlib = await import('node:zlib');
    const gzipSize = async (p) => zlib.gzipSync(await fs.readFile(p)).length;

    const BUDGET = {
        jsTotalGzip: 260 * 1024,   // 260 KB 预算，为后续迭代与新功能留足呼吸空间
        cssTotalGzip: 58 * 1024    // 58 KB
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
});
